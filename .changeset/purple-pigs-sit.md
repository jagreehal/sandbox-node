---
'@jagreehal/sandbox-node': minor
---

Enriched advisory scan with severity, triage, fix hints, and agent output

**Richer OSV data.** Advisory lookups now parse CVSS severity, summaries, and fixed
versions from OSV. `sandbox scan` groups hits by severity (critical/high/moderate/low),
labels each package as direct or transitive, and prints actionable fix lines — `sandbox
<pm> update` for direct deps, `overrides`/`resolutions`/`pnpm.overrides` for transitive
ones.

**Advisory triage.** Add a `.sandbox-audit-ignore` file to suppress accepted findings:
`<package> [<advisory-id>] [-- <reason>]` per line. Triaged hits are reported separately
and excluded from severity counts and blocking logic.

**Agent-friendly scan output.** `--format agent` (alias `--format ai`) emits a compact,
line-oriented report for automation — severity totals, per-package advisories, and fix
hints without JSON scaffolding.

**Package manager detection.** `packageManager` resolution also reads the `devEngines`
field when the standard `packageManager` key is absent.
