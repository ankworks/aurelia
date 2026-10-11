<div align="center">

# 🚀 Aurelia Browser — Development Update #03

### Chromium Synchronization Complete; GN Configuration Under Review

**October 11, 2026 · AnkWorks Engineering**

![Chromium](https://img.shields.io/badge/Chromium-155.0.8059.40-4285F4?style=flat-square)
![Platform](https://img.shields.io/badge/Platform-Windows-0078D4?style=flat-square)
![CI](https://img.shields.io/badge/CI-GitHub_Actions-2088FF?style=flat-square)
![Status](https://img.shields.io/badge/Status-GN_In_Progress-F59E0B?style=flat-square)

**AnkWorks · Aurelia Browser**

---

</div>

## 📢 Overview

Aurelia is an experimental, privacy-oriented browser being developed on a pinned Chromium foundation. Our aim is a modern browser with original Aurelia interfaces, while retaining Chromium's security architecture and keeping the changes to upstream source small and reviewable.

Since [Development Update #02](./UPDATE%2002.md), the Windows validation pipeline has advanced beyond runner preparation. A standard GitHub-hosted Windows runner synchronized the pinned Chromium source and dependencies, verified Aurelia's patch, installed the WebUI overlay, and reached a real GN invocation. The latest completed GN-only attempt stopped at an Aurelia New Tab build configuration error. A source-level correction and regression tests are now in review; **a successful GN generation has not yet been demonstrated**.

> [!IMPORTANT]
> **GN generation has not yet passed.** No Aurelia C++ target or Chromium browser has been compiled, no browser executable has been generated, and no runtime smoke test or preview release is available.

---

## 🎯 Chromium 155 Integration

Aurelia keeps Chromium **155.0.8059.40** at the exact revision **`cfaadc5a132d78e1828635aa8405a499f3e14864`**. The depot_tools checkout is also pinned. Neither revision was changed to address the current GN issue.

Aurelia's integration uses an overlay for new WebUI files and a generated, digest-verified patch for the limited number of existing Chromium files that require registrations. The patch wires the Aurelia and isolated New Tab controllers, resource targets, GRIT IDs, and browser resource paks into the pinned tree. Verification against pristine upstream pre-images passed before the overlay and patch were installed in the observed Windows run.

The `chrome://aurelia` status surface and the separate `chrome://aurelia-newtab` page have C++ controller, HTML, CSS, and TypeScript sources in the repository. The New Tab page does not replace Chromium's existing `chrome://newtab` behavior. The Aurelia surfaces remain **scaffolded, not runtime-verified**; their presence in a synchronized source tree is not evidence that they work in a running browser. Other browser functionality and Chromium's existing Settings page are not replaced by this work.

---

## 🖥️ Windows Build Infrastructure

The manual [Chromium validation workflow](https://github.com/ankworks/aurelia/actions/workflows/chromium-build.yml) measures the runner before downloading Chromium. GN-only validation uses the standard `windows-2025` runner, a resource-aware preflight, a shallow `gclient sync --no-history` checkout, and a free-space safety reserve. Targeted or full compilation has stricter requirements and is not silently enabled on the standard runner.

The observed environment provisioned the required **Windows SDK 10.0.28000.0**, checked the installer signature, and detected **Visual Studio 2026** and MSVC. Chromium's toolchain was configured to use the local Visual Studio installation rather than Google's restricted packaged toolchain. The pinned depot_tools Python bootstrap succeeded without enabling depot_tools Git updates, allowing GN to start. The observed shallow synchronization consumed approximately **29.5 GB**; this is a measurement from the reported run, not a general benchmark or a compilation footprint.

These steps addressed the earlier Windows SDK compatibility, runner disk-space, Windows CRLF patch handling, and depot_tools initialization obstacles. Passing preparation and source integration does not itself prove GN generation or compilation.

---

## 📊 Verified Milestones

The [October 11 GN-only run](https://github.com/ankworks/aurelia/actions/runs/38126244950) ran against the pinned Chromium version and confirmed the following boundaries:

| Milestone                                                                                   | Observed result                                                       |
| :------------------------------------------------------------------------------------------ | :-------------------------------------------------------------------- |
| Runner resource checks, VS/MSVC and Windows SDK preparation                                 | **PASS**                                                              |
| Pinned depot_tools and Chromium source synchronization, including hooks and revision checks | **PASS**                                                              |
| Aurelia patch verification, overlay installation, patch application and fork-delta check    | **PASS**                                                              |
| Reviewed GN argument policy and pinned depot_tools Python bootstrap                         | **PASS**                                                              |
| GN invocation                                                                               | **REACHED** — not the same as generation success                      |
| `gn gen`                                                                                    | **FAIL** — New Tab `webui_context_type` was assigned but not consumed |
| Generated GN graph, effective arguments, target labels and scoped `gn check`                | **NOT TESTED** after the failed `gn gen`                              |
| WebUI resource build, targeted C++ and full Chromium compilation                            | **NOT TESTED**                                                        |
| Browser executable, launch and runtime smoke test                                           | **NOT AVAILABLE / NOT TESTED**                                        |

The fast repository checks and Windows bootstrap regression tests also passed on [CI fast run 38125865517](https://github.com/ankworks/aurelia/actions/runs/38125865517). These tests validate tooling and source contracts; they do not substitute for a successful GN-only Windows run.

---

## 🔧 The Current GN Compatibility Issue

In Aurelia's New Tab overlay `BUILD.gn`, the `build_webui("build")` invocation specified `webui_context_type = "trusted"` without declaring `ts_deps`. At the pinned Chromium revision, the `build_webui` template only reads that context when it generates TypeScript path mappings for targets with `ts_deps`. GN therefore reported an unused assignment and stopped during build graph generation. This is an **Aurelia overlay configuration issue**, not evidence of a broken pristine Chromium release or a Windows toolchain regression.

The New Tab correction declares the corresponding WebUI TypeScript dependency while retaining the explicit trusted context. It does not alter the WebUI controller's runtime origin, data source, content security policy, or Chromium pin. A separate source-level audit confirmed that the original patch also linked both controllers unconditionally from `//chrome/browser:browser`, although their resource targets reject Android (and the New Tab controller target does too). Their dependencies have been moved into an existing `!is_android` block; the generator regenerated the patch and its post-image digest against the same pristine Chromium revision. The patch still changes eight upstream files by 26 insertions and no deletions. Static regression checks cover both invariants. Only a repeat Windows GN-only run can verify whether the entire graph generates successfully and reveal any further issues.

---

## 🗺️ Next Milestones

1. Re-run GN-only validation on the current development branch. Require `gn gen`, effective argument validation, selected target resolution, and scoped `gn check` to pass in a real Windows GitHub Actions run. Investigate any next error without weakening GN checks.
2. On a suitably provisioned builder, build the WebUI TypeScript, GRIT resources and paks, then compile the Aurelia C++ controller targets. A GN-only pass is not compilation evidence.
3. Complete a full Chromium browser build on an eligible Windows runner and verify that the expected executable and runtime files were produced.
4. Launch the browser, inspect the Aurelia pages, confirm pin and resource integration, and record a separate runtime smoke test.
5. Review the build and runtime evidence before planning a first Aurelia preview release. **No release date has been announced.**

---

## 🔗 References

- [GN-only validation: Chromium 155 source integration reached GN; generation failed](https://github.com/ankworks/aurelia/actions/runs/38126244950)
- [Earlier GN-only validation: depot_tools Python bootstrap blocker](https://github.com/ankworks/aurelia/actions/runs/38124594462)
- [Fast CI: Windows bootstrap regression and repository checks](https://github.com/ankworks/aurelia/actions/runs/38125865517)
- [Building and validating Chromium](../BUILDING-CHROMIUM.md)
- [Reviewed fork delta](../FORK-DELTA.md)
- [Development Update #02](./UPDATE%2002.md)

---

## 💚 Final Thoughts

The latest Windows run verified that Aurelia's pinned Chromium source and build prerequisites can be prepared on the standard GN-only runner. The next gate is a correct, reproducible GN graph. We will keep source integration, GN configuration, compilation, and runtime validation as separate milestones, and report each only when the corresponding evidence exists.

---

<div align="center">

### Aurelia Browser

**An experimental Chromium-based browser by AnkWorks.**

[Source Code](https://github.com/ankworks/aurelia) ·
[GitHub Wiki](https://github.com/ankworks/aurelia/wiki) ·
[AnkWorks Forge](https://works.ankb.qzz.io/repos/aurelia)

---

**AnkWorks — Building things that matter.**

<sub>Development Update #03 · October 11, 2026</sub>

</div>
