# sandbox-install — reference

CLI: `@jagreehal/sandbox-node` (binaries: `sandbox`, `sandbox-node`).

## `preflight` command (the review pass)

```
sandbox [gate flags] preflight [<pm> <cmd> …]
```

Runs the same gates as a real install but **never installs** — it reports findings and exits
non-zero exactly when the matching install would have been blocked. The argument after
`preflight` is routed like any pass-through command; omit it to check the current install
surface (lockfile / direct deps).

- `sandbox --min-release-age 7 preflight npm install` — check a plain install
- `sandbox --fail-on-advisory preflight pnpm add zod` — check what adding `zod` would pull
- `sandbox preflight npx cowsay` — check the package a fetch-and-run would execute

Exit codes: **0** = no blocking findings (safe to install); **1** = would block.

### `--json` report shape

```json
{
  "blocked": true,
  "checked": 1,
  "deepChecked": 0,
  "hints": [ { "code": "recent_version", "package": "left-pad", "version": "1.3.0", "...": "" } ],
  "ageViolations": [ { "name": "left-pad", "version": "1.3.0", "publishedAt": "…", "ageDays": 0 } ],
  "advisoryHits": [ { "name": "…", "version": "…", "ids": ["MAL-…"], "malware": true } ],
  "deprecations": [ { "name": "old-lib", "version": "2.0.0", "reason": "no longer maintained" } ],
  "suggestions": [ { "name": "left-pad", "version": "1.2.0", "pin": "sandbox npm add left-pad@1.2.0", "ageDays": 159 } ]
}
```

`suggestions[]` is the closed "pin older" gap: for each release-age violation it names the
newest **stable, non-deprecated, already-aged-in** version and gives a ready-to-run `pin`
command. Empty when no older version qualifies (then recommend waiting or `--allow-recent`).

## The gates (preflight)

The preflight resolves the registry once and runs every active gate over that result. It
runs *before* the install and decides the exit code. Blocking precedence:

1. **Release-age gate** — blocks a version published fewer than N days ago. The strongest
   control against publish-and-detonate worms.
2. **Known-malware advisory** — OSV advisory with a `MAL-…` id; blocks under
   `--fail-on-advisory`. **Non-malware advisories are logged as warnings only and never
   block** — there is no flag to block on them.
3. **Deprecated version** — a version the maintainer marked deprecated. **Blocks by default**
   (deprecated = abandoned = supply-chain risk); `--allow-deprecated` downgrades it to a
   warning. Rides on the risk resolution, so `--risk off` also disables it.
4. **Risk hints** — advisory by default; blocks only under `--fail-on-risk`.

Precedence when several fire: release-age → malware → deprecated → risk hints.

**Monorepos:** the direct-deps gates (deprecated, malware, risk hints) check the **union of every
workspace package's deps** (npm/yarn/bun `workspaces` or `pnpm-workspace.yaml`), not just the root
manifest — because `install` at the root pulls them all. Local `workspace:`/`file:`/`link:` deps are
skipped (nothing to fetch).

**`--deep`** extends the **blocking** gates — release-age, **deprecated**, and **malware** (with
`--fail-on-advisory`) — to the whole transitive tree from the lockfile, at the **exact locked
versions** (so it catches the version actually installed, not the latest the range resolves to). It
reads one packument per package (age + deprecation come from the same fetch) plus OSV queries for
malware. Risk *hints* (bin/script/recent) stay direct-only — they're advisory, not worth tree-wide.

Everything **fails open**: a registry/OSV lookup error proceeds inside containment rather
than wedging the install.

## Flags this skill uses

| Flag | Effect |
|---|---|
| `--fail-on-risk` | Exit 1 when any risk hint is found (blocks before running). |
| `--fail-on-advisory` | Exit 1 when a version is flagged as malware in OSV. |
| `--allow-deprecated` | Allow a maintainer-deprecated version (deprecated **blocks by default**). |
| `--min-release-age <days>` | Block versions younger than `<days>`. `0` disables. Strict preset = 7. |
| `--allow-recent <pat>` | Exempt a package-name pattern from the age gate (repeatable; globs ok, e.g. `@scope/*`). |
| `--deep` | Apply the age gate to the whole resolved tree (lockfile), not just direct deps. |
| `--risk <off\|basic>` | Disable/enable registry risk hints. |
| `--dry-run` | Preview mounts/allowlist/command, then stop. On `install`/`add`/`run` this **skips the preflight**; use the `preflight` command for the review pass instead. |
| `--json` | On `preflight`, prints the findings report (above). On `install`/`add`/`run`, prints the resolved plan and skips the preflight. |

Strict review pass = `sandbox --fail-on-risk --fail-on-advisory --min-release-age 7 preflight <pm> install`.

## Reading findings

Default: human lines on **stderr**. Set `SANDBOX_LOG=json` for NDJSON events
(`{"level":"error","msg":"...","...":...}`); `SANDBOX_LOG_LEVEL=debug|info|warn|error` filters.

Output shapes to recognize:

- **Release-age block:** `blocked by the release-age gate (min 7 days)` followed by
  `<name>@<version> was published <N hours/days> ago`.
- **Malware:** `<name>@<version> — KNOWN MALWARE advisory (MAL-…)` then
  `blocking: a version is flagged as malware and --fail-on-advisory is set`.
- **Advisory (non-malware):** `<name>@<version> — advisory <ids>`.
- **Risk hints:** `N risk hint(s)` then per-package lines: `adds bin: <name>` (bin_exposed)
  or a recent-version message (a `!!` prefix marks the strong severity).

## Override recipes

- Approve one fresh package, keep the gate otherwise:
  `sandbox --allow-recent <pkg> --fail-on-advisory <pm> install`
- Accept all fresh releases this once: add `--min-release-age 0`.
- Pin a known-good older version instead of latest: `sandbox <pm> add <pkg>@<version>`.
- Persist a tolerance in `sandbox.config.json`: `install.minReleaseAgeExclude`,
  `install.minReleaseAgeDays`, `install.failOnAdvisory`, `install.failOnRisk`.

## Containment note

Even on "proceed," the install runs jailed: persistence paths (`.git`, `.github`, `.husky`,
`.claude`, …) and `package.json` are read-only, no host creds are mounted, and egress is
default-deny (registry-only allowlist). The prompt is a "spend the risk?" decision, not the
only thing between the user and a bad package — containment is the backstop.
