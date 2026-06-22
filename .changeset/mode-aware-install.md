---
"@jagreehal/sandbox-node": major
---

Mode-aware install: install in the project's one mode (native by default, contained when the tree
already is).

`sandbox install` / `sandbox add <pkg>` / `sandbox update` (and the per-PM binaries `spnpm`, `snpm`,
`syarn`, `sbun`) vet, then install **mode-aware**:

- a host-native or fresh project (no `node_modules`, or no native-platform signal) installs
  **natively on the host**, so your IDE and tools load the result.
- a project whose `node_modules` is a container (Linux) build installs **contained**.

The explicit `sandbox <pm>` form (`sandbox pnpm add zod`) always containerizes: the force-container
boundary on demand. `sandbox check` vets without a container.

Each write prints one action line, native
(`installing natively on the host with pnpm (host-native deps; gates ran, no container boundary)`) or
contained
(`installing in a throwaway container with pnpm (container-built deps; no host creds, default-deny egress)`),
and names its operation (`removing …`, `adding …`). A native install runs lifecycle scripts on the
host, so the gates are heuristics, not a boundary; the container is the boundary. Native honours
`--frozen` and the gate engine's safe-install pins, like the contained path.

pnpm build-script approval (`--allow-all-builds`, the interactive prompt, `sandbox approve-builds`)
applies on both the native and contained paths, keyed off the package manager in the command (so
`sandbox npm install` in a pnpm repo skips pnpm build-approval). `sandbox approve-builds` and
`sandbox upgrade --write` install through the same mode-aware path.

BREAKING: on a fresh or host-native project the friendly verbs and per-PM binaries install natively
(gates only, no container boundary). Use `sandbox <pm>` or `sandbox devcontainer init` for the
container boundary.
