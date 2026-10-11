/**
 * Minimal, dependency-free unified-diff parsing.
 *
 * Aurelia only needs to *inspect* its own patch files (list touched files,
 * count added/removed lines, sanity-check the structure). Applying patches is
 * delegated to `git apply`, which is the authoritative implementation and is
 * available in every development and CI environment we support.
 *
 * Scope: text patches produced by `git diff`. Binary patches, renames and mode
 * changes are detected and rejected explicitly rather than silently ignored.
 */

const FILE_HEADER_RE = /^diff --git a\/(.+) b\/(.+)$/;
const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export class PatchParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PatchParseError';
  }
}

/**
 * The patch text is not the byte-for-byte form `git diff` emits.
 *
 * This is a separate class from a structural parse failure because the cause
 * and the remedy are different: the diff is fine, the *file* was rewritten by
 * something between `git diff` and here (almost always a checkout that applied
 * `core.autocrlf`). See `.gitattributes` at the repository root.
 */
export class PatchEncodingError extends PatchParseError {
  /**
   * @param {string} message
   * @param {{problem: string, count: number, firstLine: number|null}} details
   */
  constructor(message, { problem, count, firstLine }) {
    super(message);
    this.name = 'PatchEncodingError';
    this.problem = problem;
    this.count = count;
    this.firstLine = firstLine;
  }
}

/** Remediation appended to every encoding error, so the fix is in the message. */
export const CANONICAL_BYTES_REMEDY =
  'Aurelia patches are SHA-256 verified and re-applied byte-for-byte, so they must be stored as the ' +
  'bytes `git diff` produced: LF line endings, no byte-order mark, no re-encoding. This normally means ' +
  'the checkout converted the file - Git for Windows defaults to core.autocrlf=true, and only a ' +
  '.gitattributes rule overrides it (see .gitattributes: `*.patch -text`). Confirm the rule applies ' +
  'with `git check-attr text -- <patch>` (expected: `unset`), then restore the file from the index ' +
  '(`git checkout -- <patch>`) or clone the repository again.';

/**
 * Problems that make the text impossible to be a canonical `git diff` output.
 *
 * Only the two transformations a checkout can perform are reported - CRLF
 * expansion and the UTF-8 byte-order mark - so a genuine upstream change can
 * never be hidden behind this check.
 *
 * @param {string} patchText
 * @returns {Array<{problem: 'crlf'|'bom', count: number, firstLine: number|null}>}
 */
export function findEncodingProblems(patchText) {
  const problems = [];
  const lines = patchText.split('\n');

  const bom = patchText.charCodeAt(0) === 0xfeff;
  if (bom) {
    problems.push({ problem: 'bom', count: 1, firstLine: 1 });
  }

  let crlf = 0;
  let crlfFirstLine = null;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].endsWith('\r')) {
      crlf += 1;
      if (crlfFirstLine === null) {
        crlfFirstLine = index + 1;
      }
    }
  }
  if (crlf > 0) {
    problems.push({ problem: 'crlf', count: crlf, firstLine: crlfFirstLine });
  }

  return problems;
}

/**
 * Throw unless `patchText` is the canonical form of a patch file.
 * Called by `parsePatch`, and usable directly by callers that want to report
 * the problem without attempting a parse.
 *
 * @param {string} patchText
 * @param {string} [subject] File name to name in the error message.
 */
export function assertCanonicalPatchBytes(patchText, subject = 'patch') {
  for (const problem of findEncodingProblems(patchText)) {
    if (problem.problem === 'bom') {
      throw new PatchEncodingError(
        `${subject} starts with a UTF-8 byte-order mark; ${CANONICAL_BYTES_REMEDY}`,
        problem,
      );
    }
    throw new PatchEncodingError(
      `${subject} has Windows (CRLF) line endings on ${problem.count} line(s), first at line ${problem.firstLine}; ` +
        'a line ending in CR cannot be matched by the `$` anchor of the unified-diff header pattern, ' +
        `so no file header is recognised and the diff cannot be parsed. ${CANONICAL_BYTES_REMEDY}`,
      problem,
    );
  }
}

/**
 * Parse a unified diff into structured data.
 *
 * @param {string} patchText
 * @returns {{files: Array<{oldPath: string, newPath: string, added: number,
 *   removed: number, hunks: number, isNewFile: boolean, isDeleted: boolean}>,
 *   addedLines: number, removedLines: number}}
 * @throws {PatchEncodingError} when the text is not canonical LF/no-BOM bytes
 * @throws {PatchParseError} when the text is canonical but not a valid diff
 */
export function parsePatch(patchText) {
  // Check the bytes before the structure: a CRLF or BOM-mangled patch would
  // otherwise fail here as "unexpected content before first file header", which
  // names the symptom rather than the cause.
  assertCanonicalPatchBytes(patchText);

  const lines = patchText.split('\n');
  const files = [];
  let current = null;
  let hunkRemaining = { old: 0, new: 0 };

  const finishCurrent = () => {
    if (current !== null) {
      files.push(current);
      current = null;
    }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    const fileMatch = FILE_HEADER_RE.exec(line);
    if (fileMatch !== null) {
      finishCurrent();
      current = {
        oldPath: fileMatch[1],
        newPath: fileMatch[2],
        added: 0,
        removed: 0,
        hunks: 0,
        isNewFile: false,
        isDeleted: false,
      };
      continue;
    }

    if (current === null) {
      // Nothing between patches except blank lines / trailing whitespace.
      if (line.trim().length > 0) {
        throw new PatchParseError(
          `unexpected content before first file header: ${JSON.stringify(line)}`,
        );
      }
      continue;
    }

    if (line.startsWith('GIT binary patch') || line.startsWith('Binary files')) {
      throw new PatchParseError(
        `binary patches are not supported (${current.newPath})`,
      );
    }
    if (line.startsWith('rename from ') || line.startsWith('rename to ')) {
      throw new PatchParseError(
        `renames are not supported (${current.newPath}); recreate the patch as add+delete`,
      );
    }
    if (line.startsWith('old mode ') || line.startsWith('new mode ')) {
      throw new PatchParseError(`mode changes are not supported (${current.newPath})`);
    }
    if (line.startsWith('new file mode ')) {
      current.isNewFile = true;
      continue;
    }
    if (line.startsWith('deleted file mode ')) {
      current.isDeleted = true;
      continue;
    }
    if (
      line.startsWith('index ') ||
      line.startsWith('--- ') ||
      line.startsWith('+++ ')
    ) {
      continue;
    }

    const hunkMatch = HUNK_HEADER_RE.exec(line);
    if (hunkMatch !== null) {
      current.hunks += 1;
      hunkRemaining = {
        old: hunkMatch[2] === undefined ? 1 : Number(hunkMatch[2]),
        new: hunkMatch[4] === undefined ? 1 : Number(hunkMatch[4]),
      };
      continue;
    }

    if (line.startsWith('@@')) {
      throw new PatchParseError(`malformed hunk header: ${line}`);
    }

    if (hunkRemaining.old > 0 || hunkRemaining.new > 0) {
      if (line.startsWith('+')) {
        current.added += 1;
        hunkRemaining.new -= 1;
        continue;
      }
      if (line.startsWith('-')) {
        current.removed += 1;
        hunkRemaining.old -= 1;
        continue;
      }
      if (line.startsWith(' ')) {
        hunkRemaining.old -= 1;
        hunkRemaining.new -= 1;
        continue;
      }
      if (line === '\\ No newline at end of file') {
        continue;
      }
      throw new PatchParseError(
        `unexpected line inside hunk of ${current.newPath}: ${JSON.stringify(line)}`,
      );
    }

    if (line.trim().length > 0) {
      throw new PatchParseError(
        `unexpected content after hunks of ${current.newPath}: ${JSON.stringify(line)}`,
      );
    }
  }
  finishCurrent();

  if (files.length === 0) {
    throw new PatchParseError('patch contains no file sections');
  }

  return {
    files,
    addedLines: files.reduce((total, file) => total + file.added, 0),
    removedLines: files.reduce((total, file) => total + file.removed, 0),
  };
}

/**
 * Paths that an Aurelia patch is never allowed to modify. Guarding against
 * these keeps the fork delta auditable and prevents accidental edits to the
 * security-critical or vendored parts of the tree.
 */
export const FORBIDDEN_PATCH_PATHS = [
  'third_party/',
  'base/allocator/',
  'sandbox/',
  'crypto/',
  'net/third_party/',
  'components/policy/resources/',
];

/** Prefixes an Aurelia patch is expected to touch. */
export const EXPECTED_PATCH_PATH_PREFIXES = [
  'chrome/browser/',
  'chrome/common/',
  'chrome/app/',
  'chrome/installer/',
  'chrome/updater/',
  'components/',
  'content/',
  'ui/',
];

/**
 * Check that every touched file looks intentional.
 * @returns {string[]} problems, empty when acceptable
 */
export function findPathProblems(parsedPatch) {
  const problems = [];
  for (const file of parsedPatch.files) {
    const target = file.newPath;
    if (FORBIDDEN_PATCH_PATHS.some((prefix) => target.startsWith(prefix))) {
      problems.push(`${target} is in a forbidden area for Aurelia patches`);
    }
    if (
      !['chrome/chrome_paks.gni', 'tools/gritsettings/resource_ids.spec'].includes(target) &&
      !EXPECTED_PATCH_PATH_PREFIXES.some((prefix) => target.startsWith(prefix))
    ) {
      problems.push(
        `${target} is outside the expected Aurelia patch areas (${EXPECTED_PATCH_PATH_PREFIXES.join(', ')})`,
      );
    }
    if (file.oldPath !== file.newPath) {
      problems.push(`${target} looks like a rename of ${file.oldPath}`);
    }
  }
  return problems;
}
