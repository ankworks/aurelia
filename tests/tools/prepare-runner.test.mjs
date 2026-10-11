/**
 * Regression tests for GitHub-hosted Windows runner preparation:
 *  - Safe non-Chromium disk cleanup (`reclaimHostedRunnerDisk`)
 *  - Protected path enforcement (`isProtectedRunnerPath`, `PROTECTED_WINDOWS_PATHS`)
 *  - Automated Windows SDK 10.0.28000.0 provisioning (`ensureWindowsSdk`)
 *  - End-to-end runner preparation (`prepareHostedWindowsRunner`) reproducing
 *    and resolving the exact preflight blockers from run 38101262458 (147 GB
 *    free disk and Windows SDK 10.0.26100.0 on windows-2025 with VS 2026
 *    18.10.12217.157 and MSVC 14.51.36231) without weakening the 150 GB floor
 *    or 10.0.28000.0 SDK requirement.
 */
import { describe, expect, it } from 'vitest';

import {
  ensureWindowsSdk,
  isProtectedRunnerPath,
  MINIMUM_PRE_SYNC_FREE_DISK_GB,
  normalizeWindowsPath,
  prepareHostedWindowsRunner,
  PROTECTED_WINDOWS_PATHS,
  reclaimHostedRunnerDisk,
  RUNNER_DISK_REGRESSION_ANALYSIS,
  SAFE_RUNNER_CLEANUP_TARGETS,
  TARGET_CLEANUP_FREE_DISK_GB,
  WINDOWS_SDK_28000_FEATURES,
  WINDOWS_SDK_28000_INSTALLER_URLS,
} from '../../tools/chromium/prepare-runner.mjs';

const HOSTED_ENV = Object.freeze({
  GITHUB_ACTIONS: 'true',
  RUNNER_ENVIRONMENT: 'github-hosted',
  GITHUB_WORKSPACE: 'D:\\a\\aurelia\\aurelia',
  RUNNER_TEMP: 'D:\\a\\_temp',
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  DEPOT_TOOLS_WIN_TOOLCHAIN: '0',
});

const VS_2026_PATH =
  'C:\\Program Files\\Microsoft Visual Studio\\18\\Enterprise';
const SDK_ROOT = 'C:\\Program Files (x86)\\Windows Kits\\10';

function createRunner38101262458State() {
  let freeDiskGb = 147.0;
  const installedSdkVersions = new Set(['10.0.26100.0']);
  const files = new Set([
    VS_2026_PATH,
    `${VS_2026_PATH}\\VC`,
    `${VS_2026_PATH}\\VC\\Auxiliary\\Build\\vcvarsall.bat`,
    `${VS_2026_PATH}\\VC\\Tools\\MSVC`,
    `${VS_2026_PATH}\\VC\\Tools\\MSVC\\14.51.36231`,
    `${VS_2026_PATH}\\VC\\Tools\\MSVC\\14.51.36231\\bin\\Hostx64\\x64\\cl.exe`,
    `${VS_2026_PATH}\\DIA SDK\\bin\\amd64\\msdia140.dll`,
    'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe',
    SDK_ROOT,
    `${SDK_ROOT}\\Include`,
    `${SDK_ROOT}\\Include\\10.0.26100.0`,
    `${SDK_ROOT}\\Include\\10.0.26100.0\\um`,
    `${SDK_ROOT}\\Include\\10.0.26100.0\\um\\windows.h`,
    `${SDK_ROOT}\\Include\\10.0.26100.0\\ucrt\\corecrt.h`,
    `${SDK_ROOT}\\Include\\10.0.26100.0\\shared\\sdkddkver.h`,
    `${SDK_ROOT}\\Lib`,
    `${SDK_ROOT}\\Lib\\10.0.26100.0`,
    `${SDK_ROOT}\\Lib\\10.0.26100.0\\um\\x64\\kernel32.lib`,
    `${SDK_ROOT}\\Lib\\10.0.26100.0\\ucrt\\x64\\ucrt.lib`,
    `${SDK_ROOT}\\Lib\\10.0.26100.0\\um\\x86\\kernel32.lib`,
    `${SDK_ROOT}\\Lib\\10.0.26100.0\\ucrt\\x86\\ucrt.lib`,
    `${SDK_ROOT}\\Debuggers\\x64\\dbghelp.dll`,
    // Preinstalled non-Chromium runner directories on windows-2025
    'C:\\Android',
    'C:\\hostedtoolcache\\windows\\CodeQL',
    'C:\\hostedtoolcache\\windows\\Boost',
    'C:\\ghcup',
  ]);

  const targetSizesGb = new Map([
    ['C:\\Android', 28.0],
    ['C:\\hostedtoolcache\\windows\\CodeQL', 6.5],
    ['C:\\hostedtoolcache\\windows\\Boost', 4.5],
    ['C:\\ghcup', 6.0],
  ]);

  const exists = (candidate) => {
    if (typeof candidate !== 'string') return false;
    return files.has(candidate.replaceAll('/', '\\'));
  };

  const readdirSync = (dir) => {
    const normalized = dir.replaceAll('/', '\\');
    if (normalized.endsWith('VC\\Tools\\MSVC')) {
      return ['14.51.36231'];
    }
    if (normalized.endsWith('Windows Kits\\10\\Include')) {
      return [...installedSdkVersions];
    }
    return [];
  };

  const readText = (filePath) => {
    const normalized = filePath.replaceAll('/', '\\');
    if (normalized.includes('10.0.28000.0\\shared\\sdkddkver.h')) {
      return '#define NTDDI_WIN11_BR 0x0A000011\n';
    }
    return '#define NTDDI_WIN11_GE 0x0A000010\n';
  };

  const rm = (targetPath) => {
    const normalized = targetPath.replaceAll('/', '\\');
    files.delete(normalized);
    if (targetSizesGb.has(normalized)) {
      freeDiskGb =
        Math.round((freeDiskGb + targetSizesGb.get(normalized)) * 10) / 10;
    }
  };

  const spawn = (file) => {
    if (file.includes('vswhere.exe')) {
      return {
        error: undefined,
        status: 0,
        stdout: JSON.stringify([
          {
            instanceId: 'vs2026',
            installationPath: VS_2026_PATH,
            installationVersion: '18.10.12217.157',
            displayName: 'Visual Studio Enterprise 2026',
          },
        ]),
        stderr: '',
      };
    }
    return { error: undefined, status: 0, stdout: '', stderr: '' };
  };

  const provisionSdk28000 = () => {
    installedSdkVersions.add('10.0.28000.0');
    files.add(`${SDK_ROOT}\\Include\\10.0.28000.0`);
    files.add(`${SDK_ROOT}\\Include\\10.0.28000.0\\um`);
    files.add(`${SDK_ROOT}\\Include\\10.0.28000.0\\um\\windows.h`);
    files.add(`${SDK_ROOT}\\Include\\10.0.28000.0\\ucrt\\corecrt.h`);
    files.add(`${SDK_ROOT}\\Include\\10.0.28000.0\\shared\\sdkddkver.h`);
    files.add(`${SDK_ROOT}\\Lib\\10.0.28000.0`);
    files.add(`${SDK_ROOT}\\Lib\\10.0.28000.0\\um\\x64\\kernel32.lib`);
    files.add(`${SDK_ROOT}\\Lib\\10.0.28000.0\\ucrt\\x64\\ucrt.lib`);
    files.add(`${SDK_ROOT}\\Lib\\10.0.28000.0\\um\\x86\\kernel32.lib`);
    files.add(`${SDK_ROOT}\\Lib\\10.0.28000.0\\ucrt\\x86\\ucrt.lib`);
    // Installing Windows SDK 10.0.28000.0 consumes ~3.0 GB on C:
    freeDiskGb = Math.round((freeDiskGb - 3.0) * 10) / 10;
  };

  return {
    getFreeDiskGb: () => freeDiskGb,
    setFreeDiskGb: (value) => {
      freeDiskGb = value;
    },
    files,
    exists,
    readdirSync,
    readText,
    rm,
    spawn,
    provisionSdk28000,
  };
}

describe('runner disk regression analysis and safety floors', () => {
  it('preserves the 150 GB pre-sync disk floor and documents the 219.9 GB -> 147.0 GB drop', () => {
    expect(MINIMUM_PRE_SYNC_FREE_DISK_GB).toBe(150);
    expect(TARGET_CLEANUP_FREE_DISK_GB).toBeGreaterThanOrEqual(165);
    expect(RUNNER_DISK_REGRESSION_ANALYSIS).toMatchObject({
      earlierRunId: '38046646098',
      earlierFreeDiskGb: 219.9,
      failedRunId: '38101262458',
      failedFreeDiskGb: 147.0,
      requiredFreeDiskGb: 150,
      shortfallGb: 3.0,
    });
  });

  it('protects Visual Studio, Windows Kits/SDK, Git, Python, Node.js, Rust, and ancestor paths', () => {
    expect(PROTECTED_WINDOWS_PATHS).toContain(
      'C:\\Program Files\\Microsoft Visual Studio',
    );
    expect(PROTECTED_WINDOWS_PATHS).toContain(
      'C:\\Program Files (x86)\\Windows Kits',
    );

    const options = {
      env: HOSTED_ENV,
      dest: 'C:\\aurelia-chromium',
      visualStudioPath: VS_2026_PATH,
      windowsSdkDir: SDK_ROOT,
    };

    // Exact protected paths and subdirectories inside them
    expect(isProtectedRunnerPath(VS_2026_PATH, options)).toBe(true);
    expect(
      isProtectedRunnerPath(
        `${VS_2026_PATH}\\VC\\Tools\\MSVC\\14.51.36231`,
        options,
      ),
    ).toBe(true);
    expect(isProtectedRunnerPath(SDK_ROOT, options)).toBe(true);
    expect(
      isProtectedRunnerPath(`${SDK_ROOT}\\Include\\10.0.26100.0`, options),
    ).toBe(true);
    expect(isProtectedRunnerPath('C:\\Program Files\\Git', options)).toBe(true);
    expect(
      isProtectedRunnerPath('C:\\hostedtoolcache\\windows\\Python', options),
    ).toBe(true);
    expect(
      isProtectedRunnerPath('C:\\hostedtoolcache\\windows\\node', options),
    ).toBe(true);
    expect(isProtectedRunnerPath('C:\\aurelia-chromium', options)).toBe(true);
    expect(isProtectedRunnerPath(HOSTED_ENV.GITHUB_WORKSPACE, options)).toBe(
      true,
    );

    // Ancestors of protected paths must also be blocked!
    expect(isProtectedRunnerPath('C:\\', options)).toBe(true);
    expect(isProtectedRunnerPath('C:\\Program Files', options)).toBe(true);
    expect(isProtectedRunnerPath('C:\\Program Files (x86)', options)).toBe(
      true,
    );
    expect(isProtectedRunnerPath('C:\\hostedtoolcache', options)).toBe(true);
    expect(isProtectedRunnerPath('C:\\hostedtoolcache\\windows', options)).toBe(
      true,
    );

    // Every allowlisted cleanup target must be non-protected
    for (const target of SAFE_RUNNER_CLEANUP_TARGETS) {
      expect(
        isProtectedRunnerPath(target.path, options),
        `cleanup target ${target.path} must not overlap with protected paths`,
      ).toBe(false);
    }
    expect(normalizeWindowsPath('C:/Android/')).toBe('c:\\android');
  });
});

describe('safe non-Chromium disk cleanup (reclaimHostedRunnerDisk)', () => {
  it('refuses to delete files outside a GitHub-hosted Windows runner', () => {
    const removed = [];
    const result = reclaimHostedRunnerDisk({
      dest: 'C:\\aurelia-chromium',
      env: { GITHUB_ACTIONS: 'false' },
      platform: 'win32',
      rm: (p) => removed.push(p),
    });
    expect(result.executed).toBe(false);
    expect(result.skipped).toBe(true);
    expect(removed).toEqual([]);
  });

  it('reclaims disk space from non-Chromium directories while rejecting protected paths', () => {
    const state = createRunner38101262458State();
    const result = reclaimHostedRunnerDisk({
      dest: 'C:\\aurelia-chromium',
      targetFreeDiskGb: 180,
      env: HOSTED_ENV,
      platform: 'win32',
      targets: [
        // Inject protected paths to prove they are rejected even if passed
        { path: VS_2026_PATH, category: 'should-be-rejected' },
        { path: SDK_ROOT, category: 'should-be-rejected' },
        ...SAFE_RUNNER_CLEANUP_TARGETS,
      ],
      visualStudioPath: VS_2026_PATH,
      windowsSdkDir: SDK_ROOT,
      exists: state.exists,
      rm: state.rm,
      measureFreeDisk: state.getFreeDiskGb,
    });

    expect(result.executed).toBe(true);
    expect(result.freeDiskBeforeGb).toBe(147.0);
    expect(result.freeDiskAfterGb).toBeGreaterThanOrEqual(180);
    expect(result.reclaimedGb).toBeGreaterThanOrEqual(33);
    expect(result.rejectedTargets).toEqual([VS_2026_PATH, SDK_ROOT]);
    expect(state.exists(VS_2026_PATH)).toBe(true);
    expect(state.exists(SDK_ROOT)).toBe(true);
  });
});

describe('automated Windows SDK 10.0.28000.0 provisioning (ensureWindowsSdk)', () => {
  it('exports Microsoft official installer URLs and required SDK features', () => {
    expect(WINDOWS_SDK_28000_INSTALLER_URLS.length).toBeGreaterThan(0);
    for (const url of WINDOWS_SDK_28000_INSTALLER_URLS) {
      expect(url).toMatch(
        /^https:\/\/(download\.microsoft\.com|go\.microsoft\.com)\//,
      );
    }
    expect(WINDOWS_SDK_28000_FEATURES).toEqual([
      'OptionId.DesktopCPPx64',
      'OptionId.DesktopCPPx86',
      'OptionId.UWPCPP',
      'OptionId.WindowsDesktopDebuggers',
    ]);
  });

  it('skips downloading when Windows SDK 10.0.28000.0 is already installed and verified', () => {
    const state = createRunner38101262458State();
    state.provisionSdk28000();

    let downloaded = false;
    const result = ensureWindowsSdk({
      env: HOSTED_ENV,
      platform: 'win32',
      exists: state.exists,
      readdirSync: state.readdirSync,
      readText: state.readText,
      downloadAndVerify: () => {
        downloaded = true;
        return { url: 'unused', signatureVerified: true };
      },
    });

    expect(result.executed).toBe(false);
    expect(result.alreadyInstalled).toBe(true);
    expect(result.installed).toBe(true);
    expect(downloaded).toBe(false);
  });

  it('installs Windows SDK 10.0.28000.0 when only 10.0.26100.0 is present and cleans up staging', () => {
    const state = createRunner38101262458State();
    const cleanedDirs = [];

    const result = ensureWindowsSdk({
      env: HOSTED_ENV,
      platform: 'win32',
      exists: state.exists,
      readdirSync: state.readdirSync,
      readText: state.readText,
      mkdir: () => {},
      rm: (dir) => cleanedDirs.push(dir),
      downloadAndVerify: ({ urls }) => ({
        url: urls[0],
        signatureVerified: true,
        signerSubject: 'CN=Microsoft Corporation',
      }),
      runInstaller: () => {
        state.provisionSdk28000();
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });

    expect(result.executed).toBe(true);
    expect(result.installed).toBe(true);
    expect(result.signatureVerified).toBe(true);
    expect(result.stagingCleaned).toBe(true);
    expect(cleanedDirs.length).toBe(1);
    expect(result.beforeSdk.selectedVersion).toBe('10.0.26100.0');
    expect(result.afterSdk.selectedVersion).toBe('10.0.28000.0');
    expect(result.verification.ok).toBe(true);
  });

  it('refuses to run the SDK installer if Microsoft Authenticode verification fails', () => {
    const state = createRunner38101262458State();
    let installerRan = false;

    const result = ensureWindowsSdk({
      env: HOSTED_ENV,
      platform: 'win32',
      exists: state.exists,
      readdirSync: state.readdirSync,
      readText: state.readText,
      mkdir: () => {},
      rm: () => {},
      downloadAndVerify: ({ urls }) => ({
        url: urls[0],
        signatureVerified: false,
      }),
      runInstaller: () => {
        installerRan = true;
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });

    expect(installerRan).toBe(false);
    expect(result.installed).toBe(false);
    expect(result.problems.join('; ')).toContain('Authenticode signature');
  });
});

describe('end-to-end runner preparation (prepareHostedWindowsRunner)', () => {
  it('resolves both run 38101262458 blockers (147 GB disk + SDK 26100) while preserving VS 2026 and the 150 GB floor', () => {
    const state = createRunner38101262458State();
    const result = prepareHostedWindowsRunner({
      dest: 'C:\\aurelia-chromium',
      minimumFreeDiskGb: 150,
      env: HOSTED_ENV,
      platform: 'win32',
      exists: state.exists,
      readdirSync: state.readdirSync,
      readText: state.readText,
      mkdir: () => {},
      rm: state.rm,
      spawn: state.spawn,
      measureFreeDisk: state.getFreeDiskGb,
      downloadAndVerify: ({ urls }) => ({
        url: urls[0],
        signatureVerified: true,
        signerSubject: 'CN=Microsoft Corporation',
      }),
      runInstaller: () => {
        state.provisionSdk28000();
        return { exitCode: 3010, stdout: '', stderr: '' };
      },
    });

    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
    expect(result.before).toMatchObject({
      freeDiskGb: 147.0,
      visualStudio: VS_2026_PATH,
      visualStudioVersion: '18.10.12217.157',
      msvcToolset: '14.51.36231',
      windowsSdk: '10.0.26100.0',
      windowsSdkCompatible: false,
    });
    expect(result.after).toMatchObject({
      visualStudio: VS_2026_PATH,
      visualStudioVersion: '18.10.12217.157',
      msvcToolset: '14.51.36231',
      visualStudioIntact: true,
      windowsSdk: '10.0.28000.0',
      windowsSdkCompatible: true,
    });
    expect(result.after.freeDiskGb).toBeGreaterThanOrEqual(150);
  });

  it('fails honestly when free disk remains below 150 GB after cleanup', () => {
    const state = createRunner38101262458State();
    state.setFreeDiskGb(100.0);

    const result = prepareHostedWindowsRunner({
      dest: 'C:\\aurelia-chromium',
      minimumFreeDiskGb: 150,
      env: HOSTED_ENV,
      platform: 'win32',
      exists: state.exists,
      readdirSync: state.readdirSync,
      readText: state.readText,
      mkdir: () => {},
      rm: state.rm,
      spawn: state.spawn,
      measureFreeDisk: state.getFreeDiskGb,
      downloadAndVerify: ({ urls }) => ({
        url: urls[0],
        signatureVerified: true,
        signerSubject: 'CN=Microsoft Corporation',
      }),
      runInstaller: () => {
        state.provisionSdk28000();
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });

    expect(result.ok).toBe(false);
    expect(result.problems.join('; ')).toContain(
      'requires at least 150 GB before Chromium synchronization',
    );
  });
});
