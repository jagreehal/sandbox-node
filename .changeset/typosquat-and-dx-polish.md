---
'@jagreehal/sandbox-node': minor
---

Cut typosquat false positives and sharpen install-review DX.

- **Typosquat**: skip names shorter than 5 characters (where a 1–2 edit band matches half the registry — `ai`, `vm`, `js`, `mcp`) and skip members of a reputable scope that owns a package in the top-packages corpus (`@typescript-eslint/parser`, `@ai-sdk/mcp`, `@total-typescript/ts-reset`). A real impersonation of a popular long name still flags.
- **preflight**: a bare reproduce-the-lockfile install that blocks on release-age now points to `sandbox delta`, the low-noise gate that judges only what a change introduces rather than every already-committed dependency.
- **doctor**: surfaces a `node_modules` platform-mismatch check, so a container-built tree (e.g. `@rolldown/binding-linux-*`) is explained before host tooling fails with a cryptic missing-binding error. Exit code is now a single derived rule — `info`-level notes (like a missing config file) never fail the run.
