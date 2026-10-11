<div align="center">

# 🚀 Aurelia Browser — Development Update #02

### Windows Toolchain Recovery & New Build Environment Challenges

**October 11, 2026 · AnkWorks Engineering**

![Chromium](https://img.shields.io/badge/Chromium-155.0.8059.40-4285F4?style=flat-square)
![Platform](https://img.shields.io/badge/Platform-Windows-0078D4?style=flat-square)
![CI](https://img.shields.io/badge/CI-GitHub_Actions-2088FF?style=flat-square)
![Status](https://img.shields.io/badge/Status-Blocked-F59E0B?style=flat-square)

**AnkWorks · Aurelia Browser**

---

</div>

## 📢 Overview

Following [Development Update #01](Development-Update-01), the Aurelia team continued improving its Chromium build validation infrastructure.

Our previous GitHub Actions attempt progressed through a substantial Chromium source synchronization process but failed during Windows toolchain initialization.

This update documents the changes made to address that failure and the new limitations discovered during the next validation run.

**The good news:** The pipeline now detects incompatible build environments before spending hours downloading Chromium.

**The challenge:** The latest GitHub-hosted runner does not currently satisfy Aurelia's configured Windows SDK and disk-space requirements.

> [!IMPORTANT]
> **Aurelia has not yet completed Chromium synchronization, GN generation, or C++ compilation.**
>
> The latest workflow stopped during preflight validation. No Chromium source synchronization was attempted in that run.

---

## 🔧 1. Resolving the Previous Toolchain Failure

In Update #01, Chromium attempted to download its Windows toolchain from Google's restricted Cloud Storage bucket.

The request failed with:

```text
ServiceException: 401

Anonymous caller does not have
storage.objects.list access.

Bucket: chrome-wintoolchain
```

Chromium's tooling recommended:

```text
DEPOT_TOOLS_WIN_TOOLCHAIN=0
```

This setting instructs Chromium to use a locally installed Visual Studio toolchain instead of retrieving Google's packaged toolchain.

### What Changed?

The Aurelia validation pipeline now configures:

```yaml
env:
  DEPOT_TOOLS_WIN_TOOLCHAIN: '0'
```

The setting is propagated through the Chromium validation driver and synchronization tooling.

Additional validation checks were introduced to detect the installed compiler and Windows SDK before starting an expensive Chromium checkout.

> [!NOTE]
> The configuration change has passed automated repository tests.
>
> Its complete behavior during Chromium synchronization remains unverified because the latest workflow stopped before that stage.

---

## 🖥️ 2. Improved Build Environment Detection

The new preflight process reports detailed information about the selected GitHub Actions runner.

It checks:

- CPU and available memory.
- Free disk space.
- Visual Studio installation.
- MSVC compiler availability.
- Windows SDK version.
- Required SDK headers and libraries.
- Git and Python availability.
- Chromium toolchain configuration.

This provides more useful diagnostic information than previous attempts.

### Latest Runner Configuration

| Component | Detected Value |
|:--|:--|
| Platform | Windows |
| CPU | 4 logical cores |
| RAM | 16 GB |
| Free disk space | 147 GB |
| Visual Studio | 18.10.12217.157 |
| MSVC toolset | 14.51.36231 |
| Windows SDK | 10.0.26100.0 |
| Toolchain mode | Local Visual Studio |
| Validation level | GN-only |

The runner successfully provided Git, Python, Visual Studio, and an MSVC compiler.

However, two preflight requirements were not satisfied.

---

## 🚧 3. Blocker #1 — Windows SDK Version

The runner reported:

```text
Installed Windows SDK:
10.0.26100.0
```

Aurelia's current preflight configuration requires:

```text
Required Windows SDK:
10.0.28000.0
```

The validation therefore stopped with:

```text
BLOCKED:

Installed Windows SDK version
10.0.26100.0 is older than
required 10.0.28000.0.
```

### Why Does This Matter?

Chromium uses Windows SDK headers, libraries, and development tools when generating and compiling Windows browser targets.

An incompatible SDK may prevent successful build configuration or compilation.

However, the exact compatibility requirements must be verified against the pinned Chromium revision.

### Next Investigation

We need to determine whether SDK `10.0.28000.0` is:

- A strict minimum requirement.
- Chromium's preferred SDK version.
- A version selected by the toolchain scripts.
- A requirement that differs between GN generation and compilation.

We must not assume an older SDK is supported without evidence.

---

## 💾 4. Blocker #2 — Insufficient Free Disk Space

The latest runner reported:

```text
Available disk:
147 GB
```

The configured minimum is:

```text
Required:
150 GB
```

The workflow stopped because the runner was approximately 3 GB below the required threshold.

### Why Did Available Space Change?

An earlier GitHub Actions run reported approximately:

```text
219.9 GB
```

The latest run reported:

```text
147 GB
```

This demonstrates that available storage can vary between GitHub-hosted runner environments.

Possible contributing factors include runner image changes, preinstalled software, and differences in temporary storage allocation.

The exact cause has not yet been confirmed.

### Planned Improvements

- Investigate available disk volumes.
- Measure storage before and after setup.
- Identify safe cleanup opportunities.
- Preserve required build tools.
- Avoid lowering safety thresholds without evidence.

> [!WARNING]
> Removing essential Visual Studio or Windows SDK components just to free disk space would create new build failures.

---

## ✅ 5. Automated Test Results

The Windows toolchain recovery changes passed the repository's automated verification.

| Check | Result |
|:--|:--|
| Dependency installation | ✅ PASS |
| Formatting | ✅ PASS |
| ESLint | ✅ PASS |
| TypeScript | ✅ PASS |
| Unit tests | ✅ 380 passed |
| Fast checks | ✅ 15/15 |
| GitHub Actions fast CI | ✅ PASS |
| Windows preflight | ⚠️ BLOCKED |
| Chromium synchronization | ⏳ NOT TESTED |
| GN generation | ⏳ NOT TESTED |
| C++ compilation | ⏳ NOT TESTED |
| Browser runtime | ⏳ NOT TESTED |

The tests validate the pipeline implementation and environment detection logic.

They do not establish that Chromium can compile successfully.

---

## 📊 6. Comparing Update #01 and Update #02

| Area | Update #01 | Update #02 |
|:--|:--|:--|
| Windows Git compatibility | Fixed | Preserved |
| Chromium source synchronization | Reached dependency hooks | Not attempted |
| Windows toolchain configuration | GCS download failed | Local toolchain selected |
| Visual Studio detection | Basic | Detailed |
| Windows SDK detection | Not validated early | Early compatibility check |
| Disk validation | Passed | Blocked |
| GN generation | Not reached | Not reached |
| Failure detection time | Approximately 1h 40m | During preflight |

**The major improvement is faster and more informative failure detection.**

Instead of discovering toolchain problems after downloading Chromium, the workflow now checks the environment first.

---

## 🗺️ 7. What Happens Next?

Our next priorities are focused on build environment compatibility.

### Phase 1 — Windows SDK Investigation

- [ ] Verify the SDK requirement at the pinned Chromium revision.
- [ ] Determine whether SDK 26100 is compatible with GN-only validation.
- [ ] Investigate availability of SDK 28000.
- [ ] Document the selected approach.
- [ ] Add regression tests for the final compatibility policy.

### Phase 2 — Runner Storage

- [ ] Investigate available disk volumes.
- [ ] Identify safe disk cleanup options.
- [ ] Verify at least 150 GB of free space.
- [ ] Preserve required compiler and SDK components.

### Phase 3 — Chromium Validation

- [ ] Pass runner preflight.
- [ ] Complete Chromium synchronization.
- [ ] Complete required gclient hooks.
- [ ] Apply Aurelia patches and overlays.
- [ ] Generate GN build files.
- [ ] Validate WebUI build targets.

### Phase 4 — Compilation

- [ ] Compile selected Aurelia resources.
- [ ] Compile Aurelia C++ controllers.
- [ ] Investigate compilation errors.
- [ ] Prepare for a browser build.

---

## 🔗 8. Technical References

### GitHub Actions

**[Latest Windows Validation — Run #38101262458](https://github.com/ankworks/aurelia/actions/runs/38101262458)**

### Toolchain Recovery

**[Pull Request #26 — Windows Toolchain Recovery](https://github.com/ankworks/aurelia/pull/26)**

### Previous Update

[Development Update #01 — Chromium Synchronization Attempt](Development-Update-01)

### Project Links

- [Aurelia Repository](https://github.com/ankworks/aurelia)
- [AnkWorks Organization](https://github.com/ankworks)
- [AnkWorks Forge](https://works.ankb.qzz.io/repos/aurelia)
- [Aurelia Discussions](https://github.com/ankworks/aurelia/discussions)

---

## 💚 9. Final Thoughts

Aurelia's development continues to progress through practical engineering validation.

The latest attempt did not reach Chromium synchronization or GN generation.

However, it demonstrated the value of testing the build environment before downloading a large source tree.

Our next goal is to establish a compatible Windows toolchain and a sufficiently provisioned GitHub Actions runner.

We will continue documenting both successes and setbacks.

**Aurelia is being built one verified step at a time.**

---

<div align="center">

### Aurelia Browser

**An experimental Chromium-based browser by AnkWorks.**

[Source Code](https://github.com/ankworks/aurelia) ·
[GitHub Wiki](https://github.com/ankworks/aurelia/wiki) ·
[AnkWorks Forge](https://works.ankb.qzz.io/repos/aurelia)

---

**AnkWorks — Building things that matter.**

<sub>Development Update #02 · October 11, 2026</sub>

</div>
