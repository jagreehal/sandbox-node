---
name: sandbox-install
description: Human-in-the-loop secure install for npm/pnpm/yarn/bun deps, driven by the `sandbox` CLI (@jagreehal/sandbox-node). Runs a read-only `preflight` review pass that reports supply-chain risk WITHOUT installing, surfaces each finding with a recommended action (including a concrete older version to pin), lets the user choose, then runs the real install with the matching flags. Use when the user wants to install, add, or update dependencies safely, vet a package before installing, review supply-chain risk (fresh releases, OSV advisories, known malware), or asks to "sandbox install" something.
---

# sandbox-install

The `sandbox` CLI runs package installs inside a container (no host creds, egress
default-deny, lifecycle scripts contained) and ships a supply-chain preflight. This skill
is the **interactive front-end**: the CLI is pure flags, and you (the agent) are the
human-in-the-loop. You drive the flags; the user makes the risk calls.

The whole point: the `preflight` command runs the gates and reports findings **without
installing anything**. So the review pass is always safe to run first — real
review-before-install — and you only run the real install once the user has cleared the risk.

## Workflow

1. **Confirm the tool is present.** `sandbox doctor` (or `npx @jagreehal/sandbox-node doctor`).
   If there's no `sandbox.config.json`, run `sandbox init --preset balanced` first.

2. **Review pass — check WITHOUT installing.** Use the `preflight` command: it runs the
   gates over what the command would pull and **never installs**, so this is always safe to
   run first.

   ```
   sandbox --json --fail-on-risk --fail-on-advisory --min-release-age 7 preflight <pm> install [pkgs]
   ```

   - Exit **0** → no blocking findings. Go to step 4 and run the real install.
   - Exit **1** → would block. Read the findings and go to step 3.
   - `--json` returns a structured report: `{ blocked, checked, hints, ageViolations,
     advisoryHits, suggestions }`. Each `suggestions[]` entry has a ready-to-run `pin`
     command (e.g. `sandbox npm add left-pad@1.2.0`). Drop `--json` for human-readable lines.

3. **Map each finding to a recommended action**, then present them to the user (use
   AskUserQuestion when there's a clear choice; recommend the safe default first):

   | Finding (from output) | Blocks the pass? | Recommend | If user agrees, install with |
   |---|---|---|---|
   | **KNOWN MALWARE** (`MAL-…` advisory) | yes | **Abort.** Do not offer an easy proceed. | — stop; suggest reporting it |
   | **Deprecated version** (`deprecations[]`) | yes (default) | Upgrade to a non-deprecated version | `--allow-deprecated` **only if the user insists** — a deprecated version is abandoned and a supply-chain risk |
   | Release-age violation (published N days ago) | yes | Pin the suggested older version | the `pin` command from `suggestions[]` · or exempt: `--allow-recent <pkg>` |
   | Risk hint (`bin_exposed`, `recent_version`) | yes (under `--fail-on-risk`) | Informational — usually proceed | drop `--fail-on-risk`, then `sandbox <pm> install` |
   | Advisory, **non-malware** (`— advisory <ids>`) | **no — warn only** | Surface it; there's no flag that blocks on it | — (see note) |

   **Non-malware advisory caveat:** these never change the exit code. `preflight` still
   reports them (in `advisoryHits[]`) without installing, so you can surface one and let the
   user decide before step 4. There is no dedicated "block on any advisory" flag — say so
   plainly rather than implying one exists.

4. **Install with the user's choices.** The review pass installed nothing, so this is the
   step that actually runs. Apply only the overrides they approved:
   - Clean pass (exit 0) → `sandbox <pm> install [pkgs]`
   - Approve one fresh package, keep the gate for the rest → `sandbox --allow-recent left-pad <pm> install`
   - Accept all fresh releases this once → `sandbox --min-release-age 0 <pm> install`
   - Pin instead of install-latest → run the `pin` command from `suggestions[]`
     (`sandbox <pm> add <pkg>@<version>`)
   - Abort → stop; nothing was installed.

5. **Report** exactly what ran, which overrides were applied and why, and what installed.

## Rules

- **Never auto-proceed past a `MAL-…` malware advisory.** Always stop and make the user
  type the override themselves if they insist.
- **Every override must be a real flag** the user approved — never silently relax the gate.
- `<pm>` is the user's package manager (npm/pnpm/yarn/bun); match their lockfile/config.
- Prefer the narrowest override (`--allow-recent <pkg>`) over the blanket one
  (`--min-release-age 0`).
- Non-interactive / CI / "just set it up": skip the prompts and pick the strict default
  (abort on any finding) unless the user pre-stated their tolerance — then encode it as flags.

See [REFERENCE.md](REFERENCE.md) for the full flag list and finding formats.
