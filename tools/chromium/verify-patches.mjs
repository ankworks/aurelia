/**
 * Patch verification.
 *
 * Two levels, both useful:
 *
 *  OFFLINE (default, no network, runs in fast CI)
 *    - every patch parses and touches only expected paths;
 *    - the patch file digest matches the digest recorded in its metadata;
 *    - metadata records pre-image and post-image digests for every file;
 *    - the recorded pre-images match the digests stored in
 *      chromium/verification/pre-images.json (detects tampering);
 *    - overlay files referenced by the patch exist and are non-empty;
 *    - the pin configuration is valid and immutable.
 *
 *  ONLINE (`--online`, or `--checkout <path>` for a local Chromium tree)
 *    - fetch the pre-images from the pinned revision and confirm their
 *      SHA-256 digests match the recorded ones (proves the patch targets that
 *      exact revision);
 *    - apply the patch with `git apply` to a copy of those pre-images and
 *      confirm every post-image digest matches (proves the patch still applies
 *      cleanly and produces the exact expected result).
 *
 * What this does NOT prove: that Chromium compiles. The manual GitHub-hosted
 * validation workflow in .github/workflows/chromium-build.yml can provide
 * compiler evidence, but a successful patch check alone does not prove a build.
 */
import { readFileSync, readdirSync, existsSync, mkdirSync, rmSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';

import {
  loadConfig,
  patchesDir,
  overlayDir,
  verificationDir,
} from './lib/config.mjs';
import { parsePatch, findPathProblems, findEncodingProblems, CANONICAL_BYTES_REMEDY } from './lib/patch.mjs';
import { extractPreImages, makeScratchDir, run, sha256 } from './lib/upstream.mjs';

export function listPatchFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith('.patch'))
    .sort();
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

/** Collect overlay files (every non-empty file under the overlay directory). */
export function collectOverlayFiles(directory) {
  const files = [];
  if (!existsSync(directory)) return files;
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        files.push({
          path: path.relative(directory, full).split(path.sep).join('/'),
          bytes: statSync(full).size,
        });
      }
    }
  };
  walk(directory);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

/**
 * Run the offline verification.
 * @returns {{ok: boolean, checks: Array<{name: string, ok: boolean, details: string}>}}
 */
export function verifyOffline(config = loadConfig()) {
  const checks = [];
  const push = (name, ok, details) => checks.push({ name, ok, details });

  const patchDirectory = patchesDir(config);
  const patchFiles = listPatchFiles(patchDirectory);
  push(
    'patch set is not empty',
    patchFiles.length > 0,
    `${patchFiles.length} patch file(s) in ${config.patchSet.directory}`,
  );

  const verificationFile = path.join(verificationDir(config), 'pre-images.json');
  const hasVerification = existsSync(verificationFile);
  push(
    'pre-image digest record exists',
    hasVerification,
    hasVerification ? path.relative(process.cwd(), verificationFile) : 'missing',
  );
  const recorded = hasVerification ? readJson(verificationFile) : null;

  if (recorded !== null) {
    push(
      'digest record targets the pinned revision',
      recorded.baseRevision === config.chromium.revision,
      `record=${recorded.baseRevision} config=${config.chromium.revision}`,
    );
  }

  for (const patchName of patchFiles) {
    const patchPath = path.join(patchDirectory, patchName);
    // Read bytes, not decoded text: the digest below is over the bytes on disk,
    // and the encoding check must see exactly what git checked out. Decoding and
    // re-encoding would silently repair invalid UTF-8 and change the digest.
    const patchBytes = readFileSync(patchPath);
    const patchText = patchBytes.toString('utf8');
    const metaPath = path.join(patchDirectory, patchName.replace(/\.patch$/, '.meta.json'));
    const meta = existsSync(metaPath) ? readJson(metaPath) : null;

    push(
      `${patchName}: metadata present`,
      meta !== null,
      meta === null ? 'missing .meta.json' : path.basename(metaPath),
    );

    // Line endings first. A CRLF checkout is a checkout problem with a checkout
    // remedy, and reporting it as a generic parse failure (or worse, as an
    // upstream change) sends the reader to the wrong file. The patch is NOT
    // repaired here: normalising it would defeat the digest check below.
    const encodingProblems = findEncodingProblems(patchText);
    push(
      `${patchName}: stored with canonical LF bytes`,
      encodingProblems.length === 0,
      encodingProblems.length === 0
        ? `${patchBytes.length} bytes, no CRLF, no byte-order mark`
        : encodingProblems
            .map((problem) =>
              problem.problem === 'bom'
                ? `UTF-8 byte-order mark at byte 0. ${CANONICAL_BYTES_REMEDY}`
                : `CRLF line endings on ${problem.count} line(s), first at line ${problem.firstLine}. ${CANONICAL_BYTES_REMEDY}`,
            )
            .join(' '),
    );

    if (meta !== null) {
      // These do not depend on the parse. A mangled checkout must report both
      // "not canonical bytes" and "digest mismatch": the first says what to fix,
      // the second says the artifact is no longer the reviewed one. Stopping at
      // the parse error would report less than the evidence shows.
      const actualDigest = sha256(patchBytes);
      push(
        `${patchName}: patch digest matches metadata`,
        meta.sha256 === actualDigest,
        meta.sha256 === actualDigest
          ? `${meta.sha256.slice(0, 16)}... over ${patchBytes.length} byte(s)`
          : `metadata=${String(meta.sha256).slice(0, 16)}... on-disk=${actualDigest.slice(0, 16)}...`,
      );

      push(
        `${patchName}: metadata targets the pinned revision`,
        meta.baseRevision === config.chromium.revision,
        `meta=${meta.baseRevision} config=${config.chromium.revision}`,
      );

      const missingDigests = meta.files.filter(
        (file) =>
          !/^[0-9a-f]{64}$/.test(file.preImageSha256 ?? '') ||
          !/^[0-9a-f]{64}$/.test(file.postImageSha256 ?? ''),
      );
      push(
        `${patchName}: records pre/post digests for every file`,
        missingDigests.length === 0,
        missingDigests.length === 0
          ? 'ok'
          : missingDigests.map((file) => file.path).join(', '),
      );
    }

    let parsed = null;
    try {
      parsed = parsePatch(patchText);
      push(
        `${patchName}: parses as a unified diff`,
        true,
        `${parsed.files.length} file(s), +${parsed.addedLines}/-${parsed.removedLines}`,
      );
    } catch (error) {
      push(`${patchName}: parses as a unified diff`, false, error.message);
      continue;
    }

    const pathProblems = findPathProblems(parsed);
    push(
      `${patchName}: touches only expected paths`,
      pathProblems.length === 0,
      pathProblems.length === 0 ? parsed.files.map((f) => f.newPath).join(', ') : pathProblems.join('; '),
    );

    if (meta === null) continue;

    const metaPaths = meta.files.map((file) => file.path).sort();
    const parsedPaths = parsed.files.map((file) => file.newPath).sort();
    push(
      `${patchName}: metadata matches patch file list`,
      metaPaths.length === parsedPaths.length &&
        metaPaths.every((value, index) => value === parsedPaths[index]),
      metaPaths.join(', '),
    );

    if (recorded !== null) {
      const recordedByPath = new Map(
        recorded.preImages.map((entry) => [entry.path, entry.sha256]),
      );
      const mismatches = meta.files.filter((file) => {
        const expected = recordedByPath.get(file.path);
        return expected === undefined || expected !== file.preImageSha256;
      });
      push(
        `${patchName}: pre-image digests agree with the verification record`,
        mismatches.length === 0,
        mismatches.length === 0
          ? 'ok'
          : mismatches.map((file) => file.path).join(', '),
      );
    }
  }

  const overlayFiles = collectOverlayFiles(overlayDir(config));
  push(
    'overlay contains files to install',
    overlayFiles.length > 0,
    `${overlayFiles.length} file(s), ${overlayFiles.reduce((total, file) => total + file.bytes, 0)} bytes`,
  );

  return {
    ok: checks.every((check) => check.ok),
    checks,
  };
}

/**
 * Online verification against the pinned revision.
 * @returns {{ok: boolean, checks: Array<{name: string, ok: boolean, details: string}>}}
 */
export function verifyOnline({ checkoutPath, config = loadConfig() } = {}) {
  const offline = verifyOffline(config);
  const checks = [...offline.checks];
  if (!offline.ok) return offline;

  const patchDirectory = patchesDir(config);
  const patchFiles = listPatchFiles(patchDirectory);
  const scratch = makeScratchDir('aurelia-verify-');

  try {
    for (const patchName of patchFiles) {
      const metaPath = path.join(patchDirectory, patchName.replace(/\.patch$/, '.meta.json'));
      if (!existsSync(metaPath)) continue;
      const meta = readJson(metaPath);
      const paths = meta.files.map((file) => file.path);

      const preDir = path.join(scratch, `pre-${patchName}`);
      mkdirSync(preDir, { recursive: true });
      let extracted;
      try {
        extracted = extractPreImages({
          config,
          paths,
          destinationDir: preDir,
          transport: checkoutPath === undefined ? 'api' : 'git',
          checkoutPath,
        });
      } catch (error) {
        checks.push({
          name: `${patchName}: pre-images fetched at the pinned revision`,
          ok: false,
          details: error.message,
        });
        continue;
      }

      const digestMismatches = extracted.entries.filter((entry) => {
        const expected = meta.files.find((file) => file.path === entry.path);
        return expected === undefined || expected.preImageSha256 !== entry.sha256;
      });
      checks.push({
        name: `${patchName}: upstream pre-images match the recorded digests`,
        ok: digestMismatches.length === 0,
        details:
          digestMismatches.length === 0
            ? `${extracted.entries.length} file(s) verified via ${extracted.transport} at ${config.chromium.revision.slice(0, 12)}`
            : digestMismatches.map((entry) => entry.path).join(', '),
      });

      // Apply the patch for real, then compare post-image digests.
      const repoDir = path.join(scratch, `apply-${patchName}`);
      mkdirSync(repoDir, { recursive: true });
      run('git', ['init', '--quiet', repoDir]);
      run('git', ['-C', repoDir, 'config', 'user.email', 'verify@aurelia.invalid']);
      run('git', ['-C', repoDir, 'config', 'user.name', 'Aurelia Verify']);
      // The recorded post-image digests are over LF bytes, and the pre-images
      // are written with the exact bytes `git show` returned. Without this, a
      // machine whose global config sets core.autocrlf=true (the Git for Windows
      // default) would have `git apply` re-expand the patch to CRLF and report a
      // post-image mismatch that is purely local. generate-patch.mjs pins the
      // same setting on its throwaway repository.
      run('git', ['-C', repoDir, 'config', 'core.autocrlf', 'false']);
      for (const entry of extracted.entries) {
        const source = path.join(preDir, entry.path);
        const target = path.join(repoDir, entry.path);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, readFileSync(source));
      }
      run('git', ['-C', repoDir, 'add', '--all']);

      let applyOk = true;
      let applyDetails = 'applied cleanly';
      try {
        run('git', [
          '-C',
          repoDir,
          'apply',
          '--verbose',
          '--whitespace=nowarn',
          path.join(patchDirectory, patchName),
        ]);
      } catch (error) {
        applyOk = false;
        applyDetails = error.message.split('\n').slice(0, 6).join(' ');
      }
      checks.push({
        name: `${patchName}: applies to the pinned pre-images`,
        ok: applyOk,
        details: applyDetails,
      });

      if (applyOk) {
        const postMismatches = [];
        for (const file of meta.files) {
          const target = path.join(repoDir, file.path);
          const digest = sha256(readFileSync(target));
          if (digest !== file.postImageSha256) {
            postMismatches.push(file.path);
          }
        }
        checks.push({
          name: `${patchName}: post-images match the recorded digests`,
          ok: postMismatches.length === 0,
          details:
            postMismatches.length === 0
              ? `${meta.files.length} file(s) byte-identical to the recorded result`
              : postMismatches.join(', '),
        });
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  return { ok: checks.every((check) => check.ok), checks };
}

export function formatChecks(checks) {
  return checks
    .map((check) => `${check.ok ? 'PASS' : 'FAIL'}  ${check.name}\n        ${check.details}`)
    .join('\n');
}
