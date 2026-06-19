---
title: Quickstart
description: Install the sandbox CLI, run your first contained install, and wire it so a bare npm install routes through the box automatically.
---

You need a container runtime: Docker Desktop, OrbStack, Podman, or any Docker-compatible engine. That's the only dependency; the CLI builds its own images on first run. macOS and Linux are supported directly; on Windows, run inside WSL2.

## Try it once, no install

```bash
npx @jagreehal/sandbox-node@latest check lodash
```

`check` audits a package against the registry and the OSV advisory database and prints what it finds. It never starts a container and never installs anything, so it's the safest way to see the tool work.

## Install it

```bash
# as a dev dependency (recommended)
npm install -D @jagreehal/sandbox-node
```

That puts `sandbox` on your path. The first contained command builds the sandbox image (a one-time step, around 30 seconds); every run after that reuses it.

## Run your first contained install

Put `sandbox` in front of the command you already run:

```bash
sandbox npm install        # lifecycle scripts run in the box, not on your host
sandbox pnpm add zod       # add a dependency (saved exact by default)
sandbox npm uninstall left-pad
```

A clean install ends with one line confirming you were never exposed:

```
sandbox: ✓ done, ran in a throwaway sandbox, now deleted; it never had your credentials or home dir
```

## Stop typing the prefix

Tired of remembering `sandbox`? Wire shell wrappers so a bare `npm install` / `pnpm add` / `npx` routes through the box automatically:

```bash
sandbox path install     # undo any time with: sandbox path uninstall
```

This installs shell functions (zsh, bash, fish, pwsh) that send the install-class and fetch-and-run commands through sandbox, and leave read-only commands untouched. Bypass once with `command npm …`, or a whole shell with `SANDBOX_OFF=1`.

:::tip[One-button setup]
`sandbox setup` writes a config if you don't have one, checks your container runtime, builds the images, and offers to wire the shell wrappers, all in one command. Add `--vibe` for a dev-focused preset or `--agent` to also harden a coding agent.
:::

## Check your setup any time

```bash
sandbox doctor
```

It reports config, package manager, runtime, daemon, and image state, with a one-line verdict and the exact fix for anything that's off.

## Next

- [How it works](/sandbox-node/how-it-works/): the boundary in detail.
- [What's protected](/sandbox-node/security-model/): and the parts that stay writable.
- [Commands](/sandbox-node/commands/): the full surface.
