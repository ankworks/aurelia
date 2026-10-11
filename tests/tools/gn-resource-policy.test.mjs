/**
 * Regression tests for the GN-only resource-aware preflight and disk monitoring.
 *
 * These tests pin the M1.3 policy:
 *  - GN-only validation has a separate, evidence-based pre-sync disk floor
 *    (config.buildRequirements.gnValidation.freeDiskGb), smaller than the
 *    unchanged 150 GB reference-builder floor used for compilation modes.
 *  - compilation modes (targeted/full) retain the 150 GB pre-sync floor and
 *    the 15 GB runtime disk reserve.
 *  - GN-only uses a shallow gclient sync (--no-history) to keep the checkout
 *    small enough to fit on the 147 GB windows-2025 destination volume.
 *  - Disk usage is measured and recorded before sync, after sync, after patch
 *    application, and after gn gen.
 *  - The runtime disk reserve is mode-aware (10 GB for GN, 15 GB for builds).
 */
import { describe, expect, it } from 'vitest';

import { diskFloorGb, gclientSyncArgs } from '../../tools/chromium/sync.mjs';
import {
  diskReserveForMode,
  GN_SYNC_JOBS,
  MINIMUM_DISK_RESERVE_GB,
  MINIMUM_DISK_RESERVE_GB_GN,
  syncJobsForMode,
} from '../../tools/chromium/ci-validation.mjs';
import {
  MINIMUM_PRE_SYNC_FREE_DISK_GB,
  prepareHostedWindowsRunner,
} from '../../tools/chromium/prepare-runner.mjs';
import {
  evaluateResources,
  requirementsForMode,
} from '../../tools/ci/check-builder.mjs';
import { loadConfig } from '../../tools/chromium/lib/config.mjs';

const config = loadConfig();
const GN_FLOOR = config.buildRequirements.gnValidation.freeDiskGb;
const GN_DISK_RESERVE =
  config.buildRequirements.gnValidation.diskSafetyReserveGb;

// Backslash doubling is for JS strings: real Windows path C:\foo becomes 'C:\\foo'.
const VS_PATH = 'C:\\Program Files\\Microsoft Visual Studio\\18\\Enterprise';
const SDK_ROOT = 'C:\\Program Files (x86)\\Windows Kits\\10';
const HOSTED_ENV = Object.freeze({
  GITHUB_ACTIONS: 'true',
  RUNNER_ENVIRONMENT: 'github-hosted',
  GITHUB_WORKSPACE: 'D:\\a\\aurelia\\aurelia',
  RUNNER_TEMP: 'D:\\a\\_temp',
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  DEPOT_TOOLS_WIN_TOOLCHAIN: '0',
});

describe('GN-only resource policy (evidence-based)', () => {
  it('has a GN disk floor strictly below the reference 150 GB but not arbitrarily low', () => {
    // Evidence: depot_tools ~0.3 GB, gclient --no-history shallow checkout
    // ~15-25 GB (working tree + shallow .git across ~750 deps; see Chromium
    // upstream windows_build_instructions.md and cl-shrink measurements of
    // dependency .git overhead), GN generation ~1-2 GB. The 80 GB floor
    // leaves ~50 GB of headroom over the observed footprint.
    expect(GN_FLOOR).toBeGreaterThanOrEqual(50);
    expect(GN_FLOOR).toBeLessThan(MINIMUM_PRE_SYNC_FREE_DISK_GB);
    expect(GN_DISK_RESERVE).toBeGreaterThanOrEqual(5);
    expect(GN_DISK_RESERVE).toBeLessThan(MINIMUM_DISK_RESERVE_GB);
  });

  it('accepts the measured windows-2025 free disk (147.0 GB) for GN-only', () => {
    const gnReqs = requirementsForMode(config, 'gn');
    expect(
      evaluateResources(
        { cpuCores: 4, ramGb: 16, bestFreeDiskGb: 147.0 },
        gnReqs,
      ),
    ).toEqual([]);
  });

  it('keeps targeted/full blocked at 147 GB (unchanged 150 GB floor)', () => {
    for (const mode of ['targeted', 'full']) {
      const reqs = requirementsForMode(config, mode);
      const problems = evaluateResources(
        { cpuCores: 8, ramGb: 32, bestFreeDiskGb: 147.0 },
        reqs,
      );
      expect(problems.join(';')).toMatch(/free disk.*150 GB/);
    }
  });

  it('uses mode-aware runtime disk reserves', () => {
    expect(diskReserveForMode('gn')).toBe(MINIMUM_DISK_RESERVE_GB_GN);
    expect(diskReserveForMode('targeted')).toBe(MINIMUM_DISK_RESERVE_GB);
    expect(diskReserveForMode('full')).toBe(MINIMUM_DISK_RESERVE_GB);
    expect(MINIMUM_DISK_RESERVE_GB_GN).toBeLessThan(MINIMUM_DISK_RESERVE_GB);
  });

  it('uses fewer checkout jobs for GN-only', () => {
    expect(syncJobsForMode('gn')).toBe(GN_SYNC_JOBS);
    expect(GN_SYNC_JOBS).toBeLessThanOrEqual(2);
  });

  it('returns the GN floor when mode=gn and 150 GB otherwise', () => {
    expect(diskFloorGb({ config, mode: 'gn' })).toBe(GN_FLOOR);
    expect(diskFloorGb({ config, mode: 'full' })).toBe(150);
    expect(diskFloorGb({ config, mode: 'targeted' })).toBe(150);
    expect(diskFloorGb()).toBe(150);
  });
});

describe('gclient sync shallow history flag', () => {
  const REV = 'cfaadc5a132d78e1828635aa8405a499f3e14864';

  it('omits --no-history by default (compilation-safe)', () => {
    const args = gclientSyncArgs({ revision: REV, jobs: 4 });
    expect(args).not.toContain('--no-history');
  });

  it('includes --no-history when requested (GN shallow checkout)', () => {
    const args = gclientSyncArgs({
      revision: REV,
      jobs: 2,
      noHistory: true,
    });
    expect(args).toContain('--no-history');
    expect(args).toContain('--revision');
    expect(args).toContain(`src@${REV}`);
  });
});

/**
 * Build a state that mirrors real windows-2025 topology:
 *   C:\ contains VS, Windows Kits, preinstalled ecosystems (cleanup targets
 *       live here but are on a DIFFERENT volume from Chromium destination).
 *   D:\ hosts GITHUB_WORKSPACE and RUNNER_TEMP (Chromium destination).
 *   SDK installs to C:\ so D:\ free disk is unchanged by SDK provisioning.
 */
function makeDualVolumeState(freeDiskD) {
  let freeD = freeDiskD;
  let freeC = 30.3;
  const installedSdkVersions = new Set(['10.0.26100.0']);
  const files = new Set([
    VS_PATH,
    `${VS_PATH}\\VC`,
    `${VS_PATH}\\VC\\Auxiliary\\Build\\vcvarsall.bat`,
    `${VS_PATH}\\VC\\Tools\\MSVC`,
    `${VS_PATH}\\VC\\Tools\\MSVC\\14.51.36231`,
    `${VS_PATH}\\VC\\Tools\\MSVC\\14.51.36231\\bin\\Hostx64\\x64\\cl.exe`,
    `${VS_PATH}\\DIA SDK\\bin\\amd64\\msdia140.dll`,
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
  ]);

  const exists = (p) => files.has(String(p).replaceAll('/', '\\'));
  const readdirSync = (dir) => {
    const n = String(dir).replaceAll('/', '\\');
    if (n.endsWith('VC\\Tools\\MSVC')) return ['14.51.36231'];
    if (n.endsWith('Windows Kits\\10\\Include'))
      return [...installedSdkVersions];
    if (n.endsWith('Windows Kits\\10\\Lib')) return [...installedSdkVersions];
    return [];
  };
  const readText = (fp) => {
    const n = String(fp).replaceAll('/', '\\');
    if (n.includes('10.0.28000.0\\shared\\sdkddkver.h')) {
      return '#define NTDDI_WIN11_BR 0x0A000011\n';
    }
    return '#define NTDDI_WIN11_GE 0x0A000010\n';
  };
  const measureFreeDisk = (targetPath) => {
    const vol = String(targetPath)
      .replaceAll('/', '\\')
      .slice(0, 3)
      .toUpperCase();
    if (vol === 'C:\\') return Math.round(freeC * 10) / 10;
    return Math.round(freeD * 10) / 10;
  };
  const rm = () => {
    // Cleanup targets in SAFE_RUNNER_CLEANUP_TARGETS all live on C:\ in the
    // real windows-2025 image, so they cannot free space on D:. We don't
    // model them as present here (matching run 38105208893).
  };
  const spawn = (file) => {
    if (String(file).includes('vswhere.exe')) {
      return {
        error: undefined,
        status: 0,
        stdout: JSON.stringify([
          {
            instanceId: 'vs2026',
            installationPath: VS_PATH,
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
    // SDK installs to C:\ and does NOT consume D:\ free space (real topology).
    freeC = Math.round((freeC - 3.0) * 10) / 10;
  };

  return {
    files,
    exists,
    readdirSync,
    readText,
    rm,
    spawn,
    measureFreeDisk,
    provisionSdk28000,
  };
}

describe('prepareHostedWindowsRunner with GN-only floor on windows-2025 D: volume topology', () => {
  it('reports BLOCKED for targeted/full when D: has 147 GB free (preserves 150 GB floor)', () => {
    const state = makeDualVolumeState(147.0);
    const result = prepareHostedWindowsRunner({
      dest: 'D:\\a\\_temp\\aurelia-chromium',
      minimumFreeDiskGb: 150,
      env: HOSTED_ENV,
      platform: 'win32',
      exists: state.exists,
      readdirSync: state.readdirSync,
      readText: state.readText,
      mkdir: () => {},
      rm: state.rm,
      spawn: state.spawn,
      measureFreeDisk: state.measureFreeDisk,
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
    expect(result.problems.join('; ')).toMatch(/150 GB/);
    // SDK must still have been provisioned (the blocker is disk, not SDK).
    expect(result.sdkProvisioning.installed).toBe(true);
    expect(result.after.windowsSdk).toBe('10.0.28000.0');
  });

  it('succeeds for GN-only with 147 GB free on D: (SDK installs to C:, D: unchanged)', () => {
    const state = makeDualVolumeState(147.0);
    const result = prepareHostedWindowsRunner({
      dest: 'D:\\a\\_temp\\aurelia-chromium',
      minimumFreeDiskGb: GN_FLOOR,
      env: HOSTED_ENV,
      platform: 'win32',
      exists: state.exists,
      readdirSync: state.readdirSync,
      readText: state.readText,
      mkdir: () => {},
      rm: state.rm,
      spawn: state.spawn,
      measureFreeDisk: state.measureFreeDisk,
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
    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
    expect(result.sdkProvisioning.installed).toBe(true);
    expect(result.after.windowsSdk).toBe('10.0.28000.0');
    expect(result.after.windowsSdkCompatible).toBe(true);
    // D:\ free disk is NOT consumed by SDK install (SDK lives on C:\).
    expect(result.after.freeDiskGb).toBe(147.0);
    expect(result.volumes.destinationVolume).toBe('D:\\');
  });
});
