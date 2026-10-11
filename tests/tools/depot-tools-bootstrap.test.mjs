import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  bootstrapWindowsDepotTools,
  windowsPythonPath,
} from '../../tools/chromium/bootstrap-depot-tools.mjs';
import { REPO_ROOT } from '../../tools/chromium/lib/config.mjs';

const PIN = '1e43ae345913614898e3d6a1ef2680a0d47574e9';
const depotTools = path.join('C:', 'checkout with spaces', 'depot_tools');
const script = path.join(depotTools, 'bootstrap', 'win_tools.bat');
const pointer = path.join(depotTools, 'python3_bin_reldir.txt');
const relative = 'bootstrap-2@3_11_8_chromium_35_bin\\python3\\bin';
const python = path.join(depotTools, ...relative.split('\\'), 'python3.exe');

function fixture({
  heads = [PIN, PIN],
  status = 0,
  content = relative,
  files = [script, pointer, python],
} = {}) {
  const calls = [];
  const capture = (command, options) => {
    calls.push({ kind: 'git', command, options });
    return `${heads.shift()}\n`;
  };
  const spawn = (command, options) => {
    calls.push({ kind: 'bootstrap', command, options });
    return { status };
  };
  const exists = (file) => files.includes(file);
  const read = () => content;
  const run = (revision = PIN) =>
    bootstrapWindowsDepotTools({
      depotTools,
      revision,
      platform: 'win32',
      env: { Path: 'C:\\Windows', DEPOT_TOOLS_UPDATE: '1' },
      capture,
      spawn,
      exists,
      read,
    });
  return { calls, run };
}

describe('Windows pinned depot_tools bootstrap for GN', () => {
  it('runs only win_tools.bat at the pin, with updates disabled, and checks HEAD again', () => {
    const { calls, run } = fixture();
    expect(run()).toBe(python);
    expect(calls.map((entry) => entry.kind)).toEqual([
      'git',
      'bootstrap',
      'git',
    ]);
    expect(calls[1].command).toEqual({
      file: script,
      args: [],
      cwd: depotTools,
    });
    for (const entry of calls) {
      expect(entry.options.env.DEPOT_TOOLS_UPDATE).toBe('0');
      expect(entry.options.env.DEPOT_TOOLS_WIN_TOOLCHAIN).toBe('0');
      expect(entry.options.env.PATH.startsWith(depotTools)).toBe(true);
      expect(entry.options.env.Path).toBeUndefined();
      expect(entry.command.file).not.toMatch(/update_depot_tools|gclient/);
    }
  });

  it('refuses a missing or changed pin before trusting the bootstrap', () => {
    expect(() => fixture().run(null)).toThrow('pinned depot_tools commit SHA');
    const before = fixture({ heads: ['f'.repeat(40)] });
    expect(() => before.run()).toThrow('expected pinned');
    expect(before.calls.map((entry) => entry.kind)).toEqual(['git']);
    const after = fixture({ heads: [PIN, 'f'.repeat(40)] });
    expect(() => after.run()).toThrow('expected pinned');
  });

  it('does not call GN when the bootstrap fails or leaves no Python pointer', () => {
    expect(() => fixture({ status: 1 }).run()).toThrow('exited with code 1');
    expect(() => fixture({ files: [script] }).run()).toThrow('did not create');
    expect(() => fixture({ files: [] }).run()).toThrow(
      'bootstrap script is missing',
    );
    expect(() => fixture({ files: [script, pointer] }).run()).toThrow(
      'Python is missing',
    );
  });

  it('rejects a pointer outside the versioned CIPD Python install', () => {
    for (const content of [
      '..\\outside',
      'C:\\outside',
      '/outside',
      'bootstrap-old_bin\\python3\\bin\\..',
    ]) {
      expect(() =>
        windowsPythonPath(depotTools, {
          exists: () => true,
          read: () => content,
        }),
      ).toThrow('invalid depot_tools Python pointer');
    }
  });

  it('retains GN policy and runs bootstrap before real GN generation', () => {
    const driver = readFileSync(
      path.join(REPO_ROOT, 'tools/chromium/ci-validation.mjs'),
      'utf8',
    );
    const policy = driver.indexOf("id: 'gn-argument-policy'");
    const bootstrap = driver.indexOf("id: 'depot-tools-bootstrap'", policy);
    const generation = driver.indexOf("id: 'gn-generation'", bootstrap);
    const gnCheck = driver.indexOf("id: 'gn-check'", generation);
    expect(policy).toBeGreaterThan(-1);
    expect(bootstrap).toBeGreaterThan(policy);
    expect(generation).toBeGreaterThan(bootstrap);
    expect(gnCheck).toBeGreaterThan(generation);
    expect(driver).toContain("file: 'gn'");
  });
});
