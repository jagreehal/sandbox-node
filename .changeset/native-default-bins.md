---
"@jagreehal/sandbox-node": major
---

Vetted-and-contained by default, with a clearer write path and a happy IDE.

## One mode per project (the model)

`node_modules` is in exactly one mode at a time: local (a host-native tree from your own package manager) or container (a Linux tree built by a contained install), never both and never auto-reconciled. See `docs/rfc-native-default.md` for the full model.

**The default write path is `sandbox install`, `sandbox add <pkg>`, `sandbox update`.** Sandbox auto-detects your package manager (npm/pnpm/yarn/bun) and mirrors the verb, vets the target versions before any byte is fetched, then runs the install in a throwaway container with no host credentials, default-deny egress, lifecycle scripts contained, and `--cap-drop ALL`. To review a package without installing, `sandbox check <pkg>` (no Docker).

Before every contained write, sandbox prints one orienting line, `pnpm · container-built deps · contained` (package manager, project mode, containment), so you always know which tree you are touching. It stays one line; findings stay loud.

**Expert: per-PM binaries.** `sandbox-npm`/`sandbox-pnpm`/`sandbox-yarn`/`sandbox-bun`/`sandbox-npx`/`sandbox-bunx` and the terse aliases `snpm`/`spnpm`/`syarn`/`sbun`/`snpx`/`sbunx` are muscle-memory shortcuts for the same contained path. `spnpm add zod` is exactly `sandbox pnpm add zod`. They never shadow your real package manager; you opt in by typing the prefix. pnpm/yarn run through Corepack, so a host with Node but no global PM shim still works.

**BREAKING: `--sandbox`, the native-install path, and `sandbox materialize` are removed.** The previous direction (`sandbox-<pm>` installs natively on the host by default, `--sandbox` to contain, `sandbox materialize` to rebuild a host tree) is gone: it made the gates a boundary only on opt-in, and `materialize` was a fragile reconciliation step. The default path is now contained, so the "gates are heuristics, not a boundary" caveat no longer applies. For a host-native tree your IDE loads, run your own package manager (`pnpm install`); for containment and a happy IDE together, use `sandbox devcontainer init`.

**BREAKING: `sandbox path install` is removed.** The shell-function takeover that shadowed bare `npm`/`pnpm`/`yarn`/`bun` is gone. Use the `sandbox-<pm>` / `s<pm>` binaries, which come on PATH with the install and never shadow the real tool. If you previously ran `sandbox path install`, delete the `# >>> sandbox path` block from your shell rc by hand.

**Cross-mode safety.** Before a contained install rebuilds `node_modules`, if the existing tree looks host-native sandbox warns and, on a TTY, asks you to confirm the switch, so a Linux tree your IDE can't load never silently replaces a working local one. The signal is read live from the tree, not a written marker, so it can't go stale after a later host install.

**`sandbox devcontainer init`** mounts `node_modules` as a named Docker volume (not part of the bind-mounted source) and installs into it on container create: the path that keeps the full container boundary AND a happy IDE. When the egress firewall is on, it is applied before the create-time install so that install is itself contained.

## Safe install by default

`sandbox add <pkg>` does the safe thing and gets out of your way: when the version it would install is freshly published (inside the supply-chain worm window) and an older release already predates the window, sandbox installs that older release and pins it exact in the right manifest, then prints what it did and how to override (`--allow-recent <pkg>`, or `install.safeInstall: false`). The scope is freshness only: malware, typosquats, and CVE advisories are handled upstream by the gate engine, not by this swap. New config: `install.safeInstall` (default `true`) and `install.pinExact` (default `false`). A substituted version is always pinned exact.

## Source-write tripwire

The source tree stays writable during an install by design (a package manager needs a writable root), the one surface NOT protected by default. That residual is now visible: an install that changes project files outside dependency output is recorded in the audit log (`SANDBOX_AUDIT_LOG`) as an `install.source-write` event, alongside `egress.denied` / `canary.exfil`. `--fail-on-source-writes` (config `install.failOnSourceWrites`, default `false`; on by default in the `strict` preset) fails an otherwise-clean install that touched your source tree, so CI or an agent notices and reverts. This is detection after the fact, not prevention: review with `git diff`, revert with `git checkout`.

## Sharper risk-hint output

- **Worst-first ordering.** Findings lead with the error-level packages (typosquat, dropped provenance, malware-window publishes) above the warnings, so the most serious finding can't land buried mid-list.
- **Bins stop being noise.** A package adding a command-line binary is the boundary doing its job, so it no longer counts toward "N things worth a look" and a package whose only signal is a bin stays silent. The bin still shows as a sub-line next to a real finding, and every hint remains in `--json`.
- **Freshness hints offer an older release.** A freshly-published version points at the newest release that predates the worm window, with a copy-pasteable pin, framed as age, never as safety.
