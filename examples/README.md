# Examples

Runnable mini-projects that do more than show syntax: they check that each package
manager routes through the right containment model, and in `--real` mode they fetch a
real registry dependency while a malicious local `postinstall` probe tries to break the
boundary.

> These are **not** part of the published package (`package.json#files` ships only
> `dist/`, the Dockerfile, the proxy, the schema, and the README). Nothing here is
> distributed to npm consumers.

## Layout

| Folder | Proves |
| --- | --- |
| [`npm/`](./npm) | `sandbox npm install` plans npm with read-only persistence paths and allowlist egress |
| [`pnpm/`](./pnpm) | `sandbox pnpm install` plans pnpm via corepack with the same containment |
| [`yarn/`](./yarn) | `sandbox yarn install` plans yarn via corepack, with `registry.yarnpkg.com` added because yarn's registry is not npm's |
| [`bun/`](./bun) | `sandbox bun install` plans the standalone bun binary with the same boundary |
| [`workspace/`](./workspace) | install runs at the workspace root while `run` stays in the package dir you invoked from |

Each folder is a tiny project with:

- one real registry dependency (`is-odd`) so the package manager has to fetch normally
- one local dependency (`./bad-dep`) whose `postinstall` probe fails if it can
  see host creds, create `.github/`, or reach `https://example.com`

Put `sandbox` in front of the command you already know:

```bash
cd examples/bun
sandbox bun install        # bun runs in the sandbox; your secrets stay on the host
```

## Proof without Docker

`run.mjs` asks each example for its resolved execution plan (`--json`) and asserts:

- the right package manager is invoked
- install egress stays on `allowlist`
- `package.json` and persistence paths are read-only
- `HOME=/root`, `cap-drop ALL`, and `no-new-privileges` are in effect
- fetch-and-run commands (`npx`/`dlx`/`bunx`) stay on the `run` model by default, so they
  have **no network** until you deliberately widen it
- workspace installs resolve to the repo root while `run` stays in the leaf package dir

This is fast and needs no container runtime:

```bash
npm run build              # produce dist/cli.js first
node examples/run.mjs
```

## Proof for real (needs Docker or Podman)

Add `--real` to actually run every install inside a container. In this mode an example
passes only if:

- the real dependency installs
- the malicious `postinstall` probe actually runs
- the probe cannot see host creds, cannot create `.github/`, and cannot egress
- a follow-up `--frozen` install resolves to the package-manager-specific reproducible
  mode and succeeds with the seeded lockfile
- fetch-and-run commands work once you deliberately opt into run networking
- from a workspace package, install happens at the root but `run` executes in the package dir

```bash
node examples/run.mjs --real
```
