---
title: Commands
description: The sandbox command surface — the passthrough you already know, plus the sandbox-only commands for setup, vetting, and CI.
---

The first rule: **put `sandbox` in front of what you'd type anyway.** Everything below the passthrough table is sugar or a sandbox-only command.

## Passthrough — your package manager, contained

sandbox auto-detects npm, pnpm, yarn, or bun and runs the command verbatim inside the box.

| | install | add / remove | update / dedupe | audit | run / exec |
| --- | --- | --- | --- | --- | --- |
| **npm** | `install` · `ci` | `install <pkg>` · `uninstall` | `update` · `dedupe` | `audit` · `audit fix` · `audit signatures` | `run` · `npx` · `x` |
| **pnpm** | `install` | `add` · `remove` | `update` · `dedupe` | `audit` · `audit --fix` | `<script>` · `dlx` · `exec` |
| **yarn** | `install` · bare `yarn` | `add` · `remove` | `up` · `upgrade` · `dedupe` | `audit` | `<script>` · `dlx` |
| **bun** | `install` | `add` · `remove` | `update` | `audit` | `<script>` · `bunx` · `x` |

Anything that pulls a *new* version runs through the supply-chain gates first. Removing a dependency skips the gates (it fetches nothing) but stays contained.

## Everyday sugar

```bash
sandbox dev               # run dev / start / serve with native PM syntax
sandbox test              # run any package.json script
sandbox x vite            # one-off tool, npx/bunx-style
sandbox script build      # run a script whose name collides with a sandbox command
```

## Setup and health

| Command | What it does |
| --- | --- |
| `sandbox setup [--vibe \| --agent]` | One-button onboarding: write config, check the runtime, build images, offer shell wiring. |
| `sandbox init [--preset N]` | Write a `sandbox.config.json` from a preset (interactive picker, or `--preset strict\|balanced\|vibe\|agent\|trusted`). |
| `sandbox doctor [--fix]` | Check config, package manager, runtime, daemon, and image state. `--fix` runs the safe remedies. |
| `sandbox path install` | Route bare `npm/pnpm/yarn/bun` + `npx` through sandbox in your shell. |
| `sandbox build` | Build (or rebuild) the sandbox and egress-proxy images. |
| `sandbox off` / `on` | Toggle containment for this project (a git-ignored personal override). |

## Vetting and CI

| Command | What it does |
| --- | --- |
| `sandbox check [pkg \| file.json]` | Audit dependencies **before** you install them. No container, no Docker. |
| `sandbox delta [--base <ref>]` | Gate only the dependency changes a PR introduces. |
| `sandbox scan` | Retroactive malware sweep over your committed lockfile (CI/cron). |
| `sandbox secrets [path]` | Offline scan for committed credentials (CI tripwire). |
| `sandbox verify [--scan] [--secrets] [--sign]` | Fail unless the repo commits a real, un-loosened boundary. `--sign` emits a signed receipt. |

## Useful globals

Put these before the command (`sandbox --frozen npm install`):

- `--frozen` — reproducible install; read-only source tree (every PM except pnpm).
- `--min-release-age <days>` — block versions published fewer than N days ago.
- `--fail-on-advisory` — block when a version is flagged as malware.
- `--fail-on-risk` — exit non-zero on any risk hint.
- `--allow-build-hosts` — widen egress to the curated native-build hosts for this run.
- `--dry-run` — print the resolved plan (mounts, network, grants) without running anything.
- `--json` — machine-readable output.

Run `sandbox help` for the complete surface.
