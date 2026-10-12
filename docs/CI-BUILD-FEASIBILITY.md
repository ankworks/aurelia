# GitHub-hosted Chromium build feasibility

Chromium validation is manual-only and runs on GitHub-hosted Windows x64
runners. The workflow does not use a self-hosted runner, an external build
server, a containerized Chromium replacement, or credentials from a third party.

## Published runner resources

This repository is public. GitHub's current published specification for the
standard public `windows-2025` runner is **4 vCPUs, 16 GB RAM, and 14 GB SSD**.
The values available to an individual job can differ from a published image
summary, so every run also measures the destination volume and actual machine
before fetching Chromium. See the [GitHub-hosted runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).

GitHub documents a Windows larger-runner tier with **8 vCPUs, 32 GB RAM, and
300 GB SSD**. Larger runners are a GitHub-hosted service, but they require an
eligible organization plan, a configured runner, repository access, and billing.
The optional `larger` input selects the label `windows-latest-8-cores`; an
organization administrator must configure a GitHub-hosted Windows runner with
that name. See [larger-runner specifications](https://docs.github.com/en/actions/reference/runners/larger-runners).

| Runner choice                        | Published resources              | Expected outcome                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------ | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `standard` (`windows-2025`, default) | 4 vCPUs / 16 GB RAM / 14 GB SSD  | `gn` runs within the reduced GN-only profile (4 cores / 15.5 GB / 80 GB free, shallow `--no-history` checkout). `targeted-lite` runs its experimental bounded-compilation profile (same machine class, Ninja `-j 2`, object-level C++ only). `targeted` and `full` are **BLOCKED** before Chromium source sync because they need the strict 8 / 32 / 150 minimums. |
| `larger` (`windows-latest-8-cores`)  | 8 vCPUs / 32 GB RAM / 300 GB SSD | Proceeds only if the live measurement confirms at least 150 GB free on the exact Chromium destination volume and the required Windows toolchain is present.                                                                                                                                                                                                        |

Earlier runner experiments recorded different free-space totals on preinstalled
Windows volumes (`219.9 GB` in run `38046646098` vs `147.0 GB` in run
`38101262458` after the `actions/runner-images` `windows-2025-vs2026` transition
in issue `#14004` / PR `#14851`, which preinstalled Visual Studio 2026
Enterprise `18.10.12217.157`, MSVC `14.51.36231`, Windows SDK `10.0.26100.0`,
and ~109 GB of toolchains on `C:`). Those historical measurements are not
treated as a guarantee; `tools/chromium/prepare-runner.mjs` reclaims disk space
only from an explicit allowlist of non-Chromium runner packages (`C:\Android`,
`CodeQL`, `Boost`, `Go`, `Ruby`, `PyPy`, `ghcup`, `Miniconda`, `Julia`, `R`,
database servers, and Chocolatey caches) while protecting Visual Studio, MSVC,
Windows SDK, Git, Python, Node.js, and Rust, and provisions Windows SDK
`10.0.28000.0` from Microsoft's Authenticode-verified installer before
`tools/ci/check-builder.mjs` records the final CPU, RAM, architecture, Visual
Studio installation, Windows SDK version, and free space for each run.

### GN-only disk policy (M1.3)

For GN-only validation (`validation_level=gn`) the pre-sync disk floor is
**80 GB** (evidence-based), not 150 GB. Compilation modes (`targeted`, `full`)
retain the unchanged 150 GB floor. The evidence supporting 80 GB for GN-only:

| Component                                                         | Estimated size | Source                                                                                                                               |
| ----------------------------------------------------------------- | -------------: | ------------------------------------------------------------------------------------------------------------------------------------ |
| `depot_tools` (pinned clone)                                      |        ~0.3 GB | git clone measurement                                                                                                                |
| Chromium `src` working tree (pinned revision)                     |      ~12–15 GB | upstream Chromium source tree                                                                                                        |
| DEPS / third_party working trees (~750 pinned repos)              |       ~8–12 GB | cl-shrink analysis of third_party                                                                                                    |
| Shallow `.git` directories (`--no-history`, depth=1, ~750 repos)  |        ~3–5 GB | upstream `fetch --no-history` (~3.7 GB reported by Torne, 2020); cl-shrink measures dependency `.git` overhead at 40 GB with history |
| GN generation artifacts (args.gn, ninja files, generated headers) |        ~1–2 GB | measured GN output size                                                                                                              |
| **Subtotal (expected)**                                           |  **~25–35 GB** |                                                                                                                                      |
| Safety reserve enforced during run                                |          10 GB | `config.buildRequirements.gnValidation.diskSafetyReserveGb`                                                                          |
| **Pre-sync floor**                                                |      **80 GB** | Leaves ~45 GB headroom for hooks, temp files, and run-to-run variance                                                                |

GN-only invokes `gclient sync --no-history` (shallow, depth=1 for every synced
repo) per `fetch chromium --no-history` in the upstream Windows build
instructions. Full-history clones are retained for `targeted`/`full` because
incremental `gclient sync` and compilation need them. The 150 GB floor for
compilation modes is never lowered and a GN PASS is never reported as a
compiler PASS.

Disk consumption is measured and recorded at four checkpoints (written to
`artifacts/disk-measurements.json`):

1. Before sync
2. After gclient sync
3. After patch/overlay application
4. After `gn gen`

The runtime disk reserve is also mode-aware: 10 GB for GN, 15 GB for
compilation. The runner aborts (safely stops the process tree) if free disk
falls below the reserve; it never removes protected system files.

## Experimental resource-aware targeted-lite compilation (M1.9)

`validation_level=targeted-lite` is the first level that actually compiles
anything on the free standard runner. It exists to answer one question with
real compiler evidence: **do Aurelia's integrated components compile against
Chromium 155?** It is deliberately not a small `targeted`, and its summary says
so every time.

### Scope (what a PASS can claim)

| In scope                                                                                                                         | Out of scope (always reported NOT TESTED)            |
| -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| WebUI TypeScript compilation (`build_ts`, both pages)                                                                            | The source_sets' transitive C++ dependency libraries |
| GRIT resource generation (`build_grd`, `resources_grit`)                                                                         | Linking (no library, DLL, or executable is produced) |
| WebUI resource packaging (`resources`, both `.pak` files)                                                                        | The full `chrome` target                             |
| Aurelia C++ controller translation units (`aurelia_ui.cc`, `newtab_ui.cc`) compiled with the real MSVC toolchain and Windows SDK | Browser runtime, smoke tests, and any runtime claim  |

The C++ step compiles the two controller translation units as **exact Ninja
object targets** derived from the overlay `source_set` labels through GN's
`obj/<label-dir>/<label-name>/<source>.obj` convention. The exact object
targets are compiled first and the `.obj` outputs are verified after (the
build executor itself rejects nonexistent targets). This is not a
reduced `targeted`: the reason is the build graph itself. The controller
targets depend on `//chrome/browser:browser_public_dependencies`, a group of
roughly 60 public dependencies (`//content/public/browser`, `//chrome/common`,
`//components/sync`, and more), so building the source_set labels compiles
thousands of upstream translation units that say nothing about Aurelia's code
and cannot finish on 4 cores inside the 360-minute job. The strict `targeted`
level (full source_set compilation with dependencies) keeps its unchanged
8-core / 32 GB / 150 GB gate on the larger runner.

### Resource profile (a separate profile, not a lowered gate)

| Resource               | targeted-lite                                             | targeted / full (unchanged) |
| ---------------------- | --------------------------------------------------------- | --------------------------- |
| Logical cores          | 4                                                         | 8 (never lowered)           |
| RAM                    | 15.5 GB                                                   | 32 GB (never lowered)       |
| Pre-sync disk floor    | 80 GB                                                     | 150 GB (never lowered)      |
| Runtime disk reserve   | 15 GB                                                     | 15 GB                       |
| Memory reserve         | 1.5 GB                                                    | 1.5 GB                      |
| Sync jobs / Ninja jobs | 2 / 2                                                     | 4 / 4                       |
| Checkout               | Shallow (`--no-history`)                                  | Full history                |
| GN arguments           | `config/gn/win-x64-targeted-lite.gn` (`symbol_level = 0`) | `config/gn/win-x64-dev.gn`  |

The 80 GB disk floor reuses the GN-only evidence base (measured ~31.3 GB for
shallow sync + GN generation in run `38130837908`) plus headroom for bounded
compile outputs: two translation units, one small PCH, and script-based
resource actions, with no link step. Every compile command is constructed by
`tools/chromium/build-plan.mjs` and recorded in the stage log with its exact
arguments, exit code, duration, and sampled peak memory/disk. Failures are
classified as memory exhaustion, disk exhaustion, missing include, target
resolution, link error, or source/compiler error — the run monitor's
`RESOURCE EXHAUSTED` status is kept distinct from a compiler `FAIL`, and the
compiler diagnostics themselves are never suppressed.

### Supported validation modes

| Mode            | Standard runner     | What it proves                                                                       |
| --------------- | ------------------- | ------------------------------------------------------------------------------------ |
| `gn`            | Runs                | GN generation, target verification, scoped `gn check`. No compilation.               |
| `targeted-lite` | Runs (experimental) | Aurelia WebUI resources compile, and the Aurelia C++ controllers compile (TU-level). |
| `targeted`      | BLOCKED             | Aurelia C++ source_sets compile with transitive dependencies.                        |
| `full`          | BLOCKED             | The `chrome` target compiles.                                                        |

### Known limitations

- `targeted-lite` never links and never produces a browser binary. Its C++
  PASS is an Aurelia-code compile claim, not a dependency-completeness or
  link claim.
- On 4 cores / 16 GB the full `source_set` build is out of reach inside the
  job timeout; that work belongs to `targeted` on the larger builder.
- The mode is experimental: its profile is justified by the GN-only
  measurements above, not yet by repeated compile runs. The first real runs
  update the measurement table below.

### GN labels versus Ninja target names (learned from run `38139216273`)

The first targeted-lite run proved a boundary bug in the build command
construction: the driver passed canonical GN labels (`//chrome/browser/
resources/aurelia:build_ts`) to `autoninja`, and Siso/Ninja rejected every one
of them as an unknown target. This is exact pinned-tool behavior, not a quirk:
GN `cfcd774b`'s `gn help ninja_rules` states _"Full label name with no leading
slashes. So you can use `ninja tools/fruit:doom_melon` to build
`//tools/fruit:doom_melon`"_ and _"GN introspection commands accept explicit
labels"_. So `gn desc` / `gn check` take the canonical `//` form while the
build executor requires the same label without `//`. The conversion now lives
in one place at the build execution boundary
(`tools/chromium/build-plan.mjs` `ninjaTargetFor`, applied by `ninjaBuildArgs`
and `sisoQueryInputsArgs`); GN validation keeps the canonical form, and
regression tests pin the exact executor argv. Unknown-target errors are still hard
failures, classified as `target-resolution` — the fix converts names, it never
suppresses errors. The Chromium pin and patch set were not changed.

### One build backend on Siso-managed out dirs (runs `38218572222` and `38248455910`)

Two runs taught the boundary between the pinned backends and their tools.
Run `38218572222` failed its object-target check because the driver queried
the generated graph with plain `ninja -t query`. Pinned depot_tools `ninja.py`
(`1e43ae34`) refuses that: when the out dir contains the Siso state marker
`.siso_deps` it exits with _"contains Siso state file. Use `autoninja` to
choose appropriate build tool, or run `gn clean` to switch from siso to
ninja"_ for every tool outside a small read-only allowlist (`list`,
`commands`, `inputs`, `targets` — with a TODO to implement those in Siso),
and `query` is not in that allowlist. Builds are owned by Siso
(`autoninja.py` `_get_use_siso_default` dispatches `siso ninja --offline`
whenever `.sisoenv` + `build_with_chromium = true`, and treats an existing
`.siso_deps` as "this out dir already uses Siso").

Run `38248455910` replaced that query with `siso query inputs` on the pinned
Siso binary (CIPD `build/siso` @ `d38036b6`) and reached the C++ stage — only
to fail with `spawnSync ... ENOBUFS` before a controller compiled. Siso's
query group (`subcmd/query` @ `d38036b6`) is read-only and rejects
nonexistent targets (`ninjautil.State.Targets` returns `unknown target %q`,
the inputs traversal `target not found: %q`), but `query inputs` prints the
**complete transitive input closure** of every requested target — and with no
arguments it falls back to the default targets of the whole build. That
unbounded listing overflowed Node's 1 MiB `spawnSync` capture default.

The design is now the simplest one that preserves every check: **build exact
object targets, require exit code 0, verify the object files exist.** A real
build command already rejects unknown targets (siso resolves build targets
through the same `ninjautil.State.Targets` manifest lookup as its query
group), a zero exit code is the compilation result, and the verify step
requires `obj/<label-dir>/<label-name>/<source>.obj` on disk. GN-native
metadata checks (`verifyGnTargets`, `plannedObjectTargets` allowlisting) run
before, and `ninjaTargetFor` still converts labels at the execution boundary.
The pre-query added no verification the build does not provide and was
removed from the execution path. The capture layer is now explicitly bounded
(`DEFAULT_MAX_BUFFER_BYTES`, 32 MiB) with `ENOBUFS` classified as
`capture-overflow` — a loud failure, never a silent truncation — and stage
logs collect both stdout and stderr. Siso state files are never deleted and
`gn clean` is never used as a workaround.

### Measured build results

| Run                                                                           | Date (UTC) | Scope                                                                            | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Evidence                                                        |
| ----------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| [`38139216273`](https://github.com/ankworks/aurelia/actions/runs/38139216273) | 2026-10-11 | targeted-lite full pipeline on `windows-2025` (4 vCPU / 16 GB), commit `cd1ecab` | **FAIL** at WebUI resource compilation — every `autoninja` resource target was rejected as an unknown target because the driver passed GN-style `//` labels to the Ninja-name boundary. Preflight, pinned sync, patch/overlay, GN argument policy, `gn gen`, effective-arguments, target-label and scoped `gn check` stages completed before the failure (job 12:25:43Z–12:48:52Z, 23m09s total). No compilation PASS is claimed.                                                    | Run URL; stage logs and `build-summary.md` in the run artifacts |
| [`38141751383`](https://github.com/ankworks/aurelia/actions/runs/38141751383) | 2026-10-11 | targeted-lite, commit `93e2216` (label-conversion fix)                           | **FAIL** at `//chrome/browser/resources/newtab:lint_css` — Siso executed 105 real WebUI actions (both pages' `build_ts` TypeScript compiles completed) before Chromium Stylelint reported 29 errors in the New Tab CSS (single-quote, short-hex and duplicate-`:root` rules). Job 13:04:50Z–13:24:46Z, 19m56s.                                                                                                                                                                       | Run URL; artifacts `chromium-build-validation-38141751383`      |
| [`38146612150`](https://github.com/ankworks/aurelia/actions/runs/38146612150) | 2026-10-11 | targeted-lite, commit `41a0703` (Stylelint fix)                                  | **FAIL** at `//chrome/browser/resources/aurelia:lint_ts` — `@typescript-eslint/no-unnecessary-type-assertion` at `aurelia_app.ts:153:20`. Stylelint clean and TypeScript compiles completed. Job 14:17:59Z–14:39:02Z, 21m03s.                                                                                                                                                                                                                                                        | Run URL; artifacts `chromium-build-validation-38146612150`      |
| [`38218572222`](https://github.com/ankworks/aurelia/actions/runs/38218572222) | 2026-10-12 | targeted-lite, commit `47a6790` (ESLint fix)                                     | **WebUI resource compilation PASS** (`37.66s` Siso build, 119 steps: TypeScript, CSS lint, TS ESLint, minify, GRIT, resource maps, `.pak` targets; two resource-map C++ objects compiled), then **FAIL** at the C++ object-target check: plain `ninja -t query` hit depot_tools' `.siso_deps` guard (backend mixing — see the Siso backend section). Job 07:35:16Z–08:01:52Z, 26m36s. Controller C++ compilation is **NOT TESTED** (the failing check is not a compiler invocation). | Run URL; artifacts `chromium-build-validation-38218572222`      |
| [`38248455910`](https://github.com/ankworks/aurelia/actions/runs/38248455910) | 2026-10-12 | targeted-lite, commit `8da0573` (Siso query backend)                             | **WebUI resource compilation PASS** (Siso build 119 steps / 34.79s), then **FAIL** at the C++ stage before any controller compiled: `siso query inputs` overflowed the child-process capture buffer (`spawnSync ... ENOBUFS`) while listing the object target's full transitive input closure. Job 12:20:49Z–12:47:33Z. Controller C++ compilation is **NOT TESTED**.                                                                                                                | Run URL; artifacts `chromium-build-validation-38248455910`      |

The build-then-verify fix (with bounded capture) is committed on the M1.9
branch; a rerun is required before the targeted-lite C++ stage can be judged.
WebUI resource compilation has passed on Windows; the Aurelia controller C++
controllers remain **NOT TESTED** until their compile commands exit 0, and
`targeted-lite` PASS never implies a full browser build.

## Runner storage topology (measured in run `38103342538`)

GitHub-hosted Windows runners expose `C:` and `D:` as **separate volumes**:

| Path                                                                   | Volume | Contents                                                                                                                                     |
| ---------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `C:\Android`, `C:\hostedtoolcache\windows\...`, `C:\Program Files\...` | `C:\`  | Operating system and preinstalled toolchains (Visual Studio, Windows Kits, Android, CodeQL, Go, Ruby, Miniconda, Julia, R, database servers) |
| `D:\a\aurelia\aurelia` (`GITHUB_WORKSPACE`)                            | `D:\`  | Checked-out Aurelia repository                                                                                                               |
| `D:\a\_temp\aurelia-chromium` (`RUNNER_TEMP`)                          | `D:\`  | Chromium checkout destination measured by preflight                                                                                          |

Run `38103342538` proved this with live measurements: cleanup deleted 20
allowlisted directories under `C:\` while the Chromium destination volume
reported **147.0 GB free before cleanup and 147.0 GB free after cleanup**
(`0.0 GB` reclaimed). Deleting files on `C:` cannot increase free space on
`D:`.

Run `38105208893` then measured every volume on the same image after the
Windows SDK `10.0.28000.0` installation:

| Volume | Free disk (measured)   | Meets the 150 GB floor |
| ------ | ---------------------- | ---------------------- |
| `C:\`  | 30.3 GB                | no                     |
| `D:\`  | 147.0 GB (destination) | no                     |

No volume on a standard `windows-2025` runner reaches 150 GB, so for
`targeted` and `full` validation `runner-preflight` reports **BLOCKED** with
those measurements instead of starting a Chromium sync. For GN-only
validation, the D:\ destination volume (147.0 GB free) **does** meet the
80 GB GN-mode floor, so GN-only (`gn / standard`) can proceed. The 150 GB
floor for compilation modes is deliberately not lowered, and compilation on a
standard runner is still blocked.

`tools/chromium/prepare-runner.mjs` is therefore volume-aware:

- It resolves the volume that hosts the Chromium destination and only deletes
  allowlisted targets **on that volume**.
- Targets on any other volume are recorded as `offVolumeTargets` and skipped;
  they are never counted as reclaimed space.
- Reclaimed space is the difference between two live measurements of the
  destination volume. It is never estimated and never clamped to zero, so a
  `0.0 GB` result is reported honestly.
- Each target is classified as `removed`, `missing`, `failed`, `rejected`
  (protected path), or `offVolume`. An absent directory is never reported as
  removed.
- Every volume on the runner is measured and reported with its free space,
  whether it meets the unchanged 150 GB floor, and whether it is the Chromium
  destination volume. When the destination volume is short, `runner-preflight`
  lists any alternative volume that does satisfy the floor, and the workflow
  accepts an explicit `chromium_dest` input to place the checkout there.

The 150 GB floor is unchanged by this work.

## Windows SDK signature verification (run `38103342538`)

`winsdksetup.exe` downloaded successfully (1,417,000 bytes), but the single
verification host `powershell.exe` aborted with
`CouldNotAutoloadMatchingModule - the module Microsoft.PowerShell.Security could
not be loaded`, so no signature was verified and the installer was never
executed. Verification now tries `pwsh` (PowerShell 7) first and falls back to
Windows PowerShell 5.1, explicitly runs
`Import-Module Microsoft.PowerShell.Security -Force` on every host, captures the
PowerShell version, `PSModulePath`, and the underlying module-import error, and
requires a valid `Microsoft Corporation` Authenticode signature. If no host can
verify the signature the installer is deleted and never executed.

## Chromium requirements and workflow design

Chromium's current Linux build instructions specify at least 100 GB free disk
and recommend more than 16 GB RAM; Aurelia deliberately retains its more
conservative, reviewed first-build gate: **8 logical cores, 32 GB RAM, and
150 GB free on one volume**. That gate is stored in
`config/chromium_version.json`, checked by `tools/ci/check-builder.mjs`, and the
150 GB disk floor is independently enforced by `tools/chromium/sync.mjs`.

GN-only validation (`validation_level=gn`) has its own reduced profile of
4 logical cores, 15.5 GB RAM, and an 80 GB pre-sync disk floor (see the
GN-only disk policy above). It runs sync, patch/overlay, `gn gen`, and
`gn check`, and it never compiles. Those
GN-only results are reported as `GN GEN PASS` with `COMPILATION NOT TESTED`. They
are not compiler evidence, and that profile does not lower the `targeted` or
`full` gate. The experimental `targeted-lite` level shares the same machine
class and disk floor but adds bounded compilation (see
[above](#experimental-resource-aware-targeted-lite-compilation-m19)); it
likewise does not lower the `targeted` or `full` gate.

The manual workflow is `.github/workflows/chromium-build.yml` (canonical
source: `tools/ci/workflows/chromium-build.yml`). It has no `push`,
`pull_request`, or schedule trigger. `gn` is the default validation level;
`targeted-lite`, `targeted`, and `full` require explicit selection. A standard
runner records a `BLOCKED` result for `targeted` and `full` and exits before any
Chromium checkout. It runs `gn` and `targeted-lite` within their reduced
profiles.

When a configured larger runner is selected, each validation level is
incremental within one job:

1. Verify the runner reports `GITHUB_ACTIONS=true` and
   `RUNNER_ENVIRONMENT=github-hosted`, measure its resources, and stop unless the
   full recorded builder minimums are met.
2. Use `tools/chromium/sync.mjs` to install the pinned `depot_tools`, sync the
   configured Chromium revision with at most four sync jobs, and verify the
   resulting SHA. Verify the `depot_tools` pin as well.
3. Verify the patch set against the pristine checkout, then apply the patch and
   overlay with Aurelia's existing tools.
4. Validate the reviewed GN arguments, run `gn gen`, verify the generated
   `out/Aurelia/args.gn` against the same policy, resolve all selected target
   labels with `gn desc`, and run scoped `gn check` for the two Aurelia C++
   controller targets.
5. Build WebUI `build_ts`, `build_grd`, and `resources` targets for both pages.
   The pinned Chromium `build_webui()` template defines those targets; they
   validate TypeScript, GRIT generation, resource maps, and `.pak` packaging.
6. `targeted` additionally compiles the two overlay `source_set` targets and
   their C++ dependencies. `full` does the same first, then compiles Chromium's
   `chrome` target. A failure in any earlier stage stops the run.

The selected target labels are declared in the Aurelia overlay `BUILD.gn` files
and the `build_webui()` template fetched at the configured Chromium revision;
the generated GN graph must resolve each label before any compile command.
Ninja invocations are capped at four jobs (two on `targeted-lite`). Disk and
available memory are sampled
every 30 seconds; the process tree is stopped if the 15 GB disk reserve or
1.5 GB available-memory reserve is breached. A 330-minute internal deadline
leaves time for summaries and artifact upload under GitHub's 6-hour job limit.

## Ephemeral checkout and artifact policy

GitHub-hosted runners are fresh VMs. This workflow does not assume a persistent
Chromium checkout and does not cache or upload the source tree. Each manual run
that passes preflight syncs the exact pin once, then performs only its selected
validation level. That first sync is expensive and is deliberately not started
on a standard runner.

`artifacts/` contains build logs, resource-usage samples, runner capabilities,
GN arguments, and a build summary. It never contains the Chromium checkout. A
browser runtime is staged and uploaded only after the full `chrome` compiler
command exits successfully and the staged files fit within a 450 MiB upload
budget. A skipped binary upload is recorded in the summary. No compiler success
is claimed without a zero exit code.

The workflow job has a 360-minute hard timeout and runs one at a time. If a
larger runner is not configured or available, choose `standard` to capture the
`BLOCKED` evidence; the `larger` job will remain queued until its GitHub-hosted
runner label is available. The legacy self-hosted heavy-build and standard-runner experiment workflows are
retired and have no source sync or compiler steps. The only supported Chromium
validation and compilation entry point is `chromium-build.yml`.
