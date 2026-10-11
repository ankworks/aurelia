#!/usr/bin/env node
/**
 * Line-ending policy check for the artefacts whose bytes are part of a digest.
 *
 * ## Why this exists
 *
 * Run https://github.com/ankworks/aurelia/actions/runs/38108794402 failed on the
 * windows-2025 runner because the checked-out copy of
 * `chromium/patches/0001-aurelia-webui-and-resources.patch` had CRLF line
 * endings: Git for Windows defaults to `core.autocrlf=true`, this repository had
 * no `.gitattributes`, and `actions/checkout` therefore materialised every text
 * file with CRLF. The patch is SHA-256 verified and parsed with `$`-anchored
 * unified-diff regexes, so the digest and the parse both failed.
 *
 * `.gitattributes` is the fix. This check is what notices if somebody deletes
 * it, narrows it, or adds a rule that re-enables conversion for a patch file -
 * which fast CI on Linux can otherwise never see, because there such a checkout
 * looks perfectly healthy.
 *
 * ## What it asserts
 *
 * For every file in the patch set directory, the *effective* git attributes must
 * guarantee LF bytes in the working tree even when `core.autocrlf=true`. Two
 * attribute combinations do that:
 *
 *   - `text: unset`                -> git performs no conversion at all;
 *   - `text: set|auto` + `eol=lf`  -> git converts to LF explicitly.
 *
 * Anything else (`text: auto` with no `eol`, or no matching rule at all) leaves
 * the working tree at the mercy of the machine's `core.autocrlf`, which is
 * exactly the bug. `git check-attr` is asked for the answer, so real attribute
 * resolution is exercised instead of a re-implementation of the pattern matcher.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { REPO_ROOT, loadConfig, patchesDir } from '../chromium/lib/config.mjs';
import { isMainModule } from '../lib/entry.mjs';

export const GITATTRIBUTES_NAME = '.gitattributes';

/**
 * Is this attribute combination safe for a digest-verified file?
 *
 * @param {{text: string, eol: string}} attributes
 * @returns {boolean}
 */
export function preservesBytesRegardlessOfAutocrlf({ text, eol }) {
  if (text === 'unset') return true;
  if ((text === 'set' || text === 'auto') && eol === 'lf') return true;
  return false;
}

/** Why an attribute combination is not safe, in reviewable English. */
export function explainUnsafeAttributes({ text, eol }) {
  if (text === 'unspecified') {
    return `no .gitattributes rule matches it (eol=${eol}), so core.autocrlf decides the line endings`;
  }
  if (eol === 'unspecified') {
    return `text=${text} without eol=lf leaves the line endings to core.autocrlf/core.eol`;
  }
  return `text=${text} eol=${eol} does not guarantee LF`;
}

function defaultRunGit(args) {
  return execFileSync('git', args, { encoding: 'utf8' });
}

/** `git check-attr text eol -- <relativePath>` for one file, resolved by git. */
export function effectiveAttributes({
  relativePath,
  runGit = defaultRunGit,
  cwd = REPO_ROOT,
}) {
  const output = runGit([
    '-C',
    cwd,
    'check-attr',
    'text',
    'eol',
    '--',
    relativePath,
  ]);
  const attributes = {};
  for (const line of output.split('\n')) {
    const match = /^(.+?): (text|eol): (\S+)$/.exec(line.trim());
    if (match !== null && match[1] === relativePath) {
      attributes[match[2]] = match[3];
    }
  }
  return {
    text: attributes.text ?? 'unspecified',
    eol: attributes.eol ?? 'unspecified',
  };
}

/**
 * @returns {{ok: boolean, problems: string[], checked: number, attributesFile: string}}
 */
export function checkLineEndings({
  root = REPO_ROOT,
  config = loadConfig(),
  patchDirectory = patchesDir(config),
  runGit = defaultRunGit,
  exists = existsSync,
  read = (file) => readFileSync(file, 'utf8'),
} = {}) {
  const problems = [];
  const attributesFile = path.join(root, GITATTRIBUTES_NAME);

  if (!exists(attributesFile)) {
    return {
      ok: false,
      problems: [
        `${GITATTRIBUTES_NAME} is missing at the repository root: without it a Windows checkout ` +
          '(core.autocrlf=true) rewrites every text file to CRLF, including the patch files ' +
          '(the failure in actions/runs/38108794402)',
      ],
      checked: 0,
      attributesFile: GITATTRIBUTES_NAME,
    };
  }

  const patchFiles = exists(patchDirectory)
    ? readdirSync(patchDirectory)
        .filter((name) => name.endsWith('.patch'))
        .sort()
    : [];

  if (patchFiles.length === 0) {
    problems.push(
      `patch set is empty: no *.patch file under ${path.relative(root, patchDirectory)}`,
    );
  }

  let checked = 0;
  for (const name of patchFiles) {
    const absolute = path.join(patchDirectory, name);
    const relativePath = path
      .relative(root, absolute)
      .split(path.sep)
      .join('/');
    const attributes = effectiveAttributes({
      relativePath,
      runGit,
      cwd: root,
    });
    checked += 1;
    if (!preservesBytesRegardlessOfAutocrlf(attributes)) {
      problems.push(`${relativePath}: ${explainUnsafeAttributes(attributes)}`);
    }
  }

  // The declaration itself is checked too: `git check-attr` is authoritative for
  // the files that exist today, and this catches a policy that only survives
  // because a nested rule happens to cover the current names.
  const attributesText = read(attributesFile);
  const declaresPatchRule =
    /^\s*\*\.patch\s+.*-text\b/m.test(attributesText) ||
    /^\s*\*\.patch\s+.*eol=lf\b/m.test(attributesText);
  if (!declaresPatchRule) {
    problems.push(
      `${GITATTRIBUTES_NAME} has no \`*.patch\` rule that pins LF ` +
        '(expected `*.patch -text` or `*.patch text eol=lf`)',
    );
  }

  return {
    ok: problems.length === 0,
    problems,
    checked,
    attributesFile: path
      .relative(root, attributesFile)
      .split(path.sep)
      .join('/'),
  };
}

const isMain = isMainModule(import.meta.url);

if (isMain) {
  const result = checkLineEndings();
  for (const problem of result.problems) {
    console.log(`FAIL  ${problem}`);
  }
  console.log(
    result.ok
      ? `PASS  line-ending policy holds for ${result.checked} patch file(s)`
      : 'LINE-ENDING CHECK FAILED',
  );
  process.exitCode = result.ok ? 0 : 1;
}
