# Fork delta

How much of Chromium Aurelia changes, why, and how hard it is to rebase.

Keeping this number small is a product requirement, not a style preference: a
small delta is what makes security updates land quickly. Aurelia is built as
**isolated code plus a handful of one-line build registrations**, never as a
patched-up copy of a Chromium subsystem.

- Pinned base: Chromium `155.0.8059.40`
  (`cfaadc5a132d78e1828635aa8405a499f3e14864`, stable channel)
- Patch set version: `0.1.0`

> **Verification state:** the numbers below are measured by
> `node tools/chromium/cli.mjs fork-delta` and the patch set is verified against
> the pinned upstream revision by
> `node tools/chromium/cli.mjs verify-patches --online`.
> **The tree has not been compiled yet** - there is no buildable builder in the
> scaffolding environment. See [Status](#status) at the bottom of this file and
> `.github/workflows/chromium-build.yml`.

## Measured delta

| Metric                            | Value        |
| --------------------------------- | ------------ |
| Patch files                       | 1            |
| Modified upstream files           | 8            |
| Lines added to upstream files     | 26           |
| Lines removed from upstream files | 0            |
| Overlay files added               | 20           |
| Overlay size                      | 89,411 bytes |

Reproduce with:

```bash
node tools/chromium/cli.mjs fork-delta --json
node tools/chromium/cli.mjs status
```

## Modified upstream files

Every entry is an insertion, in an area upstream rarely rewrites. None of them
changes Chromium behaviour; they register Aurelia code that lives in
`chromium/overlay/`.

| File                                               | Delta | Reason                                                      |
| -------------------------------------------------- | ----- | ----------------------------------------------------------- |
| `chrome/common/webui_url_constants.h`              | +2    | Declare the two isolated Aurelia hosts.                     |
| `chrome/browser/resources/BUILD.gn`                | +2    | Build both resource bundles.                                |
| `chrome/browser/ui/webui/BUILD.gn`                 | +2    | Link both controllers to the WebUI config registry.         |
| `chrome/browser/ui/BUILD.gn`                       | +2    | Link controllers into browser UI.                           |
| `chrome/browser/BUILD.gn`                          | +2    | Link controllers into the non-Android browser graph.        |
| `chrome/browser/ui/webui/chrome_web_ui_configs.cc` | +4    | Include and register both controllers in the desktop guard. |
| `chrome/chrome_paks.gni`                           | +4    | Repack both generated paks with explicit dependencies.      |
| `tools/gritsettings/resource_ids.spec`             | +8    | Allocate IDs for both generated GRDs, 20 resources each.    |

All are Aurelia-specific registrations; none redirects `chrome://newtab`.
The malformed M1 patch `0002` was consolidated into generator-owned `0001`:
one atomic patch against untouched pinned upstream, not mixed pre/post contexts.

Machine-readable version of this table (including the exact anchor text each
edit inserts at, pre-image and post-image digests):
`chromium/patches/0001-aurelia-webui-and-resources.meta.json`.

## Overlay files (added, not patched)

These are plain new files. They carry no rebase cost: if upstream moves, the
only thing that can break is an API they call, not a conflict.

| File                                                      | Purpose                                                                                             |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `chrome/browser/ui/webui/aurelia/BUILD.gn`                | GN target for the controller, modelled on `webui_gallery`.                                          |
| `chrome/browser/ui/webui/aurelia/aurelia_ui.h`            | `AureliaUIConfig` + `AureliaUI` controller declaration.                                             |
| `chrome/browser/ui/webui/aurelia/aurelia_ui.cc`           | Serves `chrome://aurelia` from the resource pak; exposes only compile-time provenance strings.      |
| `chrome/browser/ui/webui/aurelia/aurelia_version.h`       | **Generated** from `config/chromium_version.json`; single place product identity is defined in C++. |
| `chrome/browser/resources/aurelia/BUILD.gn`               | `build_webui()` target: pak, grit map, TypeScript compilation.                                      |
| `chrome/browser/resources/aurelia/aurelia.html`           | Page shell.                                                                                         |
| `chrome/browser/resources/aurelia/aurelia_app.ts`         | `<aurelia-app>` page element.                                                                       |
| `chrome/browser/resources/aurelia/aurelia_status_card.ts` | `<aurelia-status-card>` component.                                                                  |
| `chrome/browser/resources/aurelia/aurelia.css`            | Page styles (tokens only, accessibility fallbacks).                                                 |
| `chrome/browser/resources/aurelia/design_tokens.css`      | **Generated** from `packages/design-tokens/tokens.json`.                                            |

The table above lists the original status surface. M1 additionally carries
New Tab HTML/CSS/TypeScript and its C++ controller/BUILD files, command palette
TS/CSS, and a generated copy of design tokens under the New Tab resource origin.
Run `fork-delta --json` for current totals.

## Integration verification boundary

Both configs now register in the desktop `!IS_ANDROID` branch alongside the
upstream `NewTabUIConfig`, outside the AppHome ChromeOS guard. The new controller
is named `AureliaNewTabUI` to avoid colliding with upstream's incognito controller.
The generated `.grd` files feed Chromium's ID allocator and GRIT, which produces
headers, maps and paks. The desktop repack includes both paks. Static checks are
not compilation or runtime evidence; see [M1 finalization audit](M1-FINALIZATION.md).

## What would grow the delta (and why we avoid it)

| Temptation                                                                 | Why it is refused                                                                                                                                                                                      |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Editing Chromium's tab strip / toolbar Views code for the shell design     | Every upstream UI change becomes a conflict. Prefer WebUI surfaces and supported extension points; treat Views edits as a last resort with a documented reason.                                        |
| Carrying a Manifest V2 patch to claim legacy extension support             | Long-term security and maintenance liability. Targeted at Manifest V3 only.                                                                                                                            |
| Vendoring a filter engine into `//components`                              | Adds a dependency fork. Prefer building on Chromium's `subresource_filter` component and properly licensed filter components (see `docs/THREAT-MODEL.md`, ad blocker licensing notes in `PRIVACY.md`). |
| Patching the network stack for DoH policy                                  | Chromium already expresses the required policy through Secure DNS configuration; we only choose configuration, not behaviour.                                                                          |
| Disabling a Chromium security or privacy feature to make something simpler | Prohibited. See the security rules in `SECURITY.md`.                                                                                                                                                   |

## Status

| Item                                                          | State            |
| ------------------------------------------------------------- | ---------------- |
| Patch/overlay mechanism                                       | IMPLEMENTED      |
| Patch verifies against the pinned revision (offline + online) | TESTED           |
| Tooling unit tests                                            | TESTED           |
| Overlay compiles inside a Chromium tree                       | **NOT VERIFIED** |
| `chrome://aurelia` runs in a built browser                    | **NOT VERIFIED** |

`NOT VERIFIED` here means exactly that: no evidence exists yet, and no claim of
integration is made. The manual GitHub-hosted validation workflow can provide
compiler evidence; a successful compile alone does not prove runtime integration.
Attach the build summary and a separate smoke-test result to the milestone issue
before M1 is called done.

## Update procedure

See [CHROMIUM-UPSTREAM.md](CHROMIUM-UPSTREAM.md#update-procedure). Summary:
detect → open issue → regenerate and verify the patch set → dispatch
GitHub-hosted Chromium validation → run and attach a separate smoke test →
maintainer merge. Nothing merges automatically.
