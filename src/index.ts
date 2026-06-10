import { existsSync, readdirSync, rmdirSync } from 'node:fs';
import path from 'node:path';
import { createBackend, type ContainerBackend } from './backend.js';
import { log } from './log.js';
import { networkPolicy } from './network.js';
import type { RunPlan } from './plan.js';
import { missingAllowHosts, renderAllowCommand, renderAllowlistSnippet } from './registry.js';
import { classifyCommand, snapshotTree, summarizeUnexpectedChanges } from './tamper.js';

export * from './config.js';
export * from './dispatch.js';
export * from './network.js';
export { renderPlanSummary } from './dryrun.js';
export * from './package-manager.js';
export * from './plan.js';
export * from './project.js';
export * from './presets.js';
export * from './risk.js';
export * from './advisory.js';
export { runPreflight, type PreflightPolicy, type PreflightResult, type PreflightContext } from './preflight.js';
export { runDoctor, type DoctorOptions } from './doctor.js';
export { runInit, writeSandboxConfig, writeAgentArtifacts, printUnwiredHookWarning, type InitOptions, type AgentArtifacts } from './init.js';
export { classifyBareCommand, mergePreToolUseHook, mergeAgentSettings, installAgentHook, HOOK_SCRIPT, MANUAL_AGENT_SNIPPET, SECRET_DENY_RULES, type HookDecision, type HookInstall } from './hook.js';
export {
  writeDevcontainer,
  devcontainerJson,
  devcontainerDockerfile,
  initFirewallScript,
  firewallEnabled,
  firewallAllowlist,
  resolveImageDigest,
  CLAUDE_DOMAINS,
  BASE_IMAGE,
  type WriteDevcontainerResult,
} from './devcontainer.js';
export { runSetup, type SetupOptions } from './setup.js';
export { createBackend, renderRunArgs, type ContainerBackend, type RunOverride } from './backend.js';
export { EgressError, parseEgressDenials, type EgressHandle } from './egress.js';
export { createLogger, formatEvent, log, type Logger, type LogLevel } from './log.js';
export {
  detectRegistryHints,
  allowHosts,
  missingAllowHosts,
  projectRegistryHints,
  renderAllowCommand,
  readProjectNpmrc,
  renderAllowlistSnippet,
  type RegistryHints,
} from './registry.js';
export { classifyCommand, snapshotTree, summarizeUnexpectedChanges, type CommandKind, type TreeSnapshot } from './tamper.js';
export { parseVersion, runtimeVulnerabilities, type RuntimeVuln } from './runtime-cve.js';

/**
 * A read-only volume mounted at a missing persistence path blocks its creation,
 * but Docker first materializes the mountpoint dir in the host bind. Remove those
 * empty dirs afterwards so a clean repo isn't littered with `.github`, `.husky`, …
 */
function cleanupBlockerMountpoints(plan: RunPlan): void {
  const root = plan.mounts.find((m) => m.type === 'bind' && m.target === '/workspace')?.source;
  if (!root) return;
  for (const m of plan.mounts) {
    if (m.type !== 'volume' || !m.target.startsWith('/workspace/')) continue;
    const hostPath = path.join(root, m.target.slice('/workspace/'.length));
    try {
      if (existsSync(hostPath) && readdirSync(hostPath).length === 0) rmdirSync(hostPath);
    } catch {
      /* best-effort: leave it if non-empty or unremovable */
    }
  }
}

/**
 * Realize a RunPlan: ensure the image, then run. This is the ONE place that knows
 * `allowlist` means "stand up the proxy AND wire the container through it" — the
 * plan only declares intent.
 */
export interface ExecuteOptions {
  /** Exit non-zero if the proxy refused any egress (a CI tripwire for exfil attempts). */
  failOnEgress?: boolean;
}

export async function execute(
  plan: RunPlan,
  backend: ContainerBackend = createBackend('docker'),
  opts: ExecuteOptions = {},
): Promise<number> {
  const workspaceRoot = plan.mounts.find((m) => m.type === 'bind' && m.target === '/workspace')?.source;
  const kind = classifyCommand(plan.argv);
  const before = workspaceRoot && kind !== 'other' ? snapshotTree(workspaceRoot) : undefined;
  await backend.ensureImage(plan.image);
  const policy = networkPolicy(plan.network);
  if (plan.interactive && plan.ports.length) {
    // We can't tap the (inherited) stdio to read the real port, but we publish the
    // common ones up-front — tell the user where to look before the server starts.
    const hostPorts = plan.ports.map((p) => p.split(':')[0]);
    log.info(`dev server ports forwarded: ${hostPorts.join(', ')} — open http://localhost:<port> in your browser`, { ports: hostPorts });
  }
  try {
    if (policy.useEgressProxy) {
      const denied: string[] = [];
      const code = await backend.withEgress(
        plan.egressAllow,
        ({ network, proxyEnv }) => backend.runPlan(plan, { network, extraEnv: proxyEnv }),
        (hosts) => denied.push(...hosts),
      );
      if (denied.length) {
        // What happened: a dependency tried to reach a host that isn't allowlisted.
        log.warn(`sandbox blocked ${denied.length} network request(s) to host(s) not on your egress allowlist`, { hosts: denied });
        const add = missingAllowHosts(plan.egressAllow, denied);
        if (add.length) {
          // What to type next: the persistent fix (allow the host) and the one-off escape hatch.
          log.info(`This is the default-deny egress guard. Often a package fetching native headers (e.g. nodejs.org).`);
          log.info(`If you trust ${add.length === 1 ? add[0] : 'these hosts'}, allow them for this repo: ${renderAllowCommand(add)}`);
          log.info(`Config preview:\n${renderAllowlistSnippet(plan.egressAllow, add)}`);
          log.info('Or run this once with full network (no allowlist): re-run with --full-network');
        }
        if (opts.failOnEgress) return code === 0 ? 1 : code;
      }
      return code;
    }
    // isolate -> `--network none`; otherwise the default bridge (no explicit --network).
    const network = policy.isolate ? 'none' : undefined;
    return await backend.runPlan(plan, { network });
  } finally {
    if (workspaceRoot && before && kind !== 'other') {
      const changes = summarizeUnexpectedChanges(before, snapshotTree(workspaceRoot), kind);
      if (changes.length) {
        log.warn(`install changed ${changes.length} project file(s) outside dependency output paths`, {
          files: changes.slice(0, 8),
          truncated: changes.length > 8,
        });
      }
    }
    cleanupBlockerMountpoints(plan);
  }
}
