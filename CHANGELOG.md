# @jagreehal/sandbox-node

## 1.4.1

### Patch Changes

- e3d0d67: Don't sandbox global installs — they're host tooling (all package managers).

  `npm install -g <pkg>` (and `pnpm add -g`, `bun add -g`, `--global`, `--location=global`, plus
  yarn classic's `yarn global add`) routed through the path wrappers ran inside the ephemeral
  container, so nothing landed on the host — a silent no-op that looked like a successful global install.

  - The path wrappers (zsh/bash/fish/pwsh) now pass any global install straight through to the real
    package manager. `PATH_WRAPPER_VERSION` is bumped so `sandbox path status` flags existing blocks
    as outdated — re-run `sandbox path install` to update.
  - As defense in depth, `sandbox <pm> … -g` (or `yarn global add …`) invoked directly now refuses with
    guidance (`command npm install -g …`) instead of doing a useless in-container install. Detection
    covers the flag form (npm/pnpm/bun) and yarn classic's `global` subcommand.

- e3d0d67: Add a version command/flag: `sandbox version`, `sandbox -v`, and `sandbox --version` print the
  installed sandbox version (previously `--version` errored with "unknown command").

## 1.4.0

### Minor Changes

- 612ad8c: Sandbox install reliability, image caching, and build-script approval.

  **Per-fingerprint image tags** — Tag the managed sandbox image per build fingerprint instead of one shared `:latest`. Every project previously shared the `node-install-sandbox:latest` tag, even though its contents depend on per-project config (notably the baked `packageManager` version). Switching between projects with different package managers rebuilt and re-tagged that one image back and forth — which also flipped the baked pnpm version, made a project's `node_modules` look foreign, and triggered a (no-TTY-fatal) reinstall purge. The managed image now resolves to `node-install-sandbox:<fingerprint>`, so projects with different build configs each keep their own cached image — no cross-project clobbering, stable reuse, and no spurious purges. Custom/explicit `config.image` values are still used verbatim.

  **Build approval** — Resolve pnpm's ignored dependency build scripts without hand-editing YAML. When pnpm refuses an unknown install script it records the package under `allowBuilds:` in `pnpm-workspace.yaml` as undecided and exits non-zero — previously you had to hand-edit two config blocks to continue. Now a sandboxed install detects the pending decision and:

  - **prompts on a TTY** (multiselect, all selected by default), writes the decision to both `allowBuilds` and `onlyBuiltDependencies`, and re-runs the install so the scripts build;
  - **prints a ready-to-run `sandbox approve-builds <pkg…>`** line and keeps the safe non-zero exit when there's no TTY (CI/agents);
  - **approves everything with `--allow-all-builds`** for non-interactive runs.

  Adds the `sandbox approve-builds [pkg…]` command (`--deny` records the opposite decision) and the `--allow-all-builds` flag. Build approval is currently pnpm-only.

  **No-TTY install fix** — Fix installs aborting (and never writing a lockfile) in the no-TTY container. The container env hard-set `CI=''`, so pnpm assumed it could prompt and aborted with `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` whenever it needed to purge `node_modules` (common after the baked package-manager version changed) — leaving the install failed and the lockfile unwritten. Install-class plans (`install`/`add`/`update`/`audit fix`) now run with `CI=1`, which is correct for a non-interactive container. Interactive `run`/`dev` plans keep `CI=''` so a real TTY can still drive prompts.

  **Quieter install output** —

  - `pnpm-workspace.yaml` edits are now treated as expected install writes. pnpm legitimately records build-script approvals (`allowBuilds`) and release-age exclusions there during an install, so the "changed N project file(s) outside dependency output paths" warning no longer fires on its own benign edits (which trained people to ignore the warning that matters).
  - The host-incompatible-native-packages notice is now a single calm `info` line with the fix inline, instead of a `warn` + `info` pair that repeated on every install.

## 1.3.0

### Minor Changes

- 575d434: Enriched advisory scan with severity, triage, fix hints, and agent output

  **Richer OSV data.** Advisory lookups now parse CVSS severity, summaries, and fixed
  versions from OSV. `sandbox scan` groups hits by severity (critical/high/moderate/low),
  labels each package as direct or transitive, and prints actionable fix lines — `sandbox
<pm> update` for direct deps, `overrides`/`resolutions`/`pnpm.overrides` for transitive
  ones.

  **Advisory triage.** Add a `.sandbox-audit-ignore` file to suppress accepted findings:
  `<package> [<advisory-id>] [-- <reason>]` per line. Triaged hits are reported separately
  and excluded from severity counts and blocking logic.

  **Agent-friendly scan output.** `--format agent` (alias `--format ai`) emits a compact,
  line-oriented report for automation — severity totals, per-package advisories, and fix
  hints without JSON scaffolding.

  **Package manager detection.** `packageManager` resolution also reads the `devEngines`
  field when the standard `packageManager` key is absent.

## 1.2.0

### Minor Changes

- 69df2d3: Warn when a contained install leaves host-incompatible native dependencies

  Installs run inside the Linux sandbox, so package managers fetch the Linux build
  of platform-specific native optional deps (`@rollup/rollup-linux-*`,
  `@esbuild/linux-*`, `@img/sharp-linux-*`, …). On a macOS or Windows host those
  binaries can't load, and host-side tools (`vite`, `vitest`, `tsx`) fail with a
  cryptic _Cannot find module `@rollup/rollup-darwin-arm64`_.

  After an install, `sandbox` now scans `node_modules` for packages whose declared
  `os`/`cpu` excludes the host and warns with the offending package names, pointing
  at the fix (run tools through `sandbox`, or do a plain host install for native
  host-side dev). The check is host-relative and self-gating — it stays silent when
  the install platform matches the host (e.g. a Linux host) — and only inspects
  packages whose name carries a platform token, so it adds no measurable cost.

## 1.1.1

### Patch Changes

- c0dd887: Tightens CLI behavior and project guardrails.

  **Safer one-off networking semantics.** `--full-network` now widens install/run networking without
  implicitly turning on dev-port publishing for non-dev commands. Port forwarding stays tied to dev-mode
  runs instead of being enabled as a side effect of broader network access.

  **Machine-readable build output.** `sandbox build --json` now emits the resolved build spec so
  automation can inspect the image build plan without scraping human-oriented logs.

  **Maintainer guardrails.** The repo test path now includes import-cycle detection, committed pnpm
  policy verification, and release-metadata checks, with integration coverage for those checks.

## 1.1.0

### Minor Changes

- eaac81f: Native package scripts, monorepo task runners, smarter egress defaults, and an update notice.

  **Run package.json scripts natively.** `sandbox dev`, `sandbox test`, `sandbox <script>` route any
  script through your package manager's native syntax (auto-detected from `package.json#packageManager`
  then the lockfile). `sandbox dev` runs the first of `dev`/`start`/`serve` with dev-mode networking.
  Built-in commands win on a name clash; force a colliding script with `sandbox script <name>`. The
  monorepo task runners route directly too: `sandbox turbo …` and `sandbox nx …`.

  **Smarter, still-minimal egress.** Detection prefers the `packageManager` field (Corepack semantics)
  over the lockfile. The effective allowlist is package-manager aware — yarn classic adds its own
  registry (`yarnpkg.com`) so a `yarn install` works out of the box, while the committed config stays
  minimal. New `--allow-build-hosts` opts into the curated native-build/release hosts (node-gyp,
  Prisma, Playwright, Cypress, Puppeteer, Electron, GitHub releases) for one run — still a default-deny
  allowlist, not full network. `sandbox init` can pre-allow opt-in egress bundles (host groups):
  `build-tools` plus narrow cloud groups (`vercel`/`cloudflare`/`supabase`/`aws`), scoped to specific
  control-plane hosts only — never provider-wide wildcards, and `aws` is STS-auth-only.

  **Update notice.** On an interactive run, `sandbox` prints a "new version available" notice (to
  stderr, from a once-a-day cached background check). Off automatically for `--json`/non-TTY/CI; disable
  with `--no-update-check`, `NO_UPDATE_NOTIFIER`, or `updateCheck: false`. No new dependencies.

## 1.0.0

### Major Changes

- ad17287: Add `runCode(code, options)` — a programmatic API for executing untrusted / AI-generated JavaScript or TypeScript inside the sandbox and getting its captured output back. Unlike `vm.runInThisContext` or in-process "sandbox" packages (which Node's own docs warn are not security boundaries), code runs in a throwaway container with no host credentials and no network by default, and a real wall-clock timeout is enforced by a separate process (the container's init), so a busy loop can't block or outrun it the way it defeats an in-process `vm` timeout. Returns `{ stdout, stderr, exitCode, timedOut, durationMs, deniedHosts }`. TypeScript runs via Node's built-in type stripping (no `tsx`, no network). Supports `network: 'allowlist'` egress, extra `files`, and `env`.

  Internally this adds output capture to the canonical run layer: `execute(plan, backend, { capture: true })` now returns `stdout`/`stderr` in its `ExecuteResult`.

  **BREAKING:** the `ContainerBackend` interface gained a required `runPlanCaptured(plan, override?)` method. Anyone who implements `ContainerBackend` themselves (rather than using `createBackend`) must add it — it runs the plan capturing stdout/stderr, the sibling of `runPlan` which inherits stdio. Consumers using `createBackend('docker' | 'podman')` are unaffected.

## 0.6.2

### Patch Changes

- 4b6496b: Don't flag nested workspace `node_modules` as tampering.

  The post-install integrity check skipped only the root `node_modules/`, so a
  workspace/monorepo install — which writes into per-package `node_modules`
  (`app/node_modules`, `packages/*/node_modules`, …) — was reported as "changed N project
  file(s) outside dependency output paths". `node_modules` at any depth is now skipped, while
  paths that merely mention it (e.g. `src/node_modules_loader.ts`) are still checked.

## 0.6.1

### Patch Changes

- 4f74b23: Stop flagging pnpm's project-local store as tampering.

  pnpm relocates its content store next to `node_modules` (`.pnpm-store/`) when its
  configured store is on a different device than the project — always the case for a
  bind-mounted workspace. An install legitimately writes thousands of files there, which the
  post-install check reported as "changed N project file(s) outside dependency output paths".

  `.pnpm-store/` is now treated as an expected install artifact. When pnpm creates one, the
  run prints a short note that `node_modules` is tied to that in-project store, so running
  pnpm directly on the host rebuilds it against the host store — run later commands through
  `sandbox` to reuse it as-is. Adds `wroteProjectLocalPnpmStore`.

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
