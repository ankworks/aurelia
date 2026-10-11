#!/usr/bin/env node
/**
 * Windows toolchain and SDK detection and diagnostics.
 *
 * ## Context
 *
 * When compiling or generating GN build files for Chromium on Windows outside
 * Google's internal infrastructure, Chromium's `src/build/vs_toolchain.py` hook
 * must not attempt to download Google's private hermetic toolchain from Google
 * Cloud Storage (`chrome-wintoolchain` bucket, which yields HTTP 401
 * `ServiceException: 401 Anonymous caller does not have storage.objects.list access`).
 *
 * Setting `DEPOT_TOOLS_WIN_TOOLCHAIN=0` instructs Chromium to use the locally
 * installed Visual Studio and Windows SDK.
 *
 * Chromium 155.0.8059.40 at pinned SHA cfaadc5a132d78e1828635aa8405a499f3e14864
 * requires:
 *  - Visual Studio 2022 (v17.0 / VC143) or 2026 (v18.0 / VC145), or 2019/2017
 *    with MSVC C++ toolset (`Microsoft.VisualStudio.Component.VC.Tools.x86.x64`);
 *  - Windows SDK version 10.0.28000.0 or higher (`NTDDI_WIN11_BR` in
 *    `base/win/windows_version.cc` and `SDK_VERSION` in `build/vs_toolchain.py`);
 *  - Windows SDK headers (`um/windows.h`, `ucrt/corecrt.h`), libraries
 *    (`um/x64/kernel32.lib`, `ucrt/x64/ucrt.lib`), and Debugging Tools for
 *    Windows (`Debuggers/x64/dbghelp.dll`);
 *  - DIA SDK (`DIA SDK/bin/amd64/msdia140.dll`).
 *
 * This module detects and validates all required components before expensive
 * source synchronization begins, failing fast with status `BLOCKED` if any
 * requirement is missing or incompatible.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  readdirSync as fsReaddirSync,
} from 'node:fs';
import path from 'node:path';

/** Minimum Windows SDK version required by Chromium 155. */
export const REQUIRED_SDK_VERSION = '10.0.28000.0';

/** Required Visual Studio component for C++ x64 compilation. */
export const REQUIRED_VS_COMPONENT =
  'Microsoft.VisualStudio.Component.VC.Tools.x86.x64';

/** Supported Visual Studio versions in descending priority order. */
export const SUPPORTED_VS_VERSIONS = Object.freeze([
  '2026',
  '2022',
  '2019',
  '2017',
]);

/** Visual Studio edition directory names. */
export const VS_EDITIONS = Object.freeze([
  'Enterprise',
  'Professional',
  'Community',
  'Preview',
  'Insiders',
  'BuildTools',
]);

function getPath(platform) {
  return platform === 'win32' ? path.win32 : path;
}

/**
 * Parse a version string into an array of integer numbers.
 *
 * E.g., '10.0.28000.0' -> [10, 0, 28000, 0]
 *
 * @param {string} versionString
 * @returns {number[]}
 */
export function parseVersion(versionString) {
  if (typeof versionString !== 'string' || versionString.trim().length === 0) {
    return [];
  }
  const parts = versionString.trim().split(/[._-]/);
  const result = [];
  for (const part of parts) {
    const match = /^\d+/.exec(part);
    if (match !== null) {
      result.push(Number.parseInt(match[0], 10));
    }
  }
  return result;
}

/**
 * Compare two version tuples element-by-element.
 *
 * @param {number[]} v1
 * @param {number[]} v2
 * @returns {number} 1 if v1 > v2, -1 if v1 < v2, 0 if equal
 */
export function compareVersions(v1, v2) {
  const length = Math.max(v1.length, v2.length);
  for (let i = 0; i < length; i += 1) {
    const p1 = v1[i] ?? 0;
    const p2 = v2[i] ?? 0;
    if (p1 > p2) return 1;
    if (p1 < p2) return -1;
  }
  return 0;
}

/**
 * Check whether an installed SDK version meets or exceeds the required version.
 *
 * @param {string} installed
 * @param {string} [required]
 * @returns {boolean}
 */
export function isSdkVersionCompatible(
  installed,
  required = REQUIRED_SDK_VERSION,
) {
  if (typeof installed !== 'string') {
    return false;
  }
  const parsedInstalled = parseVersion(installed);
  const parsedRequired = parseVersion(required);
  if (parsedInstalled.length === 0 || parsedRequired.length === 0) {
    return false;
  }
  return compareVersions(parsedInstalled, parsedRequired) >= 0;
}

/**
 * Locate the `vswhere.exe` installer query utility.
 *
 * @param {object} [options]
 * @param {object} [options.env]
 * @param {string} [options.platform]
 * @param {Function} [options.exists]
 * @returns {string|null}
 */
export function findVswhereExecutable({
  env = process.env,
  platform = process.platform,
  exists = existsSync,
} = {}) {
  const p = getPath(platform);
  const programFilesX86 = env['ProgramFiles(x86)'];
  const programFiles = env.ProgramFiles;
  const candidates = [
    programFilesX86 !== undefined
      ? p.join(
          programFilesX86,
          'Microsoft Visual Studio',
          'Installer',
          'vswhere.exe',
        )
      : null,
    programFiles !== undefined
      ? p.join(
          programFiles,
          'Microsoft Visual Studio',
          'Installer',
          'vswhere.exe',
        )
      : null,
    'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe',
    'C:\\Program Files\\Microsoft Visual Studio\\Installer\\vswhere.exe',
  ].filter((value) => value !== null);

  for (const candidate of candidates) {
    try {
      if (exists(candidate)) {
        return candidate;
      }
    } catch {
      // Ignore filesystem probe error
    }
  }
  return null;
}

/**
 * Generate candidate filesystem paths where Visual Studio might be installed.
 *
 * @param {object} [options]
 * @param {object} [options.env]
 * @param {string} [options.platform]
 * @returns {string[]}
 */
export function candidateVisualStudioPaths({
  env = process.env,
  platform = process.platform,
} = {}) {
  const p = getPath(platform);
  const candidates = [];

  if (env.GYP_MSVS_OVERRIDE_PATH) {
    candidates.push(env.GYP_MSVS_OVERRIDE_PATH);
  }
  for (const version of SUPPORTED_VS_VERSIONS) {
    const envKey = `vs${version}_install`;
    if (env[envKey]) {
      candidates.push(env[envKey]);
    }
  }
  if (env.VSINSTALLDIR) {
    candidates.push(env.VSINSTALLDIR);
  }

  const programFiles = env.ProgramFiles ?? 'C:\\Program Files';
  const programFilesX86 =
    env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';

  const roots = [
    { base: programFiles, year: '2026', folder: '18' },
    { base: programFiles, year: '2022', folder: '2022' },
    { base: programFilesX86, year: '2019', folder: '2019' },
    { base: programFilesX86, year: '2017', folder: '2017' },
  ];

  for (const { base, folder } of roots) {
    const parent = p.join(base, 'Microsoft Visual Studio', folder);
    for (const edition of VS_EDITIONS) {
      candidates.push(p.join(parent, edition));
    }
  }

  return [...new Set(candidates)];
}

/**
 * Detect Visual Studio installation and MSVC C++ toolset.
 *
 * @param {object} [options]
 * @param {object} [options.env]
 * @param {string} [options.platform]
 * @param {Function} [options.spawn]
 * @param {Function} [options.exists]
 * @param {Function} [options.readdirSync]
 * @returns {{installationPath: string|null, version: string|null, displayName: string|null, vcvarsallBat: string|null, msvcToolsetVersion: string|null, msvcDir: string|null, clExe: string|null, diaSdkDll: string|null, ok: boolean, problems: string[], notes: string[]}|null}
 */
export function detectVisualStudio({
  env = process.env,
  platform = process.platform,
  spawn = spawnSync,
  exists = existsSync,
  readdirSync = fsReaddirSync,
} = {}) {
  if (platform !== 'win32') {
    return null;
  }

  const p = getPath(platform);
  let installationPath = null;
  let installationVersion = null;
  let displayName = null;
  const problems = [];
  const notes = [];

  // 1. Try vswhere.exe
  const vswhere = findVswhereExecutable({ env, platform, exists });
  if (vswhere !== null) {
    try {
      const result = spawn(
        vswhere,
        [
          '-latest',
          '-products',
          '*',
          '-requires',
          REQUIRED_VS_COMPONENT,
          '-format',
          'json',
          '-utf8',
        ],
        { encoding: 'utf8', env },
      );
      if (result.status === 0 && result.stdout) {
        const parsed = JSON.parse(result.stdout.trim());
        const instance = Array.isArray(parsed) ? parsed[0] : parsed;
        if (instance?.installationPath) {
          installationPath = instance.installationPath;
          installationVersion = instance.installationVersion ?? null;
          displayName = instance.displayName ?? null;
        }
      }
    } catch {
      // JSON parse or spawn failure: fall back to candidate paths
    }
  }

  // 2. Fall back to candidate directory inspection
  if (installationPath === null) {
    const candidates = candidateVisualStudioPaths({ env, platform });
    for (const candidate of candidates) {
      try {
        if (exists(candidate)) {
          const vcvars = p.join(
            candidate,
            'VC',
            'Auxiliary',
            'Build',
            'vcvarsall.bat',
          );
          const legacyVcvars = p.join(candidate, 'VC', 'vcvarsall.bat');
          if (exists(vcvars) || exists(legacyVcvars)) {
            installationPath = candidate;
            break;
          }
        }
      } catch {
        // Skip inaccessible path
      }
    }
  }

  if (installationPath === null) {
    problems.push(
      'Visual Studio with C++ x64 toolchain (VC.Tools.x86.x64) was not found',
    );
    return {
      installationPath: null,
      version: null,
      displayName: null,
      vcvarsallBat: null,
      msvcToolsetVersion: null,
      msvcDir: null,
      clExe: null,
      diaSdkDll: null,
      ok: false,
      problems,
      notes,
    };
  }

  // Check vcvarsall.bat
  const vcvarsall = p.join(
    installationPath,
    'VC',
    'Auxiliary',
    'Build',
    'vcvarsall.bat',
  );
  const legacyVcvarsall = p.join(installationPath, 'VC', 'vcvarsall.bat');
  let vcvarsallBat = null;
  if (exists(vcvarsall)) {
    vcvarsallBat = vcvarsall;
  } else if (exists(legacyVcvarsall)) {
    vcvarsallBat = legacyVcvarsall;
  } else {
    problems.push(
      `vcvarsall.bat not found in Visual Studio directory: ${installationPath}`,
    );
  }

  // Check MSVC toolset versions
  const msvcToolsRoot = p.join(installationPath, 'VC', 'Tools', 'MSVC');
  let msvcToolsetVersion = null;
  let msvcDir = null;
  let clExe = null;

  try {
    const toolsetDirs = readdirSync(msvcToolsRoot);
    if (Array.isArray(toolsetDirs) && toolsetDirs.length > 0) {
      const sorted = [...toolsetDirs].sort((a, b) =>
        compareVersions(parseVersion(b), parseVersion(a)),
      );
      for (const candidateVersion of sorted) {
        const candidateDir = p.join(msvcToolsRoot, candidateVersion);
        const hostX64Cl = p.join(
          candidateDir,
          'bin',
          'Hostx64',
          'x64',
          'cl.exe',
        );
        const hostX86Cl = p.join(
          candidateDir,
          'bin',
          'Hostx86',
          'x64',
          'cl.exe',
        );
        if (exists(hostX64Cl)) {
          msvcToolsetVersion = candidateVersion;
          msvcDir = candidateDir;
          clExe = hostX64Cl;
          break;
        } else if (exists(hostX86Cl)) {
          msvcToolsetVersion = candidateVersion;
          msvcDir = candidateDir;
          clExe = hostX86Cl;
          break;
        }
      }
      if (clExe === null) {
        msvcToolsetVersion = sorted[0];
        msvcDir = p.join(msvcToolsRoot, msvcToolsetVersion);
        problems.push(
          `MSVC compiler cl.exe not found under ${msvcDir}\\bin`,
        );
      }
    } else {
      problems.push(
        `No MSVC toolset versions found in ${msvcToolsRoot}`,
      );
    }
  } catch (error) {
    problems.push(
      `Failed to inspect MSVC toolset directory ${msvcToolsRoot}: ${error.message}`,
    );
  }

  // Check DIA SDK msdia140.dll
  const diaSdkDllAmd64 = p.join(
    installationPath,
    'DIA SDK',
    'bin',
    'amd64',
    'msdia140.dll',
  );
  const diaSdkDllGeneric = p.join(
    installationPath,
    'DIA SDK',
    'bin',
    'msdia140.dll',
  );
  let diaSdkDll = null;
  if (exists(diaSdkDllAmd64)) {
    diaSdkDll = diaSdkDllAmd64;
  } else if (exists(diaSdkDllGeneric)) {
    diaSdkDll = diaSdkDllGeneric;
  } else {
    notes.push(
      'DIA SDK msdia140.dll not found in Visual Studio (Chromium debugger symbolization may fall back)',
    );
  }

  return {
    installationPath,
    version: installationVersion,
    displayName,
    vcvarsallBat,
    msvcToolsetVersion,
    msvcDir,
    clExe,
    diaSdkDll,
    ok: problems.length === 0,
    problems,
    notes,
  };
}

/**
 * Generate candidate root directories for Windows Kits / SDK.
 *
 * @param {object} [options]
 * @param {object} [options.env]
 * @param {string} [options.platform]
 * @returns {string[]}
 */
export function candidateWindowsSdkPaths({
  env = process.env,
  platform = process.platform,
} = {}) {
  const p = getPath(platform);
  const candidates = [];
  if (env.WINDOWSSDKDIR) {
    candidates.push(env.WINDOWSSDKDIR);
  }
  const programFilesX86 =
    env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const programFiles = env.ProgramFiles ?? 'C:\\Program Files';

  candidates.push(
    p.join(programFilesX86, 'Windows Kits', '10'),
    p.join(programFiles, 'Windows Kits', '10'),
  );

  return [...new Set(candidates)];
}

/**
 * Detect installed Windows SDK and verify headers, libraries, and tools.
 *
 * @param {object} [options]
 * @param {object} [options.env]
 * @param {string} [options.platform]
 * @param {Function} [options.exists]
 * @param {Function} [options.readdirSync]
 * @param {string} [options.requiredVersion]
 * @returns {{sdkDir: string|null, installedVersions: string[], selectedVersion: string|null, requiredVersion: string, isCompatible: boolean, headersOk: boolean, libsOk: boolean, debuggersOk: boolean, ok: boolean, problems: string[], notes: string[]}|null}
 */
export function detectWindowsSdk({
  env = process.env,
  platform = process.platform,
  exists = existsSync,
  readdirSync = fsReaddirSync,
  requiredVersion = REQUIRED_SDK_VERSION,
} = {}) {
  if (platform !== 'win32') {
    return null;
  }

  const p = getPath(platform);
  const problems = [];
  const notes = [];
  const candidateDirs = candidateWindowsSdkPaths({ env, platform });
  let sdkDir = null;

  for (const candidate of candidateDirs) {
    try {
      if (exists(candidate) && exists(p.join(candidate, 'Include'))) {
        sdkDir = candidate;
        break;
      }
    } catch {
      // Skip inaccessible candidate
    }
  }

  if (sdkDir === null) {
    problems.push(
      `Windows 10/11 SDK was not found in candidate paths (${candidateDirs.join(', ')})`,
    );
    return {
      sdkDir: null,
      installedVersions: [],
      selectedVersion: null,
      requiredVersion,
      isCompatible: false,
      headersOk: false,
      libsOk: false,
      debuggersOk: false,
      ok: false,
      problems,
      notes,
    };
  }

  const includeRoot = p.join(sdkDir, 'Include');
  let installedVersions = [];
  try {
    const entries = readdirSync(includeRoot);
    if (Array.isArray(entries)) {
      installedVersions = entries.filter((entry) => {
        return (
          entry.startsWith('10.') &&
          exists(p.join(includeRoot, entry, 'um'))
        );
      });
      installedVersions.sort((a, b) =>
        compareVersions(parseVersion(b), parseVersion(a)),
      );
    }
  } catch (error) {
    problems.push(
      `Failed to list Windows SDK include directory ${includeRoot}: ${error.message}`,
    );
  }

  if (installedVersions.length === 0) {
    problems.push(
      `No Windows 10/11 SDK versions found under ${includeRoot}`,
    );
    return {
      sdkDir,
      installedVersions: [],
      selectedVersion: null,
      requiredVersion,
      isCompatible: false,
      headersOk: false,
      libsOk: false,
      debuggersOk: false,
      ok: false,
      problems,
      notes,
    };
  }

  // Select preferred version (or env override if present)
  let selectedVersion = installedVersions[0];
  if (
    env.WINDOWSSDKVERSION &&
    installedVersions.includes(env.WINDOWSSDKVERSION.replace(/[\\/]$/, ''))
  ) {
    selectedVersion = env.WINDOWSSDKVERSION.replace(/[\\/]$/, '');
  }

  const isCompatible = isSdkVersionCompatible(selectedVersion, requiredVersion);
  if (!isCompatible) {
    problems.push(
      `Installed Windows SDK version ${selectedVersion} is older than required ${requiredVersion} for Chromium 155`,
    );
  }

  // Verify headers
  const windowsH = p.join(
    includeRoot,
    selectedVersion,
    'um',
    'windows.h',
  );
  const corecrtH = p.join(
    includeRoot,
    selectedVersion,
    'ucrt',
    'corecrt.h',
  );
  const headersOk = exists(windowsH) && exists(corecrtH);
  if (!headersOk) {
    problems.push(
      `Windows SDK ${selectedVersion} missing required headers (windows.h or corecrt.h)`,
    );
  }

  // Verify libraries
  const libRoot = p.join(sdkDir, 'Lib', selectedVersion);
  const kernel32Lib = p.join(libRoot, 'um', 'x64', 'kernel32.lib');
  const ucrtLib = p.join(libRoot, 'ucrt', 'x64', 'ucrt.lib');
  const libsOk = exists(kernel32Lib) && exists(ucrtLib);
  if (!libsOk) {
    problems.push(
      `Windows SDK ${selectedVersion} missing required x64 libraries (kernel32.lib or ucrt.lib)`,
    );
  }

  // Verify Debuggers (Debugging Tools for Windows)
  const dbghelp = p.join(
    sdkDir,
    'Debuggers',
    'x64',
    'dbghelp.dll',
  );
  const debuggersOk = exists(dbghelp);
  if (!debuggersOk) {
    notes.push(
      `Windows SDK Debugging Tools (Debuggers\\x64\\dbghelp.dll) not found in ${sdkDir}`,
    );
  }

  return {
    sdkDir,
    installedVersions,
    selectedVersion,
    requiredVersion,
    isCompatible,
    headersOk,
    libsOk,
    debuggersOk,
    ok: problems.length === 0,
    problems,
    notes,
  };
}

/**
 * Perform complete Windows toolchain inspection.
 *
 * @param {object} [options]
 * @param {object} [options.env]
 * @param {string} [options.platform]
 * @param {Function} [options.spawn]
 * @param {Function} [options.exists]
 * @param {Function} [options.readdirSync]
 * @returns {{platform: string, depotToolsWinToolchain: string|null, vs: object|null, sdk: object|null, ok: boolean, problems: string[], notes: string[]}}
 */
export function detectWindowsToolchain({
  env = process.env,
  platform = process.platform,
  spawn = spawnSync,
  exists = existsSync,
  readdirSync = fsReaddirSync,
} = {}) {
  const problems = [];
  const notes = [];
  const depotToolsWinToolchain = env.DEPOT_TOOLS_WIN_TOOLCHAIN ?? null;

  if (platform !== 'win32') {
    return {
      platform,
      depotToolsWinToolchain,
      vs: null,
      sdk: null,
      ok: true,
      problems: [],
      notes: [],
    };
  }

  if (depotToolsWinToolchain !== '0') {
    notes.push(
      `DEPOT_TOOLS_WIN_TOOLCHAIN is "${depotToolsWinToolchain ?? 'unset'}"; should be "0" for local toolchain builds`,
    );
  }

  const vs = detectVisualStudio({ env, platform, spawn, exists, readdirSync });
  if (vs !== null) {
    problems.push(...vs.problems);
    notes.push(...vs.notes);
  }

  const sdk = detectWindowsSdk({ env, platform, exists, readdirSync });
  if (sdk !== null) {
    problems.push(...sdk.problems);
    notes.push(...sdk.notes);
  }

  return {
    platform,
    depotToolsWinToolchain,
    vs,
    sdk,
    ok: problems.length === 0,
    problems,
    notes,
  };
}

/**
 * Return human-readable diagnostic lines describing the Windows toolchain
 * without exposing any secrets or sensitive environment values.
 *
 * @param {object} [options]
 * @param {object} [options.env]
 * @param {string} [options.platform]
 * @param {Function} [options.spawn]
 * @param {Function} [options.exists]
 * @param {Function} [options.readdirSync]
 * @returns {{lines: string[], problems: string[], notes: string[]}}
 */
export function describeWindowsToolchain({
  env = process.env,
  platform = process.platform,
  spawn = spawnSync,
  exists = existsSync,
  readdirSync = fsReaddirSync,
} = {}) {
  const lines = [];
  const toolchain = detectWindowsToolchain({
    env,
    platform,
    spawn,
    exists,
    readdirSync,
  });

  const toolchainVar = env.DEPOT_TOOLS_WIN_TOOLCHAIN;
  lines.push(
    `DEPOT_TOOLS_WIN_TOOLCHAIN: ${
      toolchainVar !== undefined
        ? `${toolchainVar} (${
            toolchainVar === '0'
              ? 'use system Visual Studio / SDK toolchain'
              : 'download hermetic toolchain from Google Cloud Storage'
          })`
        : 'UNSET (defaults to hermetic download in depot_tools)'
    }`,
  );

  if (platform === 'win32') {
    if (toolchain.vs?.installationPath) {
      lines.push(
        `visual studio: ${toolchain.vs.installationPath}${
          toolchain.vs.version ? ` (${toolchain.vs.version})` : ''
        }`,
      );
      if (toolchain.vs.msvcToolsetVersion && toolchain.vs.clExe) {
        lines.push(
          `msvc toolset: ${toolchain.vs.msvcToolsetVersion} (cl.exe: ${toolchain.vs.clExe})`,
        );
      } else {
        lines.push('msvc toolset: NOT FOUND');
      }
      lines.push(
        `vcvarsall.bat: ${toolchain.vs.vcvarsallBat ?? 'NOT FOUND'}`,
      );
    } else {
      lines.push('visual studio: NOT FOUND');
    }

    if (toolchain.sdk?.sdkDir) {
      lines.push(
        `windows sdk: ${toolchain.sdk.selectedVersion ?? 'UNKNOWN'} (${toolchain.sdk.sdkDir})`,
      );
      lines.push(
        `windows sdk compatibility: ${
          toolchain.sdk.isCompatible
            ? `COMPATIBLE (>= ${REQUIRED_SDK_VERSION})`
            : `INCOMPATIBLE (requires >= ${REQUIRED_SDK_VERSION})`
        }`,
      );
      lines.push(
        `windows sdk headers: ${toolchain.sdk.headersOk ? 'OK' : 'MISSING'}`,
      );
      lines.push(
        `windows sdk libraries: ${toolchain.sdk.libsOk ? 'OK' : 'MISSING'}`,
      );
      lines.push(
        `windows sdk debuggers: ${
          toolchain.sdk.debuggersOk ? 'OK' : 'NOT FOUND'
        }`,
      );
    } else {
      lines.push('windows sdk: NOT FOUND');
    }
  }

  return {
    lines,
    problems: toolchain.problems,
    notes: toolchain.notes,
  };
}
