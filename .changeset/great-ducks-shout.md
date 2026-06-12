---
'@jagreehal/sandbox-node': minor
---

New `sandbox upgrade` command, shell-wrapper wiring, and onboarding polish.

**`sandbox upgrade`** — config-driven safe dependency upgrades. Wraps `ncu` to bump dependencies only within ranges you opt into, so routine updates stay inside the sandbox boundary. Honors per-package cooldown exemptions and writes exactly what was gated, so you can see why an upgrade was held back.

**Shell wrappers** — `sandbox setup` now offers to wire shell wrappers so a bare `npm install` routes through the sandbox automatically. No need to remember the `sandbox` prefix; opt in during setup.

**Onboarding & docs** — clearer onboarding tips, more honest build messaging, and hot-reload docs that describe what actually works rather than overselling it.
