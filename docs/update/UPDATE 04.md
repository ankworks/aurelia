<div align="center">

# 🚀 Aurelia Browser — Development Update #04

### First Successful Chromium 155 GN Generation on Windows GitHub Actions

**October 11, 2026 · AnkWorks Engineering**

![Chromium](https://img.shields.io/badge/Chromium-155.0.8059.40-4285F4?style=flat-square)
![Platform](https://img.shields.io/badge/Platform-Windows-0078D4?style=flat-square)
![CI](https://img.shields.io/badge/CI-GitHub_Actions-2088FF?style=flat-square)
![Status](https://img.shields.io/badge/Status-GN_Generated-F59E0B?style=flat-square)

**AnkWorks · Aurelia Browser**

---

</div>

## 📢 Overview

Aurelia Browser is an experimental, privacy-oriented browser project built on a pinned Chromium foundation. Its WebUI pages live in an Aurelia-owned overlay; a small, digest-verified patch connects their controllers and resources to Chromium's build graph. The project aims to preserve Chromium's security architecture while keeping its upstream changes reviewable.

Since [Development Update #03](./UPDATE%2003.md), a standard GitHub-hosted Windows runner has **successfully generated the Chromium 155 GN build graph for the first time**. This is an important configuration milestone, not a completed build. The same run stopped at a separate target-inspection command, before the scoped GN dependency checks.

> [!IMPORTANT]
> **GN generation passed; the complete GN-only workflow did not.** No Aurelia C++ target or Chromium browser was compiled in this run. No browser executable was generated, launched, packaged, or made available for download.

---

## 🎯 First Windows GN Generation

The evidence is [GitHub Actions run 38128649838](https://github.com/ankworks/aurelia/actions/runs/38128649838), using Chromium **155.0.8059.40** at revision **`cfaadc5a132d78e1828635aa8405a499f3e14864`**. The Windows runner reported:

```text
Done. Made 35817 targets from 5040 files in 26870ms
```

GN generation evaluated the pinned source tree, Aurelia's installed overlay and patch, the selected Windows build arguments, and the resulting target graph sufficiently to produce build files. Effective GN arguments were also verified after generation. This is stronger evidence than static repository checks alone. It does **not** prove that target inspection, GN's C++ header dependency check, TypeScript or GRIT actions, C++ compilation, browser linking, or runtime behavior will succeed.

### Observed validation boundary

| Stage in run 38128649838                                                                                                 | Result                                       |
| :----------------------------------------------------------------------------------------------------------------------- | :------------------------------------------- |
| Windows resource preflight, Visual Studio 2026 detection and Windows SDK 10.0.28000.0 provisioning                       | **PASS**                                     |
| Installer Authenticode verification; pinned depot_tools and shallow Chromium synchronization, including dependency hooks | **PASS**                                     |
| Pristine patch verification, overlay installation, patch application and fork-delta budget                               | **PASS**                                     |
| GN argument policy and pinned depot_tools Python bootstrap                                                               | **PASS**                                     |
| `gn gen` and effective generated argument verification                                                                   | **PASS**                                     |
| Aurelia GN target-label verification                                                                                     | **FAIL** — unsupported target metadata query |
| Scoped `gn check`                                                                                                        | **NOT TESTED** in this run                   |
| WebUI resource and C++ compilation                                                                                       | **NOT TESTED**                               |
| Browser executable, packaging and runtime smoke test                                                                     | **NOT GENERATED / NOT TESTED**               |

The target query tried to display `type` as an individual `gn desc` field for an action. The GN version pinned by Chromium does not provide that field through this form of the command, although the target exists. The pipeline stopped rather than treating the query failure as success. Source-level review of the pinned GN CLI also found that `gn check` takes at most one optional target label or pattern per invocation. The validation tooling has since been changed to inspect the **full JSON target description**, check exact labels, types, direct dependencies and declared outputs, and run a separate scoped dependency check for each controller. These changes have local regression coverage; they still require a new Windows GN-only workflow run before either downstream stage can be reported as passing.

---

## 🖥️ Infrastructure That Made This Possible

The standard Windows runner used a resource-aware preflight before attempting a large checkout. It provisioned the required Windows SDK 10.0.28000.0, verified the downloaded installer signature, and used the detected Visual Studio 2026/MSVC installation instead of a restricted Google-hosted Windows toolchain. The pipeline then performed a shallow Chromium synchronization, recovered safely from Windows patch line-ending conversion, applied Aurelia's reviewed patch, and initialized pinned depot_tools Python without enabling an uncontrolled depot_tools Git update.

Previous runs exposed these issues one at a time: SDK compatibility and available disk, CRLF patch application, depot_tools bootstrap, and the New Tab WebUI template's requirement for a TypeScript dependency when a trusted context is declared. Each correction was checked against the pinned source or an observed Windows failure; this run establishes that the resulting configuration now reaches a successful `gn gen`.

### Disk measurements from this runner

| Measurement                          |            Observed value |
| :----------------------------------- | ------------------------: |
| Chromium synchronization consumption | Approximately **29.5 GB** |
| GN generation consumption            |  Approximately **1.8 GB** |
| Total consumption since pre-sync     | Approximately **31.3 GB** |
| Free disk after synchronization      |              **190.3 GB** |
| Free disk after GN generation        |              **188.5 GB** |

These figures describe **one observed GitHub-hosted Windows run**. They are not guaranteed minimum disk requirements, compilation footprints, or performance benchmarks for other runners.

---

## 🧩 Aurelia WebUI in the Build Graph

Aurelia's overlay contains a scaffolded `chrome://aurelia` status page and a separate `chrome://aurelia-newtab` page with HTML, CSS, TypeScript and C++ controllers. The latter does not replace Chromium's existing `chrome://newtab`. Chromium's `build_webui` template defines the TypeScript, resource-description and GRIT targets, while the limited upstream patch registers the controllers, resource IDs and paks. The source-level audit also placed their desktop-only browser dependencies behind Chromium's existing non-Android guard.

Successful GN generation shows that these declarations can be incorporated into the selected Windows build graph. It does not show that TypeScript or GRIT ran, that resources load in a browser, that the controllers compile, or that either page works at runtime. Their trusted origins and content security policies must still be assessed in an actual build and browser smoke test.

---

## 🗺️ Next Milestones

1. Re-run the Windows **GN-only** workflow on the current development branch. Require exact target-label/type/dependency/output inspection and scoped `gn check` to pass alongside `gn gen`; investigate any new failure without skipping a check.
2. On a suitably provisioned builder, build the WebUI TypeScript and GRIT resources and verify the generated paks and maps.
3. Compile both Aurelia C++ WebUI controller targets, then attempt a full Chromium browser build on an eligible runner.
4. Package a complete Windows executable and its runtime dependencies only after a successful build. Launch it and separately record a browser smoke test for the Aurelia pages and security boundaries.
5. Review build and runtime evidence before planning a first preview release. **No release date has been announced.**

---

## 🔗 Evidence and Further Reading

- [Windows run 38128649838: first successful GN generation; target verification failed](https://github.com/ankworks/aurelia/actions/runs/38128649838)
- [Earlier GN-only run 38126244950: New Tab WebUI configuration blocked GN generation](https://github.com/ankworks/aurelia/actions/runs/38126244950)
- [Fast CI on the prior development head: repository and Windows bootstrap tests](https://github.com/ankworks/aurelia/actions/runs/38128496310)
- [Building and validating Chromium](../BUILDING-CHROMIUM.md)
- [Reviewed fork delta](../FORK-DELTA.md)
- [Development Update #03](./UPDATE%2003.md)

Repository checks and the local GN CLI compatibility probe are distinct from a full Windows Chromium build. As new validation runs complete, we will report their evidence separately rather than retroactively upgrading this run's result.

---

<div align="center">

### Aurelia Browser

**An experimental Chromium-based browser by AnkWorks.**

[Source Code](https://github.com/ankworks/aurelia) ·
[GitHub Wiki](https://github.com/ankworks/aurelia/wiki)

---

**AnkWorks — Building things that matter.**

<sub>Development Update #04 · October 11, 2026</sub>

</div>
