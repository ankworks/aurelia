/**
 * Regression suite for the Windows-checkout line-ending failure.
 *
 * Evidence: https://github.com/ankworks/aurelia/actions/runs/38108794402 failed
 * on the windows-2025 runner with
 *
 *   unexpected content before first file header:
 *   "diff --git a/chrome/browser/BUILD.gn b/chrome/browser/BUILD.gn\r"
 *
 * The checked-out patch file had CRLF line endings because Git for Windows
 * defaults to `core.autocrlf=true` (the GitHub-hosted Windows image installs it
 * with the installer default) and this repository had no `.gitattributes`.
 *
 * These tests cannot run on Windows, so they reproduce the condition that made
 * Windows fail: a checkout performed with `core.autocrlf=true`. That is the same
 * conversion `actions/checkout` performs on the runner.
 */
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadConfig, REPO_ROOT } from '../../tools/chromium/lib/config.mjs';
import { sha256 } from '../../tools/chromium/lib/upstream.mjs';
import {
  listPatchFiles,
  verifyOffline,
} from '../../tools/chromium/verify-patches.mjs';
import {
  checkLineEndings,
  effectiveAttributes,
  explainUnsafeAttributes,
  preservesBytesRegardlessOfAutocrlf,
} from '../../tools/ci/check-line-endings.mjs';

const config = loadConfig();
const PATCH_DIRECTORY = path.join(REPO_ROOT, config.patchSet.directory);
const ATTRIBUTES = readFileSync(path.join(REPO_ROOT, '.gitattributes'), 'utf8');

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' });
}

const scratch = [];
afterAll(() => {
  for (const directory of scratch.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeTemp(prefix) {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  scratch.push(directory);
  return directory;
}

describe('a Windows-style checkout (core.autocrlf=true)', () => {
  /** Build a tiny repository, then clone it the way a Windows runner checks out. */
  function cloneFixture({ autocrlf, attributes }) {
    const source = makeTemp('aurelia-eol-source-');
    const destination = makeTemp('aurelia-eol-clone-');
    rmSync(destination, { recursive: true, force: true });
    scratch.push(destination);

    git(['init', '--quiet', source]);
    git(['-C', source, 'config', 'user.email', 'test@aurelia.invalid']);
    git(['-C', source, 'config', 'user.name', 'Aurelia Test']);
    if (attributes !== undefined) {
      writeFileSync(path.join(source, '.gitattributes'), attributes);
    }
    writeFileSync(
      path.join(source, 'sample.patch'),
      'diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n',
    );
    git(['-C', source, 'add', '--all']);
    git(['-C', source, 'commit', '--quiet', '--message', 'fixture']);
    git([
      '-c',
      `core.autocrlf=${autocrlf}`,
      'clone',
      '--quiet',
      '--no-hardlinks',
      source,
      destination,
    ]);
    return destination;
  }

  it('reproduces the failure without a .gitattributes rule', () => {
    // Control: this is the state this repository was in when run 38108794402
    // failed. If this ever stops producing CRLF, the test below has stopped
    // proving anything.
    const destination = cloneFixture({ autocrlf: 'true' });
    expect(
      readFileSync(path.join(destination, 'sample.patch'), 'utf8'),
    ).toContain('\r\n');
  });

  it('keeps patch files at LF with the repository policy, whatever autocrlf says', () => {
    for (const autocrlf of ['true', 'false', 'input']) {
      const destination = cloneFixture({ autocrlf, attributes: ATTRIBUTES });
      const bytes = readFileSync(
        path.join(destination, 'sample.patch'),
        'utf8',
      );
      expect(bytes).not.toContain('\r');
      expect(bytes).toMatch(/^diff --git a\/x b\/x\n/);
    }
  });

  it('checks out every real patch file byte-identical to its recorded digest', () => {
    // The strongest available simulation of the runner: build a repository from
    // this working tree, clone it with core.autocrlf=true - the setting the
    // windows-2025 image ships - and compare every patch byte with the SHA-256
    // that chromium/patches/*.meta.json records for it. The fixture is built
    // from the working tree on purpose, so the test exercises the policy in the
    // file on disk rather than whatever HEAD happens to contain.
    const source = makeTemp('aurelia-eol-repo-');
    cpSync(REPO_ROOT, source, {
      recursive: true,
      filter: (entry) =>
        !/(^|[/\\])(\.git|node_modules|artifacts)([/\\]|$)/.test(entry),
    });
    git(['init', '--quiet', source]);
    git(['-C', source, 'config', 'user.email', 'test@aurelia.invalid']);
    git(['-C', source, 'config', 'user.name', 'Aurelia Test']);
    git(['-C', source, 'add', '--all']);
    git(['-C', source, 'commit', '--quiet', '--message', 'working tree']);

    const destination = makeTemp('aurelia-eol-repo-clone-');
    rmSync(destination, { recursive: true, force: true });
    scratch.push(destination);
    git([
      '-c',
      'core.autocrlf=true',
      'clone',
      '--quiet',
      '--no-hardlinks',
      source,
      destination,
    ]);

    const patchFiles = listPatchFiles(PATCH_DIRECTORY);
    expect(patchFiles.length).toBeGreaterThan(0);
    for (const name of patchFiles) {
      const meta = JSON.parse(
        readFileSync(
          path.join(PATCH_DIRECTORY, name.replace(/\.patch$/, '.meta.json')),
          'utf8',
        ),
      );
      const bytes = readFileSync(
        path.join(destination, config.patchSet.directory, name),
      );
      expect(bytes.includes(0x0d)).toBe(false);
      expect(sha256(bytes)).toBe(meta.sha256);
    }
  });
});

describe('the repository protects its digest-verified patches', () => {
  it('declares a no-conversion rule for patch files', () => {
    expect(ATTRIBUTES).toMatch(/^\*\.patch\s+.*-text\b/m);
  });

  it('resolves every checked-in patch file to bytes git will not convert', () => {
    const result = checkLineEndings({ config });
    expect(result.problems).toEqual([]);
    expect(result.checked).toBe(listPatchFiles(PATCH_DIRECTORY).length);
    expect(result.checked).toBeGreaterThan(0);
  });

  it('agrees with what git itself resolves, not just what the file says', () => {
    for (const name of listPatchFiles(PATCH_DIRECTORY)) {
      const attributes = effectiveAttributes({
        relativePath: `${config.patchSet.directory}/${name}`,
      });
      expect(attributes.text).toBe('unset');
      expect(preservesBytesRegardlessOfAutocrlf(attributes)).toBe(true);
    }
  });

  it('fails when the rule is missing or weakened', () => {
    const root = makeTemp('aurelia-eol-policy-');
    const patches = path.join(root, 'chromium', 'patches');
    cpSync(PATCH_DIRECTORY, patches, { recursive: true });
    // git check-attr resolves attributes per repository, so the fixture needs one.
    git(['init', '--quiet', root]);

    const writeAttributes = (text) => {
      writeFileSync(path.join(root, '.gitattributes'), text);
      git(['-C', root, 'add', '.gitattributes']);
    };

    // No .gitattributes at all: the state that caused the failure.
    const missing = checkLineEndings({ root, patchDirectory: patches });
    expect(missing.ok).toBe(false);
    expect(missing.problems[0]).toMatch(/missing/);

    // Present but weaker than required: text=auto without eol=lf.
    writeAttributes('*.patch text=auto\n');
    const weakened = checkLineEndings({ root, patchDirectory: patches });
    expect(weakened.ok).toBe(false);
    expect(weakened.problems.join(' ')).toMatch(/core\.autocrlf/);
    expect(weakened.problems.join(' ')).toMatch(
      /no `\*\.patch` rule that pins LF/,
    );

    // A rule for a different extension: nothing matches the patch files.
    writeAttributes('*.diff -text\n');
    expect(checkLineEndings({ root, patchDirectory: patches }).ok).toBe(false);

    // The rule this repository ships.
    writeAttributes(ATTRIBUTES);
    const installed = checkLineEndings({ root, patchDirectory: patches });
    expect(installed.problems).toEqual([]);
    expect(installed.checked).toBeGreaterThan(0);
  });
});

describe('a CRLF checkout fails verification instead of being repaired', () => {
  let fixtureDirectory = null;

  beforeAll(() => {
    // verifyOffline() resolves patchesDir() against the repository root, the way
    // tests/tools/patch-verification.test.mjs already does: put the fixture in a
    // temporary directory and point the config at it with a relative path.
    const root = makeTemp('aurelia-eol-verify-');
    for (const key of ['directory', 'verificationDirectory']) {
      cpSync(path.join(REPO_ROOT, config.patchSet[key]), path.join(root, key), {
        recursive: true,
      });
    }
    fixtureDirectory = root;
    // Mangle exactly the way a Windows checkout does.
    for (const name of listPatchFiles(path.join(root, 'directory'))) {
      const file = path.join(root, 'directory', name);
      writeFileSync(file, readFileSync(file, 'utf8').replaceAll('\n', '\r\n'));
    }
  });

  function mangledConfig() {
    const mangled = structuredClone(config);
    for (const key of ['directory', 'verificationDirectory']) {
      mangled.patchSet[key] = path.relative(
        REPO_ROOT,
        path.join(fixtureDirectory, key),
      );
    }
    return mangled;
  }

  it('reports the line endings and the digest mismatch as separate failures', () => {
    const result = verifyOffline(mangledConfig());
    expect(result.ok).toBe(false);

    const failed = result.checks.filter((check) => !check.ok);
    const names = failed.map((check) => check.name);
    const details = failed.map((check) => check.details).join('\n');

    expect(
      names.some((name) => /stored with canonical LF bytes/.test(name)),
    ).toBe(true);
    expect(details).toMatch(/CRLF line endings/);
    expect(details).toMatch(/gitattributes/);

    // The digest check must still fire: the checkout changed the reviewed
    // artefact, and reporting only the encoding problem would understate it.
    expect(
      names.some((name) => /patch digest matches metadata/.test(name)),
    ).toBe(true);

    // And the parse must fail loudly rather than succeeding on repaired text.
    expect(details).toMatch(/PatchEncodingError|CRLF|byte-order mark/);
  });

  it('leaves the pristine patch set passing', () => {
    expect(verifyOffline(config).ok).toBe(true);
  });
});

describe('explainUnsafeAttributes', () => {
  it('names the mechanism instead of the symptom', () => {
    expect(
      explainUnsafeAttributes({ text: 'unspecified', eol: 'unspecified' }),
    ).toMatch(/core\.autocrlf/);
    expect(
      explainUnsafeAttributes({ text: 'auto', eol: 'unspecified' }),
    ).toMatch(/core\.autocrlf/);
    expect(explainUnsafeAttributes({ text: 'set', eol: 'native' })).toMatch(
      /does not guarantee LF/,
    );
  });
});
