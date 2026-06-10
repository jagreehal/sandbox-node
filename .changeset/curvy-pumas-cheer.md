---
"@jagreehal/sandbox-node": minor
---

Add guided egress remediation, a warm package-manager cache, native-module onboarding, host classification, and `sandbox path` shell wrappers.

- **Guided egress (`--interactive`)**: when default-deny blocks a host, prompt (TTY-only) to allow once, save for the team (`sandbox.config.json`), save for yourself (`sandbox.config.local.json`), or retry once with full network — with each blocked host annotated (registry / native-build / unknown).
- **Warm cache (`install.cache`, on by default)**: persist each package manager's content-addressed download store in a named volume across runs; also applied to the fetch-and-run runners (`npx`/`bunx`/`pnpx`/`<pm> dlx`). Set `install.cache: false` for a cold, per-run-isolated install.
- **Native-module onboarding**: `sandbox init`/`setup` now pre-allow `nodejs.org` when the project has node-gyp/prebuild indicators, so the common first-run native build doesn't fail on egress.
- **`sandbox path [install|uninstall|status|print]`**: install shell wrappers (zsh/bash/fish/pwsh) so a bare `npm/pnpm/yarn/bun install` and the fetch-and-run commands (`npx`, `bunx`, `pnpx`, `<pm> dlx`, `<pm> exec`) route through `sandbox` automatically — the human equivalent of the agent hook. Bypass with `command npm …` or `SANDBOX_OFF=1`.
- **Host classification** exported from the library (`classifyHost`, `describeBlockedHosts`) for reuse.
- **Fix**: `sandbox allow` (and the team-save path) now write only the committed project layer, so a personal `*.local.json` / user-global override can no longer be baked into the shared config.
