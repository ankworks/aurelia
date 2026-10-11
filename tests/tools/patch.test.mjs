import { describe, expect, it } from 'vitest';

import {
  PatchParseError,
  findEncodingProblems,
  findPathProblems,
  parsePatch,
} from '../../tools/chromium/lib/patch.mjs';
import {
  UPSTREAM_EDITS,
  summariseEdits,
} from '../../tools/chromium/lib/upstream-edits.mjs';
import { applyEdits } from '../../tools/chromium/generate-patch.mjs';

const SIMPLE_PATCH = `diff --git a/chrome/browser/x.cc b/chrome/browser/x.cc
index 1111111..2222222 100644
--- a/chrome/browser/x.cc
+++ b/chrome/browser/x.cc
@@ -1,2 +1,3 @@
 #include "x.h"
+// aurelia
 int main() { return 0; }
`;

describe('parsePatch', () => {
  it('counts files, hunks and line changes', () => {
    const parsed = parsePatch(SIMPLE_PATCH);
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0].newPath).toBe('chrome/browser/x.cc');
    expect(parsed.files[0].added).toBe(1);
    expect(parsed.files[0].removed).toBe(0);
    expect(parsed.files[0].hunks).toBe(1);
    expect(parsed.addedLines).toBe(1);
  });

  it('rejects binary patches', () => {
    expect(() =>
      parsePatch(`diff --git a/a.png b/a.png
GIT binary patch
literal 3
`),
    ).toThrow(PatchParseError);
  });

  it('rejects renames and mode changes', () => {
    expect(() =>
      parsePatch(`diff --git a/a.cc b/b.cc
rename from a.cc
rename to b.cc
`),
    ).toThrow(/renames are not supported/);
    expect(() =>
      parsePatch(`diff --git a/a.sh b/a.sh
old mode 100644
new mode 100755
`),
    ).toThrow(/mode changes are not supported/);
  });

  it('rejects an empty patch', () => {
    expect(() => parsePatch('')).toThrow(/no file sections/);
    expect(() => parsePatch('\n\n')).toThrow(/no file sections/);
  });

  it('rejects trailing content that is not a file header', () => {
    expect(() => parsePatch('# just a comment\n')).toThrow(
      /unexpected content before first file header/,
    );
  });

  it('rejects a CRLF patch file and says what to fix', () => {
    // Regression: actions/runs/38108794402. A Windows checkout with
    // core.autocrlf=true turned the committed LF patch into CRLF. `\r` is an
    // ECMAScript LineTerminator, so `^diff --git a/(.+) b/(.+)$` cannot match
    // the header and the parser used to report the misleading
    // "unexpected content before first file header".
    const crlf = SIMPLE_PATCH.replaceAll('\n', '\r\n');
    let thrown = null;
    try {
      parsePatch(crlf);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PatchParseError);
    expect(thrown?.name).toBe('PatchEncodingError');
    expect(thrown?.problem).toBe('crlf');
    expect(thrown?.message).toMatch(/CRLF/);
    expect(thrown?.message).toMatch(/gitattributes/);
    expect(thrown?.message).not.toMatch(/unexpected content/);
  });

  it('rejects a byte-order mark', () => {
    let thrown = null;
    try {
      parsePatch(`\uFEFF${SIMPLE_PATCH}`);
    } catch (error) {
      thrown = error;
    }
    expect(thrown?.name).toBe('PatchEncodingError');
    expect(thrown?.problem).toBe('bom');
    expect(thrown?.message).toMatch(/byte-order mark/);
  });

  it('reports every offending line ending, not just the first', () => {
    expect(findEncodingProblems(SIMPLE_PATCH)).toEqual([]);
    expect(findEncodingProblems(SIMPLE_PATCH.replaceAll('\n', '\r\n'))).toEqual(
      [expect.objectContaining({ problem: 'crlf', firstLine: 1 })],
    );
    const both = findEncodingProblems(
      `\uFEFF${SIMPLE_PATCH.replaceAll('\n', '\r\n')}`,
    );
    expect(both.map((entry) => entry.problem).sort()).toEqual(['bom', 'crlf']);
    expect(both.find((entry) => entry.problem === 'crlf').count).toBe(
      SIMPLE_PATCH.split('\n').length - 1,
    );
  });

  it('keeps structural errors structural for canonical LF patches', () => {
    expect(() => parsePatch(SIMPLE_PATCH)).not.toThrow();
    expect(() => parsePatch('')).toThrow(/no file sections/);
    expect(() => parsePatch('# just a comment\n')).toThrow(PatchParseError);
  });

  it('rejects unexpected content inside a hunk', () => {
    expect(() =>
      parsePatch(`diff --git a/a.cc b/a.cc
--- a/a.cc
+++ b/a.cc
@@ -1,1 +1,1 @@
???
`),
    ).toThrow(/unexpected line inside hunk/);
  });
});

describe('findPathProblems', () => {
  const parse = (text) => parsePatch(text);

  it('accepts chrome/browser changes', () => {
    expect(findPathProblems(parse(SIMPLE_PATCH))).toEqual([]);
  });

  it('refuses patches into vendored or security-critical trees', () => {
    const patch = SIMPLE_PATCH.replaceAll(
      'chrome/browser/x.cc',
      'third_party/x.cc',
    );
    expect(findPathProblems(parse(patch)).join('\n')).toMatch(/forbidden area/);
  });

  it('refuses patches outside the expected areas', () => {
    const patch = SIMPLE_PATCH.replaceAll('chrome/browser/x.cc', 'weird/x.cc');
    expect(findPathProblems(parse(patch)).join('\n')).toMatch(
      /outside the expected/,
    );
  });
});

describe('upstream edits', () => {
  it('targets a small, reviewable set of files', () => {
    const summary = summariseEdits(UPSTREAM_EDITS);
    expect(summary.modifiedFiles).toBeLessThanOrEqual(8);
    expect(summary.editCount).toBeLessThanOrEqual(18);
  });

  it('documents every edit', () => {
    for (const edit of UPSTREAM_EDITS) {
      expect(edit.reason.length).toBeGreaterThan(10);
      expect(edit.component.length).toBeGreaterThan(0);
      expect(edit.rebaseDifficulty.length).toBeGreaterThan(0);
      expect(edit.find).not.toBe(edit.replace);
      expect(edit.replace).toContain(edit.find.split('\n')[0]);
    }
  });

  it('never shrinks a file: insertions only', () => {
    for (const edit of UPSTREAM_EDITS) {
      const before = edit.find.split('\n').length;
      const after = edit.replace.split('\n').length;
      expect(after).toBeGreaterThanOrEqual(before);
    }
  });

  it('only replaces anchors that are unique in the pinned pre-images', () => {
    // The generator enforces uniqueness against the real upstream files; this
    // test enforces that each anchor is unique within the edit list itself so
    // two edits cannot fight over the same lines.
    const anchors = UPSTREAM_EDITS.map((edit) => `${edit.path}::${edit.find}`);
    expect(new Set(anchors).size).toBe(anchors.length);
  });

  it('applies edits to an in-memory file map and refuses missing anchors', () => {
    const fileMap = new Map([
      ['chrome/common/webui_url_constants.h', 'a\nANCHOR\nb\n'],
    ]);
    const { files, applied } = applyEdits(fileMap, [
      {
        path: 'chrome/common/webui_url_constants.h',
        find: 'ANCHOR',
        replace: 'ANCHOR\nAURELIA',
      },
    ]);
    expect(files.get('chrome/common/webui_url_constants.h')).toBe(
      'a\nANCHOR\nAURELIA\nb\n',
    );
    expect(applied).toHaveLength(1);

    expect(() =>
      applyEdits(fileMap, [
        {
          path: 'chrome/common/webui_url_constants.h',
          find: 'MISSING',
          replace: 'x',
        },
      ]),
    ).toThrow(/anchor not found/);

    expect(() =>
      applyEdits(new Map([['p', 'DUP DUP DUP']]), [
        { path: 'p', find: 'DUP', replace: 'DUP!' },
      ]),
    ).toThrow(/ambiguous/);
  });
});
