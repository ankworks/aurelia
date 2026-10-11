# Chromium upstream strategy

Aurelia is a **thin fork**: a pinned Chromium revision plus a small, isolated
set of Aurelia-owned changes installed by tooling. This document explains the
model, the pin, and the exact procedure for taking an upstream update.

## The four-layer model

```
layer 4  Aurelia product code (TS/WebUI, C++ overlay, design tokens)
         -> chromium/overlay/**            ADDED files, no rebase cost
layer 3  Registration patch (7 inserted lines in 6 upstream files)
         -> chromium/patches/**            ONE patch, trivial to rebase
layer 2  Pinned Chromium source tree
         -> config/chromium_version.json   exact revision, never a moving ref
layer 1  Chromium build tooling (depot_tools, gclient, GN, ninja)
         -> pinned separately, see below
```

Nothing in layer 4 modifies Chromium. Layer 3 exists only because a new WebUI
must be referenced from Chromium's build graph and WebUI registry.

## The pin

`config/chromium_version.json` is the single source of truth:

```json
{
  "chromium": {
    "version": "155.0.8059.40",
    "channel": "stable",
    "milestone": 155,
    "revision": "cfaadc5a132d78e1828635aa8405a499f3e14864",
    "upstreamRepository": "https://github.com/chromium/chromium"
  }
}
```

Rules enforced by `tools/chromium/lib/config.mjs` (and its tests):

- the revision must be a full 40-character commit SHA;
- moving refs (`main`, `HEAD`, `latest`, `beta`, ...) are rejected;
- `patchSet.baseRevision` must equal `chromium.revision`;
- `updatePolicy.automaticMerge` must be `false`;
- the upstream repository must be an expected origin
  (`github.com/chromium/chromium` or `chromium.googlesource.com`).

### Why `155.0.8059.40`

This is the build chromiumdash reports as **stable on Windows x64** — the first
target platform — when the pin was set, so the baseline is a promoted,
security-patched release rather than an unpromoted branch head. The channel was
cross-checked on Linux (also milestone 155 on stable) and the revision is
verified by reading `chrome/VERSION` at the exact commit: `MAJOR=155 MINOR=0
BUILD=8059 PATCH=40`.

Pin history is kept in `pinHistory` in the config file. The first scaffolding
pin (`155.0.8059.73`) was chosen as "the newest version tag", which is not
evidence of a channel: that revision sits _later_ on `branch-heads/8059` than
the promoted stable build, and chromiumdash never reported it as stable for a
target platform. It is the signature of an unpromoted PGO roll, so it was the
wrong baseline.

The mirror's mechanics were also checked rather than assumed, and an earlier
note in this repository was wrong and is corrected here: the
`github.com/chromium/chromium` mirror **does** expose release tags
(`refs/tags/<version>` — `refs/tags/155.0.8059.40` resolves to the pinned commit
`cfaadc5a…`), but it has **no GitHub Releases**, and its release branches are not
pushed as `branch-heads/*` refs. Chromium's own release branches live on
`chromium.googlesource.com` as `refs/branch-heads/8059`. Both facts are recorded
rather than quietly corrected: pin evidence must be re-checkable.

### Re-checking the pin

One command re-checks the evidence above without trusting this document:

```bash
node tools/chromium/verify-pin.mjs
```

It resolves `refs/tags/<version>` on the mirror and reads `chrome/VERSION` at the
pinned revision, failing if either disagrees with `config/chromium_version.json`.
It runs in fast CI on every pull request.

### Toolchain pin

`depot_tools` is pinned separately in the same file
(`toolchain.depotTools`). Its revision is currently `null` ("unresolved")
because it is not mirrored on GitHub and the scaffolding sandbox cannot reach
`chromium.googlesource.com`. **Do not invent a SHA.** Resolve it on the builder:

```bash
git -C <dest>/depot_tools rev-parse HEAD
node tools/chromium/sync.mjs --record-depot-tools <sha>
```

## Source management

Chromium sources are **never** committed to this repository (see `.gitignore`).
Two paths exist:

1. **Lightweight (sandbox, fast CI, development):** fetch only the upstream
   files we care about, at the exact pinned revision, through
   `gh api` (default) or `git show` from a local checkout. This is what
   `verify-patches --online` uses, and it is why the patch can be verified
   without a 150 GB checkout.
2. **Full checkout (builder):** `tools/chromium/sync.mjs` clones/updates
   `depot_tools`, writes a `.gclient` solution for `chromium/src`, syncs with
   `--revision src@<pin>`, verifies `HEAD`, and (with `--install`) installs the
   overlay and applies the patch set. Requirements are in
   [BUILDING-CHROMIUM.md](BUILDING-CHROMIUM.md).

## Fork layout in the repository

| Path                                    | Contents                                                                                                    |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `config/chromium_version.json`          | Pin, patch-set version, update policy, builder requirements.                                                |
| `chromium/overlay/`                     | Files copied into the Chromium tree. Paths mirror the tree exactly.                                         |
| `chromium/patches/`                     | Patch files **and** their `.meta.json` (reason, difficulty, digests).                                       |
| `chromium/verification/pre-images.json` | SHA-256 of every untouched upstream file the patch expects. Enables offline audit and detects tampering.    |
| `tools/chromium/`                       | `sync.mjs`, `install-overlay.mjs`, `generate-patch.mjs`, `verify-patches.mjs`, `smoke-test.mjs`, `cli.mjs`. |

## Patch rules

A patch is accepted only if it:

1. touches a path inside the expected areas (`chrome/browser`, `chrome/common`,
   `chrome/app`, `chrome/installer`, `chrome/updater`, `components`, `content`,
   `ui`) — enforced by `tools/chromium/lib/patch.mjs`;
2. never touches `third_party/`, `sandbox/`, `crypto/`, `net/third_party/` or
   `base/allocator/`;
3. is a pure insertion where possible (the current patch removes zero lines);
4. carries metadata: reason, component, rebase difficulty, whether it could
   become an overlay, and whether it is upstreamable;
5. is regenerated — not hand-edited — by
   `node tools/chromium/cli.mjs generate-patch`, so it always targets the
   pinned revision exactly.

### Patch files are byte-exact, so their line endings are a build input

A patch file is hashed (`*.meta.json` → `sha256`) and re-applied byte-for-byte
with `git apply`. It must therefore be stored exactly as `git diff` produced it:
**LF line endings, no byte-order mark**. The repository enforces this with
`.gitattributes`:

```
* text=auto eol=lf
*.patch -text
*.diff -text
```

This is not cosmetic. Run
[38108794402](https://github.com/ankworks/aurelia/actions/runs/38108794402)
failed on the `windows-2025` runner because Git for Windows defaults to
`core.autocrlf=true` and nothing in this repository overrode it, so
`actions/checkout` materialised the patch with CRLF. `\r` is an ECMAScript
line terminator, so the `$`-anchored `diff --git` header regex in
`tools/chromium/lib/patch.mjs` cannot match such a line, and the parser reported
`unexpected content before first file header`.

Checks that keep it that way:

| Check                                                        | Where                                |
| ------------------------------------------------------------ | ------------------------------------ |
| Patch bytes are LF with no BOM, and the digest still matches | `verify-patches` (offline, every PR) |
| `.gitattributes` still pins `*.patch` to no conversion       | `tools/ci/check-line-endings.mjs`    |
| A `core.autocrlf=true` checkout still yields LF patch bytes  | `tests/tools/line-endings.test.mjs`  |

Chromium protects its own tree the same way (`*.gn text eol=lf`,
`*.cc text eol=lf`, … in its `.gitattributes`); `tools/gritsettings/resource_ids.spec`
is one of the few patched paths Chromium does not list, which is why the patch
must be LF rather than relying on the target tree's settings.

## Update procedure

Never merge a Chromium update directly into `main`.

```
1. DETECT      tools/ci/workflows/chromium-update-watch.yml (daily) or
               node tools/chromium/cli.mjs check-updates
               -> opens/updates an issue titled
                  "chore(chromium): evaluate update to <version>"
2. PLAN        Read the issue. Decide: adopt the current milestone's newer
               patch level (security) or jump milestones (features + risk).
3. RE-PIN      Edit config/chromium_version.json: version, milestone, revision,
               pinnedAt, and any pinRationale change. Update patchSet.baseRevision
               and patchSet.version.
4. REGENERATE  node tools/chromium/cli.mjs generate-version
               node tools/chromium/cli.mjs generate-patch
               (the generator fails loudly if an anchor moved - that is the
               signal a human must rebase the edit by hand)
5. VERIFY      node tools/chromium/cli.mjs verify-patches --online
               Both the pre-image and post-image digests must match.
6. BUILD       Dispatch .github/workflows/chromium-build.yml on a configured
               GitHub-hosted larger runner. Run targeted validation before full,
               and attach the build summary and logs to the issue.
7. DOCUMENT    Update docs/FORK-DELTA.md (numbers come from
               `node tools/chromium/cli.mjs fork-delta --json`).
8. MERGE       Maintainer review and merge. Security updates take priority over
               feature work, but are still verified - an unverified browser
               update is itself a security risk.
```

### Rebasing an edit that moved

If the generator reports `anchor not found in <file>`, upstream changed those
lines. Fix it in `tools/chromium/lib/upstream-edits.mjs`, not in the patch:

1. open the file at the new revision and find the equivalent location;
2. update `find` so it is unique (`grep -c` the string — the generator also
   rejects ambiguous anchors);
3. re-run `generate-patch` and `verify-patches --online`.

## Release channels

| Channel | Chromium pin              | Notes                                               |
| ------- | ------------------------- | --------------------------------------------------- |
| Nightly | may track dev/canary      | Experimental; never published as a supported build. |
| Beta    | current beta milestone    | Feature preview, security-verified.                 |
| Stable  | latest stable patch level | Default. Security updates land here first.          |

Channel definitions and artifact rules: [RELEASE.md](RELEASE.md).

## What we do not do

- No moving-ref builds, ever. A build is reproducible from the pin.
- No automatic merges of Chromium updates.
- No rebasing public history: patches are regenerated forward-only.
- No patching of Chromium security mechanisms to make a feature easier
  (see `SECURITY.md`).
