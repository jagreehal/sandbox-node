import { existsSync, readdirSync, rmdirSync } from 'node:fs';
import path from 'node:path';
import { createBackend, type ContainerBackend } from './backend.js';
import { log } from './log.js';
import { networkPolicy } from './network.js';
import type { RunPlan } from './plan.js';
import { missingAllowHosts, renderAllowCommand, renderAllowlistSnippet } from './registry.js';
import { classifyCommand, snapshotTree, summarizeUnexpectedChanges } from './tamper.js';
import { appendAudit } from './receipt.js';
import { scanCanaryLog, type Canary } from './canary.js';

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
export { runScan, type ScanResult, type ScanContext } from './scan.js';
export { runDelta, changedPackages, type DeltaPolicy, type DeltaResult, type DeltaContext } from './delta.js';
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
export { canPromptInteractively, nextPlanForBlockedEgressChoice, promptForBlockedEgress, type BlockedEgressChoice } from './interactive.js';
export {
  detectRegistryHints,
  detectEgressHosts,
  allowHosts,
  allowHostsLocal,
  missingAllowHosts,
  projectRegistryHints,
  registryDiagnostics,
  renderAllowCommand,
  readProjectNpmrc,
  renderAllowlistSnippet,
  type RegistryHints,
  type RegistryDiagnostics,
} from './registry.js';
export {
  classifyHost,
  describeBlockedHosts,
  renderBlockedHostLines,
  hostGlyph,
  type HostCategory,
  type HostClassification,
  type DescribeHostsOptions,
} from './hosts.js';
export { classifyCommand, snapshotTree, summarizeUnexpectedChanges, type CommandKind, type TreeSnapshot } from './tamper.js';
export { parseVersion, runtimeVulnerabilities, nodeEolStatus, type RuntimeVuln, type NodeEolStatus } from './runtime-cve.js';
export {
  loadKnownBad,
  matchKnownBad,
  parseAdvisoryFile,
  loadAdvisoryFile,
  loadFeedCache,
  parseFeed,
  updateFeeds,
  projectAdvisoryPath,
  userAdvisoryPath,
  feedCacheDir,
  PROJECT_ADVISORY_NAME,
  type KnownBadEntry,
  type KnownBadHit,
  type Severity,
  type FeedUpdate,
  type FeedPackage,
} from './known-bad.js';
export { scanSecrets, scanText, listScannableFiles, redact, shannonEntropy, highEntropyToken, luhnValid, jwtValid, SECRET_RULES, SKIP_DIRS, type SecretRule, type SecretFinding, type ScanSecretsOptions } from './secrets.js';
export {
  canonicalize,
  sha256Hex,
  chainEntry,
  appendAudit,
  readAuditLog,
  verifyChain,
  generateSigningKey,
  signPayload,
  verifyReceipt,
  keyFingerprint,
  GENESIS,
  type AuditEntry,
  type ChainVerdict,
  type SigningKeyPair,
  type SignedReceipt,
  type ReceiptVerdict,
} from './receipt.js';
export { signVerifyReceipt, runVerifyReceipt, runKeygen, runAuditVerify, readSigningKey, verifyConfig, runVerify, type VerifyResult, type VerifyReceiptPayload } from './verify.js';
export { makeCanary, scanCanaryLog, canaryMarkers, type Canary, type CanaryHit } from './canary.js';
export { runDemo, demoPlan, DEMO_SCENARIOS, IMDS_BLOCKED_CODE, type DemoScenario, type DemoOutcome, type DemoRunner } from './demo.js';

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
  /** Plant canary honeytokens in the container env and watch the proxy log for them (allowlist mode only). */
  canary?: Canary;
}

export interface ExecuteResult {
  code: number;
  deniedHosts: string[];
  /** Canary nonces caught in the egress log — a planted credential left the box. Empty unless canaries ran. */
  canaryHits: string[];
}

/**
 * Append this run to the hash-chained audit log when `SANDBOX_AUDIT_LOG` points at one — opt-in,
 * tamper-evident evidence of what the sandbox did (run, or blocked egress). Best-effort by contract:
 * audit bookkeeping must NEVER break an install, so any failure here is swallowed. Verify the chain
 * later with `sandbox audit verify`.
 */
function auditRun(plan: RunPlan, result: ExecuteResult): ExecuteResult {
  const file = process.env.SANDBOX_AUDIT_LOG;
  if (file) {
    try {
      const event = result.canaryHits.length ? 'canary.exfil' : result.deniedHosts.length ? 'egress.denied' : 'run';
      appendAudit(
        file,
        event,
        {
          argv: plan.argv.join(' '),
          code: result.code,
          ...(result.deniedHosts.length ? { deniedHosts: result.deniedHosts } : {}),
          ...(result.canaryHits.length ? { canaryHits: result.canaryHits } : {}),
        },
        { now: new Date() },
      );
    } catch {
      /* best-effort: never let audit logging break the run */
    }
  }
  return result;
}

export async function execute(
  plan: RunPlan,
  backend: ContainerBackend = createBackend('docker'),
  opts: ExecuteOptions = {},
): Promise<ExecuteResult> {
  const workspaceRoot = plan.mounts.find((m) => m.type === 'bind' && m.target === '/workspace')?.source;
  const kind = classifyCommand(plan.argv);
  const before = workspaceRoot && kind !== 'other' ? snapshotTree(workspaceRoot) : undefined;
  await backend.ensureImage(plan.build);
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
      const canaryHits: string[] = [];
      const code = await backend.withEgress(
        plan.egressAllow,
        // Plant the canary honeytokens alongside the proxy env so a credential-harvester finds them.
        ({ network, proxyEnv }) => backend.runPlan(plan, { network, extraEnv: { ...proxyEnv, ...opts.canary?.env } }),
        (hosts) => denied.push(...hosts),
        opts.canary ? (logText) => canaryHits.push(...scanCanaryLog(logText, opts.canary!).map((h) => h.line)) : undefined,
      );
      if (canaryHits.length) {
        // Unambiguous: a value we planted — one with no legitimate use — reached a request the proxy
        // could see. This is an exfiltration attempt caught in the act, not a maybe-benign denied host.
        log.error('CANARY TRIPPED — a planted honeytoken credential left the sandbox; treat this as a live exfiltration attempt', { lines: canaryHits.slice(0, 5) });
      }
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
        if (opts.failOnEgress) return auditRun(plan, { code: code === 0 ? 1 : code, deniedHosts: denied, canaryHits });
      }
      // A canary hit is proof of theft, so it fails the run unconditionally — unlike a denied host
      // (which can be benign, e.g. nodejs.org headers), there's no innocent reason a honeytoken leaks.
      const finalCode = canaryHits.length && code === 0 ? 1 : code;
      return auditRun(plan, { code: finalCode, deniedHosts: denied, canaryHits });
    }
    // isolate -> `--network none`; otherwise the default bridge (no explicit --network).
    const network = policy.isolate ? 'none' : undefined;
    return auditRun(plan, { code: await backend.runPlan(plan, { network }), deniedHosts: [], canaryHits: [] });
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
