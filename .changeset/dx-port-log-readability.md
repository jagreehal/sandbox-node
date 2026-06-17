---
'@jagreehal/sandbox-node': patch
---

Dev-server port output: readable, honest, no `[object Object]`

The 1.5.0 "ports forwarded" line attached the endpoints as a structured field, which the
human logger rendered as `(endpoints=[object Object],[object Object],…)`. Beyond the broken
rendering, listing five "open me" URLs for the dev-port catch-all is misleading — only one of
them actually serves.

- **Logger**: object-valued fields serialize as JSON instead of `[object Object]` (a logger
  should never emit that for a structured value).
- **One port** (explicit `run.ports`): print the exact clickable URL — `port forwarded →
  http://localhost:4321`.
- **Many ports** (the dev catch-all): name the mapped ports and point at the URL the dev server
  prints itself, rather than five URLs where four have nothing behind them.
- **Skipped / duplicate ports**: concise one-liners, no redundant `(skipped=…)` echo.
