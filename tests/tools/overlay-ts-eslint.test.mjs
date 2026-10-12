/**
 * Regression tests for the Chromium 155 pinned type-aware ESLint gate over the
 * Aurelia TypeScript overlay.
 *
 * Real enforcement happens on the Windows validation run via the generated
 * `lint_ts` targets (ui/webui/resources/tools/eslint_ts.py with
 * eslint_ts.config_base.ts at the pinned revision). Run 38146612150 failed on
 * `//chrome/browser/resources/aurelia:lint_ts` with
 * `@typescript-eslint/no-unnecessary-type-assertion` at aurelia_app.ts:153:20.
 * This test runs the same type-aware rule set (the always-on `defaultConfig`
 * rules that apply to plain TypeScript) with the repository's typescript-eslint
 * over every overlay file, and proves the rules actually fire via a deliberate
 * fixture violation. The Lit/Polymer-specific @webui-eslint rules cannot
 * trigger on these files at all: the overlay never imports lit or Polymer, and
 * those rules are gated on Lit/Polymer class inheritance.
 */
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const FIXTURE_DIR = path.join(REPO_ROOT, 'tests/fixtures/overlay-ts');
const OVERLAY_FILES = [
  'chromium/overlay/chrome/browser/resources/aurelia/aurelia_app.ts',
  'chromium/overlay/chrome/browser/resources/aurelia/aurelia_status_card.ts',
  'chromium/overlay/chrome/browser/resources/aurelia/command_palette.ts',
  'chromium/overlay/chrome/browser/resources/newtab/newtab_app.ts',
];

// Always-on rules from the pinned eslint_ts.config_base.ts defaultConfig that
// apply to plain (non-Lit) TypeScript.
const PINNED_TYPE_AWARE_RULES = {
  'require-await': 'off',
  '@typescript-eslint/require-await': 'error',
  '@typescript-eslint/no-unnecessary-type-assertion': 'error',
  '@typescript-eslint/no-unnecessary-type-conversion': 'error',
  '@typescript-eslint/consistent-type-exports': 'error',
};

function makeEslint() {
  return new ESLint({
    cwd: REPO_ROOT,
    // Do not load the repository's own eslint.config.mjs; use the pinned
    // Chromium rule set below.
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ['**/*.ts'],
        languageOptions: {
          parser: tseslint.parser,
          parserOptions: {
            project: ['./tsconfig.json'],
            tsconfigRootDir: FIXTURE_DIR,
          },
        },
        plugins: {
          '@typescript-eslint': tseslint.plugin,
        },
        rules: PINNED_TYPE_AWARE_RULES,
      },
    ],
  });
}

describe('overlay TypeScript versus the pinned Chromium type-aware ESLint rules', () => {
  it('reports no violations in any overlay file', async () => {
    const results = await makeEslint().lintFiles(OVERLAY_FILES);
    const problems = results.flatMap((result) =>
      result.messages.map(
        (message) =>
          `${path.relative(REPO_ROOT, result.filePath)}:${message.line}:` +
          `${message.column} ${message.ruleId ?? 'parse'} ${message.message}`,
      ),
    );
    expect(problems).toEqual([]);
    expect(results).toHaveLength(OVERLAY_FILES.length);
  });

  it('catches an unnecessary type assertion (gate is enforced, not vacuous)', async () => {
    const results = await makeEslint().lintText(
      'export function identity(value: string): string {\n' +
        '  return value as string;\n' +
        '}\n',
      {
        filePath: path.join(FIXTURE_DIR, 'redundant-cast-fixture.ts'),
      },
    );
    const rules = results.flatMap((result) =>
      result.messages.map((message) => message.ruleId),
    );
    expect(rules).toContain('@typescript-eslint/no-unnecessary-type-assertion');
  });

  it('never imports lit or Polymer (their rules cannot apply to the overlay)', () => {
    // The remaining always-on @webui-eslint rules (lit-element-*,
    // lit-property-accessor, polymer-property-*) are gated on Lit/Polymer
    // class inheritance; keeping the overlay free of those imports keeps the
    // gate closed.
    for (const file of OVERLAY_FILES) {
      const source = readFileSync(path.join(REPO_ROOT, file), 'utf8');
      expect(source).not.toMatch(/from ['"](?:lit|@polymer|polymer)/);
    }
  });
});
