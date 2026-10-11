/**
 * Windows toolchain and SDK pre-sync validation tests.
 *
 * These unit tests verify Visual Studio detection, MSVC compiler resolution,
 * Windows SDK compatibility checking (Chromium 155 requires SDK >= 10.0.28000.0),
 * DEPOT_TOOLS_WIN_TOOLCHAIN=0 propagation, and safe diagnostic output.
 *
 * Designed to run deterministically on Linux runners without requiring a live
 * Windows environment or Chromium checkout.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  candidateVisualStudioPaths,
  candidateWindowsSdkPaths,
  compareVersions,
  describeWindowsToolchain,
  detectVisualStudio,
  detectWindowsSdk,
  detectWindowsToolchain,
  findVswhereExecutable,
  GN_ONLY_REQUIRES_REQUIRED_SDK,
  isSdkVersionCompatible,
  MINIMUM_DEBUGGERS_VERSION,
  parseVersion,
  PREFERRED_SDK_SUBVERSION,
  REQUIRED_NTDDI_MACRO,
  REQUIRED_SDK_VERSION,
  REQUIRED_VS_COMPONENT,
  SUPPORTED_VS_VERSIONS,
  verifyWindowsSdkInstallation,
} from '../../tools/chromium/lib/windows-toolchain.mjs';
import { checkBuilder } from '../../tools/ci/check-builder.mjs';
import { toolingDiagnostics } from '../../tools/chromium/sync.mjs';
import { loadConfig, REPO_ROOT } from '../../tools/chromium/lib/config.mjs';

const MOCK_VS_PATH =
  'C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise';
const MOCK_SDK_PATH = 'C:\\Program Files (x86)\\Windows Kits\\10';

function mockVsFiles() {
  return new Set([
    MOCK_VS_PATH,
    `${MOCK_VS_PATH}\\VC`,
    `${MOCK_VS_PATH}\\VC\\Auxiliary\\Build\\vcvarsall.bat`,
    `${MOCK_VS_PATH}\\VC\\Tools\\MSVC`,
    `${MOCK_VS_PATH}\\VC\\Tools\\MSVC\\14.42.34433`,
    `${MOCK_VS_PATH}\\VC\\Tools\\MSVC\\14.42.34433\\bin\\Hostx64\\x64\\cl.exe`,
    `${MOCK_VS_PATH}\\DIA SDK\\bin\\amd64\\msdia140.dll`,
    'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe',
  ]);
}

function mockSdkFiles(sdkVersion = '10.0.28000.0') {
  return new Set([
    MOCK_SDK_PATH,
    `${MOCK_SDK_PATH}\\Include`,
    `${MOCK_SDK_PATH}\\Include\\${sdkVersion}`,
    `${MOCK_SDK_PATH}\\Include\\${sdkVersion}\\um`,
    `${MOCK_SDK_PATH}\\Include\\${sdkVersion}\\um\\windows.h`,
    `${MOCK_SDK_PATH}\\Include\\${sdkVersion}\\ucrt\\corecrt.h`,
    `${MOCK_SDK_PATH}\\Lib`,
    `${MOCK_SDK_PATH}\\Lib\\${sdkVersion}`,
    `${MOCK_SDK_PATH}\\Lib\\${sdkVersion}\\um\\x64\\kernel32.lib`,
    `${MOCK_SDK_PATH}\\Lib\\${sdkVersion}\\ucrt\\x64\\ucrt.lib`,
    `${MOCK_SDK_PATH}\\Debuggers\\x64\\dbghelp.dll`,
  ]);
}

function createMockFs({
  vsFiles = mockVsFiles(),
  sdkFiles = mockSdkFiles(),
} = {}) {
  const allFiles = new Set([...vsFiles, ...sdkFiles]);
  const exists = (candidate) => {
    if (typeof candidate !== 'string') return false;
    const normalized = candidate.replaceAll('/', '\\');
    return allFiles.has(normalized);
  };
  const readdirSync = (dir) => {
    const normalizedDir = dir.replaceAll('/', '\\');
    if (normalizedDir.endsWith('VC\\Tools\\MSVC')) {
      return ['14.42.34433', '14.40.33807'];
    }
    if (normalizedDir.endsWith('Windows Kits\\10\\Include')) {
      return ['10.0.28000.0', '10.0.26100.0'];
    }
    return [];
  };
  return { exists, readdirSync };
}

function mockVswhereSpawn(file) {
  if (file.includes('vswhere.exe')) {
    return {
      error: undefined,
      status: 0,
      stdout: JSON.stringify([
        {
          instanceId: 'mock123',
          installationPath: MOCK_VS_PATH,
          installationVersion: '17.12.35527.113',
          displayName: 'Visual Studio Enterprise 2022',
        },
      ]),
      stderr: '',
    };
  }
  return { error: undefined, status: 1, stdout: '', stderr: '' };
}

describe('version parsing and comparison', () => {
  it('defines required component constants', () => {
    expect(REQUIRED_VS_COMPONENT).toBe(
      'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
    );
    expect(SUPPORTED_VS_VERSIONS).toEqual(['2026', '2022', '2019', '2017']);
  });

  it('parses version strings into number arrays', () => {
    expect(parseVersion('10.0.28000.0')).toEqual([10, 0, 28000, 0]);
    expect(parseVersion('17.12.35527.113')).toEqual([17, 12, 35527, 113]);
    expect(parseVersion('14.42.34433')).toEqual([14, 42, 34433]);
    expect(parseVersion('')).toEqual([]);
    expect(parseVersion(null)).toEqual([]);
  });

  it('compares versions accurately', () => {
    expect(compareVersions([10, 0, 28000, 0], [10, 0, 26100, 0])).toBe(1);
    expect(compareVersions([10, 0, 26100, 0], [10, 0, 28000, 0])).toBe(-1);
    expect(compareVersions([10, 0, 28000, 0], [10, 0, 28000, 0])).toBe(0);
    expect(compareVersions([10, 0, 28000, 1], [10, 0, 28000])).toBe(1);
  });

  it('validates Windows SDK compatibility for Chromium 155', () => {
    expect(REQUIRED_SDK_VERSION).toBe('10.0.28000.0');
    expect(isSdkVersionCompatible('10.0.28000.0')).toBe(true);
    expect(isSdkVersionCompatible('10.0.28000.2270')).toBe(true);
    expect(isSdkVersionCompatible('10.0.28100.0')).toBe(true);
    expect(isSdkVersionCompatible('10.0.26100.0')).toBe(false);
    expect(isSdkVersionCompatible('10.0.22621.0')).toBe(false);
    expect(isSdkVersionCompatible('10.0.19041.0')).toBe(false);
    expect(isSdkVersionCompatible(null)).toBe(false);
  });
});

describe('candidate paths generation', () => {
  it('generates candidate Visual Studio paths including environment overrides', () => {
    const paths = candidateVisualStudioPaths({
      env: {
        GYP_MSVS_OVERRIDE_PATH: 'D:\\custom\\vs',
        vs2022_install: 'C:\\vs2022',
        ProgramFiles: 'C:\\Program Files',
        'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      },
      platform: 'win32',
    });
    expect(paths).toContain('D:\\custom\\vs');
    expect(paths).toContain('C:\\vs2022');
    expect(paths).toContain(
      'C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise',
    );
  });

  it('generates candidate Windows SDK paths including WINDOWSSDKDIR override', () => {
    const paths = candidateWindowsSdkPaths({
      env: {
        WINDOWSSDKDIR: 'D:\\custom\\sdk',
        'ProgramFiles(x86)': 'C:\\Program Files (x86)',
        ProgramFiles: 'C:\\Program Files',
      },
      platform: 'win32',
    });
    expect(paths).toContain('D:\\custom\\sdk');
    expect(paths).toContain('C:\\Program Files (x86)\\Windows Kits\\10');
  });
});

describe('Visual Studio toolchain detection', () => {
  it('returns null on non-Windows platforms', () => {
    expect(detectVisualStudio({ platform: 'linux' })).toBeNull();
  });

  it('finds vswhere.exe when present', () => {
    const { exists } = createMockFs();
    expect(
      findVswhereExecutable({
        env: { 'ProgramFiles(x86)': 'C:\\Program Files (x86)' },
        platform: 'win32',
        exists,
      }),
    ).toBe(
      'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe',
    );
  });

  it('detects Visual Studio installation through vswhere and verifies MSVC tools', () => {
    const { exists, readdirSync } = createMockFs();
    const vs = detectVisualStudio({
      env: { 'ProgramFiles(x86)': 'C:\\Program Files (x86)' },
      platform: 'win32',
      spawn: mockVswhereSpawn,
      exists,
      readdirSync,
    });

    expect(vs).not.toBeNull();
    expect(vs.ok).toBe(true);
    expect(vs.installationPath).toBe(MOCK_VS_PATH);
    expect(vs.version).toBe('17.12.35527.113');
    expect(vs.msvcToolsetVersion).toBe('14.42.34433');
    expect(vs.clExe).toBe(
      `${MOCK_VS_PATH}\\VC\\Tools\\MSVC\\14.42.34433\\bin\\Hostx64\\x64\\cl.exe`,
    );
    expect(vs.vcvarsallBat).toBe(
      `${MOCK_VS_PATH}\\VC\\Auxiliary\\Build\\vcvarsall.bat`,
    );
    expect(vs.diaSdkDll).toBe(
      `${MOCK_VS_PATH}\\DIA SDK\\bin\\amd64\\msdia140.dll`,
    );
    expect(vs.problems).toEqual([]);
  });

  it('falls back to candidate paths when vswhere is unavailable', () => {
    const { exists, readdirSync } = createMockFs();
    const vs = detectVisualStudio({
      env: { ProgramFiles: 'C:\\Program Files' },
      platform: 'win32',
      spawn: () => ({ error: undefined, status: 1, stdout: '', stderr: '' }),
      exists,
      readdirSync,
    });

    expect(vs).not.toBeNull();
    expect(vs.installationPath).toBe(MOCK_VS_PATH);
    expect(vs.msvcToolsetVersion).toBe('14.42.34433');
    expect(vs.ok).toBe(true);
  });

  it('reports failure when Visual Studio is not installed', () => {
    const vs = detectVisualStudio({
      env: {},
      platform: 'win32',
      spawn: () => ({ error: undefined, status: 1, stdout: '', stderr: '' }),
      exists: () => false,
      readdirSync: () => [],
    });

    expect(vs).not.toBeNull();
    expect(vs.ok).toBe(false);
    expect(vs.installationPath).toBeNull();
    expect(vs.problems.join('; ')).toContain(
      'Visual Studio with C++ x64 toolchain',
    );
  });

  it('reports failure when MSVC cl.exe is missing from Visual Studio', () => {
    const vsFiles = new Set([
      MOCK_VS_PATH,
      `${MOCK_VS_PATH}\\VC`,
      `${MOCK_VS_PATH}\\VC\\Auxiliary\\Build\\vcvarsall.bat`,
      `${MOCK_VS_PATH}\\VC\\Tools\\MSVC`,
      `${MOCK_VS_PATH}\\VC\\Tools\\MSVC\\14.42.34433`,
      // cl.exe is omitted
    ]);
    const { exists } = createMockFs({ vsFiles });
    const vs = detectVisualStudio({
      env: { ProgramFiles: 'C:\\Program Files' },
      platform: 'win32',
      spawn: mockVswhereSpawn,
      exists,
      readdirSync: () => ['14.42.34433'],
    });

    expect(vs.ok).toBe(false);
    expect(vs.problems.join('; ')).toContain('cl.exe not found');
  });
});

describe('Windows SDK detection', () => {
  it('returns null on non-Windows platforms', () => {
    expect(detectWindowsSdk({ platform: 'linux' })).toBeNull();
  });

  it('detects compatible Windows SDK and verifies headers and libraries', () => {
    const { exists, readdirSync } = createMockFs();
    const sdk = detectWindowsSdk({
      env: { 'ProgramFiles(x86)': 'C:\\Program Files (x86)' },
      platform: 'win32',
      exists,
      readdirSync,
    });

    expect(sdk).not.toBeNull();
    expect(sdk.ok).toBe(true);
    expect(sdk.sdkDir).toBe(MOCK_SDK_PATH);
    expect(sdk.selectedVersion).toBe('10.0.28000.0');
    expect(sdk.isCompatible).toBe(true);
    expect(sdk.headersOk).toBe(true);
    expect(sdk.libsOk).toBe(true);
    expect(sdk.debuggersOk).toBe(true);
    expect(sdk.problems).toEqual([]);
  });

  it('flags an outdated Windows SDK as incompatible for Chromium 155', () => {
    const sdkFiles = mockSdkFiles('10.0.26100.0');
    const { exists } = createMockFs({ sdkFiles });
    const sdk = detectWindowsSdk({
      env: { 'ProgramFiles(x86)': 'C:\\Program Files (x86)' },
      platform: 'win32',
      exists,
      readdirSync: () => ['10.0.26100.0'],
    });

    expect(sdk.ok).toBe(false);
    expect(sdk.selectedVersion).toBe('10.0.26100.0');
    expect(sdk.isCompatible).toBe(false);
    expect(sdk.problems.join('; ')).toContain(
      'older than required 10.0.28000.0',
    );
  });

  it('reports failure when Windows SDK root directory does not exist', () => {
    const sdk = detectWindowsSdk({
      env: {},
      platform: 'win32',
      exists: () => false,
      readdirSync: () => [],
    });

    expect(sdk.ok).toBe(false);
    expect(sdk.sdkDir).toBeNull();
    expect(sdk.problems.join('; ')).toContain(
      'Windows 10/11 SDK was not found',
    );
  });

  it('reports failure when Windows SDK headers or libraries are missing', () => {
    const sdkFiles = new Set([
      MOCK_SDK_PATH,
      `${MOCK_SDK_PATH}\\Include`,
      `${MOCK_SDK_PATH}\\Include\\10.0.28000.0`,
      `${MOCK_SDK_PATH}\\Include\\10.0.28000.0\\um`,
      // windows.h and kernel32.lib are omitted
    ]);
    const { exists } = createMockFs({ sdkFiles });
    const sdk = detectWindowsSdk({
      env: { 'ProgramFiles(x86)': 'C:\\Program Files (x86)' },
      platform: 'win32',
      exists,
      readdirSync: () => ['10.0.28000.0'],
    });

    expect(sdk.ok).toBe(false);
    expect(sdk.headersOk).toBe(false);
    expect(sdk.libsOk).toBe(false);
    expect(sdk.problems.join('; ')).toContain('missing required headers');
    expect(sdk.problems.join('; ')).toContain('missing required x64 libraries');
  });
});

describe('complete Windows toolchain diagnostics', () => {
  it('reports safe diagnostics with tool paths, versions, and no secrets', () => {
    const { exists, readdirSync } = createMockFs();
    const tokenFixture = ['bearer', 'redacted', 'fixtureValue'].join('_');
    const report = describeWindowsToolchain({
      env: {
        'ProgramFiles(x86)': 'C:\\Program Files (x86)',
        ProgramFiles: 'C:\\Program Files',
        DEPOT_TOOLS_WIN_TOOLCHAIN: '0',
        GITHUB_TOKEN: tokenFixture,
      },
      platform: 'win32',
      spawn: mockVswhereSpawn,
      exists,
      readdirSync,
    });

    const text = report.lines.join('\n');
    expect(text).toContain('DEPOT_TOOLS_WIN_TOOLCHAIN: 0');
    expect(text).toContain('use system Visual Studio / SDK toolchain');
    expect(text).toContain(
      'visual studio: C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise',
    );
    expect(text).toContain('msvc toolset: 14.42.34433');
    expect(text).toContain('cl.exe');
    expect(text).toContain('windows sdk: 10.0.28000.0');
    expect(text).toContain('COMPATIBLE (>= 10.0.28000.0)');
    expect(text).toContain('windows sdk headers: OK');
    expect(text).toContain('windows sdk libraries: OK');
    expect(text).toContain('windows sdk debuggers: OK');
    expect(text).not.toContain(tokenFixture);
    expect(report.problems).toEqual([]);
  });

  it('detects when DEPOT_TOOLS_WIN_TOOLCHAIN is unset or set to 1', () => {
    const { exists, readdirSync } = createMockFs();
    const toolchain = detectWindowsToolchain({
      env: {
        'ProgramFiles(x86)': 'C:\\Program Files (x86)',
        ProgramFiles: 'C:\\Program Files',
        DEPOT_TOOLS_WIN_TOOLCHAIN: '1',
      },
      platform: 'win32',
      spawn: mockVswhereSpawn,
      exists,
      readdirSync,
    });

    expect(toolchain.depotToolsWinToolchain).toBe('1');
    expect(toolchain.notes.join('; ')).toContain(
      'DEPOT_TOOLS_WIN_TOOLCHAIN is "1"; should be "0"',
    );
  });
});

describe('integration with checkBuilder and sync diagnostics', () => {
  it('records toolchain capabilities in checkBuilder when on Windows', () => {
    const { exists, readdirSync } = createMockFs();
    const config = loadConfig();
    const result = checkBuilder({
      config,
      mode: 'gn',
      env: {
        'ProgramFiles(x86)': 'C:\\Program Files (x86)',
        ProgramFiles: 'C:\\Program Files',
        DEPOT_TOOLS_WIN_TOOLCHAIN: '0',
      },
      platform: 'win32',
      spawn: (file, args) =>
        file.includes('vswhere')
          ? mockVswhereSpawn(file, args)
          : {
              error: undefined,
              status: 0,
              stdout: 'v22.0.0\n',
              stderr: '',
            },
      exists,
      readdirSync,
    });

    expect(result.capabilities.depotToolsWinToolchain).toBe('0');
    expect(result.capabilities.visualStudio).toBe(MOCK_VS_PATH);
    expect(result.capabilities.msvcToolset).toBe('14.42.34433');
    expect(result.capabilities.windowsSdk).toBe('10.0.28000.0');
    expect(result.capabilities.windowsSdkDir).toBe(MOCK_SDK_PATH);
  });

  it('includes toolchain diagnostics in sync toolingDiagnostics on Windows', () => {
    const { exists, readdirSync } = createMockFs();
    const report = toolingDiagnostics({
      env: {
        'ProgramFiles(x86)': 'C:\\Program Files (x86)',
        ProgramFiles: 'C:\\Program Files',
        DEPOT_TOOLS_WIN_TOOLCHAIN: '0',
        PATH: 'C:\\Program Files\\Git\\cmd',
      },
      platform: 'win32',
      spawn: (file, args) =>
        file.includes('vswhere')
          ? mockVswhereSpawn(file, args)
          : {
              error: undefined,
              status: 0,
              stdout: 'git version 2.47.1.windows.1\n',
              stderr: '',
            },
      exists: (candidate) => candidate.includes('git.exe') || exists(candidate),
      readdirSync,
    });

    const text = report.lines.join('\n');
    expect(text).toContain('DEPOT_TOOLS_WIN_TOOLCHAIN: 0');
    expect(text).toContain('visual studio:');
    expect(text).toContain('msvc toolset:');
    expect(text).toContain('windows sdk: 10.0.28000.0');
  });

  it('verifies workflow definition includes DEPOT_TOOLS_WIN_TOOLCHAIN=0', () => {
    const workflowPath = path.join(
      REPO_ROOT,
      '.github/workflows/chromium-build.yml',
    );
    const workflow = readFileSync(workflowPath, 'utf8');
    expect(workflow).toContain("DEPOT_TOOLS_WIN_TOOLCHAIN: '0'");
  });

  it('distinguishes preferred packaged SDK release from minimum supported SDK directory version and enforces it for gn-only mode', () => {
    expect(REQUIRED_SDK_VERSION).toBe('10.0.28000.0');
    expect(PREFERRED_SDK_SUBVERSION).toBe('10.0.28000.2270');
    expect(MINIMUM_DEBUGGERS_VERSION).toBe('10.0.26100.3323');
    expect(REQUIRED_NTDDI_MACRO).toBe('NTDDI_WIN11_BR');
    expect(GN_ONLY_REQUIRES_REQUIRED_SDK).toBe(true);

    // Even in gn-only mode, SDK 10.0.26100.0 is blocked because setup_toolchain.py
    // hardcodes SDK_VERSION = '10.0.28000.0' during gn gen.
    const sdkFiles = mockSdkFiles('10.0.26100.0');
    const { exists } = createMockFs({ sdkFiles });
    const config = loadConfig();
    const result = checkBuilder({
      config,
      mode: 'gn',
      env: {
        'ProgramFiles(x86)': 'C:\\Program Files (x86)',
        ProgramFiles: 'C:\\Program Files',
        DEPOT_TOOLS_WIN_TOOLCHAIN: '0',
      },
      platform: 'win32',
      spawn: (file, args) =>
        file.includes('vswhere')
          ? mockVswhereSpawn(file, args)
          : {
              error: undefined,
              status: 0,
              stdout: 'v22.0.0\n',
              stderr: '',
            },
      exists,
      readdirSync: (dir) =>
        dir.replaceAll('/', '\\').endsWith('Windows Kits\\10\\Include')
          ? ['10.0.26100.0']
          : ['14.42.34433'],
    });
    expect(result.ok).toBe(false);
    expect(result.problems.join('; ')).toContain(
      'Installed Windows SDK version 10.0.26100.0 is older than required 10.0.28000.0',
    );
  });

  it('deeply verifies Windows SDK 10.0.28000.0 headers, NTDDI_WIN11_BR macro, x64/x86 libs, and dbghelp.dll', () => {
    const completeSet = new Set([
      ...mockSdkFiles('10.0.28000.0'),
      `${MOCK_SDK_PATH}\\Include\\10.0.28000.0\\shared\\sdkddkver.h`,
      `${MOCK_SDK_PATH}\\Lib\\10.0.28000.0\\um\\x86\\kernel32.lib`,
      `${MOCK_SDK_PATH}\\Lib\\10.0.28000.0\\ucrt\\x86\\ucrt.lib`,
    ]);
    const verification = verifyWindowsSdkInstallation({
      sdkDir: MOCK_SDK_PATH,
      version: '10.0.28000.0',
      platform: 'win32',
      exists: (candidate) => completeSet.has(candidate.replaceAll('/', '\\')),
      readText: () => '#define NTDDI_WIN11_BR 0x0A000011\n',
    });
    expect(verification.ok).toBe(true);
    expect(verification.checks).toEqual({
      versionCompatible: true,
      windowsH: true,
      corecrtH: true,
      sdkddkverH: true,
      ntddiWin11BrMacro: true,
      x64Libs: true,
      x86Libs: true,
      debuggersDll: true,
    });

    // Missing NTDDI_WIN11_BR or x86 libs fails verification
    const missingMacro = verifyWindowsSdkInstallation({
      sdkDir: MOCK_SDK_PATH,
      version: '10.0.28000.0',
      platform: 'win32',
      exists: (candidate) =>
        !candidate.includes('\\x86\\') &&
        completeSet.has(candidate.replaceAll('/', '\\')),
      readText: () => '#define NTDDI_WIN11_GE 0x0A000010\n',
    });
    expect(missingMacro.ok).toBe(false);
    expect(missingMacro.checks.ntddiWin11BrMacro).toBe(false);
    expect(missingMacro.checks.x86Libs).toBe(false);
    expect(missingMacro.problems.join('; ')).toContain('NTDDI_WIN11_BR');
    expect(missingMacro.problems.join('; ')).toContain('missing x86 libraries');
  });
});
