/**
 * Generate every design-token artifact from packages/design-tokens/tokens.json.
 *
 * Outputs:
 *   chromium/overlay/chrome/browser/resources/aurelia/design_tokens.css
 *   packages/design-tokens/src/tokens.generated.ts
 *   packages/ui-lab/src/tokens.generated.css
 *
 * The Chromium overlay file is checked in on purpose: the Chromium build must
 * not depend on Node.js tooling. CI runs this generator with `--check` and
 * fails if a checked-in file is stale.
 *
 * Usage:
 *   node tools/design/generate-tokens.mjs           # write files
 *   node tools/design/generate-tokens.mjs --check   # verify up to date
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from '../lib/entry.mjs';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

const TOKENS_PATH = path.join(REPO_ROOT, 'packages/design-tokens/tokens.json');

const OUTPUTS = {
  css: [
    path.join(
      REPO_ROOT,
      'chromium/overlay/chrome/browser/resources/aurelia/design_tokens.css',
    ),
    path.join(
      REPO_ROOT,
      'chromium/overlay/chrome/browser/resources/newtab/design_tokens.css',
    ),
    path.join(REPO_ROOT, 'packages/ui-lab/src/tokens.generated.css'),
  ],
  ts: path.join(REPO_ROOT, 'packages/design-tokens/src/tokens.generated.ts'),
};

const BANNER = `/* GENERATED FILE - DO NOT EDIT.
 * Source: packages/design-tokens/tokens.json
 * Regenerate: node tools/design/generate-tokens.mjs
 * License: MPL-2.0 (Aurelia Browser)
 */`;

/** Flatten the token tree into theme-aware CSS custom properties. */
export function flattenTokens(tokens) {
  const shared = [];
  const light = [];
  const dark = [];

  const walk = (node, trail) => {
    for (const [key, value] of Object.entries(node)) {
      if (key.startsWith('$') || key === 'meta') continue;
      const nextTrail = [...trail, key];
      if (value === null || typeof value !== 'object') continue;
      if (typeof value.value === 'string') {
        shared.push([nextTrail, value.value]);
        continue;
      }
      if (typeof value.light === 'string' || typeof value.dark === 'string') {
        if (value.light !== undefined) light.push([nextTrail, value.light]);
        if (value.dark !== undefined) dark.push([nextTrail, value.dark]);
        // Fall back on a shared value when only one theme is provided so a
        // theme can never end up with an undefined variable.
        if (value.light === undefined) light.push([nextTrail, value.dark]);
        if (value.dark === undefined) dark.push([nextTrail, value.light]);
        continue;
      }
      walk(value, nextTrail);
    }
  };

  walk(tokens, []);

  const customProperty = ([trail]) =>
    `--aurelia-${trail
      .map((part) => part.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase())
      .join('-')}`;

  return { shared, light, dark, customProperty };
}

function renderBlock(entries, customProperty, indent = '  ') {
  return entries
    .map(([trail, value]) => `${indent}${customProperty([trail])}: ${value};`)
    .join('\n');
}

export function renderCss(tokens) {
  const { shared, light, dark, customProperty } = flattenTokens(tokens);

  return `${BANNER}
/* Aurelia design tokens.
 * Light is the default; the dark block overrides it. Consumers must not hard
 * code colours: use these variables so themes and high-contrast modes work. */

:root {
${renderBlock(shared, customProperty)}
${renderBlock(light, customProperty)}

  /* Transparency is a progressive enhancement: when it is unavailable the
   * opaque elevated surface is used instead. */
  --aurelia-surface: var(--aurelia-color-background-elevated);
}

@media (prefers-color-scheme: dark) {
  :root {
${renderBlock(dark, customProperty, '    ')}
  }
}

/* Force a theme regardless of the OS setting (appearance.theme preference). */
:root[data-aurelia-theme='light'] {
${renderBlock(light, customProperty)}
}

:root[data-aurelia-theme='dark'] {
${renderBlock(dark, customProperty)}
}

@media (prefers-reduced-transparency: no-preference) {
  :root[data-aurelia-transparency='on'] {
    --aurelia-surface: var(--aurelia-color-surface-glass);
  }
}

@media (prefers-reduced-motion: reduce) {
  :root {
    --aurelia-motion-duration-fast: 0ms;
    --aurelia-motion-duration-normal: 0ms;
  }
}
`;
}

export function renderTypeScript(tokens) {
  const { shared, light, dark, customProperty } = flattenTokens(tokens);
  const toEntries = (entries) =>
    entries
      .map(
        ([trail, value]) =>
          `  '${customProperty([trail])}': ${JSON.stringify(value)},`,
      )
      .join('\n');

  // A themed token appears once in the light set and once in the dark set, so
  // the flat list of names must be de-duplicated rather than emitted as object
  // keys (duplicate keys are a TypeScript error).
  const uniqueNames = [
    ...new Set(
      [...shared, ...light, ...dark].map(([trail]) => customProperty([trail])),
    ),
  ].sort();

  return `// GENERATED FILE - DO NOT EDIT.
// Source: packages/design-tokens/tokens.json
// Regenerate: node tools/design/generate-tokens.mjs

/** Every CSS custom property the Aurelia design system defines. */
export const CSS_VARIABLE_NAMES = [
${uniqueNames.map((name) => `  '${name}',`).join('\n')}
] as const;

/** Shared (theme-independent) token values. */
export const SHARED_TOKENS = {
${toEntries(shared)}
} as const;

/** Light-theme token values. */
export const LIGHT_TOKENS = {
${toEntries(light)}
} as const;

/** Dark-theme token values. */
export const DARK_TOKENS = {
${toEntries(dark)}
} as const;

export type AureliaCssVariableName = (typeof CSS_VARIABLE_NAMES)[number];
`;
}

export function generate({ check = false, log = console.log } = {}) {
  const tokens = JSON.parse(readFileSync(TOKENS_PATH, 'utf8'));
  const css = renderCss(tokens);
  const ts = renderTypeScript(tokens);

  const stale = [];
  const writeIfChanged = (filePath, contents) => {
    const existing = existsSync(filePath)
      ? readFileSync(filePath, 'utf8')
      : null;
    if (existing === contents) {
      log(`up to date  ${path.relative(REPO_ROOT, filePath)}`);
      return;
    }
    if (check) {
      stale.push(path.relative(REPO_ROOT, filePath));
      log(`STALE       ${path.relative(REPO_ROOT, filePath)}`);
      return;
    }
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, contents);
    log(`wrote       ${path.relative(REPO_ROOT, filePath)}`);
  };

  for (const cssPath of OUTPUTS.css) {
    writeIfChanged(cssPath, css);
  }
  writeIfChanged(OUTPUTS.ts, ts);

  if (check && stale.length > 0) {
    throw new Error(
      `generated design token files are out of date:\n- ${stale.join('\n- ')}\nRun: node tools/design/generate-tokens.mjs`,
    );
  }
  return { stale };
}

const isMain = isMainModule(import.meta.url);

if (isMain) {
  try {
    generate({ check: process.argv.includes('--check') });
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  }
}
