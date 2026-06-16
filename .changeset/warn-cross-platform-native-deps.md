---
"@jagreehal/sandbox-node": minor
---

Warn when a contained install leaves host-incompatible native dependencies

Installs run inside the Linux sandbox, so package managers fetch the Linux build
of platform-specific native optional deps (`@rollup/rollup-linux-*`,
`@esbuild/linux-*`, `@img/sharp-linux-*`, …). On a macOS or Windows host those
binaries can't load, and host-side tools (`vite`, `vitest`, `tsx`) fail with a
cryptic *Cannot find module `@rollup/rollup-darwin-arm64`*.

After an install, `sandbox` now scans `node_modules` for packages whose declared
`os`/`cpu` excludes the host and warns with the offending package names, pointing
at the fix (run tools through `sandbox`, or do a plain host install for native
host-side dev). The check is host-relative and self-gating — it stays silent when
the install platform matches the host (e.g. a Linux host) — and only inspects
packages whose name carries a platform token, so it adds no measurable cost.
