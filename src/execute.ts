import { existsSync, readdirSync, rmdirSync } from 'node:fs';
import path from 'node:path';
import { createBackend, type ContainerBackend, type RunOverride } from './backend.js';
import { scanCanaryLog, type Canary } from './canary.js';
import { log } from './log.js';
import { findHostIncompatiblePackagesInWorkspace, hostPlatform } from './native-deps.js';
import { networkPolicy } from './network.js';
import type { RunPlan } from './plan.js';
import { appendAudit } from './receipt.js';
import { missingAllowHosts, renderAllowCommand, renderAllowlistSnippet } from './registry.js';
import { classifyCommand, snapshotTree, summarizeUnexpectedChanges, wroteProjectLocalPnpmStore } from './tamper.js';

/**
 * Named volume blockers can leave empty host directories behind once the container exits.
 * Remove only the empty mountpoints so the host workspace returns to its pre-run shape.
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

export interface ExecuteOptions {
  failOnEgress?: boolean;
  canary?: Canary;
  /** Capture output across both proxied and isolated execution paths for CLI JSON/reporting flows. */
  capture?: boolean;
}

export interface ExecuteResult {
  code: number;
  deniedHosts: string[];
  canaryHits: string[];
  stdout?: string;
  stderr?: string;
}

/**
 * Audit logging is intentionally best-effort. A broken receipt sink must never block or alter the sandboxed run.
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
    const hostPorts = plan.ports.map((p) => p.split(':')[0]);
    log.info(`dev server ports forwarded: ${hostPorts.join(', ')} — open http://localhost:<port> in your browser`, { ports: hostPorts });
  }
  const realize = (override: RunOverride): Promise<{ code: number; stdout?: string; stderr?: string }> =>
    opts.capture ? backend.runPlanCaptured(plan, override) : backend.runPlan(plan, override).then((code) => ({ code }));
  const captured = (out: { stdout?: string; stderr?: string }) => (opts.capture ? { stdout: out.stdout ?? '', stderr: out.stderr ?? '' } : {});
  try {
    if (policy.useEgressProxy) {
      const denied: string[] = [];
      const canaryHits: string[] = [];
      const out = await backend.withEgress(
        plan.egressAllow,
        ({ network, proxyEnv }) => realize({ network, extraEnv: { ...proxyEnv, ...opts.canary?.env } }),
        (hosts) => denied.push(...hosts),
        opts.canary ? (logText) => canaryHits.push(...scanCanaryLog(logText, opts.canary!).map((h) => h.line)) : undefined,
      );
      if (canaryHits.length) {
        log.error('CANARY TRIPPED — a planted honeytoken credential left the sandbox; treat this as a live exfiltration attempt', { lines: canaryHits.slice(0, 5) });
      }
      if (denied.length) {
        if (!opts.capture) {
          log.warn(`sandbox blocked ${denied.length} network request(s) to host(s) not on your egress allowlist`, { hosts: denied });
          const add = missingAllowHosts(plan.egressAllow, denied);
          if (add.length) {
            log.info(`This is the default-deny egress guard. Often a package fetching native headers (e.g. nodejs.org).`);
            log.info(`If you trust ${add.length === 1 ? add[0] : 'these hosts'}, allow them for this repo: ${renderAllowCommand(add)}`);
            log.info(`Config preview:\n${renderAllowlistSnippet(plan.egressAllow, add)}`);
            log.info('Or run this once with full network (no allowlist): re-run with --full-network');
          }
        }
        if (opts.failOnEgress) return auditRun(plan, { code: out.code === 0 ? 1 : out.code, deniedHosts: denied, canaryHits, ...captured(out) });
      }
      // Canary evidence is a proof of exfiltration, so a nominal exit code still becomes a failed run.
      const finalCode = canaryHits.length && out.code === 0 ? 1 : out.code;
      return auditRun(plan, { code: finalCode, deniedHosts: denied, canaryHits, ...captured(out) });
    }
    const network = policy.isolate ? 'none' : undefined;
    const out = await realize({ network });
    return auditRun(plan, { code: out.code, deniedHosts: [], canaryHits: [], ...captured(out) });
  } finally {
    if (workspaceRoot && before && kind !== 'other') {
      const after = snapshotTree(workspaceRoot);
      const changes = summarizeUnexpectedChanges(before, after, kind);
      if (changes.length) {
        log.warn(`install changed ${changes.length} project file(s) outside dependency output paths`, {
          files: changes.slice(0, 8),
          truncated: changes.length > 8,
        });
      }
      if (wroteProjectLocalPnpmStore(before, after)) {
        log.info('pnpm created a project-local store (.pnpm-store/). Run later commands through `sandbox` to reuse it as-is; running pnpm directly on the host rebuilds node_modules against the host store.');
      }
      // The install ran on Linux; native optional deps resolve for that platform.
      // On a macOS/Windows host those binaries can't load — warn before the
      // host's own toolchain (vite/vitest/tsx) fails with a cryptic missing-module error.
      const foreignNative = findHostIncompatiblePackagesInWorkspace(workspaceRoot, hostPlatform());
      if (foreignNative.length) {
        log.warn(`${foreignNative.length} native package(s) were installed for the Linux sandbox and won't load on your ${process.platform} host`, {
          packages: foreignNative.slice(0, 8),
          truncated: foreignNative.length > 8,
        });
        log.info('Run project tools through sandbox so they execute on the same platform (e.g. `sandbox test`, `sandbox dev`). For host-native dev, run your package-manager install on the host to add its binaries.');
      }
    }
    cleanupBlockerMountpoints(plan);
  }
}
