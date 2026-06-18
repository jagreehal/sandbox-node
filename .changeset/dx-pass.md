---
'@jagreehal/sandbox-node': minor
---

DX pass: complete the package-manager verb surface, add `sandbox check`, and an `off` escape hatch.

**Contained dependency removal — the missing peer of `add`.** `npm uninstall` / `pnpm remove` /
`yarn remove` / `bun rm` (and aliases `rm`/`un`) now route through the sandbox as a deliberate,
write-class manifest change, so the removed package's `preuninstall`/`postuninstall` scripts run in
the throwaway box instead of against your real home dir. Removal fetches nothing new, so there's no
supply-chain surface to gate. Previously these fell through to the generic `run` model and, once
`sandbox path install` was active, bare `npm uninstall` ran on the host while `npm install` was
sandboxed. The drop-a-dep verbs are now mirrored across the router, the shell wrappers, the agent
`PreToolUse` hook, and tab-completion, with a new explicit `sandbox remove <pkg...>` command.

Two more completeness wins:

- **`sandbox x <tool>`** — an `npx`/`bunx` muscle-memory shorthand (`sandbox x vite`), PM-aware (bun
  projects get `bunx`) and local-first.
- **`dedupe` is now contained correctly** — `npm/pnpm/yarn dedupe` (and `npm ddp`) re-resolve against
  the registry, so they run install-class with registry egress instead of falling through to a
  no-network `run` that couldn't re-resolve.

**`sandbox check` — audit packages before you install them.** An npq-style review pass with **no
container and no Docker**: it only queries the registry and the OSV advisory DB.

- `sandbox check express lodash@4` — bare names, the friendly common case.
- `sandbox check` — the whole project: the root manifest **and every workspace `package.json`** in a
  monorepo, deduped (local `workspace:`/`file:` deps are skipped).
- `sandbox check ./apps/web/package.json` — the deps in a specific manifest; a `package.json` is read
  workspace-aware, and relative paths resolve from your current directory.
- `sandbox check npm install x` — a full command form.

It always queries OSV, so a bare `check` actually checks. Blocks on malware/known-bad; the usual
flags (`--min-release-age`, `--fail-on-advisory`, `--fail-on-risk`) tighten it for CI. `preflight` is
the command-mirroring sibling (and now also always queries OSV).

**Turn containment off for a trusted repo.** A new top-level `off` config field (default `false`):
when set, every operation command runs straight on the host, exactly as if `sandbox` weren't in front
of it. Set it for the whole team in `sandbox.config.json`, or just for yourself in
`sandbox.config.local.json`, so a globally-wired `sandbox path install` stops sandboxing there. The
env var `SANDBOX_OFF=1` now does the same for the CLI itself (previously only the shell wrappers
honored it), and **`sandbox off` / `sandbox on`** toggle the local override in one keystroke.
Sandbox-only commands (`check`, `doctor`, `init`, `verify`, …) keep working regardless. As a
first-class security control, `off` rides the existing guardrails: enabling it from a personal layer
fires the loudest "loosen loudly" warning, and `sandbox off` ensures the local override is git-ignored
so a containment disable can't be committed for the whole team.

**Polish.** `sandbox doctor` now prints a one-line verdict (an all-clear run names the next two
commands; a failing run counts what needs attention), and the README is trimmed to a tight intro with
the full reference moved to `docs/reference.md`.
