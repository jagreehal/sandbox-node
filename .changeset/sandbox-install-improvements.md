---
"@jagreehal/sandbox-node": minor
---

Sandbox install reliability, image caching, and build-script approval.

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
