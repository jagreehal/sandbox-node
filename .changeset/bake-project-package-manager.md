---
'@jagreehal/sandbox-node': minor
---

Bake the project's pinned package manager into the image at build time.

The bundled image pre-activates pnpm 9.15.0 / yarn 1.22.22. A project that pins a
different version via package.json `packageManager` (e.g. `pnpm@11.5.3`) previously made
corepack try to download that version at run time, which fails behind the egress proxy
(corepack doesn't route through it) and in no-network phases — so `sandbox pnpm install`
broke for most modern pnpm/yarn repos.

`resolveBuildSpec` now reads the project's `packageManager` field and, when it differs from
the baked version, prepends a `corepack prepare <pinned> --activate` step (run during the
build, where the network is available; the integrity hash is passed through so corepack
verifies it). npm/bun and already-baked versions add no step.

New exports: `parsePackageManagerField` (package-manager), `corepackPrepareStep` and
`BAKED_COREPACK` (image).
