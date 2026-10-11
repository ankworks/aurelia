/**
 * Windows-correct process invocation.
 *
 * The build driver calls `gn`, `autoninja` and `gclient` - batch files on
 * Windows, executables elsewhere. Node 18.20+ refuses to spawn a `.bat` file
 * directly, and `shell: true` with an argument array loses the quoting of any
 * path that contains a space. These tests pin the resolution and quoting rules
 * on Linux, because the machine that actually uses them cannot run this suite.
 */
import { describe, expect, it } from 'vitest';

import {
  captureCommand,
  captureCommandBuffer,
  quoteWindowsArgument,
  resolveSpawn,
  spawnCommand,
  windowsCommandLine,
} from '../../tools/chromium/lib/exec.mjs';

describe('windows argument quoting', () => {
  it('leaves simple arguments untouched', () => {
    for (const argument of [
      'gen',
      'out/Release',
      '--args=is_debug = false'.slice(0, 8),
      'D:\\aeb\\src',
      'chrome',
      '-j',
      '2',
    ]) {
      expect(quoteWindowsArgument(argument)).toBe(argument);
    }
  });

  it('quotes arguments with spaces, quotes and trailing backslashes', () => {
    expect(quoteWindowsArgument('C:\\Program Files\\Git')).toBe(
      '"C:\\Program Files\\Git"',
    );
    expect(quoteWindowsArgument('--args=is_debug = false')).toBe(
      '"--args=is_debug = false"',
    );
    expect(quoteWindowsArgument('say "hi"')).toBe('"say \\"hi\\""');
    expect(quoteWindowsArgument('C:\\dir with space\\')).toBe(
      '"C:\\dir with space\\\\"',
    );
    expect(quoteWindowsArgument('')).toBe('""');
  });

  it('builds one command line for cmd.exe', () => {
    expect(windowsCommandLine('gn', ['gen', 'out/Release'])).toBe(
      'gn gen out/Release',
    );
    expect(
      windowsCommandLine('C:\\aeb\\depot_tools\\autoninja.bat', [
        '-C',
        'out/Release',
        '-j',
        '2',
        'chrome',
      ]),
    ).toBe('C:\\aeb\\depot_tools\\autoninja.bat -C out/Release -j 2 chrome');
  });
});

describe('platform resolution', () => {
  it('spawns directly on POSIX', () => {
    const resolved = resolveSpawn(
      { file: 'gn', args: ['gen', 'out/Release'], cwd: '/tmp/x' },
      { platform: 'linux', env: {} },
    );
    expect(resolved.file).toBe('gn');
    expect(resolved.args).toEqual(['gen', 'out/Release']);
    expect(resolved.options.shell).toBe(false);
    expect(resolved.options.cwd).toBe('/tmp/x');
  });

  it('goes through cmd.exe on Windows, with verbatim arguments', () => {
    const resolved = resolveSpawn(
      { file: 'gn', args: ['gen', 'out/Release'], cwd: 'D:\\aeb\\src' },
      { platform: 'win32', env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' } },
    );
    expect(resolved.file).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(resolved.args).toEqual(['/d', '/s', '/c', '"gn gen out/Release"']);
    expect(resolved.options.windowsVerbatimArguments).toBe(true);
    // Without this, Node would quote the already-quoted command line again.
    expect(resolved.options.shell).toBeUndefined();
  });

  it('falls back to cmd.exe when ComSpec is missing', () => {
    const resolved = resolveSpawn(
      { file: 'gn', args: [], cwd: 'D:\\aeb' },
      { platform: 'win32', env: {} },
    );
    expect(resolved.file).toBe('cmd.exe');
  });

  it('keeps the environment it was given', () => {
    const env = { PATH: 'D:\\aeb\\depot_tools;C:\\Windows' };
    const resolved = resolveSpawn(
      { file: 'gn', args: [], cwd: 'D:\\aeb' },
      { platform: 'win32', env },
    );
    expect(resolved.options.env).toBe(env);
  });
});

describe('running and capturing', () => {
  it('runs a command and returns its status', () => {
    const result = spawnCommand({
      file: process.execPath,
      args: ['-e', 'process.exit(3)'],
      cwd: process.cwd(),
    });
    expect(result.status).toBe(3);
    expect(result.commandLine).toContain('-e');
  });

  it('captures standard output', () => {
    const output = captureCommand({
      file: process.execPath,
      args: ['-e', 'console.log("aurelia")'],
      cwd: process.cwd(),
    });
    expect(output.trim()).toBe('aurelia');
  });

  it('throws with the command line when a command fails', () => {
    expect(() =>
      captureCommand({
        file: process.execPath,
        args: ['-e', 'console.error("boom"); process.exit(2)'],
        cwd: process.cwd(),
      }),
    ).toThrow(/command failed: .*-e .*boom/);
  });

  it('captures raw bytes, not decoded text', () => {
    const output = captureCommandBuffer({
      file: process.execPath,
      args: ['-e', 'process.stdout.write(Buffer.from([0x00,0xff,0x41]))'],
      cwd: process.cwd(),
    });
    expect(Buffer.isBuffer(output)).toBe(true);
    expect([...output]).toEqual([0x00, 0xff, 0x41]);
  });

  it('reports a missing executable with the command line', () => {
    const result = spawnCommand({
      file: 'aurelia-command-that-does-not-exist',
      args: [],
      cwd: process.cwd(),
    });
    if (process.platform === 'win32') {
      // cmd.exe starts successfully, but reports the missing command itself.
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
    } else {
      // POSIX attempts to spawn the missing executable directly.
      expect(result.error).toBeDefined();
      expect(result.status).toBeNull();
    }
  });
});

describe('child process environment consistency', () => {
  it('propagates custom environment variables including DEPOT_TOOLS_WIN_TOOLCHAIN', () => {
    const parentEnv = {
      PATH: '/usr/bin:/bin',
      DEPOT_TOOLS_WIN_TOOLCHAIN: '0',
      DEPOT_TOOLS_UPDATE: '0',
      GCLIENT_PY3: '1',
    };
    const child = resolveSpawn(
      { file: 'node', args: ['-v'] },
      { platform: 'win32', env: parentEnv },
    );
    expect(child.options.env.DEPOT_TOOLS_WIN_TOOLCHAIN).toBe('0');
    expect(child.options.env.DEPOT_TOOLS_UPDATE).toBe('0');
    expect(child.options.env.GCLIENT_PY3).toBe('1');
  });
});
