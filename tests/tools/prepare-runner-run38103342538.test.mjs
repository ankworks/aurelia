/**
 * Regression tests for the two real blockers observed in workflow run
 * `38103342538` (`gn / standard`, `windows-2025` image `windows-2025-vs2026`,
 * pinned Chromium 155.0.8059.40 @ cfaadc5a132d78e1828635aa8405a499f3e14864).
 *
 * Blocker 1 - Windows SDK Authenticode verification
 *   The installer downloaded successfully (1,417,000 bytes) but
 *   `powershell.exe` aborted with
 *   `CouldNotAutoloadMatchingModule - the module Microsoft.PowerShell.Security
 *   could not be loaded`, so no signature was ever verified and the installer
 *   was never executed.
 *
 * Blocker 2 - Disk cleanup reclaimed 0.0 GB
 *   Cleanup deleted 20 allowlisted directories under `C:\` while the Chromium
 *   destination `D:\a\_temp\aurelia-chromium` was measured: 147.0 GB before and
 *   147.0 GB after. `C:` and `D:` are separate volumes on GitHub-hosted Windows
 *   runners, so `C:` deletions cannot free space on `D:`.
 *
 * Neither fix lowers the 150 GB disk floor or the Windows SDK 10.0.28000.0
 * requirement, and signature verification remains mandatory.
 */
import { describe, expect, it } from 'vitest';

import {
  AUTHENTICODE_POWERSHELL_CANDIDATES,
  AUTHENTICODE_SECURITY_MODULE,
  buildAuthenticodeVerificationScript,
  defaultDownloadAndVerifyInstaller,
  downloadInstaller,
  evaluateDestinationVolumes,
  isSameVolume,
  MINIMUM_PRE_SYNC_FREE_DISK_GB,
  parseAuthenticodeReport,
  prepareHostedWindowsRunner,
  reclaimHostedRunnerDisk,
  SAFE_RUNNER_CLEANUP_TARGETS,
  verifyAuthenticodeSignature,
  volumeRootOf,
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

/** JSON report emitted by a successful Authenticode verification. */
const VERIFIED_REPORT = {
  ok: true,
  stage: 'get-authenticodesignature',
  psVersion: '7.4.6',
  psEdition: 'Core',
  psHome: 'C:\\Program Files\\PowerShell\\7',
  psModulePath: 'C:\\Program Files\\PowerShell\\Modules',
  moduleImported: true,
  moduleImportError: null,
  signatureStatus: 'Valid',
  signerSubject:
    'CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US',
  error: null,
};

/**
 * The exact failure recorded in run 38103342538: Windows PowerShell 5.1 could
 * not load `Microsoft.PowerShell.Security`.
 */
const MODULE_IMPORT_FAILURE_REPORT = {
  ok: false,
  stage: 'import-module',
  psVersion: '5.1.26100.0',
  psEdition: 'Desktop',
  psHome: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0',
  psModulePath: 'C:\\Modules\\azurerm_6.1.0;C:\\Modules\\azuread_2.0.2.182',
  moduleImported: false,
  moduleImportError:
    "System.Management.Automation.CommandNotFoundException: The 'Get-AuthenticodeSignature' command was found in the module 'Microsoft.PowerShell.Security', but the module could not be loaded. For more information, run 'Import-Module Microsoft.PowerShell.Security'.",
  signatureStatus: null,
  signerSubject: null,
  error:
    "The 'Get-AuthenticodeSignature' command was found in the module 'Microsoft.PowerShell.Security', but the module could not be loaded.",
};

/**
 * Build a `spawn` double that answers the download script and each PowerShell
 * verification host independently.
 *
 * @param {object} options
 * @param {object|Error|null} [options.pwsh] Response for `pwsh`.
 * @param {object|Error|null} [options.powershell] Response for `powershell`.
 */
function createAuthenticodeSpawn({ pwsh = null, powershell = null } = {}) {
  const handlers = { pwsh, powershell };
  return (file, args) => {
    const script = Array.isArray(args) ? String(args.at(-1) ?? '') : '';
    const isDownload = script.includes('curl.exe');
    if (isDownload) {
      return {
        error: undefined,
        status: 0,
        stdout: `${JSON.stringify({
          url: WINDOWS_SDK_28000_INSTALLER_URLS[0],
          bytes: 1417000,
        })}\n`,
        stderr: '',
      };
    }
    const handler = handlers[file];
    if (handler instanceof Error) {
      return { error: handler, status: null, stdout: '', stderr: '' };
    }
    if (handler === null) {
      return {
        error: undefined,
        status: 3,
        stdout: `${JSON.stringify(MODULE_IMPORT_FAILURE_REPORT)}\n`,
        stderr: 'Get-AuthenticodeSignature : module could not be loaded',
      };
    }
    const { status = 0, stdout = '', stderr = '' } = handler;
    return { error: undefined, status, stdout, stderr };
  };
}

describe('volume topology helpers', () => {
  it('resolves the volume root of Windows, UNC, and POSIX paths', () => {
    expect(volumeRootOf('D:\\a\\_temp\\aurelia-chromium')).toBe('D:\\');
    expect(volumeRootOf('C:\\Android')).toBe('C:\\');
    expect(volumeRootOf('C:\\')).toBe('C:\\');
    expect(volumeRootOf('C:/Android/')).toBe('C:\\');
    expect(volumeRootOf('d:\\a')).toBe('D:\\');
    expect(volumeRootOf('/home/user/aurelia')).toBe('/');
    expect(volumeRootOf('')).toBeNull();
    expect(volumeRootOf(null)).toBeNull();
  });

  it('reports C: and D: as different volumes on a GitHub-hosted Windows runner', () => {
    const dest = 'D:\\a\\_temp\\aurelia-chromium';
    expect(isSameVolume('C:\\Android', dest)).toBe(false);
    expect(isSameVolume('C:\\hostedtoolcache\\windows\\CodeQL', dest)).toBe(
      false,
    );
    expect(isSameVolume('D:\\Android', dest)).toBe(true);
    expect(isSameVolume('D:\\a\\_temp', dest)).toBe(true);
  });

  it('evaluates the destination volume and lists alternatives that meet the floor', () => {
    const freeByVolume = new Map([
      ['C:\\', 180.0],
      ['D:\\', 147.0],
    ]);
    const evaluation = evaluateDestinationVolumes({
      dest: 'D:\\a\\_temp\\aurelia-chromium',
      platform: 'win32',
      exists: (candidate) => freeByVolume.has(candidate),
      measureFreeDisk: (candidate) =>
        freeByVolume.get(volumeRootOf(candidate)) ?? null,
    });

    expect(evaluation.destinationVolume).toBe('D:\\');
    expect(evaluation.destinationFreeDiskGb).toBe(147.0);
    expect(evaluation.destinationMeetsMinimum).toBe(false);
    expect(evaluation.alternativeVolumes.map((entry) => entry.volume)).toEqual([
      'C:\\',
    ]);
    expect(evaluation.recommendedVolume).toBe('C:\\');
  });

  it('keeps the destination volume as the recommendation when it meets the floor', () => {
    const freeByVolume = new Map([
      ['C:\\', 80.0],
      ['D:\\', 200.0],
    ]);
    const evaluation = evaluateDestinationVolumes({
      dest: 'D:\\a\\_temp\\aurelia-chromium',
      platform: 'win32',
      exists: (candidate) => freeByVolume.has(candidate),
      measureFreeDisk: (candidate) =>
        freeByVolume.get(volumeRootOf(candidate)) ?? null,
    });

    expect(evaluation.destinationMeetsMinimum).toBe(true);
    expect(evaluation.alternativeVolumes).toEqual([]);
    expect(evaluation.recommendedVolume).toBe('D:\\');
  });

  it('reports no alternative when every volume is short of the floor', () => {
    const freeByVolume = new Map([
      ['C:\\', 90.0],
      ['D:\\', 147.0],
    ]);
    const evaluation = evaluateDestinationVolumes({
      dest: 'D:\\a\\_temp\\aurelia-chromium',
      platform: 'win32',
      exists: (candidate) => freeByVolume.has(candidate),
      measureFreeDisk: (candidate) =>
        freeByVolume.get(volumeRootOf(candidate)) ?? null,
    });

    expect(evaluation.destinationMeetsMinimum).toBe(false);
    expect(evaluation.alternativeVolumes).toEqual([]);
    expect(evaluation.recommendedVolume).toBeNull();
    expect(evaluation.minimumFreeDiskGb).toBe(MINIMUM_PRE_SYNC_FREE_DISK_GB);
  });
});

describe('cross-volume disk cleanup (run 38103342538 blocker 2)', () => {
  const DEST = 'D:\\a\\_temp\\aurelia-chromium';

  it('deletes nothing and reclaims 0.0 GB when every allowlisted target lives on another volume', () => {
    const removed = [];
    // D: is a separate volume: deleting C: content cannot change its free disk.
    const result = reclaimHostedRunnerDisk({
      dest: DEST,
      targetFreeDiskGb: 165,
      env: HOSTED_ENV,
      platform: 'win32',
      targets: SAFE_RUNNER_CLEANUP_TARGETS,
      exists: () => true,
      rm: (targetPath) => removed.push(targetPath),
      measureFreeDisk: () => 147.0,
      log: () => {},
    });

    expect(result.executed).toBe(true);
    expect(result.destinationVolume).toBe('D:\\');
    // The reported failure: 20 directories "removed" but 0.0 GB reclaimed.
    expect(removed).toEqual([]);
    expect(result.removedTargets).toEqual([]);
    expect(result.reclaimedGb).toBe(0);
    expect(result.freeDiskBeforeGb).toBe(147.0);
    expect(result.freeDiskAfterGb).toBe(147.0);
    expect(result.offVolumeTargets).toHaveLength(
      SAFE_RUNNER_CLEANUP_TARGETS.length,
    );
    for (const entry of result.offVolumeTargets) {
      expect(entry.volume).toBe('C:\\');
    }
  });

  it('reclaims real space only from targets on the destination volume', () => {
    const files = new Set([
      'D:\\Android',
      'D:\\ghcup',
      'C:\\Android',
      'C:\\hostedtoolcache\\windows\\CodeQL',
    ]);
    const sizesGb = new Map([
      ['D:\\Android', 28.0],
      ['D:\\ghcup', 6.0],
      ['C:\\Android', 28.0],
      ['C:\\hostedtoolcache\\windows\\CodeQL', 6.5],
    ]);
    const freeByVolume = new Map([
      ['C:\\', 120.0],
      ['D:\\', 147.0],
    ]);
    // A deletion only frees space on its own volume.
    const rm = (targetPath) => {
      if (!files.has(targetPath)) {
        return;
      }
      files.delete(targetPath);
      const volume = volumeRootOf(targetPath);
      freeByVolume.set(
        volume,
        Math.round(
          (freeByVolume.get(volume) + (sizesGb.get(targetPath) ?? 0)) * 10,
        ) / 10,
      );
    };

    const result = reclaimHostedRunnerDisk({
      dest: DEST,
      targetFreeDiskGb: 200,
      env: HOSTED_ENV,
      platform: 'win32',
      targets: [
        { path: 'C:\\Android', category: 'Android SDK' },
        { path: 'C:\\hostedtoolcache\\windows\\CodeQL', category: 'CodeQL' },
        { path: 'D:\\Android', category: 'Android SDK on D:' },
        { path: 'D:\\ghcup', category: 'Haskell on D:' },
      ],
      exists: (candidate) => files.has(candidate),
      rm,
      measureFreeDisk: (candidate) =>
        freeByVolume.get(volumeRootOf(candidate)) ?? null,
      log: () => {},
    });

    expect(result.removedTargets.map((entry) => entry.path)).toEqual([
      'D:\\Android',
      'D:\\ghcup',
    ]);
    expect(result.removedTargets[0].reclaimedGb).toBe(28.0);
    expect(result.removedTargets[1].reclaimedGb).toBe(6.0);
    expect(result.reclaimedGb).toBe(34.0);
    expect(result.freeDiskAfterGb).toBe(181.0);
    expect(result.offVolumeTargets.map((entry) => entry.path)).toEqual([
      'C:\\Android',
      'C:\\hostedtoolcache\\windows\\CodeQL',
    ]);
  });

  it('never reports an absent directory as removed', () => {
    const result = reclaimHostedRunnerDisk({
      dest: 'D:\\aurelia-chromium',
      targetFreeDiskGb: 165,
      env: HOSTED_ENV,
      platform: 'win32',
      targets: [
        { path: 'D:\\Android', category: 'absent' },
        { path: 'D:\\ghcup', category: 'absent' },
      ],
      exists: () => false,
      rm: () => {
        throw new Error('rm must not be called for an absent directory');
      },
      measureFreeDisk: () => 147.0,
      log: () => {},
    });

    expect(result.removedTargets).toEqual([]);
    expect(result.missingTargets).toEqual(['D:\\Android', 'D:\\ghcup']);
    expect(result.reclaimedGb).toBe(0);
  });

  it('records a failed removal instead of claiming success', () => {
    let freeDiskGb = 147.0;
    const result = reclaimHostedRunnerDisk({
      dest: 'D:\\aurelia-chromium',
      targetFreeDiskGb: 165,
      env: HOSTED_ENV,
      platform: 'win32',
      targets: [{ path: 'D:\\Android', category: 'locked' }],
      // Still present after `rm`: the removal did not actually happen.
      exists: () => true,
      rm: () => {},
      measureFreeDisk: () => freeDiskGb,
      log: () => {},
    });

    expect(result.removedTargets).toEqual([]);
    expect(result.failedTargets).toHaveLength(1);
    expect(result.failedTargets[0].path).toBe('D:\\Android');
    expect(result.reclaimedGb).toBe(0);
  });

  it('reports a measured decrease instead of clamping it to zero', () => {
    let freeDiskGb = 147.0;
    const result = reclaimHostedRunnerDisk({
      dest: 'D:\\aurelia-chromium',
      targetFreeDiskGb: 165,
      env: HOSTED_ENV,
      platform: 'win32',
      targets: [{ path: 'D:\\Android', category: 'sdk' }],
      exists: () => false,
      rm: () => {},
      // Another process consumed space while cleanup ran.
      measureFreeDisk: () => {
        freeDiskGb -= 2;
        return Math.round(freeDiskGb * 10) / 10;
      },
      log: () => {},
    });

    expect(result.reclaimedGb).toBeLessThan(0);
  });

  it('still rejects protected paths, including Visual Studio and Windows Kits ancestors', () => {
    const removed = [];
    const result = reclaimHostedRunnerDisk({
      dest: 'D:\\aurelia-chromium',
      targetFreeDiskGb: 165,
      env: HOSTED_ENV,
      platform: 'win32',
      targets: [
        { path: VS_2026_PATH, category: 'must be rejected' },
        { path: SDK_ROOT, category: 'must be rejected' },
        { path: 'C:\\Program Files\\Git', category: 'must be rejected' },
        { path: 'C:\\hostedtoolcache\\windows\\Python', category: 'rejected' },
        { path: 'C:\\Windows\\System32', category: 'must be rejected' },
      ],
      visualStudioPath: VS_2026_PATH,
      windowsSdkDir: SDK_ROOT,
      exists: () => true,
      rm: (targetPath) => removed.push(targetPath),
      measureFreeDisk: () => 147.0,
      log: () => {},
    });

    expect(removed).toEqual([]);
    expect(result.rejectedTargets).toHaveLength(5);
    expect(result.removedTargets).toEqual([]);
  });
});

describe('Windows SDK Authenticode verification (run 38103342538 blocker 1)', () => {
  it('prefers pwsh and falls back to Windows PowerShell 5.1', () => {
    expect(
      AUTHENTICODE_POWERSHELL_CANDIDATES.map((entry) => entry.file),
    ).toEqual(['pwsh', 'powershell']);
  });

  it('builds a script that explicitly imports the security module instead of relying on auto-loading', () => {
    const script = buildAuthenticodeVerificationScript({
      installerPath: 'D:\\a\\_temp\\winsdksetup.exe',
    });
    expect(script).toContain('Import-Module -Name $moduleName -Force');
    expect(script).toContain(`$moduleName = '${AUTHENTICODE_SECURITY_MODULE}'`);
    expect(script).toContain('Get-AuthenticodeSignature -LiteralPath $dest');
    expect(script).toContain('-ErrorAction Stop');
    // The module import failure must be captured, not swallowed.
    expect(script).toContain(
      '$report.moduleImportError = $_.Exception.ToString()',
    );
    // An unverified installer must be deleted and the host must fail.
    expect(script).toContain('Remove-Item -LiteralPath $dest -Force');
    expect(script).toContain('exit 3');
  });

  it('parses the last JSON report even when the host printed progress noise', () => {
    const stdout = [
      '',
      '  Dload  Upload   Total   Spent    Left  Speed',
      '{"ok":false,"stage":"import-module"}',
      '{"ok":true,"stage":"get-authenticodesignature"}',
    ].join('\n');
    expect(parseAuthenticodeReport(stdout)).toMatchObject({
      ok: true,
      stage: 'get-authenticodesignature',
    });
    expect(parseAuthenticodeReport('')).toBeNull();
    expect(parseAuthenticodeReport('no json here')).toBeNull();
  });

  it('verifies with the first host that reports a valid Microsoft signature', () => {
    const result = verifyAuthenticodeSignature({
      filePath: 'D:\\a\\_temp\\winsdksetup.exe',
      spawn: createAuthenticodeSpawn({
        pwsh: {
          status: 0,
          stdout: `${JSON.stringify(VERIFIED_REPORT)}\n`,
        },
      }),
    });

    expect(result.verified).toBe(true);
    expect(result.host).toBe('pwsh');
    expect(result.attempts).toHaveLength(1);
    expect(result.report.signerSubject).toContain('Microsoft Corporation');
  });

  it('falls back to Windows PowerShell 5.1 when pwsh is unavailable', () => {
    const result = verifyAuthenticodeSignature({
      filePath: 'D:\\a\\_temp\\winsdksetup.exe',
      spawn: createAuthenticodeSpawn({
        pwsh: new Error('spawn pwsh ENOENT'),
        powershell: {
          status: 0,
          stdout: `${JSON.stringify({ ...VERIFIED_REPORT, psVersion: '5.1.26100.0' })}\n`,
        },
      }),
    });

    expect(result.verified).toBe(true);
    expect(result.host).toBe('powershell');
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0].launched).toBe(false);
    expect(result.attempts[0].detail).toContain('ENOENT');
  });

  it('captures the module import error when Windows PowerShell 5.1 cannot load Microsoft.PowerShell.Security', () => {
    const result = verifyAuthenticodeSignature({
      filePath: 'D:\\a\\_temp\\winsdksetup.exe',
      spawn: createAuthenticodeSpawn({
        pwsh: new Error('spawn pwsh ENOENT'),
        powershell: {
          status: 3,
          stdout: `${JSON.stringify(MODULE_IMPORT_FAILURE_REPORT)}\n`,
          stderr: 'Get-AuthenticodeSignature : module could not be loaded',
        },
      }),
    });

    expect(result.verified).toBe(false);
    expect(result.report.stage).toBe('import-module');
    expect(result.report.moduleImported).toBe(false);
    expect(result.report.moduleImportError).toContain(
      'Microsoft.PowerShell.Security',
    );
    expect(result.report.psVersion).toBe('5.1.26100.0');
    expect(result.report.psModulePath.length).toBeGreaterThan(0);
  });

  it('rejects a valid-looking report whose signer is not Microsoft', () => {
    const result = verifyAuthenticodeSignature({
      filePath: 'D:\\a\\_temp\\winsdksetup.exe',
      spawn: createAuthenticodeSpawn({
        pwsh: {
          status: 4,
          stdout: `${JSON.stringify({
            ok: false,
            stage: 'get-authenticodesignature',
            moduleImported: true,
            signatureStatus: 'Valid',
            signerSubject: 'CN=Contoso Publishing, O=Contoso',
            error: 'Authenticode verification failed: signer is not Microsoft',
          })}\n`,
        },
        powershell: new Error('spawn powershell ENOENT'),
      }),
    });

    expect(result.verified).toBe(false);
    expect(result.attempts).toHaveLength(2);
  });

  it('downloads the installer and refuses to execute it when verification fails', () => {
    const removed = [];
    let executed = false;

    expect(() =>
      defaultDownloadAndVerifyInstaller({
        urls: WINDOWS_SDK_28000_INSTALLER_URLS,
        installerPath: 'D:\\a\\_temp\\winsdksetup.exe',
        spawn: createAuthenticodeSpawn({
          pwsh: new Error('spawn pwsh ENOENT'),
          powershell: {
            status: 3,
            stdout: `${JSON.stringify(MODULE_IMPORT_FAILURE_REPORT)}\n`,
          },
        }),
        rm: (targetPath) => removed.push(targetPath),
        log: () => {},
      }),
    ).toThrow(/Authenticode verification failed/);

    expect(removed).toEqual(['D:\\a\\_temp\\winsdksetup.exe']);
    expect(executed).toBe(false);
  });

  it('includes PowerShell diagnostics in the verification failure message', () => {
    try {
      defaultDownloadAndVerifyInstaller({
        urls: WINDOWS_SDK_28000_INSTALLER_URLS,
        installerPath: 'D:\\a\\_temp\\winsdksetup.exe',
        spawn: createAuthenticodeSpawn({
          pwsh: new Error('spawn pwsh ENOENT'),
          powershell: {
            status: 3,
            stdout: `${JSON.stringify(MODULE_IMPORT_FAILURE_REPORT)}\n`,
          },
        }),
        rm: () => {},
        log: () => {},
      });
      throw new Error('expected verification to fail');
    } catch (error) {
      expect(error.message).toContain(AUTHENTICODE_SECURITY_MODULE);
      expect(error.message).toContain('Microsoft.PowerShell.Security');
      expect(error.message).toContain('moduleImported=false');
      expect(error.message).toContain('will not be executed');
    }
  });

  it('returns a verified signature after a successful verification', () => {
    const result = defaultDownloadAndVerifyInstaller({
      urls: WINDOWS_SDK_28000_INSTALLER_URLS,
      installerPath: 'D:\\a\\_temp\\winsdksetup.exe',
      spawn: createAuthenticodeSpawn({
        pwsh: {
          status: 0,
          stdout: `${JSON.stringify(VERIFIED_REPORT)}\n`,
        },
      }),
      rm: () => {},
      log: () => {},
    });

    expect(result.signatureVerified).toBe(true);
    expect(result.url).toBe(WINDOWS_SDK_28000_INSTALLER_URLS[0]);
    expect(result.powershellHost).toBe('PowerShell 7 (pwsh)');
    expect(result.signerSubject).toContain('Microsoft Corporation');
  });

  it('fails the download when no Microsoft endpoint returns the installer', () => {
    expect(() =>
      downloadInstaller({
        urls: WINDOWS_SDK_28000_INSTALLER_URLS,
        installerPath: 'D:\\a\\_temp\\winsdksetup.exe',
        spawn: () => ({
          error: undefined,
          status: 22,
          stdout: '',
          stderr: 'HTTP 404',
        }),
      }),
    ).toThrow(/download failed/);
  });
});

describe('prepareHostedWindowsRunner reports accurate storage evidence', () => {
  /**
   * Reproduces run 38103342538: destination on D: (147.0 GB), allowlisted
   * cleanup targets on C:, Windows SDK 10.0.26100.0 only, and an Authenticode
   * verification failure on every PowerShell host.
   */
  function createRun38103342538State() {
    const files = new Set([
      'C:\\',
      'D:\\',
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
      `${SDK_ROOT}\\Include\\10.0.26100.0\\ucrt`,
      `${SDK_ROOT}\\Include\\10.0.26100.0\\shared`,
      `${SDK_ROOT}\\Include\\10.0.26100.0\\um\\windows.h`,
      `${SDK_ROOT}\\Include\\10.0.26100.0\\ucrt\\corecrt.h`,
      `${SDK_ROOT}\\Include\\10.0.26100.0\\shared\\sdkddkver.h`,
      `${SDK_ROOT}\\Lib\\10.0.26100.0\\um\\x64\\kernel32.lib`,
      `${SDK_ROOT}\\Lib\\10.0.26100.0\\ucrt\\x64\\ucrt.lib`,
      `${SDK_ROOT}\\Lib\\10.0.26100.0\\um\\x86\\kernel32.lib`,
      `${SDK_ROOT}\\Lib\\10.0.26100.0\\ucrt\\x86\\ucrt.lib`,
      `${SDK_ROOT}\\Debuggers\\x64\\dbghelp.dll`,
      // Allowlisted non-Chromium directories, all on C: in this run.
      'C:\\Android',
      'C:\\hostedtoolcache\\windows\\CodeQL',
      'C:\\ghcup',
    ]);
    const freeByVolume = new Map([
      ['C:\\', 180.0],
      ['D:\\', 147.0],
    ]);
    const sizesGb = new Map([
      ['C:\\Android', 28.0],
      ['C:\\hostedtoolcache\\windows\\CodeQL', 6.5],
      ['C:\\ghcup', 6.0],
    ]);

    return {
      exists: (candidate) =>
        typeof candidate === 'string' && files.has(candidate),
      readdirSync: (dir) => {
        const normalized = String(dir).replaceAll('/', '\\');
        if (normalized.endsWith('VC\\Tools\\MSVC')) {
          return ['14.51.36231'];
        }
        if (normalized.endsWith('Windows Kits\\10\\Include')) {
          return ['10.0.26100.0'];
        }
        return [];
      },
      readText: (filePath) =>
        String(filePath).includes('10.0.28000.0\\shared\\sdkddkver.h')
          ? '#define NTDDI_WIN11_BR 0x0A000011\n'
          : '#define NTDDI_WIN11_GE 0x0A000010\n',
      // A deletion frees space only on its own volume.
      rm: (targetPath) => {
        files.delete(targetPath);
        const volume = volumeRootOf(targetPath);
        if (freeByVolume.has(volume) && sizesGb.has(targetPath)) {
          freeByVolume.set(
            volume,
            Math.round(
              (freeByVolume.get(volume) + sizesGb.get(targetPath)) * 10,
            ) / 10,
          );
        }
      },
      mkdir: () => undefined,
      measureFreeDisk: (candidate) =>
        freeByVolume.get(volumeRootOf(candidate)) ?? null,
      spawn: (file) => {
        if (String(file).includes('vswhere.exe')) {
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
      },
      freeByVolume,
    };
  }

  it('reclaims 0.0 GB on the destination volume and records every off-volume target', () => {
    const state = createRun38103342538State();
    const result = prepareHostedWindowsRunner({
      dest: 'D:\\a\\_temp\\aurelia-chromium',
      minimumFreeDiskGb: MINIMUM_PRE_SYNC_FREE_DISK_GB,
      env: HOSTED_ENV,
      platform: 'win32',
      exists: state.exists,
      readdirSync: state.readdirSync,
      readText: state.readText,
      mkdir: state.mkdir,
      rm: state.rm,
      measureFreeDisk: state.measureFreeDisk,
      spawn: state.spawn,
      downloadAndVerify: () => {
        throw new Error(
          `${AUTHENTICODE_SECURITY_MODULE} diagnostics: Windows PowerShell 5.1 (powershell.exe) launched=true exit=3 stage=import-module moduleImported=false`,
        );
      },
      runInstaller: () => ({ exitCode: 0, stdout: '', stderr: '' }),
      log: () => {},
    });

    expect(result.cleanup.destinationVolume).toBe('D:\\');
    expect(result.cleanup.removedTargets).toEqual([]);
    expect(result.cleanup.reclaimedGb).toBe(0);
    expect(result.cleanup.freeDiskBeforeGb).toBe(147.0);
    expect(result.cleanup.freeDiskAfterGb).toBe(147.0);
    expect(result.cleanup.offVolumeTargets.length).toBeGreaterThan(0);
    for (const entry of result.cleanup.offVolumeTargets) {
      expect(entry.volume).toBe('C:\\');
    }

    // Storage topology evidence for the owner.
    expect(result.volumes.destinationVolume).toBe('D:\\');
    expect(result.volumes.destinationFreeDiskGb).toBe(147.0);
    expect(result.volumes.destinationMeetsMinimum).toBe(false);
    expect(result.volumes.volumes.map((entry) => entry.volume)).toEqual([
      'C:\\',
      'D:\\',
    ]);
    expect(
      result.volumes.volumes.find((entry) => entry.volume === 'D:\\')
        .isDestinationVolume,
    ).toBe(true);
    expect(
      result.volumes.alternativeVolumes.map((entry) => entry.volume),
    ).toEqual(['C:\\']);

    // Blocked, with accurate evidence rather than a fabricated reclamation.
    expect(result.ok).toBe(false);
    const joined = result.problems.join('\n');
    expect(joined).toMatch(
      /reclaimed 0\.0 GB on the Chromium destination volume D:\\/,
    );
    expect(joined).toMatch(/147\.0 GB/);
    expect(joined).toMatch(/10\.0\.28000\.0/);
  });

  it('never lowers the 150 GB floor or the 10.0.28000.0 SDK requirement', () => {
    const state = createRun38103342538State();
    const result = prepareHostedWindowsRunner({
      dest: 'D:\\a\\_temp\\aurelia-chromium',
      minimumFreeDiskGb: MINIMUM_PRE_SYNC_FREE_DISK_GB,
      env: HOSTED_ENV,
      platform: 'win32',
      exists: state.exists,
      readdirSync: state.readdirSync,
      readText: state.readText,
      mkdir: state.mkdir,
      rm: state.rm,
      measureFreeDisk: state.measureFreeDisk,
      spawn: state.spawn,
      downloadAndVerify: () => {
        throw new Error('verification failed');
      },
      runInstaller: () => ({ exitCode: 0, stdout: '', stderr: '' }),
      log: () => {},
    });

    expect(result.volumes.minimumFreeDiskGb).toBe(150);
    expect(result.after.windowsSdk).toBe('10.0.26100.0');
    expect(result.after.windowsSdkCompatible).toBe(false);
    expect(result.ok).toBe(false);
  });
});
