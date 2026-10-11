import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkWebUIResources } from '../../tools/ci/check-webui-resources.mjs';
import { REPO_ROOT } from '../../tools/chromium/lib/config.mjs';
import { UPSTREAM_EDITS } from '../../tools/chromium/lib/upstream-edits.mjs';

const read = (file) => readFileSync(path.join(REPO_ROOT, file), 'utf8');
describe('static GN/GRIT resource contracts', () => {
  it('wires both isolated pages without requiring generated headers in Git', () => {
    expect(checkWebUIResources()).toEqual({ ok: true, problems: [] });
  });

  it('catches the Chromium 155 unused webui_context_type regression in New Tab', () => {
    const result = checkWebUIResources({
      read: (file) =>
        file.endsWith('resources/newtab/BUILD.gn')
          ? read(file).replace(
              /\s*ts_deps = \[ "\/\/ui\/webui\/resources\/js:build_ts" \]/,
              '',
            )
          : read(file),
    });
    expect(result.ok).toBe(false);
    expect(result.problems).toContain(
      'newtab: trusted WebUI TypeScript mapping requires ts_deps',
    );
  });

  it.each([
    'chrome/chrome_paks.gni',
    'tools/gritsettings/resource_ids.spec',
    'chrome/browser/ui/webui/BUILD.gn',
  ])('rejects missing integration in %s', (file) => {
    expect(
      checkWebUIResources({
        edits: UPSTREAM_EDITS.filter((edit) => edit.path !== file),
      }).ok,
    ).toBe(false);
  });

  it.each([
    ['resources/newtab/BUILD.gn', 'static_files', 'css_files'],
    ['resources/newtab/BUILD.gn', 'newtab_app.ts', 'missing.ts'],
    [
      'resources/newtab/BUILD.gn',
      'ts_deps = [ "//ui/webui/resources/js:build_ts" ]',
      '',
    ],
    [
      'resources/newtab/BUILD.gn',
      'webui_context_type = "trusted"',
      'webui_context_type = "untrusted"',
    ],
    [
      'resources/aurelia/BUILD.gn',
      'ts_deps = [ "//ui/webui/resources/js:build_ts" ]',
      '',
    ],
    [
      'resources/newtab/newtab.html',
      'design_tokens.css',
      '//chrome/browser/resources/aurelia/design_tokens.css',
    ],
    [
      'ui/webui/newtab/newtab_ui.cc',
      'IDR_AURELIA_NEWTAB_NEWTAB_HTML',
      'IDR_NEWTAB_NEWTAB_HTML',
    ],
    ['ui/webui/newtab/newtab_ui.h', 'class AureliaNewTabUI', 'class NewTabUI'],
  ])('rejects broken %s: %s', (suffix, before, after) => {
    expect(
      checkWebUIResources({
        read: (file) =>
          file.endsWith(suffix)
            ? read(file).replace(before, after)
            : read(file),
      }).ok,
    ).toBe(false);
  });
});
