# RFC: one mode per project (gate-first, native-default, container on demand)

Status: accepted. Owner: Jag. This is the spine for the current product story: the everyday path
vets every dependency, installs natively on the host by default, and uses the container as an
explicit boundary when trust drops. `check` vets without installing, a project's `node_modules` is
in exactly one mode at a time, and `devcontainer init` gives you containment and a happy IDE
together.

> An earlier iteration of this pivot tried "vet by default, install natively on the host, container on
> `--sandbox`." It was abandoned: native install made the container a boundary only on an opt-in (the
> gates alone are heuristics), and the host-tree reconciliation step (`sandbox materialize`) was
> fragile (a no-op on a frozen pnpm tree, and a second place for the two trees to disagree). The model
> below replaces it. `--sandbox`, the native-install path, and `sandbox materialize` are all removed.

## The decision

sandbox-node has two jobs:

1. **Vet before fetch (the gate engine):** OSV malware advisories, your malware feeds + team
   advisories (hard block), typosquat/maintainer/provenance risk hints, the release-age worm window
   (with safe-install substitution + pinning), and deprecation.
2. **Contain the install (the boundary):** when you opt in, run the install in a throwaway Docker/Podman
   container, so lifecycle scripts never touch the host. No host credentials, default-deny egress,
   `--cap-drop ALL`.

So `spnpm add zod` vets, then installs natively on the host. `sandbox pnpm add zod` vets, then installs
contained. `sandbox check express` vets without a container (no Docker), and installs nothing: the
read-only review pass.

Because the default path is native, the honest line is stricter than the old contained-default story:
the default has **heuristic gates, not a boundary**. The one surface still NOT protected, even in the
container, is the writable source tree (a malicious install can edit `src/`; `--frozen` locks it).

## One mode per project

A project's `node_modules` is in exactly one mode at a time, never both and never auto-reconciled:

- **local:** a host-native tree built by the user's own package manager (`pnpm install`), so the IDE
  and host tools load native binaries and just work.
- **container:** a Linux tree built by a contained install (`spnpm install` / `sandbox <pm>`), so
  lifecycle scripts stayed in the box.

We detect the mode from the tree itself and warn on a cross-mode action instead of maintaining two
trees. The signal is the platform of the installed native packages, read live (not a written marker):
a host-native tree has native binaries built for the host, a container tree has Linux ones. A written
sentinel would survive a later host install and go stale (wrongly suppressing the warning); reading
the live tree can't.

- **local → container:** before a contained install clobbers a host-native tree with a Linux one the
  IDE can't load, we warn (and on a TTY ask to confirm the switch). Non-interactively (CI/agents) the
  warning is logged and the install proceeds. (On Linux there is no mismatch, so no warning.)
- **container → host tool:** a host tool loading a Linux tree is caught by the same native-deps
  platform check, which names the foreign-native packages and points at the options.

The decision is a pure function (`crossModeWarning` in `src/mode.ts`, fed the live host-native count
from `findHostNativePackages` in `src/native-deps.ts`), unit-tested per the repo's
`cli.ts`-stays-thin convention.

## The surface: `sandbox-<pm>` binaries

Muscle-memory binaries, no shell hijack:

```
sandbox-npm   sandbox-pnpm   sandbox-yarn   sandbox-bun   sandbox-npx   sandbox-bunx
(snpm)        (spnpm)        (syarn)        (sbun)        (snpx)        (sbunx)
```

`sandbox-pnpm add zod` (or `spnpm add zod`) is the exact keystrokes of `pnpm add zod`, just a clear
prefix that vets and contains. They are thin front-ends for `sandbox <pm>`, so they always
containerize. Your real `pnpm` is never shadowed; you opt in by typing the prefix.

- Install/add/update get the gates; run/exec/dlx just run (the same dispatch models as `sandbox <pm>`).
- For agents we keep enforcement: the `init --agent` PreToolUse hook rewrites a bare `pnpm install` to
  the sandbox form. Humans get explicit bins; agents get the hook. Nobody gets a silently-hijacked shell.
- **Bin identity.** A package-manager shim can re-exec us via `node <path>` and lose `argv[0]`, so the
  bin name alone is not reliable. Each bin is a tiny launcher in `bin/` that sets `SANDBOX_PM_BIN` to
  the leader before importing the CLI; `leaderForBin` (`src/native.ts`) is the fallback for running
  the bundle directly under a `sandbox-<pm>`-named symlink (dev/test).

### What happened to `sandbox path`

Removed entirely (no migration shim). `sandbox path install` wrote shell functions that shadowed
`npm/pnpm/yarn/bun` so bare commands routed through sandbox. That global takeover is the exact
behavior the product rejects. The `sandbox-<pm>` / `s<pm>` bins come on PATH with the npm install and
you opt in by typing them; nothing ever shadows your real package manager.

## The devcontainer: containment AND a happy IDE

The contained-install path gives you a real boundary, but on macOS/Windows it leaves a Linux
`node_modules` your host IDE can't load (that is the whole reason for one-mode-per-project). When you
want the full boundary AND the editor working at once, the answer is `sandbox devcontainer init`.

It mounts `node_modules` as a named Docker volume (not part of the bind-mounted source) and installs
into it on container create, so the editor (Dev Containers) and the deps both live in Linux: the
mismatch is gone by construction, and macOS/Windows file I/O stays fast (the hot path is a native
volume, not a gRPC-FUSE bind). When the egress firewall is on, it is applied before the create-time
install so that install is itself contained.

The load-bearing gotcha: a named volume mounts as root but `remoteUser` is `node`, so the
`postCreateCommand` must `sudo chown node:node node_modules` before installing or it fails with EACCES.

```jsonc
"mounts": ["source=${localWorkspaceFolderBasename}-node_modules,target=${containerWorkspaceFolder}/node_modules,type=volume"],
"postCreateCommand": "sudo chown node:node node_modules && corepack pnpm install"
```

So the product offers two shapes for two desires: the everyday `sandbox install` / `sandbox add` /
`sandbox update` path (vetted + native by default, with the explicit `sandbox <pm>` escape hatch when
you want the boundary), and the devcontainer (full boundary + IDE in one, for when you live in the project).

## "Better than npq" (the gate-engine deltas to keep sharp)

`sandbox check` is already a superset of npq's marshalls. What we lead with:

- **OSV** (open) instead of Snyk (no vendor key).
- **Hard block** on malware feeds + team advisories vs npq's warn-and-15s-auto-continue.
- **safe-install:** auto-substitute a fresh release for an aged one and pin exact, vs "we warned you."
- All four PMs auto-detected and mirrored.
- Signed receipts, hash-chained audit log, `scan`, `delta`, `secrets` for CI.
- And, unlike npq, every install carries the gate engine by default, with the container boundary one explicit keystroke away.

## Docs impact

README, `docs/reference.md`, the docs site, all skills, `src/setup.ts`, and AGENTS.md / CLAUDE.md all
describe the native-default model: gates first, host-native install by default, explicit `sandbox <pm>`
or devcontainer for the boundary, and `check` to review without Docker. No file ships with the old
contained-by-default or `materialize` framing.
