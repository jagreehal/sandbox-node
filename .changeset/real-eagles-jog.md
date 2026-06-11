---
"@jagreehal/sandbox-node": minor
---

Supply-chain lifecycle gating, packaging fix, and CLI polish.

**Fix:** ship `net-guard.sh` in the npm package. The published Dockerfile does `COPY net-guard.sh`, but the file was missing from `files`, so a fresh `sandbox npm install` failed at image build with `"/net-guard.sh": not found`. Added a `test/packaging.test.ts` regression guard that asserts every Dockerfile `COPY` source is published.

**`sandbox scan`** — retroactive malware sweep. Re-queries OSV for the versions in the committed lockfile and exits non-zero if any installed package is now flagged as malware (`MAL-…`). Closes the time gap install-time gating can't cover. No container needed; cheap to run nightly in CI. `sandbox verify --scan` folds it into the boundary gate.

**`sandbox delta [--base <ref>]`** — gate only what a PR changes. Diffs the lockfile against the merge target (default `origin/main`, or `--base-lockfile <path>`) and runs the release-age, malware, and deprecation gates over just the added/bumped versions. Fails safe (gates everything) if the base lockfile can't be read.

**`sandbox completion <shell>`** — tab-completion scripts for zsh, bash, and fish (commands, globals, and `--preset` / `--backend` / `--risk`).

**First-run build feedback** — clear progress during the one-time image build (clack spinner on a TTY, plain stderr lines in CI). Distinguishes absent vs stale images when config changed since the last build.

**`sandbox doctor` improvements** — reports whether the image is absent, current, or stale (out of date vs config); optional `--fix` auto-rebuilds a missing or stale image.

Both scan/delta reuse the existing OSV/registry engine, honor `--min-release-age` / `--fail-on-advisory` / `--json`, and expose `parseLockfilePackages` for parsing a lockfile from text (e.g. a git blob).
