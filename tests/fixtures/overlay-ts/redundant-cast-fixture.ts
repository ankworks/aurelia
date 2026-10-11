/**
 * Deliberate `@typescript-eslint/no-unnecessary-type-assertion` violation used
 * by tests/tools/overlay-ts-eslint.test.mjs to prove the pinned Chromium 155
 * type-aware lint gate is actually enforced by the regression test (run
 * 38146612150 failed on exactly this rule in aurelia_app.ts). This fixture is
 * test-only and is never part of the Chromium overlay.
 */
export function redundantCastFixture(value: string): string {
  return value as string;
}
