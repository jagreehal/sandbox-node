---
'@jagreehal/sandbox-node': patch
---

Tightens CLI behavior and project guardrails.

**Safer one-off networking semantics.** `--full-network` now widens install/run networking without
implicitly turning on dev-port publishing for non-dev commands. Port forwarding stays tied to dev-mode
runs instead of being enabled as a side effect of broader network access.

**Machine-readable build output.** `sandbox build --json` now emits the resolved build spec so
automation can inspect the image build plan without scraping human-oriented logs.

**Maintainer guardrails.** The repo test path now includes import-cycle detection, committed pnpm
policy verification, and release-metadata checks, with integration coverage for those checks.
