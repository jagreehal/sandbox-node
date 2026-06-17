---
'@jagreehal/sandbox-node': minor
---

Dev-server DX: deterministic, conflict-safe port publishing

- **Truthful URLs.** Ports now publish as explicit `HOST:CONTAINER`, so the forwarded URL the CLI
  prints is the real host port. A bare `run.ports` entry like `"4321"` no longer maps to a random
  Docker-assigned host port.
- **Port conflicts no longer abort the run.** Host ports already in use (e.g. `8080`) are probed
  and skipped with a one-line notice instead of failing the whole run with a Docker bind error;
  the remaining dev ports still map. The run log also emits structured `endpoints` (`{ container,
  host, url }`) for machine-readable / agent consumption.
- **`run.ports` accepts numbers and honours a bind IP.** `4321` and `"4321"` are both valid
  (alongside `"3000:3000"` and `"127.0.0.1:3000:3000"`); a malformed value now reports the accepted
  forms instead of a terse "expected string, received number". An `IP:HOST:CONTAINER` spec publishes
  on that interface, prints the IP in its URL, and counts as distinct from the same port on another
  IP. A second spec claiming an already-claimed host endpoint is surfaced as an ignored duplicate
  rather than dropped silently.
- **`sandbox init` no longer dead-ends without a TTY.** With no TTY and no `--preset`, it writes
  the safe `balanced` preset and says so, rather than erroring.
- **Bind mounts use `docker --mount` instead of `-v`.** The `key=value` form never splits on `:`,
  so a Windows host path like `C:\Users\you\proj` mounts correctly. Mounts that relied on `-v`'s
  implicit directory creation (the project Claude config dir) keep that behaviour via an explicit
  pre-run `mkdir`.
- Devcontainer base image bumped to Node 24 (`javascript-node:24-bookworm`) to match the bundled
  sandbox image and the current LTS line.
