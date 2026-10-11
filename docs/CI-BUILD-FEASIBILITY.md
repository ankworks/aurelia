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

| Runner choice                        | Published resources              | Expected outcome                                                                                                                                                                                      |
| ------------------------------------ | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `standard` (`windows-2025`, default) | 4 vCPUs / 16 GB RAM / 14 GB SSD  | `gn` runs within the reduced GN-only profile (4 cores / 15.5 GB / 150 GB free). `targeted` and `full` are **BLOCKED** before Chromium source sync because they need the strict 8 / 32 / 150 minimums. |
| `larger` (`windows-latest-8-cores`)  | 8 vCPUs / 32 GB RAM / 300 GB SSD | Proceeds only if the live measurement confirms at least 150 GB free on the exact Chromium destination volume and the required Windows toolchain is present.                                           |

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
Studio installation, Windows SDK version, and free space for each run. It never
lowers the existing 150 GB builder minimum or `10.0.28000.0` SDK requirement in
order to force a sync.

## Chromium requirements and workflow design

Chromium's current Linux build instructions specify at least 100 GB free disk
and recommend more than 16 GB RAM; Aurelia deliberately retains its more
conservative, reviewed first-build gate: **8 logical cores, 32 GB RAM, and
150 GB free on one volume**. That gate is stored in
`config/chromium_version.json`, checked by `tools/ci/check-builder.mjs`, and the
150 GB disk floor is independently enforced by `tools/chromium/sync.mjs`.

GN-only validation (`validation_level=gn`) has its own reduced profile of
4 logical cores and 15.5 GB RAM, with the same 150 GB disk floor. It runs
sync, patch/overlay, `gn gen`, and `gn check`, and it never compiles. Those
GN-only results are reported as `GN GEN PASS` with `COMPILATION NOT TESTED`. They
are not compiler evidence, and that profile does not lower the `targeted` or
`full` gate. The reduced profile is only proven once a `gn` run completes on a
GitHub-hosted standard runner; until then, no GN validation success is claimed.

The manual workflow is `.github/workflows/chromium-build.yml` (canonical
source: `tools/ci/workflows/chromium-build.yml`). It has no `push`,
`pull_request`, or schedule trigger. `gn` is the default validation level;
`targeted` and `full` require explicit selection. A standard runner records a
`BLOCKED` result for `targeted` and `full` and exits before any Chromium
checkout. It runs `gn` within the reduced profile above.

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
the generated GN graph must resolve each label before any compile command. All
Ninja invocations are capped at four jobs. Disk and available memory are sampled
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
