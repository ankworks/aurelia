/**
 * Regression tests for Chromium 155 pinned Stylelint compliance of the
 * Aurelia CSS overlay.
 *
 * Real enforcement happens on the Windows validation run via the generated
 * `lint_css` build targets (`ui/webui/resources/tools/stylelint.py` with
 * `stylelint.config_base.mjs` at the pinned revision). Run 38141751383 failed
 * on `//chrome/browser/resources/newtab:lint_css` with 29 errors (and the
 * same rules flagged 30 more in the Aurelia page files). These tests pin the
 * three demonstrated rule classes so a regression fails the fast test suite
 * before a Windows run is wasted; they never disable or bypass Stylelint.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderCss } from '../../tools/design/generate-tokens.mjs';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const OVERLAY = path.join(
  REPO_ROOT,
  'chromium/overlay/chrome/browser/resources',
);

function overlayCssFiles() {
  const files = [];
  for (const page of ['aurelia', 'newtab']) {
    const dir = path.join(OVERLAY, page);
    for (const name of readdirSync(dir)) {
      if (name.endsWith('.css')) files.push(path.join(dir, name));
    }
  }
  return files;
}

/** Shortenable hex: #aabbcc -> #abc, #aabbccdd -> #abcd (color-hex-length). */
function findShortenableHex(css) {
  const found = [];
  const re = /#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})/g;
  for (const match of css.matchAll(re)) {
    const digits = match[1];
    const pairs = digits.match(/../g);
    if (pairs.every((pair) => pair[0] === pair[1])) {
      found.push(match[0]);
    }
  }
  return found;
}

/**
 * Duplicate rule-header selector sets within the same nesting context
 * (no-duplicate-selectors equivalent, verified against the pinned Stylelint:
 * `a, b` + `b, a` is a duplicate, `html, body` + `body` is not, and `:root`
 * inside an at-rule is a different context from a top-level `:root`).
 */
function findDuplicateSelectors(css) {
  const seen = new Map();
  const duplicates = [];
  const stack = [];
  let buffer = '';
  for (const rawLine of css.split('\n')) {
    let line = rawLine.trim();
    if (line.startsWith('/*') || line.startsWith('*')) {
      continue;
    }
    line = line.replace(/\/\*.*?\*\//g, '').trim();
    if (!line) continue;

    const text = buffer ? `${buffer} ${line}` : line;
    if (text.includes('{')) {
      const beforeBrace = text.slice(0, text.indexOf('{')).trim();
      buffer = '';
      if (beforeBrace.startsWith('@')) {
        stack.push(`@:${beforeBrace}`);
      } else {
        const normalized = beforeBrace
          .split(',')
          .map((part) => part.trim())
          .sort()
          .join(',');
        const key = `${stack.join('>')}>${normalized}`;
        if (seen.has(key)) {
          duplicates.push(beforeBrace);
        } else {
          seen.set(key, true);
        }
        stack.push(`sel:${normalized}`);
      }
    } else if (text.endsWith(',')) {
      // Multi-line selector list: accumulate with the next line.
      buffer = text;
    } else {
      buffer = '';
    }

    const closes = (line.match(/\}/g) || []).length;
    for (let i = 0; i < closes; i += 1) stack.pop();
  }
  return duplicates;
}

describe('overlay CSS versus the pinned Chromium Stylelint rules', () => {
  const files = overlayCssFiles();

  it('covers every overlay stylesheet', () => {
    expect(files.length).toBeGreaterThanOrEqual(5);
    expect(
      files.some((f) => f.endsWith(`newtab${path.sep}design_tokens.css`)),
    ).toBe(true);
  });

  for (const file of files) {
    const rel = path.relative(REPO_ROOT, file).replaceAll(path.sep, '/');
    const css = readFileSync(file, 'utf8');

    it(`${rel} uses single quotes only (@stylistic/string-quotes)`, () => {
      expect(css).not.toContain('"');
    });

    it(`${rel} shortens hex colors (color-hex-length)`, () => {
      expect(findShortenableHex(css)).toEqual([]);
    });

    it(`${rel} has no duplicate selectors per context (no-duplicate-selectors)`, () => {
      expect(findDuplicateSelectors(css)).toEqual([]);
    });

    it(`${rel} ends with a newline (@stylistic/no-missing-end-of-source-newline)`, () => {
      expect(css.endsWith('\n')).toBe(true);
    });
  }
});

describe('design token CSS generator contract', () => {
  const tokens = JSON.parse(
    readFileSync(
      path.join(REPO_ROOT, 'packages/design-tokens/tokens.json'),
      'utf8',
    ),
  );
  const css = renderCss(tokens);

  it('emits Stylelint-clean CSS', () => {
    expect(css).not.toContain('"');
    expect(findShortenableHex(css)).toEqual([]);
    expect(findDuplicateSelectors(css)).toEqual([]);
  });

  it('keeps the surface fallback in the single top-level :root block', () => {
    const roots = css.match(/^:root \{/gm) || [];
    expect(roots.length).toBe(1);
    const firstRoot = css.slice(
      css.indexOf(':root {'),
      css.indexOf('@media (prefers-color-scheme: dark)'),
    );
    expect(firstRoot).toContain(
      '--aurelia-surface: var(--aurelia-color-background-elevated);',
    );
  });
});

describe('overlay BUILD.gn lint policy', () => {
  for (const page of ['aurelia', 'newtab']) {
    it(`${page} never disables the generated lint targets`, () => {
      const gn = readFileSync(path.join(OVERLAY, page, 'BUILD.gn'), 'utf8');
      expect(gn).toContain('build_webui(');
      expect(gn).not.toMatch(/lint\s*=\s*false/i);
      expect(gn).not.toMatch(/enable_\w*lint\w*\s*=\s*false/i);
    });
  }
});
