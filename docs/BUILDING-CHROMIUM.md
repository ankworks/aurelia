# GitHub-hosted Chromium validation

## Policy and current status

Chromium validation is a **manual GitHub Actions workflow** and all Chromium
compilation must run on GitHub-hosted Windows x64 runners. There is no
self-hosted, local, external-cloud, containerized, Electron, CEF, or WebView2
compile path. The legacy build plan remains for dry-run/history tests only; its
executor and local bootstrap are retired. The unified GitHub-hosted workflow is
the only supported compilation entry point.

No Chromium compilation has succeeded yet. A source sync, patch check, GN
configuration, or unit test is not compiler evidence. A compile is claimed only
when the corresponding `autoninja` command exits with code `0` in the
GitHub Actions run; runtime integration and smoke testing require separate
evidence.

M1.9 adds one experimental validation level, `targeted-lite`, for the first
real compilation attempts on the free standard runner. Its scope is
deliberately limited and is stated in every summary it produces: it never
links, never builds `chrome`, and never lowers the strict `targeted`/`full`
gate. See
[CI-BUILD-FEASIBILITY.md](CI-BUILD-FEASIBILITY.md#experimental-resource-aware-targeted-lite-compilation-m19).

The authoritative workflow is `.github/workflows/chromium-build.yml` (canonical
source: `tools/ci/workflows/chromium-build.yml`). It has only the
`workflow_dispatch` trigger. It does not run on `push`, `pull_request`, or a
schedule, and `gn` is the default validation level.

## Dispatch inputs

| Input              | Options                                             | Behavior                                                                                                                                                                                                                                                                                                                                                       |
| ------------------ | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `validation_level` | `gn` (default), `targeted-lite`, `targeted`, `full` | `gn` runs GN-only validation (sync, patch/overlay, `gn gen`, `gn check`) and never compiles. `targeted-lite` is the experimental resource-aware level (below). `targeted` and `full` require the strict 8-core / 32 GB builder and must be chosen explicitly. `full` compiles `chrome` only after GN, WebUI resources, and targeted C++ pass in that same run. |
| `runner_size`      | `standard` (default), `larger`                      | `standard` targets GitHub-hosted `windows-2025`. It runs `gn` and `targeted-lite` within their reduced profiles and reports `BLOCKED` for `targeted` and `full` before Chromium source sync. `larger` targets the configured GitHub-hosted label `windows-latest-8-cores`.                                                                                     |

The organization must provision a GitHub-hosted Windows larger runner, grant
repository access, and configure the label before `larger` can start. The
workflow does not silently fall back if the label is unavailable. Its preflight
also confirms the runner reports `GITHUB_ACTIONS=true` and
`RUNNER_ENVIRONMENT=github-hosted`; a local or self-hosted invocation is
blocked.

## Resource policy

The reviewed Aurelia first-build gate is **8 logical CPU cores, 32 GB RAM, and
150 GB free on the exact volume that will hold Chromium**. This is deliberately
not lowered for standard runners. `tools/ci/check-builder.mjs` checks the
resource and Windows toolchain requirements, and the validation driver repeats
the destination-volume and platform checks before source sync. The same 150 GB
disk floor is enforced by `tools/chromium/sync.mjs`.

### Resource profiles by validation level

Requirements are selected per validation level by `tools/ci/check-builder.mjs`
(`requirementsForMode`) from `config/chromium_version.json`:

| Level              | Logical cores | RAM     | Free disk on Chromium volume | Purpose                                                                                                                                                                                       |
| ------------------ | ------------- | ------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gn`               | 4             | 15.5 GB | 80 GB                        | Shallow (`--no-history`) sync, patch/overlay, `gn gen`, `gn check`. **No compilation.**                                                                                                       |
| `targeted-lite`    | 4             | 15.5 GB | 80 GB                        | **Experimental.** Adds WebUI TypeScript/GRIT/pak compilation and the Aurelia controller translation units (object-level, Ninja `-j 2`). Shallow checkout. Never links, never builds `chrome`. |
| `targeted`, `full` | 8             | 32 GB   | 150 GB                       | Adds WebUI resources, targeted C++ source_sets with their transitive dependencies, and (`full`) `chrome`. Full-history checkout. **Never lowered.**                                           |

The `gn` profile is a reduced, GN-only profile. It exists because GN generation
and dependency checking do not need the compile-time memory of a full build or a
full-history checkout. The `targeted-lite` profile is a **separate experimental
profile** (M1.9): it is not a lowered `targeted` gate. The strict
`targeted`/`full` gate stays at 8 / 32 / 150 and is enforced unchanged. The RAM
value is 15.5 GB rather than 16 GB because the OS-reported total on a nominal
16 GB machine can be slightly below 16. The GN disk floor is 80 GB
(evidence-based: see
[CI-BUILD-FEASIBILITY.md](CI-BUILD-FEASIBILITY.md#gn-only-disk-policy-m13)),
which fits on the measured 147 GB free of the windows-2025 D: volume. `gn` and
`targeted-lite` use `gclient sync --no-history` (shallow, depth=1 for every
synced repo) to keep the checkout footprint small; the strict `targeted`/`full`
compilation modes require full history and the unchanged 150 GB floor.

The runtime disk reserve is mode-aware: 10 GB for GN, 15 GB for compilation
(including `targeted-lite`). The 1.5 GB RAM reserve is enforced during every
run. `targeted` and `full` remain at the strict 8 / 32 / 150 gate and are never
lowered.

Under `gn`, the checkout uses at most **2** `gclient` sync jobs and the internal
deadline is **240** minutes. `targeted-lite` also uses two sync jobs but Ninja
is capped at **2** compile jobs (see the build configuration below).
`targeted` and `full` use four sync and Ninja jobs and a 330-minute deadline.
All levels stay below the 360-minute job timeout.

GitHub's published public standard Windows runner is 4 vCPUs, 16 GB RAM, and
14 GB SSD. Its exact usable space can vary; the live runner is measured rather
than assumed. GitHub documents a Windows larger-runner tier with 8 vCPUs,
32 GB RAM, and 300 GB SSD, but availability, labels, and billing depend on the
organization's configuration. See [CI-BUILD-FEASIBILITY.md](CI-BUILD-FEASIBILITY.md)
for the published-resource references, historical runner measurement, and
preflight policy.

### Build configuration for targeted-lite

`targeted-lite` generates its build graph from
`config/gn/win-x64-targeted-lite.gn`, which is validated against the same
allowlist in `tools/chromium/gn-args.mjs` as every other configuration. The
only deliberate difference from `config/gn/win-x64-dev.gn` is `symbol_level = 0`.
Each candidate option was checked against the pinned revision before use:

| Option                   | Supported at the pin?                                                                                                | Used? | Why                                                                                                                                                                                        |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `is_debug = false`       | Yes (`build/config/compiler/compiler.gni`)                                                                           | Yes   | Same development Release mode as the reviewed development configuration.                                                                                                                   |
| `symbol_level = 0`       | Yes (`build/config/compiler/compiler.gni`, values 0/1/2; upstream notes x86/x64 backtraces keep function names at 0) | Yes   | The targeted-lite scope compiles translation units and never links or ships a binary, so line tables buy nothing while compiler work and PDB output cost time and disk on a 4-core runner. |
| `blink_symbol_level = 0` | Yes (`third_party/blink/renderer/config.gni`, default `-1` = auto)                                                   | No    | The targeted-lite scope compiles no Blink objects; setting it would change nothing this mode builds.                                                                                       |
| `v8_symbol_level = 0`    | Yes (`v8/gni/v8.gni` at the pinned V8 revision `56832c166a78bd1eb61068ac69876d6880eaabdf`, default `= symbol_level`) | No    | Same reason; it already derives from `symbol_level`.                                                                                                                                       |

No security-relevant switch exists in this configuration. The sandbox, site
isolation, certificate validation and process isolation are always compiled in
(see `config/gn/win-x64-dev.gn` for why they are not GN switches at all), and
nothing in the targeted-lite configuration weakens trusted/untrusted WebUI
boundaries. The pinned revision is not changed by this mode.

## Validation stages

When the measured runner passes preflight, `tools/chromium/ci-validation.mjs`
uses Aurelia's pinned tooling in this order:

1. Sync the configured Chromium revision and pinned `depot_tools` with at most
   two sync jobs under `gn` and four under `targeted` and `full`; verify both
   resulting SHAs.
2. Verify the patch set against the pristine pinned checkout, apply the patch
   and overlay, and check the reviewed fork-delta budget.
3. Validate the reviewed Windows GN arguments, run `gn gen`, require the
   generated `out/Aurelia/args.gn`, then validate those effective arguments.
4. Resolve every selected label using `gn desc`; run scoped `gn check` for the
   two Aurelia C++ controller targets.
5. For `targeted-lite`, `targeted`, and `full`, build `build_ts`, `build_grd`,
   and `resources` for both Aurelia WebUI pages; verify expected TypeScript,
   GRIT, resource-map, and `.pak` outputs. `gn` skips this stage. In
   `targeted-lite` the Ninja job cap is 2 instead of 4.
6. Then, per level:
   - `targeted-lite` compiles the Aurelia C++ controller **translation units**
     as exact Ninja object targets (`obj/<label-dir>/<label-name>/<source>.obj`
     from the overlay `source_set` labels, verified against the generated Ninja
     graph before compiling and against the `.obj` outputs afterwards). This is
     an object-level compile with the real MSVC toolchain and Windows SDK: it
     deliberately does not build the source_sets' transitive dependency
     libraries or link anything, because on a 4-core runner that graph
     (`//chrome/browser:browser_public_dependencies` and friends) is thousands
     of translation units and belongs to `targeted` on the larger builder.
   - `targeted` and `full` compile the two overlay `source_set` targets and
     their C++ dependencies. `gn` skips this stage.
7. For `full` only, compile Chromium's `chrome` target. This stage is reached
   only after all previous stages in the same run pass. In `targeted-lite` the
   `chrome` and browser-artifact stages are explicitly reported **NOT TESTED**
   (out of scope), never silently skipped.

The summary reports the milestones for the selected level. `gn`, `targeted`,
and `full` report four: `PREFLIGHT`, `CHROMIUM SYNC`, `GN-ONLY`, and
`COMPILATION`. `targeted-lite` reports five, splitting compilation into
`WEBUI RESOURCES` and `AURELIA C++` so a resource pass can never be reported as
an Aurelia C++ pass (and vice versa). The `GN-ONLY` milestone includes policy,
bootstrap, generation, effective arguments, target verification and scoped
`gn check`; the stage table independently records `GN generation`. Thus a run
with `gn gen` **PASS** and target verification **FAIL** reports `GN-ONLY FAIL`,
not `GN GEN FAIL`. A fully passing `gn` run reports `GN-ONLY PASS` alongside
`COMPILATION NOT TESTED`. Every summary also states the level's claimable scope
in one explicit sentence, records each stage's exact command, exit code,
duration, and sampled peak memory/disk, and classifies failed compiler output
(memory exhaustion, disk exhaustion, missing include, target resolution, link
error, or source/compiler error) without suppressing the diagnostics.

The selected GN labels come from the checked-in Aurelia overlay and the
`build_webui()` template at the configured Chromium pin. A missing label or
resource output is a failure, not a warning. GN introspection (`gn desc`,
`gn check`) uses the canonical `//` label form; the build executor does not:
at the pinned GN revision, `build.ninja` phony aliases are the _"full label
name with no leading slashes"_ (`gn help ninja_rules`), so every build command
converts labels at the single execution boundary in
`tools/chromium/build-plan.mjs` (`ninjaTargetFor`). The first `targeted-lite`
run ([38139216273](https://github.com/ankworks/aurelia/actions/runs/38139216273))
failed exactly there — `//`-prefixed labels were rejected as unknown Ninja
targets — and regression tests now pin the exact executor argv. Unknown-target
errors remain hard failures classified as `target-resolution`; they are never
suppressed. Ninja invocations are capped at
four jobs on `targeted`/`full` and two jobs on `targeted-lite`. Resource usage
is sampled every 30 seconds; the process tree is stopped if free disk falls
below the mode's reserve or available RAM falls below 1.5 GB. A 330-minute
internal deadline (240 for `gn`) leaves time for summary and artifact handling
under GitHub's 360-minute job timeout. Only one validation run per repository is
allowed at a time.

## Build states and evidence

| State                               | Required evidence                                                                                                                               |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `INTEGRATION SOURCE VERIFIED`       | Patch verification and overlay/fork-delta checks pass.                                                                                          |
| `CONFIGURATION VERIFIED`            | `gn gen` exits `0`, generated arguments pass policy, and selected targets resolve.                                                              |
| `WEBUI RESOURCES VERIFIED`          | The WebUI Ninja targets exit `0` and expected TypeScript/GRIT/pak outputs exist.                                                                |
| `AURELIA CONTROLLERS COMPILED (TU)` | In `targeted-lite`, both Aurelia controller translation units compile with MSVC and their `.obj` outputs exist. Not a dependency or link claim. |
| `TARGETED COMPILED`                 | Both Aurelia C++ source-set Ninja targets exit `0` in `targeted` or `full` mode (with transitive dependencies).                                 |
| `COMPILED`                          | `autoninja ... chrome` exits `0` in explicit `full` mode in the same run.                                                                       |
| `RUNTIME INTEGRATED`                | Browser launches with Aurelia pages/resources available. Not established by compilation alone.                                                  |
| `TESTED`                            | A separate runtime smoke test passes. Not currently run by `chromium-build.yml`.                                                                |
| `VERIFIED`                          | A supported physical Windows device passes the compatibility test.                                                                              |

Workflow step names are not evidence. The build summary records stage statuses,
run URL, runner capabilities, pins, effective GN arguments, resource samples,
and per-stage logs. The driver writes `PASS` only after a zero compiler exit code
and any required stage postconditions.

## Artifacts and source-tree handling

The workflow uploads `artifacts/` only: logs, JSON resource samples, runner
capabilities, the effective GN arguments, and Markdown/JSON summaries. It never
caches or uploads the Chromium source tree. A browser runtime is packaged only
after a successful full `chrome` compile, staging checks, and confirmation that
the archive fits the 450 MiB upload budget. An oversized or otherwise ineligible
binary is omitted and explicitly reported; the Chromium source is never
included.

The browser artifact is unsigned development output. No release is published,
no signing secrets are used, and no security feature is weakened to make CI pass.
The workflow does not run a smoke test or claim the browser is tested.

## Pinned Windows `depot_tools` Python bootstrap before GN

At the configured depot_tools revision `1e43ae345913614898e3d6a1ef2680a0d47574e9`, `gn.bat` calls `python-bin/python3.bat gn.py`; `python-bin/python3.bat` refuses to run without `python3_bin_reldir.txt`. That pointer is intentionally Git-ignored, not part of the pinned checkout. `bootstrap/win_tools.bat` installs the Python version from the checked-out `bootstrap/manifest.txt` via CIPD and runs `bootstrap/bootstrap.py`, which generates the pointer and the versioned Python executable. The pinned source can be inspected at [the exact commit in the Chromium full mirror](https://github.com/chromium-full-mirror/chromium_tools_depot_tools/tree/1e43ae345913614898e3d6a1ef2680a0d47574e9).

With `DEPOT_TOOLS_UPDATE=0`, `gclient.bat` skips `update_depot_tools.bat`, so `gclient sync` can pass without this GN prerequisite. **Do not** enable the updater: it checks out the moving `origin/main`. The validation driver instead runs `tools/chromium/bootstrap-depot-tools.mjs` after the GN argument policy check and before GN generation. It checks the depot_tools HEAD before and after calling only the pinned `bootstrap/win_tools.bat`, forces `DEPOT_TOOLS_UPDATE=0`, and verifies the generated pointer and Python executable. CIPD installs the version specified by the pinned manifest; no depot_tools Git ref is fetched or updated. A bootstrap failure stops validation; the GN policy, `gn gen`, effective arguments, target labels, and `gn check` are never bypassed.

## Chromium 155 WebUI GN compatibility

[Windows GN-only run 38126244950](https://github.com/ankworks/aurelia/actions/runs/38126244950) passed source sync, patch/overlay installation, GN argument policy and pinned depot_tools Python bootstrap, then reached `gn gen`. GN reported `Assignment had no effect` for `webui_context_type = "trusted"` in Aurelia's `chrome/browser/resources/newtab/BUILD.gn`. GN generation **did not pass** in that run; `gn check` and compilation were not reached.

The subsequent [Windows GN-only run 38128649838](https://github.com/ankworks/aurelia/actions/runs/38128649838) **passed `gn gen`** (`35817` targets from `5040` files in `26870ms`) and the effective GN argument check. It then **failed at target-label verification**: `gn desc out\\Aurelia //chrome/browser/resources/aurelia:build_ts type` returned `Don't know how to display "type" for "action".` This is a validation-tool CLI mismatch, not a missing generated label; scoped `gn check` and compilation were not reached in that run.

Chromium's pinned `DEPS` selects GN revision `cfcd774b98f3433e18b722f9a7ff06119825b8eb`. Its [description builder](https://github.com/ArthurSonzogni/gn/blob/cfcd774b98f3433e18b722f9a7ff06119825b8eb/src/gn/desc_builder.cc) emits `type` in the **full** description, but not when a field is requested; its [description command](https://github.com/ArthurSonzogni/gn/blob/cfcd774b98f3433e18b722f9a7ff06119825b8eb/src/gn/command_desc.cc) supports `--format=json`. Its [check command](https://github.com/ArthurSonzogni/gn/blob/cfcd774b98f3433e18b722f9a7ff06119825b8eb/src/gn/command_check.cc) accepts at most one optional target label or pattern. The updated validation driver checks exact labels, types, direct dependencies and declared outputs from full GN JSON, then invokes `gn check` separately for both controller targets. Local tests and a minimal fixture using GN built from that pinned source verify the CLI behavior. The later [Windows GN-only run 38130837908](https://github.com/ankworks/aurelia/actions/runs/38130837908) on Aurelia commit `47f32400aa44d03846d763487a6d07f601b6ac61` **passed** the complete GN-only pipeline: `gn gen` (35817 targets from 5040 files in 17759 ms), effective arguments, exact Aurelia target verification, and separate scoped `gn check` invocations for both controllers (`Header dependency check OK` twice). It did not compile resources, C++ or the browser; no executable or runtime test resulted.

The [pinned Chromium `build_webui.gni`](https://github.com/chromium/chromium/blob/cfaadc5a132d78e1828635aa8405a499f3e14864/ui/webui/resources/tools/build_webui.gni) uses `invoker.webui_context_type` only inside `if (defined(invoker.ts_deps))`, when creating the `webui_path_mappings("build_path_map")` target. The [pinned path mappings template](https://github.com/chromium/chromium/blob/cfaadc5a132d78e1828635aa8405a499f3e14864/tools/typescript/webui_path_mappings.gni) passes that context to the TypeScript path-mapping script, which selects `chrome:` versus `chrome-untrusted:` import mappings. Other pinned Chromium WebUIs (for example, `chrome/browser/resources/compose/BUILD.gn` and `chrome/browser/resources/new_tab_shared/BUILD.gn`) set both `ts_deps` and their context. The offending New Tab BUILD file belongs to Aurelia's overlay, not pristine Chromium; `chrome://aurelia` already declared both variables. No GN argument or upstream patch creates the mismatch.

The New Tab resource target now declares `ts_deps = [ "//ui/webui/resources/js:build_ts" ]` and retains `webui_context_type = "trusted"`. This makes the Chromium template consume the assignment and preserves the explicit trusted TypeScript mapping. The WebUI controller remains a `DefaultInternalWebUIConfig` on the `chrome://aurelia-newtab` host, and its data source/CSP, GRIT allocation, pak dependencies, and original Chromium New Tab remain unchanged. The build-time context mapping is **not** a substitute for runtime origin or CSP checks. The New Tab fix itself is overlay-only and does not change the Chromium pin. A subsequent source audit found that `chrome/browser/BUILD.gn` had unconditional dependencies on both controllers despite the `assert(!is_android)` declarations on both of their resource targets (and the New Tab controller target). The generated patch now adds those dependencies inside an existing `!is_android` block instead; patch metadata and the affected post-image digest were regenerated against pristine pinned pre-images. Static regression checks catch a missing `ts_deps`, a changed context, or an unguarded browser dependency; the successful Windows GN-only run above supplies separate GN evidence. Neither static checks nor GN-only validation establish compilation or runtime success.

## The Windows `git.bat` shim

`depot_tools/git_cache.py` hard-codes the git program name for Windows:

```python
git_exe = "git.bat" if sys.platform.startswith("win") else "git"
```

`Mirror.GetCachePath()` then runs `git.bat config --type path cache.cachepath`
with `subprocess.check_output` and catches **only** `CalledProcessError`, and
`gclient_scm.GitWrapper.cache_dir` calls it for every git dependency in every
`gclient sync` while catching **only** `RuntimeError`. Neither depot_tools nor
Git for Windows ships a `git.bat`, so on a GitHub-hosted Windows runner the
lookup fails with `FileNotFoundError [WinError 2]` and `gclient sync` aborts
before the first fetch (run 38043815539).

`tools/chromium/lib/windows-git.mjs` closes the gap by writing a `git.bat` into
`<destination>/.aurelia-git-shim/` that forwards every argument to the resolved
`git.exe` and returns its exit code. The directory is prepended to the PATH of
the `gclient` child process only — depot_tools, the system PATH, and the
machine are never modified, and no Chromium revision or pin is touched.

The git cache is **not** disabled: with the shim in place `GetCachePath()`
reaches its `git config` probe, gets the `CalledProcessError` it was written to
handle, and falls back to `$GIT_CACHE_PATH` and then to `RuntimeError`, which
`GitWrapper.cache_dir` handles. A cache directory configured later is used as
before.

## Windows toolchain configuration (`DEPOT_TOOLS_WIN_TOOLCHAIN=0`)

When Chromium synchronizes dependencies via `gclient sync`, its
`src/build/vs_toolchain.py` hook defaults to downloading Google's internal
packaged Windows toolchain from Google Cloud Storage (`chrome-wintoolchain`
bucket). External builders and GitHub Actions runners do not have access to this
private bucket, resulting in HTTP 401 `ServiceException: 401 Anonymous caller
does not have storage.objects.list access` (run 38046646098).

Chromium's toolchain scripts support building with a locally installed Visual
Studio and Windows SDK by setting:

```env
DEPOT_TOOLS_WIN_TOOLCHAIN=0
```

Setting `DEPOT_TOOLS_WIN_TOOLCHAIN=0`:

1. Skips the private toolchain package download in `vs_toolchain.py update`.
2. Directs `vs_toolchain.py` and `build/toolchain/win/setup_toolchain.py` to
   locate the local Visual Studio installation (VS 2022/2026 with
   `Microsoft.VisualStudio.Component.VC.Tools.x86.x64`).
3. Uses the installed Windows SDK (`10.0.28000.0` or higher, matching
   `base/win/windows_version.cc` and `build/vs_toolchain.py`).

The environment variable is set at the workflow level in
`.github/workflows/chromium-build.yml` and is propagated to all child
processes spawned by `tools/chromium/ci-validation.mjs` and
`tools/chromium/sync.mjs`.

Before initiating Chromium source synchronization, `tools/ci/check-builder.mjs`
and `tools/chromium/lib/windows-toolchain.mjs` validate that Visual Studio, the
MSVC compiler (`cl.exe`), `vcvarsall.bat`, and a compatible Windows SDK are
installed and complete. If any component is missing or incompatible, the runner
preflight reports `BLOCKED` before downloading any source.

### Verified Windows SDK requirements at Chromium 155.0.8059.40 (`cfaadc5a132d78e1828635aa8405a499f3e14864`)

Inspection of upstream Chromium at pinned revision
`cfaadc5a132d78e1828635aa8405a499f3e14864` establishes:

- **Preferred packaged SDK release**: `10.0.28000.2270`
  (`docs/windows_build_instructions.md` and `build/vs_toolchain.py`
  `TOOLCHAIN_HASH = '3bfcb536c8'`), with SDK Debugging Tools
  `>= 10.0.26100.3323` (`Debuggers\x64\dbghelp.dll`).
- **Minimum supported SDK directory version**: `10.0.28000.0`
  (`NTDDI_WIN11_BR`), bumped from `10.0.26100.0` in upstream commit
  `5e7ea61dd227b6521dcbc299be43fa92d37e42ae` and enforced by preprocessor check
  in `a89c5c3387612bb30202ac73b918406c30de6a34`.
- **Why SDK `10.0.26100.0` cannot be used for GN-only validation**:
  1. `build/toolchain/win/win_toolchain_data.gni` unconditionally executes
     `build/toolchain/win/setup_toolchain.py` for both `x86` and `x64` during
     `gn gen`.
  2. `setup_toolchain.py` ignores the `windows_sdk_version` GN argument,
     hardcodes `SDK_VERSION = '10.0.28000.0'`, invokes
     `vcvarsall.bat amd64 10.0.28000.0` and
     `vcvarsall.bat amd64_x86 10.0.28000.0`, and verifies that every `INCLUDE`
     and `LIB` directory exists on disk.
  3. `build/toolchain/win/BUILD.gn` executes `vs_toolchain.py copy_dlls` during
     `gn gen`, requiring `Debuggers\x64\dbghelp.dll`.
  4. `build/config/win/BUILD.gn` defines `NTDDI_VERSION=NTDDI_WIN11_BR` and
     `base/win/windows_version.cc` fails with
     `#error Windows 10.0.28000.0 SDK or higher required.` if `NTDDI_WIN11_BR`
     is undefined in `Include/10.0.28000.0/shared/sdkddkver.h`.

### Automated runner preparation (`tools/chromium/prepare-runner.mjs`)

GitHub's `windows-2025` runner image (`windows-2025-vs2026`) currently ships
Visual Studio 2026 Enterprise (`18.10.12217.157`) and MSVC `14.51.36231` with
Windows SDK `10.0.26100.0` and ~147 GB of free disk on `C:` (run
`38101262458`), down from `219.9 GB` in run `38046646098` prior to the
`actions/runner-images` Visual Studio 2026 image transition (`#14004`, PR
`#14851`).

When `tools/chromium/ci-validation.mjs` runs on a GitHub-hosted Windows x64
runner that meets the mode's CPU, RAM, and Visual Studio requirements,
`tools/chromium/prepare-runner.mjs` prepares the runner before the final
preflight verdict:

1. **Safe non-Chromium disk cleanup**: Removes only allowlisted preinstalled
   non-Chromium directories (`C:\Android`, `C:\hostedtoolcache\windows\{CodeQL,Boost,Go,Ruby,PyPy}`,
   `C:\ghcup`, `C:\Miniconda*`, `C:\Julia`, `C:\Program Files\{Haskell,R,PostgreSQL,MySQL,MongoDB}`,
   `C:\SeleniumWebDrivers`, `C:\ProgramData\chocolatey\cache`) while strictly
   protecting Visual Studio, MSVC, Windows Kits/SDK, Git, Python, Node.js,
   Rust, Windows system directories, and the active workspace.
2. **Automated Windows SDK `10.0.28000.0` installation**: Downloads Microsoft's
   official `winsdksetup.exe`, verifies its Microsoft Corporation Authenticode
   digital signature before execution, installs
   `OptionId.DesktopCPPx64 OptionId.DesktopCPPx86 OptionId.UWPCPP OptionId.WindowsDesktopDebuggers`,
   removes the temporary installer directory, and verifies `10.0.28000.0`
   headers (`windows.h`, `corecrt.h`, `sdkddkver.h` with `NTDDI_WIN11_BR`),
   `x64`/`x86` libraries, and `Debuggers\x64\dbghelp.dll`.
3. **Unchanged safety floors**: Re-runs `tools/ci/check-builder.mjs` after
   preparation and blocks before source sync unless at least **150 GB** of free
   disk and Windows SDK **`10.0.28000.0`+** are verified.

## Troubleshooting

| Result                                              | Meaning / next action                                                                                                                                                                  |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BLOCKED` on `standard` with `targeted`/`full`      | Expected: the standard runner does not meet the strict 8 / 32 / 150 gate. No Chromium source sync starts. Use `gn`, or `larger` for compilation.                                       |
| `BLOCKED` on `standard` with `gn`                   | Unexpected on the measured 4-core / 16 GB / 150+ GB runner. Read the named problem in the summary; no source sync starts.                                                              |
| `larger` remains queued                             | Confirm the GitHub-hosted Windows runner exists, the label is exactly `windows-latest-8-cores`, its group grants this repository access, and billing is enabled. There is no fallback. |
| `RESOURCE EXHAUSTED`                                | Inspect resource samples and the named stage log. The process tree is stopped; do not lower the reserve without review.                                                                |
| Pin, patch, overlay, GN, or target failure          | Treat as a real failure. Inspect the stage log and review the pinned Chromium/`depot_tools` config; no fallback to a moving revision occurs.                                           |
| `COMPILED` but no browser zip                       | The binary was too large or failed staging/postconditions. The summary explains why; this does not downgrade compiler evidence.                                                        |
| Full compiler succeeds but smoke test is absent     | Compilation is established, runtime integration is not. Run and record the separate smoke test before claiming `TESTED`.                                                               |
| `FileNotFoundError: [WinError 2]` in `git_cache.py` | `git.bat` was not resolvable. The shim in `<dest>/.aurelia-git-shim` was not created or was not on PATH. Read the `tooling:` lines in `artifacts/logs/pinned-sync.log`.                |
| `ServiceException: 401` in `vs_toolchain.py`        | `DEPOT_TOOLS_WIN_TOOLCHAIN` was not set to `0`. Ensure `DEPOT_TOOLS_WIN_TOOLCHAIN=0` is set in the workflow environment.                                                               |

## Related documentation

- [GitHub-hosted build feasibility and runner specifications](CI-BUILD-FEASIBILITY.md)
- [CI threat model and workflow permissions](CI-SECURITY.md)
- [Testing levels and coverage](TESTING.md)
- [Chromium pin and upstream update procedure](CHROMIUM-UPSTREAM.md)
- [Reviewed fork-delta budget](FORK-DELTA.md)
