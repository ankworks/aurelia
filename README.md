# Aurelia Browser

> ## ⚠️ Early development — not ready for daily use
>
> There is **no released build**. Nothing in this repository has been compiled
> into a working browser yet. "Aurelia" is a **development codename** — a naming
> and trademark review is outstanding (see [docs/NAMING.md](docs/NAMING.md)).
>
> This README describes what the project is building and states honestly what
> exists today. If a feature is listed as _Planned_, it does not work. Do not
> install anything expecting a browser.

A free and open-source, privacy-oriented Chromium browser for people and
organizations — a real Chromium fork, not an Electron shell or a WebView wrapper.

**Priorities, in order:** security · privacy · performance · excellent UX ·
customization · web compatibility · extension compatibility · enterprise
manageability.

**Deliberately not in the product:** an AI assistant, chatbot, LLM sidebar,
autonomous browsing agent, or VPN. Translation is supported and is not allowed
to become an assistant.

## Status

Current state: **M0 — repository and Chromium architecture.** The Chromium pin,
the overlay/patch mechanism and the verification tooling work and are tested; the
browser itself does not exist yet. Full item-by-item detail:
[docs/PROJECT-STATUS.md](docs/PROJECT-STATUS.md).

| Area                                                                     | State                                                                     |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| Chromium pin (exact revision, verified)                                  | **TESTED** — `155.0.8059.40` @ `cfaadc5a132d` (stable channel)            |
| Overlay + patch mechanism (26 inserted lines in 8 upstream files)        | **TESTED** — verified against the pinned upstream revision                |
| Reproducible checkout tooling                                            | **IMPLEMENTED** — never run against a real checkout                       |
| `chrome://aurelia` WebUI (C++ + TS/CSS)                                  | **SCAFFOLDED** — written, not compiled                                    |
| GN integration                                                           | **SCAFFOLDED** — follows upstream's `webui_gallery` pattern; not compiled |
| Fast CI, supply-chain and secret checks                                  | **TESTED**                                                                |
| Privacy policies (omnibox, secure DNS, tracking parameters, preferences) | **IMPLEMENTED** — unit-tested, not wired into a browser                   |
| Browser shell (tabs, omnibox UI, command palette)                        | **NOT STARTED**                                                           |
| Ad/tracker blocking, sync, enterprise, installer, translation            | **NOT STARTED** / **SCAFFOLDED** (design + threat models only)            |

Status vocabulary: NOT STARTED · SCAFFOLDED · IMPLEMENTED · INTEGRATED ·
TESTED · VERIFIED. Nothing is called complete below IMPLEMENTED+TESTED, and no
browser feature is claimed without runtime evidence.

## Platforms

| Platform                      | Status                                                                                                                 |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Windows 10 / 11 (x64)         | Primary target — **no build yet**                                                                                      |
| Windows 11 ARM64              | Planned, once the toolchain path is verified                                                                           |
| macOS (Intel / Apple Silicon) | Architecture prepared; blocked on signing/notarisation (no Apple Developer account) and does not block Windows         |
| Linux                         | Later                                                                                                                  |
| Android                       | Later (architected for; not started)                                                                                   |
| iOS / iPadOS                  | Later — Apple's engine and distribution rules are respected; Blink is never promised where platform policy prevents it |

## Privacy principles

1. **No telemetry.** No analytics, no behavioral data, no "engagement" pings.
   There is no Aurelia telemetry endpoint.
2. **Your history stays yours.** Browsing history and visited URLs are never
   sent to Aurelia servers.
3. **Optional everything.** No account is required; sync is off by default;
   crash reporting is off by default.
4. **Disclose, then let you decide.** Encrypted DNS defaults to a NextDNS
   profile; Safe Browsing lookups go to Google in standard mode. Both are
   documented in [PRIVACY.md](PRIVACY.md) and switchable.
5. **No unverifiable claims.** The project does not claim "100% privacy" or that
   remote safety checks are local.

## Feature overview

Planned capabilities, so the direction is legible. Nothing below is a claim that
it works today.

- **Tabs & shell:** horizontal tabs by default, optional vertical tab rail,
  pinned tabs, tab groups, split view with up to 3 panes, persistent workspaces,
  multiple profiles, private browsing, session restore you control.
- **Navigation:** omnibox with safe input classification, command palette
  (Ctrl+K / Cmd+K), keyboard-first operation.
- **Data:** bookmarks, history, downloads, passwords (OS-protected), autofill,
  reader mode, PDF viewer, media controls, picture-in-picture, screenshots, QR
  generation, task manager, memory/battery saver.
- **Privacy:** built-in content blocker compatible with common filter lists
  (EasyList, EasyPrivacy, custom lists), per-site controls, blocked-request
  counts, encrypted DNS with fail-closed policy, tracking-parameter stripping,
  third-party cookie controls, Global Privacy Control, HTTPS-only mode, WebRTC
  privacy policy, High Privacy Mode.
- **Customization:** light/dark/system themes, accent colours, theme
  import/export, compact and focus modes, custom browser-UI CSS, opt-in
  per-site website CSS ([threat model](docs/threat-models/CUSTOM-CSS.md)).
- **Enterprise:** Chromium policy integration, managed bookmarks, URL and
  extension allow/blocklists, managed DNS/privacy policy, Windows Group Policy,
  MSI/PKG deployment, "managed by your organization" disclosure.
- **Sync (optional):** provider-abstracted, end-to-end encrypted, recovery key,
  verified account deletion.
- **Translation (optional):** provider-abstracted, opt-in, off by default,
  explicitly not an assistant.

## Building

You cannot build the browser in a small sandbox: Aurelia's conservative first-
build gate requires **8+ cores, 32 GB RAM and 150 GB free disk**. The manual
GitHub Actions workflow defaults to a safe `gn` validation level and blocks
standard runners before source sync; a configured GitHub-hosted larger runner
is needed to attempt Chromium validation. No Chromium compilation has run yet.

```bash
git clone https://github.com/ankworks/aurelia.git
cd aurelia
node tools/chromium/cli.mjs status          # what is pinned
node tools/chromium/cli.mjs verify-patches --online   # the delta still applies
```

Full instructions (including the required machine, GN args and the runtime smoke
test): [docs/BUILDING-CHROMIUM.md](docs/BUILDING-CHROMIUM.md). For working on
Aurelia's own code without a Chromium checkout, see
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

The minimum above is not lowered. Local and self-hosted compilation are
blocked; the only supported Chromium compile path is the manual GitHub-hosted
workflow. The former local Windows build instructions are retained as a retired
reference in [docs/LOCAL-WINDOWS-BUILD.md](docs/LOCAL-WINDOWS-BUILD.md).

## Repository layout

```
config/                 Chromium pin, patch-set version, update policy
chromium/overlay/       Aurelia files copied into a Chromium tree (added files)
chromium/patches/       The registration patch + metadata (reason, difficulty)
chromium/verification/  Pre/post-image digests for offline patch auditing
packages/core/          Pure, unit-tested policy code (omnibox, DNS, prefs)
packages/design-tokens/ One source of truth for the visual system
tools/chromium/         Pin, sync, overlay, patch, verify, smoke test
tools/ci/               CI policy, secret scanning, fast checks
docs/                   Architecture, roadmap, threat models, build guides
```

## Documentation

| Topic                            | Document                                                   |
| -------------------------------- | ---------------------------------------------------------- |
| What exists today                | [docs/PROJECT-STATUS.md](docs/PROJECT-STATUS.md)           |
| Architecture & principles        | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)               |
| Roadmap & milestones             | [docs/ROADMAP.md](docs/ROADMAP.md)                         |
| Chromium upstream strategy       | [docs/CHROMIUM-UPSTREAM.md](docs/CHROMIUM-UPSTREAM.md)     |
| How much we change Chromium      | [docs/FORK-DELTA.md](docs/FORK-DELTA.md)                   |
| Building                         | [docs/BUILDING-CHROMIUM.md](docs/BUILDING-CHROMIUM.md)     |
| Retired local Windows build path | [docs/LOCAL-WINDOWS-BUILD.md](docs/LOCAL-WINDOWS-BUILD.md) |
| Privacy (data flows)             | [PRIVACY.md](PRIVACY.md)                                   |
| Security & reporting             | [SECURITY.md](SECURITY.md)                                 |
| Threats                          | [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md)               |
| Testing                          | [docs/TESTING.md](docs/TESTING.md)                         |
| CI security                      | [docs/CI-SECURITY.md](docs/CI-SECURITY.md)                 |
| Release process                  | [docs/RELEASE.md](docs/RELEASE.md)                         |
| Contributing                     | [CONTRIBUTING.md](CONTRIBUTING.md)                         |

## Development warning

- **Unsigned builds only.** There is no code-signing certificate, so any future
  development build will be unsigned and labelled as such. The project does not
  ask you to bypass SmartScreen, and does not ship a "continue anyway" flow.
- **No stability promises.** Interfaces, preferences and file formats can change
  without migration until a Stable release exists.
- **No installer exists yet.** Anything calling itself "Aurelia Setup" today is
  not from this project.

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for the
workflow, commit conventions, the status vocabulary, and the rules that CI
enforces. Security-sensitive work requires a threat model and tests first.

## License

Aurelia's own code is **MPL-2.0** ([LICENSE](LICENSE)); upstream Chromium
remains **BSD-3-Clause**, and its notices are preserved. See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for why MPL-2.0 was chosen.

## Security

Report vulnerabilities privately — never in a public issue. See
[SECURITY.md](SECURITY.md).

<a href="https://www.star-history.com/#ankworks/aurelia&Date">
    <picture>
        <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=ankworks/aurelia&type=Date&theme=dark" />
        <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=ankworks/aurelia&type=Date" />
        <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=ankworks/aurelia&type=Date" />
    </picture>
</a>
