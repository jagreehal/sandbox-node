---
'@jagreehal/sandbox-node': patch
---

Stop flagging pnpm's project-local store as tampering.

pnpm relocates its content store next to `node_modules` (`.pnpm-store/`) when its
configured store is on a different device than the project — always the case for a
bind-mounted workspace. An install legitimately writes thousands of files there, which the
post-install check reported as "changed N project file(s) outside dependency output paths".

`.pnpm-store/` is now treated as an expected install artifact. When pnpm creates one, the
run prints a short note that `node_modules` is tied to that in-project store, so running
pnpm directly on the host rebuilds it against the host store — run later commands through
`sandbox` to reuse it as-is. Adds `wroteProjectLocalPnpmStore`.
