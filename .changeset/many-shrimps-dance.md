---
'@jagreehal/sandbox-node': patch
---

Add several security-focused checks and evidence tools around the sandbox boundary.

- Add `sandbox secrets` for offline committed-secret scanning, and allow `sandbox verify --secrets`
  to fail the boundary gate when credentials are found.
- Add local known-bad package blocking via `sandbox.advisories.json` and cached malware feeds
  managed by `sandbox feeds <update|list>`, and apply those checks to preflight, scan, delta, and
  upgrade flows.
- Add canary honeytokens for allowlisted installs, plus `sandbox demo` to run real containment
  scenarios against the live sandbox.
- Add signed verify receipts, key generation, and audit-log verification with
  `sandbox verify --sign`, `sandbox verify-receipt`, `sandbox keygen`, and
  `sandbox audit verify`.
- Expand `sandbox doctor` to flag known runtime container-escape issues and end-of-life Node
  versions in the sandbox image.
