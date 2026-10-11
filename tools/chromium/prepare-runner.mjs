#!/usr/bin/env node
/**
 * GitHub-hosted Windows runner preparation for Chromium preflight.
 *
 * ## Context
 *
 * Failed workflow run `38101262458` (`gn / standard` on `windows-2025`) blocked
 * in `runner-preflight` before any Chromium source synchronization for two
 * verified reasons:
 *
 *  1. **Windows SDK mismatch (`10.0.26100.0` installed vs `10.0.28000.0` required)**:
 *     Chromium `155.0.8059.40` at pinned SHA `cfaadc5a132d78e1828635aa8405a499f3e14864`
 *     requires Windows 11 SDK `10.0.28000.0` (`10.0.28000.2270` preferred servicing
 *     release) for both `gn gen` and compilation:
 *      - `build/toolchain/win/win_toolchain_data.gni` unconditionally invokes
 *        `build/toolchain/win/setup_toolchain.py` for `x86` and `x64` during `gn gen`.
 *      - `setup_toolchain.py` hardcodes `SDK_VERSION = '10.0.28000.0'` and invokes
 *        `vcvarsall.bat <arch> 10.0.28000.0` when `DEPOT_TOOLS_WIN_TOOLCHAIN=0`.
 *      - `build/toolchain/win/BUILD.gn` invokes `vs_toolchain.py copy_dlls` during
 *        `gn gen`, requiring `Debuggers\x64\dbghelp.dll`.
 *      - `build/config/win/BUILD.gn` defines `NTDDI_VERSION=NTDDI_WIN11_BR` and
 *        `base/win/windows_version.cc` enforces `#if !defined(NTDDI_WIN11_BR)`.
 *     GitHub's `windows-2025` image (`windows-2025-vs2026`) preinstalls Visual
 *     Studio 2026 (`18.10.12217.157`) and MSVC `14.51.36231`, but only Windows
 *     SDK `10.0.26100.0`.
 *
 *  2. **Free disk drop (`219.9 GB` in run `38046646098` -> `147.0 GB` in run `38101262458`)**:
 *     During the `actions/runner-images` Visual Studio 2026 rollout (`#14004`,
 *     PR `#14851`), `windows-2025` moved to a single `C:` volume with ~109 GB
 *     of preinstalled ecosystems (Android SDK/NDK 27-30, CodeQL, GHC/Haskell,
 *     Boost, Go, Ruby, Miniconda, Julia, R, PostgreSQL, MySQL, MongoDB), leaving
 *     `147.0 GB` free (~3 GB below Aurelia's `150 GB` pre-sync safety floor).
 *
 * ## Run `38103342538` follow-up (two further real blockers)
 *
 * After the runner-preflight fixes above were merged, run `38103342538`
 * (`gn / standard`, image `windows-2025-vs2026`) still blocked, and exposed two
 * further defects that this module now fixes:
 *
 *  3. **Authenticode verification never completed**: `winsdksetup.exe` was
 *     downloaded successfully (1,417,000 bytes), but the verification host
 *     `powershell.exe` aborted with
 *     `CouldNotAutoloadMatchingModule - the module Microsoft.PowerShell.Security
 *     could not be loaded`. Verification now runs on `pwsh` (PowerShell 7)
 *     first with Windows PowerShell 5.1 as a documented fallback, explicitly
 *     `Import-Module Microsoft.PowerShell.Security` on every host, captures the
 *     module-import error (PowerShell version, `PSModulePath`), requires a valid
 *     `Microsoft Corporation` signature, and deletes the installer instead of
 *     executing it when no host can verify it.
 *
 *  4. **Disk cleanup reclaimed `0.0 GB` while reporting 20 removals**: the
 *     Chromium destination is `D:\a\_temp\aurelia-chromium` (`147.0 GB` before
 *     and after cleanup) while every allowlisted target lives on `C:\`.
 *     GitHub-hosted Windows runners expose `C:` (operating system and
 *     preinstalled toolchains) and `D:` (workspace and `RUNNER_TEMP`) as
 *     **separate volumes**, so `C:` deletions cannot free space on `D:`.
 *     Cleanup is now volume-aware: it only deletes targets on the destination
 *     volume, records off-volume targets separately, measures the reclaimed
 *     delta from two live measurements (never estimated, never clamped),
 *     distinguishes absent / removed / failed / rejected / off-volume, and
 *     reports every volume on the runner so an alternative destination volume
 *     can be evaluated against the unchanged `150 GB` floor.
 *
 * This module prepares a GitHub-hosted Windows runner before `runner-preflight`
 * finalizes its verdict:
 *  - Reclaims disk space ONLY from an explicit allowlist of non-Chromium runner
 *    directories while strictly protecting Visual Studio, MSVC, Windows Kits/SDK,
 *    Git, Python, Node.js, Rust, Windows system directories, and the workspace.
 *  - Provisions Windows SDK `10.0.28000.0` non-interactively from Microsoft's
 *    official standalone installer (`winsdksetup.exe`), verifying Microsoft's
 *    Authenticode digital signature before execution, cleaning up installer
 *    temp files, and verifying all required headers (`NTDDI_WIN11_BR`), x64/x86
 *    libraries, and `Debuggers\x64\dbghelp.dll`.
 *  - Never runs on local or self-hosted machines, and never weakens the 150 GB
 *    disk floor or `10.0.28000.0` SDK requirement.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync as fsReaddirSync,
  readFileSync as fsReadFileSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { freeDiskGb } from '../ci/check-builder.mjs';
import { isGithubHostedRunner } from '../ci/runner-environment.mjs';
import { isMainModule } from '../lib/entry.mjs';
import {
  detectVisualStudio,
  detectWindowsSdk,
  detectWindowsToolchain,
  REQUIRED_SDK_VERSION,
  verifyWindowsSdkInstallation,
} from './lib/windows-toolchain.mjs';

/** Minimum free disk (GB) required on the Chromium destination volume before sync. */
export const MINIMUM_PRE_SYNC_FREE_DISK_GB = 150;

/**
 * Target free disk (GB) during pre-SDK cleanup so that after installing Windows
 * SDK 10.0.28000.0 (~2.5-3.5 GB) at least 150 GB remains available before sync.
 */
export const TARGET_CLEANUP_FREE_DISK_GB = 165;

/**
 * Recorded root-cause evidence for why `windows-2025` free disk changed between
 * run `38046646098` (219.9 GB) and run `38101262458` (147.0 GB).
 */
export const RUNNER_DISK_REGRESSION_ANALYSIS = Object.freeze({
  earlierRunId: '38046646098',
  earlierFreeDiskGb: 219.9,
  failedRunId: '38101262458',
  failedFreeDiskGb: 147.0,
  requiredFreeDiskGb: MINIMUM_PRE_SYNC_FREE_DISK_GB,
  shortfallGb: 3.0,
  rootCause:
    'actions/runner-images transitioned windows-2025 to the windows-2025-vs2026 image (issue #14004, PR #14851) with Visual Studio 2026 Enterprise (18.10.12217.157), side-by-side MSVC toolsets, and ~109 GB of preinstalled mobile/database/language ecosystems on C:, reducing available disk from 219.9 GB to 147.0 GB.',
});

/**
 * Directories on a Windows runner that MUST NEVER be deleted or modified during
 * disk cleanup because Chromium synchronization, GN generation, or compilation
 * depends on them.
 */
export const PROTECTED_WINDOWS_PATHS = Object.freeze([
  'C:\\Program Files\\Microsoft Visual Studio',
  'C:\\Program Files (x86)\\Microsoft Visual Studio',
  'C:\\ProgramData\\Microsoft\\VisualStudio',
  'C:\\Program Files (x86)\\Windows Kits',
  'C:\\Program Files\\Windows Kits',
  'C:\\Program Files\\Git',
  'C:\\Program Files (x86)\\Git',
  'C:\\Program Files\\nodejs',
  'C:\\hostedtoolcache\\windows\\node',
  'C:\\hostedtoolcache\\windows\\Python',
  'C:\\Users\\runneradmin\\.cargo',
  'C:\\Users\\runneradmin\\.rustup',
  'C:\\Windows\\System32',
  'C:\\Windows\\SysWOW64',
  'C:\\Windows\\WinSxS',
]);

/**
 * Reviewed allowlist of non-Chromium preinstalled directories on GitHub-hosted
 * `windows-2025` runners that can be safely removed to reclaim disk space.
 */
export const SAFE_RUNNER_CLEANUP_TARGETS = Object.freeze([
  {
    path: 'C:\\Android',
    category: 'Android SDK / NDK / emulator',
    estimatedGb: 28,
  },
  {
    path: 'C:\\Program Files (x86)\\Android',
    category: 'Android legacy tools',
    estimatedGb: 1.5,
  },
  {
    path: 'C:\\Program Files\\Android',
    category: 'Android tools',
    estimatedGb: 1.0,
  },
  {
    path: 'C:\\hostedtoolcache\\windows\\CodeQL',
    category: 'CodeQL analysis bundle',
    estimatedGb: 6.5,
  },
  {
    path: 'C:\\hostedtoolcache\\windows\\Boost',
    category: 'Boost C++ prebuilt cache',
    estimatedGb: 4.5,
  },
  {
    path: 'C:\\hostedtoolcache\\windows\\Go',
    category: 'Go toolcache',
    estimatedGb: 3.5,
  },
  {
    path: 'C:\\hostedtoolcache\\windows\\Ruby',
    category: 'Ruby toolcache',
    estimatedGb: 2.5,
  },
  {
    path: 'C:\\hostedtoolcache\\windows\\PyPy',
    category: 'PyPy toolcache',
    estimatedGb: 1.0,
  },
  {
    path: 'C:\\ghcup',
    category: 'Haskell GHCup toolchain',
    estimatedGb: 6.0,
  },
  {
    path: 'C:\\Program Files\\Haskell',
    category: 'Haskell platform',
    estimatedGb: 1.0,
  },
  {
    path: 'C:\\Miniconda',
    category: 'Miniconda distribution',
    estimatedGb: 3.0,
  },
  {
    path: 'C:\\Miniconda3',
    category: 'Miniconda3 distribution',
    estimatedGb: 3.0,
  },
  {
    path: 'C:\\Julia',
    category: 'Julia runtime',
    estimatedGb: 1.5,
  },
  {
    path: 'C:\\Program Files\\R',
    category: 'R language distribution',
    estimatedGb: 1.2,
  },
  {
    path: 'C:\\Program Files\\PostgreSQL',
    category: 'PostgreSQL database server',
    estimatedGb: 1.0,
  },
  {
    path: 'C:\\PostgreSQL',
    category: 'PostgreSQL data/tools',
    estimatedGb: 0.5,
  },
  {
    path: 'C:\\Program Files\\MySQL',
    category: 'MySQL server',
    estimatedGb: 1.0,
  },
  {
    path: 'C:\\tools\\mysql',
    category: 'MySQL tools',
    estimatedGb: 0.5,
  },
  {
    path: 'C:\\Program Files\\MongoDB',
    category: 'MongoDB server',
    estimatedGb: 1.0,
  },
  {
    path: 'C:\\SeleniumWebDrivers',
    category: 'Selenium WebDrivers',
    estimatedGb: 0.8,
  },
  {
    path: 'C:\\selenium',
    category: 'Selenium binaries',
    estimatedGb: 0.5,
  },
  {
    path: 'C:\\tools\\Apache24',
    category: 'Apache httpd',
    estimatedGb: 0.3,
  },
  {
    path: 'C:\\tools\\nginx',
    category: 'nginx server',
    estimatedGb: 0.2,
  },
  {
    path: 'C:\\tools\\php',
    category: 'PHP runtime',
    estimatedGb: 0.4,
  },
  {
    path: 'C:\\tools\\kotlinc',
    category: 'Kotlin compiler',
    estimatedGb: 0.3,
  },
  {
    path: 'C:\\ProgramData\\chocolatey\\cache',
    category: 'Chocolatey download cache',
    estimatedGb: 0.5,
  },
]);

/**
 * Official Microsoft standalone installer URLs for Windows 11 SDK 10.0.28000.0.
 * Every downloaded binary is verified for a valid Microsoft Corporation
 * Authenticode digital signature before execution.
 */
export const WINDOWS_SDK_28000_INSTALLER_URLS = Object.freeze([
  'https://download.microsoft.com/download/38ab8f6d-3676-4860-ae84-3361308b9d7f/KIT_BUNDLE_WINDOWSSDK_MEDIACREATION/winsdksetup.exe',
  'https://go.microsoft.com/fwlink/?linkid=2370315',
  'https://go.microsoft.com/fwlink/?linkid=2372508',
  'https://go.microsoft.com/fwlink/?linkid=2382519',
]);

/**
 * Windows SDK installer features required by Chromium's `setup_toolchain.py`
 * (both x64 and x86 `um`/`ucrt` libraries and headers) and `vs_toolchain.py
 * copy_dlls` (`Debuggers\x64\dbghelp.dll`).
 */
export const WINDOWS_SDK_28000_FEATURES = Object.freeze([
  'OptionId.DesktopCPPx64',
  'OptionId.DesktopCPPx86',
  'OptionId.UWPCPP',
  'OptionId.WindowsDesktopDebuggers',
]);

/**
 * Normalize a Windows filesystem path for case-insensitive comparison.
 *
 * @param {string} rawPath
 * @returns {string}
 */
export function normalizeWindowsPath(rawPath) {
  if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
    return '';
  }
  const normalized = path.win32
    .normalize(rawPath.trim().replaceAll('/', '\\'))
    .replace(/\\+$/, '');
  return normalized.toLowerCase();
}

/**
 * Resolve the filesystem volume that contains `targetPath`.
 *
 * On Windows the volume is the drive-letter root (`D:\` for
 * `D:\a\_temp\aurelia-chromium`); on POSIX it is `/`.
 *
 * Volume identity is the root cause of the zero-byte reclaim observed in run
 * `38103342538`: GitHub-hosted Windows runners expose `C:` (operating system
 * and preinstalled toolchains) and `D:` (workspace and `RUNNER_TEMP`) as
 * **separate volumes**, so deleting allowlisted directories under `C:\` cannot
 * increase free space on the `D:\` volume that hosts the Chromium destination.
 *
 * @param {string} targetPath
 * @param {object} [options]
 * @param {string} [options.platform] Node platform identifier.
 * @returns {string|null} Uppercase Windows root (`C:\`), `/` on POSIX, or null.
 */
export function volumeRootOf(targetPath, { platform = process.platform } = {}) {
  if (typeof targetPath !== 'string' || targetPath.trim().length === 0) {
    return null;
  }
  const raw = targetPath.trim();
  // Decide on the shape of the path, not only on the host platform: runner
  // preparation only ever handles Windows paths, and the helpers must stay
  // unit-testable on POSIX developers machines.
  const hasWindowsDrive = /^[a-zA-Z]:([\\/]|$)/.test(raw);
  if (hasWindowsDrive || raw.startsWith('\\\\') || platform === 'win32') {
    const normalized = path.win32.normalize(raw.replaceAll('/', '\\'));
    const drive = /^([a-zA-Z]:)/.exec(normalized);
    if (drive !== null) {
      return `${drive[1].toUpperCase()}\\`;
    }
    const root = path.win32.parse(normalized).root;
    return root.length > 0 ? root.toUpperCase() : null;
  }
  return path.posix.parse(path.posix.resolve(raw)).root || '/';
}

/**
 * True when both paths are located on the same filesystem volume.
 *
 * @param {string} leftPath
 * @param {string} rightPath
 * @param {object} [options]
 * @param {string} [options.platform]
 * @returns {boolean}
 */
export function isSameVolume(
  leftPath,
  rightPath,
  { platform = process.platform } = {},
) {
  const left = volumeRootOf(leftPath, { platform });
  const right = volumeRootOf(rightPath, { platform });
  if (left === null || right === null) {
    return false;
  }
  return left.toLowerCase() === right.toLowerCase();
}

/** Drive letters probed when measuring every volume on a Windows runner. */
export const WINDOWS_PROBE_DRIVE_LETTERS = Object.freeze(
  'CDEFGHIJKLMNOPQRSTUVWXYZ'.split(''),
);

/**
 * Measure free disk on every existing drive-letter volume of a Windows runner.
 *
 * @param {object} [options]
 * @param {string} [options.platform]
 * @param {string[]} [options.driveLetters]
 * @param {Function} [options.exists]
 * @param {Function} [options.measureFreeDisk]
 * @returns {Array<{volume: string, freeDiskGb: number|null}>}
 */
export function measureWindowsVolumes({
  platform = process.platform,
  driveLetters = WINDOWS_PROBE_DRIVE_LETTERS,
  exists = existsSync,
  measureFreeDisk = (targetPath) => measureVolumeFreeDiskGb(targetPath),
} = {}) {
  if (platform !== 'win32') {
    return [];
  }
  const volumes = [];
  for (const letter of driveLetters) {
    const root = `${letter}:\\`;
    let present = false;
    try {
      present = Boolean(exists(root));
    } catch {
      present = false;
    }
    if (!present) {
      continue;
    }
    volumes.push({ volume: root, freeDiskGb: measureFreeDisk(root) });
  }
  return volumes;
}

/**
 * Evaluate the volume hosting the Chromium destination against every other
 * volume present on the runner.
 *
 * The result never estimates or fabricates reclaimed space: every number is a
 * live measurement of `measureFreeDisk`, and `alternativeVolumes` is empty when
 * no other volume satisfies `minimumFreeDiskGb`.
 *
 * @param {object} options
 * @param {string} options.dest
 * @param {number} [options.minimumFreeDiskGb]
 * @param {string} [options.platform]
 * @param {Function} [options.exists]
 * @param {Function} [options.measureFreeDisk]
 * @returns {{destinationVolume: string|null, destinationFreeDiskGb: number|null,
 *   minimumFreeDiskGb: number, destinationMeetsMinimum: boolean,
 *   volumes: Array<object>, alternativeVolumes: Array<object>,
 *   recommendedVolume: string|null}}
 */
export function evaluateDestinationVolumes({
  dest,
  minimumFreeDiskGb = MINIMUM_PRE_SYNC_FREE_DISK_GB,
  platform = process.platform,
  exists = existsSync,
  measureFreeDisk = (targetPath) => measureVolumeFreeDiskGb(targetPath),
} = {}) {
  const destinationVolume = volumeRootOf(dest, { platform });
  const measured = measureWindowsVolumes({
    platform,
    exists,
    measureFreeDisk,
  });
  const rows = measured.map((entry) => ({
    volume: entry.volume,
    freeDiskGb: entry.freeDiskGb,
    meetsMinimum:
      typeof entry.freeDiskGb === 'number' &&
      Number.isFinite(entry.freeDiskGb) &&
      entry.freeDiskGb >= minimumFreeDiskGb,
    isDestinationVolume:
      destinationVolume !== null &&
      entry.volume.toLowerCase() === destinationVolume.toLowerCase(),
  }));

  const destinationRow = rows.find((row) => row.isDestinationVolume) ?? null;
  const destinationFreeDiskGb =
    destinationRow?.freeDiskGb ?? measureFreeDisk(dest);
  const destinationMeetsMinimum =
    typeof destinationFreeDiskGb === 'number' &&
    Number.isFinite(destinationFreeDiskGb) &&
    destinationFreeDiskGb >= minimumFreeDiskGb;
  const alternativeVolumes = rows
    .filter((row) => !row.isDestinationVolume && row.meetsMinimum)
    .sort((left, right) => right.freeDiskGb - left.freeDiskGb);

  return {
    destinationVolume,
    destinationFreeDiskGb,
    minimumFreeDiskGb,
    destinationMeetsMinimum,
    volumes: rows,
    alternativeVolumes,
    recommendedVolume: destinationMeetsMinimum
      ? destinationVolume
      : (alternativeVolumes[0]?.volume ?? null),
  };
}

/**
 * Check whether `candidatePath` is protected or overlaps with any protected
 * directory (either as a child inside a protected directory or as an ancestor
 * that contains a protected directory).
 *
 * @param {string} candidatePath
 * @param {object} [options]
 * @param {object} [options.env]
 * @param {string|null} [options.dest]
 * @param {string|null} [options.visualStudioPath]
 * @param {string|null} [options.windowsSdkDir]
 * @returns {boolean}
 */
export function isProtectedRunnerPath(
  candidatePath,
  {
    env = process.env,
    dest = null,
    visualStudioPath = null,
    windowsSdkDir = null,
  } = {},
) {
  const candidate = normalizeWindowsPath(candidatePath);
  if (candidate.length === 0 || /^[a-z]:$/i.test(candidate)) {
    return true;
  }

  const protectedList = [
    ...PROTECTED_WINDOWS_PATHS,
    env.GITHUB_WORKSPACE ?? null,
    env.RUNNER_TEMP ?? null,
    dest,
    visualStudioPath,
    windowsSdkDir,
  ]
    .filter((item) => typeof item === 'string' && item.trim().length > 0)
    .map((item) => normalizeWindowsPath(item))
    .filter((item) => item.length > 0);

  for (const protectedPath of protectedList) {
    if (candidate === protectedPath) {
      return true;
    }
    // Candidate is inside a protected path (would delete files inside VS/SDK/etc.)
    if (candidate.startsWith(`${protectedPath}\\`)) {
      return true;
    }
    // Candidate is an ancestor of a protected path (would delete the entire parent)
    if (protectedPath.startsWith(`${candidate}\\`)) {
      return true;
    }
  }

  return false;
}

/**
 * Measure free disk space in GB for a path on the runner.
 *
 * @param {string} targetPath
 * @param {object} [options]
 * @param {Function} [options.exists]
 * @param {Function} [options.statfs]
 * @returns {number|null}
 */
export function measureVolumeFreeDiskGb(
  targetPath,
  { exists = existsSync, statfs = statfsSync } = {},
) {
  if (typeof targetPath !== 'string' || targetPath.length === 0) {
    return null;
  }
  let probe = targetPath;
  try {
    while (!exists(probe) && probe !== path.dirname(probe)) {
      probe = path.dirname(probe);
    }
    const stats = statfs(probe);
    const bytes = Number(stats.bavail) * Number(stats.bsize);
    if (Number.isFinite(bytes) && bytes >= 0) {
      return Math.round((bytes / 1024 ** 3) * 10) / 10;
    }
  } catch {
    return freeDiskGb(probe);
  }
  return null;
}

/**
 * Reclaim disk space on a GitHub-hosted Windows runner by deleting only
 * allowlisted non-Chromium preinstalled directories while strictly protecting
 * Visual Studio, MSVC, Windows SDK, Git, Python, Node.js, Rust, and the
 * active workspace.
 *
 * @param {object} [options]
 * @param {string} options.dest
 * @param {number} [options.targetFreeDiskGb]
 * @param {object} [options.env]
 * @param {string} [options.platform]
 * @param {Array<{path: string, category?: string, estimatedGb?: number}>} [options.targets]
 * @param {string|null} [options.visualStudioPath]
 * @param {string|null} [options.windowsSdkDir]
 * @param {Function} [options.exists]
 * @param {Function} [options.rm]
 * @param {Function} [options.measureFreeDisk]
 * @param {Function} [options.log]
 */
export function reclaimHostedRunnerDisk({
  dest,
  targetFreeDiskGb = TARGET_CLEANUP_FREE_DISK_GB,
  env = process.env,
  platform = process.platform,
  targets = SAFE_RUNNER_CLEANUP_TARGETS,
  visualStudioPath = null,
  windowsSdkDir = null,
  exists = existsSync,
  rm = (targetPath) => rmSync(targetPath, { recursive: true, force: true }),
  measureFreeDisk = (targetPath) => measureVolumeFreeDiskGb(targetPath),
  log = () => {},
} = {}) {
  if (!isGithubHostedRunner(env) || platform !== 'win32') {
    return {
      executed: false,
      skipped: true,
      reason: 'Disk cleanup is permitted only on GitHub-hosted Windows runners.',
      freeDiskBeforeGb: null,
      freeDiskAfterGb: null,
      reclaimedGb: 0,
      destinationVolume: volumeRootOf(dest, { platform }),
      removedTargets: [],
      missingTargets: [],
      rejectedTargets: [],
      failedTargets: [],
      offVolumeTargets: [],
    };
  }

  const destinationVolume = volumeRootOf(dest, { platform });
  const freeDiskBeforeGb = measureFreeDisk(dest);
  log(
    `disk cleanup: destination volume ${destinationVolume ?? 'unknown'} free disk before cleanup is ${
      freeDiskBeforeGb === null ? 'unknown' : `${freeDiskBeforeGb.toFixed(1)} GB`
    } (target >= ${targetFreeDiskGb} GB, required floor >= ${MINIMUM_PRE_SYNC_FREE_DISK_GB} GB)`,
  );

  const removedTargets = [];
  const missingTargets = [];
  const rejectedTargets = [];
  const failedTargets = [];
  const offVolumeTargets = [];

  for (const entry of targets) {
    const targetPath = typeof entry === 'string' ? entry : entry.path;
    const category =
      typeof entry === 'object' && entry !== null && entry.category
        ? entry.category
        : 'non-Chromium runner cache';

    if (
      isProtectedRunnerPath(targetPath, {
        env,
        dest,
        visualStudioPath,
        windowsSdkDir,
      })
    ) {
      rejectedTargets.push(targetPath);
      log(
        `disk cleanup: REJECTED protected path ${targetPath} (Visual Studio / Windows SDK / core build tool protection)`,
      );
      continue;
    }

    // Deleting a directory only frees space on the volume that hosts it. The
    // Chromium checkout lives on the destination volume, so targets on any
    // other volume are recorded and skipped instead of being reported as
    // reclaimed space.
    if (!isSameVolume(targetPath, dest, { platform })) {
      const targetVolume = volumeRootOf(targetPath, { platform });
      offVolumeTargets.push({
        path: targetPath,
        category,
        volume: targetVolume,
      });
      log(
        `disk cleanup: SKIPPED ${targetPath} (${category}) - it lives on volume ${targetVolume ?? 'unknown'}, not on the Chromium destination volume ${destinationVolume ?? 'unknown'}`,
      );
      continue;
    }

    let present = false;
    try {
      present = Boolean(exists(targetPath));
    } catch {
      present = false;
    }
    if (!present) {
      missingTargets.push(targetPath);
      continue;
    }

    const freeBeforeRemovalGb = measureFreeDisk(dest);
    try {
      rm(targetPath);
    } catch (error) {
      failedTargets.push({
        path: targetPath,
        error: error.message ?? String(error),
      });
      log(
        `disk cleanup: failed to remove ${targetPath}: ${error.message ?? error}`,
      );
      continue;
    }

    const freeAfterRemovalGb = measureFreeDisk(dest);
    // Only report a removal as successful when the directory is really gone.
    let stillPresent = false;
    try {
      stillPresent = Boolean(exists(targetPath));
    } catch {
      stillPresent = false;
    }
    if (stillPresent) {
      failedTargets.push({
        path: targetPath,
        error: 'directory still exists after removal',
      });
      log(
        `disk cleanup: failed to remove ${targetPath}: directory still exists after removal`,
      );
      continue;
    }

    const reclaimedByTargetGb =
      typeof freeBeforeRemovalGb === 'number' &&
      typeof freeAfterRemovalGb === 'number'
        ? Math.round((freeAfterRemovalGb - freeBeforeRemovalGb) * 10) / 10
        : null;
    removedTargets.push({
      path: targetPath,
      category,
      reclaimedGb: reclaimedByTargetGb,
    });
    log(
      `disk cleanup: removed ${targetPath} (${category}); destination volume free disk ${freeBeforeRemovalGb?.toFixed(1) ?? 'unknown'} GB -> ${freeAfterRemovalGb?.toFixed(1) ?? 'unknown'} GB`,
    );

    const currentFreeGb = measureFreeDisk(dest);
    if (
      typeof currentFreeGb === 'number' &&
      Number.isFinite(currentFreeGb) &&
      currentFreeGb >= targetFreeDiskGb
    ) {
      log(
        `disk cleanup: reached ${currentFreeGb.toFixed(1)} GB free (target ${targetFreeDiskGb} GB); stopping cleanup early`,
      );
      break;
    }
  }

  const freeDiskAfterGb = measureFreeDisk(dest);
  // Measured, never estimated: the difference between two live measurements of
  // the destination volume. A value of 0 (or negative) is reported as measured
  // so cross-volume cleanup can never be mistaken for reclaimed space.
  const reclaimedGb =
    typeof freeDiskBeforeGb === 'number' && typeof freeDiskAfterGb === 'number'
      ? Math.round((freeDiskAfterGb - freeDiskBeforeGb) * 10) / 10
      : 0;

  log(
    `disk cleanup: destination volume ${destinationVolume ?? 'unknown'} free disk after cleanup is ${
      freeDiskAfterGb === null ? 'unknown' : `${freeDiskAfterGb.toFixed(1)} GB`
    } (measured reclaimed ${reclaimedGb.toFixed(1)} GB; ${removedTargets.length} removed, ${missingTargets.length} absent, ${offVolumeTargets.length} on another volume, ${failedTargets.length} failed, ${rejectedTargets.length} rejected)`,
  );
  if (offVolumeTargets.length > 0 && removedTargets.length === 0) {
    log(
      `disk cleanup: no allowlisted target lives on the destination volume ${destinationVolume ?? 'unknown'}; free space on that volume cannot be reclaimed by cleanup`,
    );
  }

  return {
    executed: true,
    skipped: false,
    reason: null,
    destinationVolume,
    freeDiskBeforeGb,
    freeDiskAfterGb,
    reclaimedGb,
    removedTargets,
    missingTargets,
    rejectedTargets,
    failedTargets,
    offVolumeTargets,
  };
}

/**
 * Minimum plausible size of the Windows SDK bootstrap installer (512 KiB).
 * Anything smaller is a redirect page or an error body, not the installer.
 */
export const MINIMUM_INSTALLER_BYTES = 524288;

/**
 * Module that provides `Get-AuthenticodeSignature` on Windows PowerShell.
 */
export const AUTHENTICODE_SECURITY_MODULE = 'Microsoft.PowerShell.Security';

/** Required publisher text in the Authenticode signer certificate subject. */
export const REQUIRED_SIGNER_SUBJECT = 'Microsoft Corporation';

/**
 * PowerShell hosts used for Authenticode verification, in preference order.
 *
 * Run `38103342538` proved the single-host implementation was fragile: the
 * installer downloaded successfully (1,417,000 bytes) but `powershell.exe`
 * (Windows PowerShell 5.1) aborted with
 * `CouldNotAutoloadMatchingModule - the module Microsoft.PowerShell.Security
 * could not be loaded`, so a *verified* signature was never produced and the
 * installer was (correctly) never executed.
 *
 * `pwsh` (PowerShell 7, shipped with GitHub-hosted Windows runners) is tried
 * first; Windows PowerShell 5.1 remains the fallback. Both hosts are required
 * to explicitly `Import-Module Microsoft.PowerShell.Security`, and every host
 * failure is captured with its PowerShell version, `PSModulePath`, and the
 * underlying module-import error. Signature verification stays mandatory: if
 * no host can verify a valid Microsoft publisher signature, the installer is
 * deleted and never executed.
 */
export const AUTHENTICODE_POWERSHELL_CANDIDATES = Object.freeze([
  { file: 'pwsh', label: 'PowerShell 7 (pwsh)' },
  { file: 'powershell', label: 'Windows PowerShell 5.1 (powershell.exe)' },
]);

/**
 * Build the PowerShell script that explicitly imports the Authenticode
 * security module and verifies the installer signature.
 *
 * The script never relies on module auto-loading and always prints a single
 * JSON report as its last stdout line so the caller can distinguish:
 *  - `stage: 'import-module'`  - `Microsoft.PowerShell.Security` unavailable
 *  - `stage: 'get-authenticodesignature'` - the cmdlet itself failed
 *  - `ok: $true` - a valid Microsoft Corporation signature was verified
 *
 * @param {object} options
 * @param {string} options.installerPath
 * @param {string} [options.moduleName]
 * @param {string} [options.requiredSubject]
 * @returns {string} PowerShell 5.1 and 7 compatible script.
 */
export function buildAuthenticodeVerificationScript({
  installerPath,
  moduleName = AUTHENTICODE_SECURITY_MODULE,
  requiredSubject = REQUIRED_SIGNER_SUBJECT,
} = {}) {
  const escapedPath = String(installerPath).replaceAll("'", "''");
  const escapedModule = String(moduleName).replaceAll("'", "''");
  const escapedSubject = String(requiredSubject).replaceAll("'", "''");
  return [
    "$ErrorActionPreference = 'Stop'",
    '$ProgressPreference = "SilentlyContinue"',
    `$dest = '${escapedPath}'`,
    `$moduleName = '${escapedModule}'`,
    `$requiredSubject = '${escapedSubject}'`,
    '$report = [ordered]@{',
    "  ok = $false",
    "  stage = 'start'",
    '  psVersion = [string]$PSVersionTable.PSVersion',
    '  psEdition = [string]$PSVersionTable.PSEdition',
    '  psHome = [string]$PSHOME',
    '  psModulePath = [string]$env:PSModulePath',
    "  moduleImported = $false",
    '  moduleImportError = $null',
    '  signatureStatus = $null',
    '  signerSubject = $null',
    '  error = $null',
    '}',
    '$emit = { param($r) [Console]::Out.WriteLine(($r | ConvertTo-Json -Compress)) }',
    'try {',
    '  Import-Module -Name $moduleName -Force -ErrorAction Stop',
    '  $report.moduleImported = $true',
    '} catch {',
    "  $report.stage = 'import-module'",
    '  $report.moduleImportError = $_.Exception.ToString()',
    '  $report.error = $_.Exception.Message',
    '  & $emit $report',
    '  exit 3',
    '}',
    'try {',
    "  $report.stage = 'get-authenticodesignature'",
    '  $sig = Get-AuthenticodeSignature -LiteralPath $dest',
    '  $report.signatureStatus = [string]$sig.Status',
    '  if ($null -ne $sig.SignerCertificate) {',
    '    $report.signerSubject = [string]$sig.SignerCertificate.Subject',
    '  }',
    '  $report.ok = (',
    "    $sig.Status -eq 'Valid' -and",
    '    $null -ne $sig.SignerCertificate -and',
    '    $report.signerSubject -match [regex]::Escape($requiredSubject)',
    '  )',
    '  if (-not $report.ok) {',
    '    $report.error = ("Authenticode verification failed: status=" + $report.signatureStatus + " subject=" + $report.signerSubject)',
    '    Remove-Item -LiteralPath $dest -Force -ErrorAction SilentlyContinue',
    '    & $emit $report',
    '    exit 4',
    '  }',
    '} catch {',
    "  $report.stage = 'get-authenticodesignature'",
    '  $report.error = $_.Exception.ToString()',
    '  Remove-Item -LiteralPath $dest -Force -ErrorAction SilentlyContinue',
    '  & $emit $report',
    '  exit 5',
    '}',
    '& $emit $report',
    'exit 0',
  ].join('\n');
}

/**
 * Parse the last JSON object printed by an Authenticode verification script.
 *
 * @param {string} stdout
 * @returns {object|null}
 */
export function parseAuthenticodeReport(stdout) {
  const lines = String(stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index].startsWith('{')) {
      continue;
    }
    try {
      return JSON.parse(lines[index]);
    } catch {
      // Keep scanning older lines; the report is the last valid JSON object.
    }
  }
  return null;
}

/**
 * Verify that `filePath` carries a valid Microsoft Corporation Authenticode
 * signature, trying every supported PowerShell host in order.
 *
 * @param {object} options
 * @param {string} options.filePath
 * @param {Function} [options.spawn]
 * @param {object} [options.env]
 * @param {Array<{file: string, label: string}>} [options.candidates]
 * @param {string} [options.moduleName]
 * @param {Function} [options.log]
 * @returns {{verified: boolean, host: string|null, label: string|null,
 *   report: object|null, attempts: Array<object>}}
 */
export function verifyAuthenticodeSignature({
  filePath,
  spawn = spawnSync,
  env = process.env,
  candidates = AUTHENTICODE_POWERSHELL_CANDIDATES,
  moduleName = AUTHENTICODE_SECURITY_MODULE,
  log = () => {},
} = {}) {
  const script = buildAuthenticodeVerificationScript({
    installerPath: filePath,
    moduleName,
  });
  const attempts = [];

  for (const candidate of candidates) {
    let result;
    try {
      result = spawn(
        candidate.file,
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { encoding: 'utf8', env, windowsHide: true },
      );
    } catch (error) {
      attempts.push({
        host: candidate.file,
        label: candidate.label,
        launched: false,
        exitCode: null,
        detail: error.message ?? String(error),
        report: null,
      });
      log(
        `authenticode: ${candidate.label} could not be started: ${error.message ?? error}`,
      );
      continue;
    }

    const detail = `${result.stderr ?? ''}\n${result.stdout ?? ''}`.trim();
    const report = parseAuthenticodeReport(result.stdout);

    if (result.error !== undefined) {
      attempts.push({
        host: candidate.file,
        label: candidate.label,
        launched: false,
        exitCode: null,
        detail: result.error.message ?? detail,
        report,
      });
      log(
        `authenticode: ${candidate.label} is not available on this runner: ${result.error.message}`,
      );
      continue;
    }

    attempts.push({
      host: candidate.file,
      label: candidate.label,
      launched: true,
      exitCode: result.status ?? null,
      detail,
      report,
    });

    if (result.status === 0 && report?.ok === true) {
      log(
        `authenticode: ${candidate.label} verified ${filePath} (status=${report.signatureStatus}, signer=${report.signerSubject}, ${moduleName} imported=${report.moduleImported})`,
      );
      return {
        verified: true,
        host: candidate.file,
        label: candidate.label,
        report,
        attempts,
      };
    }

    const reason =
      report?.moduleImportError ??
      report?.error ??
      (detail.length > 0 ? detail.split('\n')[0] : null) ??
      `exit code ${result.status}`;
    log(
      `authenticode: ${candidate.label} did not verify ${filePath} (exit=${result.status}, stage=${report?.stage ?? 'unknown'}, psVersion=${report?.psVersion ?? 'unknown'}, reason=${reason})`,
    );
  }

  return {
    verified: false,
    host: null,
    label: null,
    report: attempts.at(-1)?.report ?? null,
    attempts,
  };
}

/**
 * Download the Windows SDK bootstrap installer from the first Microsoft
 * endpoint that returns a file larger than `minimumBytes`.
 *
 * @param {object} options
 * @param {string[]} options.urls
 * @param {string} options.installerPath
 * @param {Function} [options.spawn]
 * @param {object} [options.env]
 * @param {number} [options.minimumBytes]
 * @param {Function} [options.log]
 * @returns {{url: string, bytes: number}}
 */
export function downloadInstaller({
  urls,
  installerPath,
  spawn = spawnSync,
  env = process.env,
  minimumBytes = MINIMUM_INSTALLER_BYTES,
  log = () => {},
} = {}) {
  const urlLiterals = urls
    .map((url) => `'${String(url).replaceAll("'", "''")}'`)
    .join(', ');
  const escapedInstaller = String(installerPath).replaceAll("'", "''");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12',
    '$ProgressPreference = "SilentlyContinue"',
    `$urls = @(${urlLiterals})`,
    `$dest = '${escapedInstaller}'`,
    `$minimumBytes = ${minimumBytes}`,
    '$selectedUrl = $null',
    '$lastError = $null',
    'foreach ($u in $urls) {',
    '  try {',
    '    & curl.exe -fL --retry 3 --retry-delay 5 -o $dest $u',
    '    if ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $dest)) {',
    '      $item = Get-Item -LiteralPath $dest',
    '      if ($item.Length -gt $minimumBytes) {',
    '        $selectedUrl = $u',
    '        break',
    '      }',
    '      Remove-Item -LiteralPath $dest -Force -ErrorAction SilentlyContinue',
    '    }',
    '  } catch {',
    '    $lastError = $_.Exception.Message',
    '  }',
    '}',
    'if (-not $selectedUrl) {',
    '  throw ("Failed to download winsdksetup.exe from Microsoft endpoints. Last error: " + $lastError)',
    '}',
    '$item = Get-Item -LiteralPath $dest',
    '@{ url = $selectedUrl; bytes = [int64]$item.Length } | ConvertTo-Json -Compress',
  ].join('\n');

  const result = spawn(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', env, windowsHide: true },
  );
  if (result.error !== undefined) {
    throw new Error(
      `Windows SDK installer download failed: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    const detail = `${result.stderr ?? ''}\n${result.stdout ?? ''}`.trim();
    throw new Error(
      `Windows SDK installer download failed: ${detail || `exit code ${result.status}`}`,
    );
  }
  const report = parseAuthenticodeReport(result.stdout);
  const url = report?.url ?? null;
  if (typeof url !== 'string' || url.length === 0) {
    throw new Error(
      'Windows SDK installer download failed: no Microsoft endpoint returned the installer',
    );
  }
  log(`windows sdk: downloaded installer from ${url}`);
  return { url, bytes: Number(report?.bytes ?? 0) };
}

/**
 * Default downloader and mandatory Authenticode verifier for
 * `winsdksetup.exe` on a GitHub-hosted Windows runner.
 *
 * The installer is executed only when a supported PowerShell host verifies a
 * valid `Microsoft Corporation` Authenticode signature. When verification
 * fails the installer is deleted and the aggregated diagnostics (PowerShell
 * version, `PSModulePath`, module-import error) are reported so the exact
 * failure is visible in the workflow log.
 */
export function defaultDownloadAndVerifyInstaller({
  urls,
  installerPath,
  spawn = spawnSync,
  env = process.env,
  rm = rmSync,
  log = () => {},
} = {}) {
  const downloaded = downloadInstaller({
    urls,
    installerPath,
    spawn,
    env,
    log,
  });
  const verification = verifyAuthenticodeSignature({
    filePath: installerPath,
    spawn,
    env,
    log,
  });

  if (!verification.verified) {
    // Never leave an unsigned or unverified installer on disk.
    try {
      rm(installerPath, { force: true });
    } catch {
      // The verification failure is the primary error; do not mask it.
    }
    const diagnostics = verification.attempts.map((attempt) => {
      const report = attempt.report ?? {};
      return [
        attempt.label,
        `launched=${attempt.launched}`,
        `exit=${attempt.exitCode ?? 'n/a'}`,
        `stage=${report.stage ?? 'unknown'}`,
        `moduleImported=${report.moduleImported ?? false}`,
        `psVersion=${report.psVersion ?? 'unknown'}`,
        `psHome=${report.psHome ?? 'unknown'}`,
        `psModulePath=${report.psModulePath ?? 'unknown'}`,
        `error=${report.moduleImportError ?? report.error ?? attempt.detail.split('\n')[0] ?? 'unknown'}`,
      ].join(' ');
    });
    throw new Error(
      `Authenticode verification failed for ${installerPath}; the installer was deleted and will not be executed. ${AUTHENTICODE_SECURITY_MODULE} diagnostics: ${diagnostics.join(' | ')}`,
    );
  }

  return {
    url: downloaded.url,
    signatureVerified: true,
    signerSubject:
      verification.report?.signerSubject ?? REQUIRED_SIGNER_SUBJECT,
    status: verification.report?.signatureStatus ?? 'Valid',
    powershellHost: verification.label,
  };
}

/**
 * Default silent execution of `winsdksetup.exe` for Windows SDK 10.0.28000.0.
 */
function defaultRunSdkInstaller({
  installerPath,
  features = WINDOWS_SDK_28000_FEATURES,
  logPath,
  spawn = spawnSync,
  env = process.env,
}) {
  const args = [
    '/features',
    ...features,
    '/quiet',
    '/norestart',
    '/ceip',
    'off',
  ];
  if (logPath) {
    args.push('/log', logPath);
  }
  const result = spawn(installerPath, args, {
    encoding: 'utf8',
    env,
    windowsHide: true,
  });
  if (result.error !== undefined) {
    throw new Error(
      `winsdksetup.exe could not be started: ${result.error.message}`,
    );
  }
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * Ensure Windows SDK `10.0.28000.0` is installed and verified on a
 * GitHub-hosted Windows runner.
 *
 * @param {object} [options]
 * @param {object} [options.env]
 * @param {string} [options.platform]
 * @param {string} [options.requiredVersion]
 * @param {string[]} [options.installerUrls]
 * @param {string[]} [options.features]
 * @param {string|null} [options.stagingRoot]
 * @param {string|null} [options.installerLogPath]
 * @param {Function} [options.exists]
 * @param {Function} [options.readdirSync]
 * @param {Function} [options.readText]
 * @param {Function} [options.mkdir]
 * @param {Function} [options.rm]
 * @param {Function} [options.spawn]
 * @param {Function} [options.downloadAndVerify]
 * @param {Function} [options.runInstaller]
 * @param {Function} [options.log]
 */
export function ensureWindowsSdk({
  env = process.env,
  platform = process.platform,
  requiredVersion = REQUIRED_SDK_VERSION,
  installerUrls = WINDOWS_SDK_28000_INSTALLER_URLS,
  features = WINDOWS_SDK_28000_FEATURES,
  stagingRoot = null,
  installerLogPath = null,
  exists = existsSync,
  readdirSync = fsReaddirSync,
  readText = (filePath) => fsReadFileSync(filePath, 'utf8'),
  mkdir = (dirPath) => mkdirSync(dirPath, { recursive: true }),
  rm = (dirPath) => rmSync(dirPath, { recursive: true, force: true }),
  spawn = spawnSync,
  downloadAndVerify = defaultDownloadAndVerifyInstaller,
  runInstaller = defaultRunSdkInstaller,
  log = () => {},
} = {}) {
  if (!isGithubHostedRunner(env) || platform !== 'win32') {
    return {
      executed: false,
      skipped: true,
      alreadyInstalled: false,
      installed: false,
      reason:
        'Automated Windows SDK installation is permitted only on GitHub-hosted Windows runners.',
      installerUrl: null,
      installerExitCode: null,
      signatureVerified: false,
      stagingCleaned: false,
      beforeSdk: null,
      afterSdk: null,
      verification: null,
      problems: [],
    };
  }

  const beforeSdk = detectWindowsSdk({
    env,
    platform,
    exists,
    readdirSync,
    requiredVersion,
  });
  const beforeVerification =
    beforeSdk?.sdkDir && beforeSdk?.selectedVersion
      ? verifyWindowsSdkInstallation({
          sdkDir: beforeSdk.sdkDir,
          version: beforeSdk.selectedVersion,
          platform,
          exists,
          readText,
        })
      : null;

  if (beforeSdk?.isCompatible && beforeVerification?.ok) {
    log(
      `windows sdk: ${beforeSdk.selectedVersion} at ${beforeSdk.sdkDir} already satisfies ${requiredVersion} (headers, x64/x86 libs, NTDDI_WIN11_BR, and dbghelp.dll verified)`,
    );
    return {
      executed: false,
      skipped: false,
      alreadyInstalled: true,
      installed: true,
      reason: null,
      installerUrl: null,
      installerExitCode: null,
      signatureVerified: false,
      stagingCleaned: true,
      beforeSdk,
      afterSdk: beforeSdk,
      verification: beforeVerification,
      problems: [],
    };
  }

  log(
    `windows sdk: installed SDK is ${
      beforeSdk?.selectedVersion ?? 'NOT FOUND'
    } (requires >= ${requiredVersion}); provisioning Windows SDK ${requiredVersion} from Microsoft official installer`,
  );

  const p = platform === 'win32' ? path.win32 : path;
  const baseTemp = stagingRoot ?? env.RUNNER_TEMP ?? tmpdir();
  const stagingDir = p.join(baseTemp, 'aurelia-winsdk-28000-stage');
  const installerPath = p.join(stagingDir, 'winsdksetup.exe');
  const problems = [];
  let installerUrl = null;
  let signatureVerified = false;
  let installerExitCode = null;
  let stagingCleaned = false;

  try {
    mkdir(stagingDir);
    const downloaded = downloadAndVerify({
      urls: installerUrls,
      installerPath,
      spawn,
      env,
    });
    installerUrl = downloaded.url;
    signatureVerified = Boolean(downloaded.signatureVerified);
    if (!signatureVerified) {
      throw new Error(
        'Refusing to execute winsdksetup.exe without a verified Microsoft Authenticode signature',
      );
    }
    log(
      `windows sdk: downloaded winsdksetup.exe from ${installerUrl} (Authenticode signature verified: ${downloaded.signerSubject ?? 'Microsoft Corporation'})`,
    );

    const installResult = runInstaller({
      installerPath,
      features,
      logPath: installerLogPath,
      spawn,
      env,
    });
    installerExitCode = installResult.exitCode;
    log(`windows sdk: winsdksetup.exe exited with code ${installerExitCode}`);
    if (installerExitCode !== 0 && installerExitCode !== 3010) {
      problems.push(
        `winsdksetup.exe exited with code ${installerExitCode} (expected 0 or 3010)`,
      );
    }
  } catch (error) {
    problems.push(error.message ?? String(error));
    log(`windows sdk: installation error: ${error.message ?? error}`);
  } finally {
    try {
      rm(stagingDir);
      stagingCleaned = true;
    } catch {
      stagingCleaned = false;
    }
  }

  const afterSdk = detectWindowsSdk({
    env,
    platform,
    exists,
    readdirSync,
    requiredVersion,
  });
  const verification = verifyWindowsSdkInstallation({
    sdkDir: afterSdk?.sdkDir ?? beforeSdk?.sdkDir ?? null,
    version: afterSdk?.selectedVersion ?? requiredVersion,
    platform,
    exists,
    readText,
  });

  if (!afterSdk?.isCompatible) {
    problems.push(
      `After SDK installation, detected Windows SDK is ${
        afterSdk?.selectedVersion ?? 'none'
      } (requires >= ${requiredVersion})`,
    );
  }
  if (!verification.ok) {
    problems.push(...verification.problems);
  }

  const installed =
    problems.length === 0 && Boolean(afterSdk?.isCompatible) && verification.ok;
  log(
    installed
      ? `windows sdk: verified ${afterSdk.selectedVersion} at ${afterSdk.sdkDir} (headers, x64/x86 libs, NTDDI_WIN11_BR, and Debuggers\\x64\\dbghelp.dll present)`
      : `windows sdk: verification failed after installation: ${problems.join('; ')}`,
  );

  return {
    executed: true,
    skipped: false,
    alreadyInstalled: false,
    installed,
    reason: null,
    installerUrl,
    installerExitCode,
    signatureVerified,
    stagingCleaned,
    beforeSdk,
    afterSdk,
    verification,
    problems,
  };
}

/**
 * Prepare a GitHub-hosted Windows runner before Chromium preflight finalizes:
 *  1. Inspect initial Visual Studio, Windows SDK, and destination free disk.
 *  2. Run safe non-Chromium disk cleanup when free disk is below the target
 *     buffer (`>= 165 GB` before SDK install so `>= 150 GB` remains after).
 *  3. Provision and verify Windows SDK `10.0.28000.0` if missing or older.
 *  4. Re-verify that Visual Studio (`cl.exe`, `vcvarsall.bat`) was not harmed,
 *     Windows SDK `10.0.28000.0` is complete, and destination free disk is at
 *     least `minimumFreeDiskGb` (`150 GB`).
 *
 * @param {object} options
 * @param {string} options.dest
 * @param {string|null} [options.artifacts]
 * @param {number} [options.minimumFreeDiskGb]
 * @param {number} [options.targetCleanupFreeDiskGb]
 * @param {object} [options.env]
 * @param {string} [options.platform]
 * @param {Function} [options.exists]
 * @param {Function} [options.readdirSync]
 * @param {Function} [options.readText]
 * @param {Function} [options.mkdir]
 * @param {Function} [options.rm]
 * @param {Function} [options.spawn]
 * @param {Function} [options.measureFreeDisk]
 * @param {Function} [options.downloadAndVerify]
 * @param {Function} [options.runInstaller]
 * @param {Function} [options.log]
 */
export function prepareHostedWindowsRunner({
  dest,
  artifacts = null,
  minimumFreeDiskGb = MINIMUM_PRE_SYNC_FREE_DISK_GB,
  // SDK installation writes to C:\ (Windows Kits), not the destination volume,
  // so we only need a small buffer over minimumFreeDiskGb on the destination.
  // Keep the 165 GB target when the caller requests the reference 150 GB floor,
  // so existing targeted/full behavior is unchanged; for smaller floors (GN-only)
  // add a flat 5 GB buffer for temp files and runhooks scratch space.
  targetCleanupFreeDiskGb = null,
  env = process.env,
  platform = process.platform,
  exists = existsSync,
  readdirSync = fsReaddirSync,
  readText = (filePath) => fsReadFileSync(filePath, 'utf8'),
  mkdir = (dirPath) => mkdirSync(dirPath, { recursive: true }),
  rm = (dirPath) => rmSync(dirPath, { recursive: true, force: true }),
  spawn = spawnSync,
  measureFreeDisk = (targetPath) => measureVolumeFreeDiskGb(targetPath),
  downloadAndVerify = defaultDownloadAndVerifyInstaller,
  runInstaller = defaultRunSdkInstaller,
  log = () => {},
} = {}) {
  if (!isGithubHostedRunner(env) || platform !== 'win32') {
    return {
      executed: false,
      skipped: true,
      ok: false,
      reason:
        'Runner preparation is permitted only on GitHub-hosted Windows runners.',
      before: null,
      cleanup: null,
      sdkProvisioning: null,
      after: null,
      problems: [],
    };
  }

  // Resolve the target cleanup free-disk floor based on the requested minimum:
  //  - reference 150 GB floor (targeted/full): keep TARGET_CLEANUP_FREE_DISK_GB (165 GB)
  //  - GN-only floor (80 GB): minimum + 5 GB buffer for temp/hooks scratch
  const effectiveTargetCleanup =
    targetCleanupFreeDiskGb !== null
      ? targetCleanupFreeDiskGb
      : minimumFreeDiskGb >= MINIMUM_PRE_SYNC_FREE_DISK_GB
        ? TARGET_CLEANUP_FREE_DISK_GB
        : minimumFreeDiskGb + 5;

  const initialToolchain = detectWindowsToolchain({
    env,
    platform,
    spawn,
    exists,
    readdirSync,
  });
  const freeDiskBeforeGb = measureFreeDisk(dest);
  const initialSdkVerification =
    initialToolchain.sdk?.sdkDir && initialToolchain.sdk?.selectedVersion
      ? verifyWindowsSdkInstallation({
          sdkDir: initialToolchain.sdk.sdkDir,
          version: initialToolchain.sdk.selectedVersion,
          platform,
          exists,
          readText,
        })
      : null;

  const before = {
    freeDiskGb: freeDiskBeforeGb,
    visualStudio: initialToolchain.vs?.installationPath ?? null,
    visualStudioVersion: initialToolchain.vs?.version ?? null,
    msvcToolset: initialToolchain.vs?.msvcToolsetVersion ?? null,
    msvcCompiler: initialToolchain.vs?.clExe ?? null,
    windowsSdk: initialToolchain.sdk?.selectedVersion ?? null,
    windowsSdkDir: initialToolchain.sdk?.sdkDir ?? null,
    windowsSdkCompatible: Boolean(
      initialToolchain.sdk?.isCompatible && initialSdkVerification?.ok,
    ),
  };

  const needsSdkProvisioning = !before.windowsSdkCompatible;
  const diskThresholdForCleanup = needsSdkProvisioning
    ? effectiveTargetCleanup
    : minimumFreeDiskGb;
  const needsDiskCleanup =
    freeDiskBeforeGb === null || freeDiskBeforeGb < diskThresholdForCleanup;

  let cleanup = {
    executed: false,
    skipped: true,
    reason: 'Free disk already meets target buffer.',
    destinationVolume: volumeRootOf(dest, { platform }),
    freeDiskBeforeGb,
    freeDiskAfterGb: freeDiskBeforeGb,
    reclaimedGb: 0,
    removedTargets: [],
    missingTargets: [],
    rejectedTargets: [],
    failedTargets: [],
    offVolumeTargets: [],
  };

  if (needsDiskCleanup) {
    cleanup = reclaimHostedRunnerDisk({
      dest,
      targetFreeDiskGb: effectiveTargetCleanup,
      env,
      platform,
      visualStudioPath: before.visualStudio,
      windowsSdkDir: before.windowsSdkDir,
      exists,
      rm,
      measureFreeDisk,
      log,
    });
  }

  const installerLogPath = artifacts
    ? path.join(artifacts, 'logs', 'windows-sdk-install.log')
    : null;

  const sdkProvisioning = ensureWindowsSdk({
    env,
    platform,
    requiredVersion: REQUIRED_SDK_VERSION,
    installerLogPath,
    exists,
    readdirSync,
    readText,
    mkdir,
    rm,
    spawn,
    downloadAndVerify,
    runInstaller,
    log,
  });

  // Re-inspect Visual Studio, Windows SDK, and destination free disk after preparation.
  const finalVs = detectVisualStudio({
    env,
    platform,
    spawn,
    exists,
    readdirSync,
  });
  const finalSdk = detectWindowsSdk({
    env,
    platform,
    exists,
    readdirSync,
    requiredVersion: REQUIRED_SDK_VERSION,
  });
  const finalSdkVerification = verifyWindowsSdkInstallation({
    sdkDir: finalSdk?.sdkDir ?? null,
    version: finalSdk?.selectedVersion ?? REQUIRED_SDK_VERSION,
    platform,
    exists,
    readText,
  });
  const freeDiskAfterGb = measureFreeDisk(dest);

  const problems = [];
  if (!finalVs?.ok) {
    problems.push(
      `Visual Studio toolchain integrity check failed after preparation: ${
        finalVs?.problems?.join('; ') || 'Visual Studio not found'
      }`,
    );
  }
  if (!finalSdk?.isCompatible || !finalSdkVerification.ok) {
    problems.push(
      ...(sdkProvisioning.problems.length > 0
        ? sdkProvisioning.problems
        : finalSdkVerification.problems),
    );
  }
  // Storage topology evidence. GitHub-hosted Windows runners expose C: (OS and
  // preinstalled toolchains) and D: (workspace and RUNNER_TEMP) as separate
  // volumes, so cleanup must be evaluated against the volume that actually
  // hosts the Chromium destination.
  const volumeEvaluation = evaluateDestinationVolumes({
    dest,
    minimumFreeDiskGb,
    platform,
    exists,
    measureFreeDisk,
  });
  for (const volume of volumeEvaluation.volumes) {
    log(
      `volume ${volume.volume}: ${
        volume.freeDiskGb === null
          ? 'unknown'
          : `${volume.freeDiskGb.toFixed(1)} GB`
      } free (${volume.meetsMinimum ? 'meets' : 'short of'} the ${minimumFreeDiskGb} GB floor)${
        volume.isDestinationVolume ? ' <- Chromium destination volume' : ''
      }`,
    );
  }
  if (!volumeEvaluation.destinationMeetsMinimum) {
    log(
      volumeEvaluation.alternativeVolumes.length > 0
        ? `destination volume ${volumeEvaluation.destinationVolume ?? 'unknown'} cannot satisfy the ${minimumFreeDiskGb} GB floor; alternative volume(s) that can: ${volumeEvaluation.alternativeVolumes
            .map((entry) => `${entry.volume} (${entry.freeDiskGb.toFixed(1)} GB free)`)
            .join(', ')}`
        : `destination volume ${volumeEvaluation.destinationVolume ?? 'unknown'} cannot satisfy the ${minimumFreeDiskGb} GB floor and no other volume on this runner reaches it`,
    );
  }

  if (freeDiskAfterGb === null || freeDiskAfterGb < minimumFreeDiskGb) {
    problems.push(
      `Free disk after runner preparation is ${
        freeDiskAfterGb === null ? 'unknown' : `${freeDiskAfterGb.toFixed(1)} GB`
      } (requires at least ${minimumFreeDiskGb} GB before Chromium synchronization)`,
    );
  }
  if (
    freeDiskAfterGb !== null &&
    freeDiskAfterGb < minimumFreeDiskGb &&
    cleanup.executed
  ) {
    const offVolumeCount = cleanup.offVolumeTargets?.length ?? 0;
    const onVolumeCount = cleanup.removedTargets.length;
    problems.push(
      `Disk cleanup reclaimed ${cleanup.reclaimedGb.toFixed(1)} GB on the Chromium destination volume ${
        volumeEvaluation.destinationVolume ?? 'unknown'
      } (measured): ${onVolumeCount} allowlisted target(s) removed on that volume, ${offVolumeCount} live on other volume(s) and cannot free space on it, ${
        cleanup.missingTargets.length
      } absent, ${cleanup.failedTargets.length} failed`,
    );
  }

  const after = {
    freeDiskGb: freeDiskAfterGb,
    visualStudio: finalVs?.installationPath ?? null,
    visualStudioVersion: finalVs?.version ?? null,
    msvcToolset: finalVs?.msvcToolsetVersion ?? null,
    msvcCompiler: finalVs?.clExe ?? null,
    visualStudioIntact: Boolean(finalVs?.ok),
    windowsSdk: finalSdk?.selectedVersion ?? null,
    windowsSdkDir: finalSdk?.sdkDir ?? null,
    windowsSdkCompatible: Boolean(
      finalSdk?.isCompatible && finalSdkVerification.ok,
    ),
    windowsSdkChecks: finalSdkVerification.checks,
  };

  const result = {
    executed: Boolean(cleanup.executed || sdkProvisioning.executed),
    skipped: false,
    ok: problems.length === 0,
    reason: null,
    diskRegressionAnalysis: RUNNER_DISK_REGRESSION_ANALYSIS,
    before,
    cleanup: {
      executed: cleanup.executed,
      skipped: cleanup.skipped,
      reason: cleanup.reason,
      destinationVolume: cleanup.destinationVolume ?? null,
      freeDiskBeforeGb: cleanup.freeDiskBeforeGb,
      freeDiskAfterGb: cleanup.freeDiskAfterGb,
      reclaimedGb: cleanup.reclaimedGb,
      removedTargets: cleanup.removedTargets,
      missingTargets: cleanup.missingTargets,
      rejectedTargets: cleanup.rejectedTargets,
      failedTargets: cleanup.failedTargets,
      offVolumeTargets: cleanup.offVolumeTargets ?? [],
    },
    volumes: volumeEvaluation,
    sdkProvisioning: {
      executed: sdkProvisioning.executed,
      alreadyInstalled: sdkProvisioning.alreadyInstalled,
      installed: sdkProvisioning.installed,
      installerUrl: sdkProvisioning.installerUrl,
      installerExitCode: sdkProvisioning.installerExitCode,
      signatureVerified: sdkProvisioning.signatureVerified,
      stagingCleaned: sdkProvisioning.stagingCleaned,
      problems: sdkProvisioning.problems,
    },
    after,
    problems,
  };

  if (artifacts) {
    try {
      mkdir(artifacts);
      writeFileSync(
        path.join(artifacts, 'runner-preparation.json'),
        `${JSON.stringify(result, null, 2)}\n`,
      );
    } catch {
      // Do not mask the primary preparation result if writing the sidecar fails.
    }
  }

  return result;
}

const isMain = isMainModule(import.meta.url);

if (isMain) {
  const argv = process.argv.slice(2);
  const valueOf = (flag) => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };
  const dest =
    valueOf('--dest') ?? process.env.AURELIA_CHROMIUM_DEST ?? process.cwd();
  const artifacts =
    valueOf('--artifacts') ?? process.env.AURELIA_ARTIFACTS_DIR ?? null;
  const result = prepareHostedWindowsRunner({
    dest: path.resolve(dest),
    artifacts: artifacts ? path.resolve(artifacts) : null,
    log: (line) => console.log(line),
  });
  if (argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  }
  process.exitCode = result.ok || result.skipped ? 0 : 1;
}
