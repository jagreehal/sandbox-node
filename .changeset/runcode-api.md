---
"@jagreehal/sandbox-node": major
---

Add `runCode(code, options)` — a programmatic API for executing untrusted / AI-generated JavaScript or TypeScript inside the sandbox and getting its captured output back. Unlike `vm.runInThisContext` or in-process "sandbox" packages (which Node's own docs warn are not security boundaries), code runs in a throwaway container with no host credentials and no network by default, and a real wall-clock timeout is enforced by a separate process (the container's init), so a busy loop can't block or outrun it the way it defeats an in-process `vm` timeout. Returns `{ stdout, stderr, exitCode, timedOut, durationMs, deniedHosts }`. TypeScript runs via Node's built-in type stripping (no `tsx`, no network). Supports `network: 'allowlist'` egress, extra `files`, and `env`.

Internally this adds output capture to the canonical run layer: `execute(plan, backend, { capture: true })` now returns `stdout`/`stderr` in its `ExecuteResult`.

**BREAKING:** the `ContainerBackend` interface gained a required `runPlanCaptured(plan, override?)` method. Anyone who implements `ContainerBackend` themselves (rather than using `createBackend`) must add it — it runs the plan capturing stdout/stderr, the sibling of `runPlan` which inherits stdio. Consumers using `createBackend('docker' | 'podman')` are unaffected.
