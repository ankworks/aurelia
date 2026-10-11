/**
 * The GN argument policy is the last thing standing between a reviewed
 * configuration file and `gn gen --args=...`. These tests pin the exact
 * behaviour: every reviewed file passes, every value that could silently reach
 * the build is either allowed with a reason or refused with a message that
 * names the key, the value and the allowed set.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import {
  GN_ARGS_DIR,
  GN_ARG_POLICY,
  REPO_ROOT,
  gnArgFiles,
  normalizeGnValue,
  parseGnArgs,
  parseGnArgsLine,
  renderGnArgs,
  validateGnArgs,
} from '../../tools/chromium/gn-args.mjs';

const TOOL = path.join(REPO_ROOT, 'tools', 'chromium', 'gn-args.mjs');
const DEV_FILE = path.join(GN_ARGS_DIR, 'win-x64-dev.gn');
const LOW_RESOURCE_FILE = path.join(GN_ARGS_DIR, 'win-x64-low-resource.gn');

const run = (arguments_) =>
  spawnSync(process.execPath, [TOOL, ...arguments_], { encoding: 'utf8' });

/** A small valid configuration, so a failure points at the rule under test. */
function config(overrides = {}) {
  const base = {
    is_debug: 'false',
    is_official_build: 'false',
    is_component_build: 'true',
    symbol_level: '1',
    target_cpu: '"x64"',
    target_os: '"win"',
  };
  return Object.entries({ ...base, ...overrides })
    .map(([key, value]) => `${key} = ${value}`)
    .join('\n');
}

describe('reviewed files', () => {
  it('finds both Windows profiles and they pass the policy', () => {
    const files = gnArgFiles();
    expect(files).toContain(DEV_FILE);
    expect(files).toContain(LOW_RESOURCE_FILE);
    for (const file of files) {
      const { entries, problems } = validateGnArgs(readFileSync(file, 'utf8'));
      expect(problems).toEqual([]);
      expect(entries.length).toBeGreaterThan(0);
      for (const { key } of entries) {
        expect(Object.keys(GN_ARG_POLICY)).toContain(key);
      }
    }
  });

  it('keeps the low-resource difference to symbols and links only', () => {
    const read = (file) =>
      Object.fromEntries(
        validateGnArgs(readFileSync(file, 'utf8')).entries.map(
          ({ key, value }) => [key, normalizeGnValue(value)],
        ),
      );
    const dev = read(DEV_FILE);
    const low = read(LOW_RESOURCE_FILE);
    expect(dev.symbol_level).toBe('1');
    expect(low.symbol_level).toBe('0');
    expect(dev.concurrent_links).toBeUndefined();
    expect(low.concurrent_links).toBe('1');
    const differing = Object.keys({ ...dev, ...low }).filter(
      (key) => dev[key] !== low[key],
    );
    expect(differing.sort()).toEqual(['concurrent_links', 'symbol_level']);
  });

  it('documents every policy entry with an allowed set and a reason', () => {
    for (const [key, rule] of Object.entries(GN_ARG_POLICY)) {
      expect(Array.isArray(rule.allowed)).toBe(true);
      expect(rule.allowed.length).toBeGreaterThan(0);
      expect(rule.reason.length).toBeGreaterThan(10);
      expect(key).toMatch(/^[a-z_][a-z0-9_]*$/);
    }
  });
});

describe('parse and render', () => {
  it('ignores comments, blank lines and trailing comments', () => {
    const text = [
      '# Aurelia - Windows x64 development build',
      '',
      'is_debug = false  # documented build switch',
      '   ',
      'target_cpu = "x64"',
    ].join('\n');
    const { entries, problems } = parseGnArgs(text);
    expect(problems).toEqual([]);
    expect(entries.map(({ key }) => key)).toEqual(['is_debug', 'target_cpu']);
    expect(entries[0].line).toBe(3);
  });

  it('reports a duplicate key and keeps the first occurrence', () => {
    const { entries, problems } = parseGnArgs(
      'is_debug = false\nis_debug = true',
    );
    expect(entries).toHaveLength(1);
    expect(problems).toEqual([
      'line 2: duplicate argument is_debug (first set on line 1)',
    ]);
  });

  it('reports a line that is not a key = value argument', () => {
    const { problems } = parseGnArgs('is_debug = false\n--some-flag');
    expect(problems).toEqual([
      'line 2: not a `key = value` argument: --some-flag',
    ]);
  });

  it('renders one argument string that parses back to the same pairs', () => {
    for (const file of [DEV_FILE, LOW_RESOURCE_FILE]) {
      const { entries } = validateGnArgs(readFileSync(file, 'utf8'));
      const rendered = renderGnArgs(entries);
      expect(rendered).not.toContain('\n');
      const reparsed = parseGnArgsLine(rendered);
      expect(reparsed.problems).toEqual([]);
      expect(reparsed.entries.map(({ key, value }) => [key, value])).toEqual(
        entries.map(({ key, value }) => [key, value]),
      );
      // The string is dropped into `gn gen --args=...`, so it must survive a
      // shell that splits on spaces without losing or duplicating a value.
      const argv = ['gn', 'gen', 'out/Release', `--args=${rendered}`];
      expect(argv[3].slice('--args='.length)).toBe(rendered);
    }
  });

  it('detects a rendered string that cannot be read back', () => {
    expect(parseGnArgsLine('is_debug = false is_debug').problems).toEqual([
      'unparsed text at the end: "is_debug"',
    ]);
    expect(parseGnArgsLine('garbage').problems).toEqual([
      'unparsed text at the end: "garbage"',
    ]);
  });
});

describe('values that must not reach gn unchecked', () => {
  it('refuses a value outside the allowed set, naming the key and the set', () => {
    const { problems } = validateGnArgs(config({ concurrent_links: '3' }));
    expect(problems).toEqual([
      'line 7: concurrent_links = 3 is outside the allowed values (1, 2) - ' +
        GN_ARG_POLICY.concurrent_links.reason,
    ]);
  });

  it('refuses the wrong architecture with the exact reason', () => {
    const { problems } = validateGnArgs(config({ target_cpu: '"arm64"' }));
    expect(problems).toEqual([
      'line 5: target_cpu = "arm64" is outside the allowed values (x64) - ' +
        GN_ARG_POLICY.target_cpu.reason,
    ]);
  });

  it('allows only "false" for an official build', () => {
    expect(
      validateGnArgs(config({ is_official_build: 'true' })).problems,
    ).toEqual([
      'line 2: is_official_build = true is outside the allowed values (false) - ' +
        GN_ARG_POLICY.is_official_build.reason,
    ]);
  });

  it('refuses an unknown argument until it is reviewed and added', () => {
    const { problems } = validateGnArgs(config({ enable_foo: 'true' }));
    expect(problems).toEqual([
      'line 7: enable_foo is not in the reviewed allowlist (tools/chromium/gn-args.mjs); verify it exists at the pinned Chromium revision, then add it with a reason and an allowed value set',
    ]);
  });

  it('refuses security-relevant switches by pattern', () => {
    for (const key of ['is_asan', 'disable_sandbox', 'site_isolation_off']) {
      const { problems } = validateGnArgs(config({ [key]: 'true' }));
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/^line 7: /);
      expect(problems[0]).toContain(key);
      expect(problems[0]).toMatch(/not allowed/);
    }
  });

  it('accepts quoted and unquoted string values', () => {
    expect(normalizeGnValue('"x64"')).toBe('x64');
    expect(normalizeGnValue("'x64'")).toBe('x64');
    expect(normalizeGnValue('x64')).toBe('x64');
    expect(validateGnArgs(config({ target_cpu: 'x64' })).problems).toEqual([]);
  });
});

describe('command line', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'aurelia-gn-args-'));
  const badFile = path.join(directory, 'bad.gn');
  writeFileSync(badFile, config({ symbol_level: '9' }));

  it('validates both reviewed files with --all', () => {
    const result = run(['--all']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('win-x64-dev.gn: 6 reviewed argument(s)');
    expect(result.stdout).toContain(
      'win-x64-low-resource.gn: 7 reviewed argument(s)',
    );
  });

  it('prints exactly the string that gn gen receives', () => {
    const result = run([DEV_FILE, '--print']);
    expect(result.status).toBe(0);
    const { entries } = validateGnArgs(readFileSync(DEV_FILE, 'utf8'));
    expect(result.stdout.trim()).toBe(renderGnArgs(entries));
    expect(result.stdout.trim()).toContain('target_cpu = "x64"');
  });

  it('exits 1 and prints the problem for an out-of-policy file', () => {
    const result = run([badFile]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('symbol_level = 9');
    expect(result.stderr).toContain('allowed values (0, 1, 2)');
  });

  it('prints machine-readable results for --all --json', () => {
    const result = run(['--all', '--json']);
    expect(result.status).toBe(0);
    const results = JSON.parse(result.stdout);
    expect(results.map((entry) => path.basename(entry.file)).sort()).toEqual([
      'win-x64-dev.gn',
      'win-x64-low-resource.gn',
      'win-x64-targeted-lite.gn',
    ]);
  });
});
