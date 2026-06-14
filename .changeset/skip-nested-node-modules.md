---
'@jagreehal/sandbox-node': patch
---

Don't flag nested workspace `node_modules` as tampering.

The post-install integrity check skipped only the root `node_modules/`, so a
workspace/monorepo install — which writes into per-package `node_modules`
(`app/node_modules`, `packages/*/node_modules`, …) — was reported as "changed N project
file(s) outside dependency output paths". `node_modules` at any depth is now skipped, while
paths that merely mention it (e.g. `src/node_modules_loader.ts`) are still checked.
