---
"@jagreehal/sandbox-node": patch
---

Don't sandbox global installs — they're host tooling (all package managers).

`npm install -g <pkg>` (and `pnpm add -g`, `bun add -g`, `--global`, `--location=global`, plus
yarn classic's `yarn global add`) routed through the path wrappers ran inside the ephemeral
container, so nothing landed on the host — a silent no-op that looked like a successful global install.

- The path wrappers (zsh/bash/fish/pwsh) now pass any global install straight through to the real
  package manager. `PATH_WRAPPER_VERSION` is bumped so `sandbox path status` flags existing blocks
  as outdated — re-run `sandbox path install` to update.
- As defense in depth, `sandbox <pm> … -g` (or `yarn global add …`) invoked directly now refuses with
  guidance (`command npm install -g …`) instead of doing a useless in-container install. Detection
  covers the flag form (npm/pnpm/bun) and yarn classic's `global` subcommand.
