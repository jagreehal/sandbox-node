---
name: sandbox-install
description: Human-in-the-loop secure install for npm/pnpm/yarn/bun deps, driven by the `sandbox` CLI (@jagreehal/sandbox-node). Runs a read-only `preflight` review pass that reports supply-chain risk WITHOUT installing, surfaces each finding with a recommended action (including a concrete older version to pin), lets the user choose, then runs the real install with the matching flags. Use when the user wants to install, add, or update dependencies safely, vet a package before installing, review supply-chain risk (fresh releases, OSV advisories, known malware), or asks to "sandbox install" something.
---

# sandbox-install

The `sandbox` CLI runs package installs inside a container (no host creds, egress
default-deny, lifecycle scripts contained) and ships a supply-chain preflight. This skill
is the **interactive front-end**: the CLI is pure flags, and you (the agent) are the
human-in-the-loop. You drive the flags; the user makes the risk calls.

The `preflight` command runs the gates and reports findings **without installing anything**.
Run the review pass first, then run the real install once the user has cleared the risk.

## Workflow

1. **Confirm the tool is present.** `sandbox doctor` (or `npx @jagreehal/sandbox-node doctor`).
   If there's no `sandbox.config.json`, run `sandbox init --preset balanced` first. For a human who
   keeps installing in their own shell, suggest `sandbox path install` once: it routes bare
   `npm/pnpm/yarn/bun install` (+ `npx`/`bunx`) through sandbox automatically, so neither of you has
   to remember the prefix. `sandbox setup` also offers to wire this. See [REFERENCE.md](REFERENCE.md).

   For scripts, prefer the short form: `sandbox dev`, `sandbox test`, `sandbox lint`. If a script
   name collides with a sandbox command such as `build`, use `sandbox script build`.

   If `package.json` pins a `"packageManager"` (pnpm/yarn) other than the image's baked default,
   the first install bakes that version into the image, so expect a one-time image build before the
   install runs. This happens automatically; no config needed.

   For a project with native modules (node-gyp, Prisma, Playwright, Cypress, Electron) that download
   binaries during `postinstall`, the interactive `sandbox init` picker can pre-allow the
   `build-tools` egress bundle so those installs don't block on the first run (see step 4).

2. **Review pass: check WITHOUT installing.** Use the `preflight` command: it runs the
   gates over what the command would pull and **never installs**, so run it first.

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

4. **Install with the user's choices.** The review pass installed nothing; this step runs.
   Apply only the overrides they approved:
   - Clean pass (exit 0) → `sandbox <pm> install [pkgs]`
   - Approve one fresh package, keep the gate for the rest → `sandbox --allow-recent left-pad <pm> install`
   - Accept all fresh releases this once → `sandbox --min-release-age 0 <pm> install`
   - Pin instead of install-latest → run the `pin` command from `suggestions[]`
     (`sandbox <pm> add <pkg>@<version>`)
   - Abort → stop; nothing was installed.

   **If the install itself blocks on egress** (not a preflight finding; a `postinstall` tried to
   reach a host that isn't on the allowlist), the proxy reports the blocked host. When it's a known
   **build host** (Node headers, GitHub releases, Prisma/Playwright/Cypress/Puppeteer/Electron
   binaries), re-run with `--allow-build-hosts`: it adds the curated native-build hosts for that run
   and **stays a default-deny allowlist** (not full network). Prefer the narrowest fix: allow
   the exact host with `sandbox allow <host>` when only one is needed.

   **If pnpm stops for dependency build-script approval** (`allowBuilds` placeholders in
   `pnpm-workspace.yaml`), keep the decision inside sandbox:
   - On a TTY, let `sandbox` prompt and re-run.
   - Non-interactive: run `sandbox approve-builds` (all pending) or
     `sandbox approve-builds <pkg...>` (specific packages).
   - For an unattended run the user has already approved, add `--allow-all-builds`.
   - If the user wants to reject one, run `sandbox approve-builds --deny <pkg>`.

5. **Report** exactly what ran, which overrides were applied and why, and what installed.

## Rules

- **Never auto-proceed past a `MAL-…` malware advisory.** Always stop and make the user
  type the override themselves if they insist.
- **Every override must be a real flag** the user approved — never silently relax the gate.
- `<pm>` is the user's package manager (npm/pnpm/yarn/bun); match their lockfile/config.
- For `package.json` scripts, prefer `sandbox <script>` over `sandbox <pm> run <script>`, and use
  `sandbox script <name>` when the script name collides with a sandbox command.
- Prefer the narrowest override (`--allow-recent <pkg>`) over the blanket one
  (`--min-release-age 0`). Same for egress: `sandbox allow <host>` (one host) before
  `--allow-build-hosts` (the curated bundle) before `--full-network` (no allowlist at all).
- For pnpm build scripts, prefer `sandbox approve-builds <pkg>` over `--allow-all-builds` when the
  user only trusts a small set of packages.
- Non-interactive / CI / "just set it up": skip the prompts and pick the strict default
  (abort on any finding) unless the user pre-stated their tolerance — then encode it as flags.

See [REFERENCE.md](REFERENCE.md) for the full flag list and finding formats.
