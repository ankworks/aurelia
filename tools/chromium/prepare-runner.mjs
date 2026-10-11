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
      removedTargets: [],
      missingTargets: [],
      rejectedTargets: [],
      failedTargets: [],
    };
  }

  const freeDiskBeforeGb = measureFreeDisk(dest);
  log(
    `disk cleanup: destination volume free disk before cleanup is ${
      freeDiskBeforeGb === null ? 'unknown' : `${freeDiskBeforeGb.toFixed(1)} GB`
    } (target >= ${targetFreeDiskGb} GB, required floor >= ${MINIMUM_PRE_SYNC_FREE_DISK_GB} GB)`,
  );

  const removedTargets = [];
  const missingTargets = [];
  const rejectedTargets = [];
  const failedTargets = [];

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

    try {
      rm(targetPath);
      removedTargets.push({ path: targetPath, category });
      log(`disk cleanup: removed ${targetPath} (${category})`);
    } catch (error) {
      failedTargets.push({
        path: targetPath,
        error: error.message ?? String(error),
      });
      log(
        `disk cleanup: failed to remove ${targetPath}: ${error.message ?? error}`,
      );
    }

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
  const reclaimedGb =
    typeof freeDiskBeforeGb === 'number' && typeof freeDiskAfterGb === 'number'
      ? Math.max(
          0,
          Math.round((freeDiskAfterGb - freeDiskBeforeGb) * 10) / 10,
        )
      : 0;

  log(
    `disk cleanup: free disk after cleanup is ${
      freeDiskAfterGb === null ? 'unknown' : `${freeDiskAfterGb.toFixed(1)} GB`
    } (reclaimed ${reclaimedGb.toFixed(1)} GB across ${removedTargets.length} directory(s))`,
  );

  return {
    executed: true,
    skipped: false,
    reason: null,
    freeDiskBeforeGb,
    freeDiskAfterGb,
    reclaimedGb,
    removedTargets,
    missingTargets,
    rejectedTargets,
    failedTargets,
  };
}

/**
 * Default downloader and Authenticode verifier for `winsdksetup.exe` on a
 * GitHub-hosted Windows runner using Windows PowerShell 5.1.
 */
function defaultDownloadAndVerifyInstaller({
  urls,
  installerPath,
  spawn = spawnSync,
  env = process.env,
}) {
  const urlLiterals = urls
    .map((url) => `'${String(url).replaceAll("'", "''")}'`)
    .join(', ');
  const escapedInstaller = installerPath.replaceAll("'", "''");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12',
    '$ProgressPreference = "SilentlyContinue"',
    `$urls = @(${urlLiterals})`,
    `$dest = '${escapedInstaller}'`,
    '$selectedUrl = $null',
    '$lastError = $null',
    'foreach ($u in $urls) {',
    '  try {',
    '    & curl.exe -fL --retry 3 --retry-delay 5 -o $dest $u',
    '    if ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $dest)) {',
    '      $item = Get-Item -LiteralPath $dest',
    '      if ($item.Length -gt 524288) {',
    '        $selectedUrl = $u',
    '        break',
    '      }',
    '    }',
    '  } catch {',
    '    $lastError = $_.Exception.Message',
    '  }',
    '}',
    'if (-not $selectedUrl) {',
    '  throw ("Failed to download winsdksetup.exe from Microsoft endpoints. Last error: " + $lastError)',
    '}',
    '$sig = Get-AuthenticodeSignature -LiteralPath $dest',
    'if ($null -eq $sig -or $sig.Status -ne "Valid" -or $null -eq $sig.SignerCertificate -or $sig.SignerCertificate.Subject -notmatch "Microsoft Corporation") {',
    '  $status = if ($null -ne $sig) { $sig.Status } else { "Unknown" }',
    '  $subject = if ($null -ne $sig -and $null -ne $sig.SignerCertificate) { $sig.SignerCertificate.Subject } else { "None" }',
    '  Remove-Item -LiteralPath $dest -Force -ErrorAction SilentlyContinue',
    '  throw ("Authenticode signature check failed for winsdksetup.exe: status=" + $status + " subject=" + $subject)',
    '}',
    '@{ url = $selectedUrl; status = [string]$sig.Status; subject = [string]$sig.SignerCertificate.Subject } | ConvertTo-Json -Compress',
  ].join('\n');

  const result = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', env, windowsHide: true },
  );
  if (result.error !== undefined || result.status !== 0) {
    const detail =
      `${result.stderr ?? ''}\n${result.stdout ?? ''}`.trim() ||
      (result.error ? result.error.message : `exit code ${result.status}`);
    throw new Error(`Windows SDK installer download/verification failed: ${detail}`);
  }
  const lines = (result.stdout ?? '')
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const lastLine = lines.at(-1) ?? '{}';
  const parsed = JSON.parse(lastLine);
  return {
    url: parsed.url ?? urls[0],
    signatureVerified: parsed.status === 'Valid',
    signerSubject: parsed.subject ?? 'Microsoft Corporation',
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
  targetCleanupFreeDiskGb = Math.max(
    minimumFreeDiskGb + 15,
    TARGET_CLEANUP_FREE_DISK_GB,
  ),
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
    ? targetCleanupFreeDiskGb
    : minimumFreeDiskGb;
  const needsDiskCleanup =
    freeDiskBeforeGb === null || freeDiskBeforeGb < diskThresholdForCleanup;

  let cleanup = {
    executed: false,
    skipped: true,
    reason: 'Free disk already meets target buffer.',
    freeDiskBeforeGb,
    freeDiskAfterGb: freeDiskBeforeGb,
    reclaimedGb: 0,
    removedTargets: [],
    missingTargets: [],
    rejectedTargets: [],
    failedTargets: [],
  };

  if (needsDiskCleanup) {
    cleanup = reclaimHostedRunnerDisk({
      dest,
      targetFreeDiskGb: targetCleanupFreeDiskGb,
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
  if (freeDiskAfterGb === null || freeDiskAfterGb < minimumFreeDiskGb) {
    problems.push(
      `Free disk after runner preparation is ${
        freeDiskAfterGb === null ? 'unknown' : `${freeDiskAfterGb.toFixed(1)} GB`
      } (requires at least ${minimumFreeDiskGb} GB before Chromium synchronization)`,
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
    cleanup,
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
