---
'@jagreehal/sandbox-node': minor
---

Native package scripts, monorepo task runners, smarter egress defaults, and an update notice.

**Run package.json scripts natively.** `sandbox dev`, `sandbox test`, `sandbox <script>` route any
script through your package manager's native syntax (auto-detected from `package.json#packageManager`
then the lockfile). `sandbox dev` runs the first of `dev`/`start`/`serve` with dev-mode networking.
Built-in commands win on a name clash; force a colliding script with `sandbox script <name>`. The
monorepo task runners route directly too: `sandbox turbo …` and `sandbox nx …`.

**Smarter, still-minimal egress.** Detection prefers the `packageManager` field (Corepack semantics)
over the lockfile. The effective allowlist is package-manager aware — yarn classic adds its own
registry (`yarnpkg.com`) so a `yarn install` works out of the box, while the committed config stays
minimal. New `--allow-build-hosts` opts into the curated native-build/release hosts (node-gyp,
Prisma, Playwright, Cypress, Puppeteer, Electron, GitHub releases) for one run — still a default-deny
allowlist, not full network. `sandbox init` can pre-allow opt-in egress bundles (host groups):
`build-tools` plus narrow cloud groups (`vercel`/`cloudflare`/`supabase`/`aws`), scoped to specific
control-plane hosts only — never provider-wide wildcards, and `aws` is STS-auth-only.

**Update notice.** On an interactive run, `sandbox` prints a "new version available" notice (to
stderr, from a once-a-day cached background check). Off automatically for `--json`/non-TTY/CI; disable
with `--no-update-check`, `NO_UPDATE_NOTIFIER`, or `updateCheck: false`. No new dependencies.
