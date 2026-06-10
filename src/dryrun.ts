import type { RunPlan } from './plan.js';

/**
 * Render a {@link RunPlan} as a plain-English preview — what `--dry-run` shows instead of running.
 *
 * `--json` already exposes the exact plan for machines; this is the human-facing companion. For a
 * security tool whose headline use is "I'm about to let an agent / a random repo install", being
 * able to *read* the boundary (what's writable, what's read-only, where it can reach, what was
 * granted) before anything executes is the point — no `jq`, no JSON literacy required.
 */

/** Env keys the runtime always sets; they're noise in a grants summary. */
const AMBIENT_ENV = new Set(['SANDBOX', 'CI', 'HOME', 'SSH_AUTH_SOCK']);

function networkLine(plan: RunPlan): string {
  switch (plan.network) {
    case 'none':
      return 'no network (fully isolated)';
    case 'on':
      return 'full network (host bridge)';
    case 'allowlist':
      return `allowlist — reaches only: ${plan.egressAllow.join(', ') || '(none)'}`;
  }
}

/** Strip the `/workspace` prefix so read-only targets read as repo-relative paths. */
function shortTarget(target: string): string {
  if (target === '/workspace') return '/workspace (project root)';
  return target.startsWith('/workspace/') ? target.slice('/workspace/'.length) : target;
}

export function renderPlanSummary(plan: RunPlan): string {
  const lines = [
    'sandbox: dry run — nothing was executed',
    `  command   ${plan.argv.join(' ')}`,
    `  image     ${plan.image}`,
    `  workdir   ${plan.workdir}`,
    `  network   ${networkLine(plan)}`,
  ];

  for (const m of plan.mounts) {
    if (m.type === 'bind' && !m.readonly) lines.push(`  writable  ${m.source} -> ${m.target}`);
  }

  const readonly = plan.mounts.filter((m) => m.readonly).map((m) => shortTarget(m.target));
  if (readonly.length) lines.push(`  readonly  ${readonly.join(', ')}`);

  const granted = Object.keys(plan.env).filter((k) => !AMBIENT_ENV.has(k) && plan.env[k] !== '');
  const grants = [...(plan.env.SSH_AUTH_SOCK ? ['ssh-agent (sign only, key bytes stay out)'] : []), ...granted];
  lines.push(`  grants    ${grants.length ? grants.join(', ') : 'none — host credentials stay out'}`);
  lines.push(`  ports     ${plan.ports.length ? plan.ports.join(', ') : 'none'}`);
  lines.push(`  security  ${plan.capDrop.includes('ALL') ? 'cap-drop ALL · ' : ''}${plan.securityOpt.join(' · ')} · container-root ≠ host-root`);

  return lines.join('\n');
}
