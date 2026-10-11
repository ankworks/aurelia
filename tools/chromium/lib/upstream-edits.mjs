/**
 * The complete set of upstream Chromium files Aurelia modifies.
 *
 * Everything that can live in `chromium/overlay/` (new files) does. This list
 * is only for files that already exist upstream and must be edited in place.
 * Keeping it declarative means:
 *   - `tools/chromium/generate-patch.mjs` can regenerate the patch from the
 *     pinned pre-images instead of hand-editing diffs;
 *   - `tools/chromium/cli.mjs verify-patches --online` can re-verify every
 *     anchor against a fresh checkout of the pinned revision;
 *   - the fork delta stays auditable: one entry per modified line.
 *
 * Every `find` string MUST be unique in its file at the pinned revision. The
 * generator fails loudly otherwise, which is exactly what should happen when
 * upstream moves and a rebase is needed.
 */

/** Where the Aurelia WebUI controller lives inside the Chromium tree. */
export const AURELIA_WEBUI_TARGET = '//chrome/browser/ui/webui/aurelia';
export const AURELIA_RESOURCES_TARGET = '//chrome/browser/resources/aurelia';
export const NEWTAB_WEBUI_TARGET = '//chrome/browser/ui/webui/newtab';
export const NEWTAB_RESOURCES_TARGET = '//chrome/browser/resources/newtab';

export const UPSTREAM_EDITS = [
  {
    path: 'chrome/common/webui_url_constants.h',
    component: 'webui-url-constants',
    reason:
      'Declare the chrome://aurelia host constant next to the other WebUI hosts.',
    rebaseDifficulty: 'trivial',
    couldBecomeOverlay: false,
    upstreamable: 'no (Aurelia-specific)',
    find: 'inline constexpr char kChromeUIAutofillAiPath[] = "/enhancedAutofill";',
    replace: [
      'inline constexpr char kChromeUIAureliaHost[] = "aurelia";',
      'inline constexpr char kChromeUIAutofillAiPath[] = "/enhancedAutofill";',
    ].join('\n'),
  },
  {
    path: 'chrome/browser/resources/BUILD.gn',
    component: 'resources',
    reason:
      'Include the Aurelia WebUI resources pak in the browser resources group.',
    rebaseDifficulty: 'trivial',
    couldBecomeOverlay: false,
    upstreamable: 'no (Aurelia-specific)',
    find: [
      '      "app_service_internals:resources",',
      '      "autofill_ml_internals:resources",',
    ].join('\n'),
    replace: [
      '      "app_service_internals:resources",',
      '      "aurelia:resources",',
      '      "autofill_ml_internals:resources",',
    ].join('\n'),
  },
  {
    path: 'chrome/browser/ui/webui/BUILD.gn',
    component: 'webui',
    reason:
      'Add the Aurelia WebUI controller to the desktop WebUI dependency set.',
    rebaseDifficulty: 'trivial',
    couldBecomeOverlay: false,
    upstreamable: 'no (Aurelia-specific)',
    find: [
      '  if (!is_android) {',
      '    deps += [',
      '      "//chrome/browser/ui/webui/bookmarks",',
    ].join('\n'),
    replace: [
      '  if (!is_android) {',
      '    deps += [',
      `      "${AURELIA_WEBUI_TARGET}",`,
      '      "//chrome/browser/ui/webui/bookmarks",',
    ].join('\n'),
  },
  {
    path: 'chrome/browser/ui/BUILD.gn',
    component: 'browser-ui',
    reason: 'Link the Aurelia WebUI controller into //chrome/browser/ui.',
    rebaseDifficulty: 'trivial',
    couldBecomeOverlay: false,
    upstreamable: 'no (Aurelia-specific)',
    find: [
      '      "//chrome/browser/ui/web_modal:browser_window_modal_dialog_delegate",',
      '      "//chrome/browser/ui/webui/webui_gallery",',
    ].join('\n'),
    replace: [
      '      "//chrome/browser/ui/web_modal:browser_window_modal_dialog_delegate",',
      `      "${AURELIA_WEBUI_TARGET}",`,
      '      "//chrome/browser/ui/webui/webui_gallery",',
    ].join('\n'),
  },
  {
    path: 'chrome/browser/BUILD.gn',
    component: 'browser',
    reason: 'Link the Aurelia WebUI controller only on non-Android builds.',
    rebaseDifficulty: 'trivial',
    couldBecomeOverlay: false,
    upstreamable: 'no (Aurelia-specific)',
    find: [
      '  if (!is_android) {',
      '    deps += [',
      '      "//chrome/browser/contextual_cueing/internals",',
      '      "//chrome/browser/safe_browsing/suspicious_site_warnings",',
    ].join('\n'),
    replace: [
      '  if (!is_android) {',
      '    deps += [',
      `      "${AURELIA_WEBUI_TARGET}",`,
      '      "//chrome/browser/contextual_cueing/internals",',
      '      "//chrome/browser/safe_browsing/suspicious_site_warnings",',
    ].join('\n'),
  },
  {
    path: 'chrome/browser/ui/webui/chrome_web_ui_configs.cc',
    component: 'webui',
    reason:
      'Register the chrome://aurelia WebUI config and include its header.',
    rebaseDifficulty: 'trivial',
    couldBecomeOverlay: false,
    upstreamable: 'no (Aurelia-specific)',
    find: '#include "chrome/browser/ui/webui/app_service_internals/app_service_internals_ui.h"',
    replace: [
      '#include "chrome/browser/ui/webui/aurelia/aurelia_ui.h"',
      '#include "chrome/browser/ui/webui/app_service_internals/app_service_internals_ui.h"',
    ].join('\n'),
  },
  {
    path: 'chrome/browser/ui/webui/chrome_web_ui_configs.cc',
    component: 'webui',
    reason: 'Make chrome://aurelia a registered WebUI page.',
    rebaseDifficulty: 'trivial',
    couldBecomeOverlay: false,
    upstreamable: 'no (Aurelia-specific)',
    find: '  map.AddWebUIConfig(std::make_unique<NewTabUIConfig>());',
    replace: [
      '  map.AddWebUIConfig(std::make_unique<AureliaUIConfig>());',
      '  map.AddWebUIConfig(std::make_unique<NewTabUIConfig>());',
    ].join('\n'),
  },
  {
    path: 'chrome/common/webui_url_constants.h',
    component: 'webui-url-constants',
    reason: 'Declare the chrome://aurelia-newtab host constant.',
    rebaseDifficulty: 'trivial',
    couldBecomeOverlay: false,
    upstreamable: 'no (Aurelia-specific)',
    find: 'inline constexpr char kChromeUIAureliaHost[] = "aurelia";',
    replace: [
      'inline constexpr char kChromeUIAureliaHost[] = "aurelia";',
      'inline constexpr char kChromeUINewTabAureliaHost[] = "aurelia-newtab";',
    ].join('\n'),
  },
  {
    path: 'chrome/browser/resources/BUILD.gn',
    component: 'resources',
    reason:
      'Include the NewTab WebUI resources pak in the browser resources group.',
    rebaseDifficulty: 'trivial',
    couldBecomeOverlay: false,
    upstreamable: 'no (Aurelia-specific)',
    find: [
      '      "app_service_internals:resources",',
      '      "aurelia:resources",',
    ].join('\n'),
    replace: [
      '      "app_service_internals:resources",',
      '      "aurelia:resources",',
      '      "newtab:resources",',
    ].join('\n'),
  },
  {
    path: 'chrome/browser/ui/webui/BUILD.gn',
    component: 'webui',
    reason:
      'Add the NewTab WebUI controller to the desktop WebUI dependency set.',
    rebaseDifficulty: 'trivial',
    couldBecomeOverlay: false,
    upstreamable: 'no (Aurelia-specific)',
    find: [
      '  if (!is_android) {',
      '    deps += [',
      `      "${AURELIA_WEBUI_TARGET}",`,
      '      "//chrome/browser/ui/webui/bookmarks",',
    ].join('\n'),
    replace: [
      '  if (!is_android) {',
      '    deps += [',
      `      "${AURELIA_WEBUI_TARGET}",`,
      `      "${NEWTAB_WEBUI_TARGET}",`,
      '      "//chrome/browser/ui/webui/bookmarks",',
    ].join('\n'),
  },
  {
    path: 'chrome/browser/ui/BUILD.gn',
    component: 'browser-ui',
    reason: 'Link the NewTab WebUI controller into //chrome/browser/ui.',
    rebaseDifficulty: 'trivial',
    couldBecomeOverlay: false,
    upstreamable: 'no (Aurelia-specific)',
    find: [
      '      "//chrome/browser/ui/web_modal:browser_window_modal_dialog_delegate",',
      `      "${AURELIA_WEBUI_TARGET}",`,
      '      "//chrome/browser/ui/webui/webui_gallery",',
    ].join('\n'),
    replace: [
      '      "//chrome/browser/ui/web_modal:browser_window_modal_dialog_delegate",',
      `      "${AURELIA_WEBUI_TARGET}",`,
      `      "${NEWTAB_WEBUI_TARGET}",`,
      '      "//chrome/browser/ui/webui/webui_gallery",',
    ].join('\n'),
  },
  {
    path: 'chrome/browser/BUILD.gn',
    component: 'browser',
    reason: 'Link the NewTab WebUI controller only on non-Android builds.',
    rebaseDifficulty: 'trivial',
    couldBecomeOverlay: false,
    upstreamable: 'no (Aurelia-specific)',
    find: [
      '  if (!is_android) {',
      '    deps += [',
      `      "${AURELIA_WEBUI_TARGET}",`,
      '      "//chrome/browser/contextual_cueing/internals",',
    ].join('\n'),
    replace: [
      '  if (!is_android) {',
      '    deps += [',
      `      "${AURELIA_WEBUI_TARGET}",`,
      `      "${NEWTAB_WEBUI_TARGET}",`,
      '      "//chrome/browser/contextual_cueing/internals",',
    ].join('\n'),
  },
  {
    path: 'chrome/browser/ui/webui/chrome_web_ui_configs.cc',
    component: 'webui',
    reason:
      'Register the chrome://aurelia-newtab WebUI config and include its header.',
    rebaseDifficulty: 'trivial',
    couldBecomeOverlay: false,
    upstreamable: 'no (Aurelia-specific)',
    find: '#include "chrome/browser/ui/webui/autofill_ml_internals/autofill_ml_internals_ui.h"',
    replace: [
      '#include "chrome/browser/ui/webui/newtab/newtab_ui.h"',
      '#include "chrome/browser/ui/webui/autofill_ml_internals/autofill_ml_internals_ui.h"',
    ].join('\n'),
  },
  {
    path: 'chrome/browser/ui/webui/chrome_web_ui_configs.cc',
    component: 'webui',
    reason: 'Make chrome://aurelia-newtab a registered WebUI page.',
    rebaseDifficulty: 'trivial',
    couldBecomeOverlay: false,
    upstreamable: 'no (Aurelia-specific)',
    find: '  map.AddWebUIConfig(std::make_unique<AureliaUIConfig>());',
    replace: [
      '  map.AddWebUIConfig(std::make_unique<AureliaUIConfig>());',
      '  map.AddWebUIConfig(std::make_unique<AureliaNewTabUIConfig>());',
    ].join('\n'),
  },
  {
    path: 'chrome/chrome_paks.gni',
    component: 'resources',
    reason:
      'Repack both Aurelia resource bundles into the desktop browser resources.pak.',
    rebaseDifficulty: 'trivial',
    couldBecomeOverlay: false,
    upstreamable: 'no (Aurelia-specific)',
    find: '        "$root_gen_dir/chrome/app_service_internals_resources.pak",',
    replace:
      '        "$root_gen_dir/chrome/app_service_internals_resources.pak",\n        "$root_gen_dir/chrome/aurelia_resources.pak",\n        "$root_gen_dir/chrome/aurelia_newtab_resources.pak",',
  },
  {
    path: 'chrome/chrome_paks.gni',
    component: 'resources',
    reason:
      'Ensure both Aurelia resource paks exist before the desktop repack action.',
    rebaseDifficulty: 'trivial',
    couldBecomeOverlay: false,
    upstreamable: 'no (Aurelia-specific)',
    find: '        "//chrome/browser/actor/resources:browser_resources",',
    replace:
      '        "//chrome/browser/actor/resources:browser_resources",\n        "//chrome/browser/resources/aurelia:resources",\n        "//chrome/browser/resources/newtab:resources",',
  },
  {
    path: 'tools/gritsettings/resource_ids.spec',
    component: 'resources',
    reason:
      'Reserve generated resource IDs for Aurelia through the upstream allocator.',
    rebaseDifficulty: 'trivial',
    couldBecomeOverlay: false,
    upstreamable: 'no (Aurelia-specific)',
    find: '  "<(SHARED_INTERMEDIATE_DIR)/chrome/browser/resources/bluetooth_internals/resources.grd": {',
    replace:
      '  "<(SHARED_INTERMEDIATE_DIR)/chrome/browser/resources/aurelia/resources.grd": {\n    "META": {"sizes": {"includes": [20]}},\n    "includes": [2870],\n  },\n  "<(SHARED_INTERMEDIATE_DIR)/chrome/browser/resources/bluetooth_internals/resources.grd": {',
  },
  {
    path: 'tools/gritsettings/resource_ids.spec',
    component: 'resources',
    reason:
      'Reserve generated resource IDs for the isolated Aurelia New Tab page.',
    rebaseDifficulty: 'trivial',
    couldBecomeOverlay: false,
    upstreamable: 'no (Aurelia-specific)',
    find: '  "<(SHARED_INTERMEDIATE_DIR)/chrome/browser/resources/omnibox/aim_eligibility_extension/resources.grd": {',
    replace:
      '  "<(SHARED_INTERMEDIATE_DIR)/chrome/browser/resources/newtab/resources.grd": {\n    "META": {"sizes": {"includes": [20]}},\n    "includes": [4452],\n  },\n  "<(SHARED_INTERMEDIATE_DIR)/chrome/browser/resources/omnibox/aim_eligibility_extension/resources.grd": {',
  },
];

/** Summary used by docs and the fork-delta report. */
export function summariseEdits(edits = UPSTREAM_EDITS) {
  const byPath = new Map();
  for (const edit of edits) {
    const entry = byPath.get(edit.path) ?? { path: edit.path, edits: 0 };
    entry.edits += 1;
    byPath.set(edit.path, entry);
  }
  return {
    modifiedFiles: byPath.size,
    editCount: edits.length,
    files: [...byPath.values()],
  };
}
