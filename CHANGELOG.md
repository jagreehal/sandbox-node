# @jagreehal/sandbox-node

## 0.6.0

### Minor Changes

- cf39ae9: Bake the project's pinned package manager into the image at build time.

  The bundled image pre-activates pnpm 9.15.0 / yarn 1.22.22. A project that pins a
  different version via package.json `packageManager` (e.g. `pnpm@11.5.3`) previously made
  corepack try to download that version at run time, which fails behind the egress proxy
  (corepack doesn't route through it) and in no-network phases — so `sandbox pnpm install`
  broke for most modern pnpm/yarn repos.

  `resolveBuildSpec` now reads the project's `packageManager` field and, when it differs from
  the baked version, prepends a `corepack prepare <pinned> --activate` step (run during the
  build, where the network is available; the integrity hash is passed through so corepack
  verifies it). npm/bun and already-baked versions add no step.

  New exports: `parsePackageManagerField` (package-manager), `corepackPrepareStep` and
  `BAKED_COREPACK` (image).

## 0.5.1

### Patch Changes

- 06c0524: Add several security-focused checks and evidence tools around the sandbox boundary.

  - Add `sandbox secrets` for offline committed-secret scanning, and allow `sandbox verify --secrets`
    to fail the boundary gate when credentials are found.
  - Add local known-bad package blocking via `sandbox.advisories.json` and cached malware feeds
    managed by `sandbox feeds <update|list>`, and apply those checks to preflight, scan, delta, and
    upgrade flows.
  - Add canary honeytokens for allowlisted installs, plus `sandbox demo` to run real containment
    scenarios against the live sandbox.
  - Add signed verify receipts, key generation, and audit-log verification with
    `sandbox verify --sign`, `sandbox verify-receipt`, `sandbox keygen`, and
    `sandbox audit verify`.
  - Expand `sandbox doctor` to flag known runtime container-escape issues and end-of-life Node
    versions in the sandbox image.

## 0.5.0

### Minor Changes

- ba226f7: New `sandbox upgrade` command, shell-wrapper wiring, and onboarding polish.

  **`sandbox upgrade`** — config-driven safe dependency upgrades. Wraps `ncu` to bump dependencies only within ranges you opt into, so routine updates stay inside the sandbox boundary. Honors per-package cooldown exemptions and writes exactly what was gated, so you can see why an upgrade was held back.

  **Shell wrappers** — `sandbox setup` now offers to wire shell wrappers so a bare `npm install` routes through the sandbox automatically. No need to remember the `sandbox` prefix; opt in during setup.

  **Onboarding & docs** — clearer onboarding tips, more honest build messaging, and hot-reload docs that describe what actually works rather than overselling it.

## 0.4.0

### Minor Changes

- e40fe9f: Supply-chain lifecycle gating, packaging fix, and CLI polish.

  **Fix:** ship `net-guard.sh` in the npm package. The published Dockerfile does `COPY net-guard.sh`, but the file was missing from `files`, so a fresh `sandbox npm install` failed at image build with `"/net-guard.sh": not found`. Added a `test/packaging.test.ts` regression guard that asserts every Dockerfile `COPY` source is published.

  **`sandbox scan`** — retroactive malware sweep. Re-queries OSV for the versions in the committed lockfile and exits non-zero if any installed package is now flagged as malware (`MAL-…`). Closes the time gap install-time gating can't cover. No container needed; cheap to run nightly in CI. `sandbox verify --scan` folds it into the boundary gate.

  **`sandbox delta [--base <ref>]`** — gate only what a PR changes. Diffs the lockfile against the merge target (default `origin/main`, or `--base-lockfile <path>`) and runs the release-age, malware, and deprecation gates over just the added/bumped versions. Fails safe (gates everything) if the base lockfile can't be read.

  **`sandbox completion <shell>`** — tab-completion scripts for zsh, bash, and fish (commands, globals, and `--preset` / `--backend` / `--risk`).

  **First-run build feedback** — clear progress during the one-time image build (clack spinner on a TTY, plain stderr lines in CI). Distinguishes absent vs stale images when config changed since the last build.

  **`sandbox doctor` improvements** — reports whether the image is absent, current, or stale (out of date vs config); optional `--fix` auto-rebuilds a missing or stale image.

  Both scan/delta reuse the existing OSV/registry engine, honor `--min-release-age` / `--fail-on-advisory` / `--json`, and expose `parseLockfilePackages` for parsing a lockfile from text (e.g. a git blob).

## 0.3.0

### Minor Changes

- ea5e1cb: Add guided egress remediation, a warm package-manager cache, native-module onboarding, host classification, and `sandbox path` shell wrappers.

  - **Guided egress (`--interactive`)**: when default-deny blocks a host, prompt (TTY-only) to allow once, save for the team (`sandbox.config.json`), save for yourself (`sandbox.config.local.json`), or retry once with full network — with each blocked host annotated (registry / native-build / unknown).
  - **Warm cache (`install.cache`, on by default)**: persist each package manager's content-addressed download store in a named volume across runs; also applied to the fetch-and-run runners (`npx`/`bunx`/`pnpx`/`<pm> dlx`). Set `install.cache: false` for a cold, per-run-isolated install.
  - **Native-module onboarding**: `sandbox init`/`setup` now pre-allow `nodejs.org` when the project has node-gyp/prebuild indicators, so the common first-run native build doesn't fail on egress.
  - **`sandbox path [install|uninstall|status|print]`**: install shell wrappers (zsh/bash/fish/pwsh) so a bare `npm/pnpm/yarn/bun install` and the fetch-and-run commands (`npx`, `bunx`, `pnpx`, `<pm> dlx`, `<pm> exec`) route through `sandbox` automatically — the human equivalent of the agent hook. Bypass with `command npm …` or `SANDBOX_OFF=1`.
  - **Host classification** exported from the library (`classifyHost`, `describeBlockedHosts`) for reuse.
  - **Fix**: `sandbox allow` (and the team-save path) now write only the committed project layer, so a personal `*.local.json` / user-global override can no longer be baked into the shared config.
