import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withEgress, type EgressHandle } from './egress.js';
import { quiet, run } from './exec.js';
import { log } from './log.js';
import type { RunPlan } from './plan.js';

const PROXY_IMAGE = 'node-install-sandbox-proxy:latest';

/** Adjustments `execute` applies at run time (the egress mechanism). */
export interface RunOverride {
  /** Explicit `--network` value; omit for the default bridge. */
  network?: string;
  extraEnv?: Record<string, string>;
}

/** A container runtime (docker or podman — their CLIs are arg-compatible here). */
export interface ContainerBackend {
  readonly bin: string;
  ensureImage(tag: string): Promise<void>;
  buildImages(sandboxTag: string): Promise<number>;
  runPlan(plan: RunPlan, override?: RunOverride): Promise<number>;
  withEgress<T>(allow: string[], fn: (handle: EgressHandle) => Promise<T>, onDenials?: (hosts: string[]) => void): Promise<T>;
}

/** Locate the package root (holds Dockerfile + proxy/) from this module. */
function assetsRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'Dockerfile'))) return dir;
    dir = dirname(dir);
  }
  throw new Error('sandbox: cannot locate Dockerfile (package assets missing)');
}

/** Entry point (in the image) that blackholes cloud metadata then drops all caps. */
const METADATA_GUARD = '/usr/local/bin/sbx-net-guard';

/** Render a RunPlan (+ runtime override) into `<bin> run ...` argv. Pure & testable. */
export function renderRunArgs(plan: RunPlan, override: RunOverride = {}): string[] {
  // Bridge mode ("on"/full-network): no explicit network, so the container has a route to the
  // host's link-local cloud-metadata endpoint (169.254.169.254). Hand the init just
  // CAP_NET_ADMIN + CAP_SETPCAP so it can blackhole that endpoint and then drop every
  // capability before your command runs — install/dev code can't reach IMDS or undo
  // the block. Isolated ('none') and allowlist-proxy modes have no such route.
  const bridge = override.network === undefined;
  const args = ['run', '--rm'];
  if (plan.interactive) args.push(process.stdin.isTTY && process.stdout.isTTY ? '-it' : '-i');
  for (const cap of plan.capDrop) args.push('--cap-drop', cap);
  if (bridge) args.push('--cap-add', 'NET_ADMIN', '--cap-add', 'SETPCAP');
  for (const opt of plan.securityOpt) args.push('--security-opt', opt);
  args.push('-w', plan.workdir);
  const env = { ...plan.env, ...override.extraEnv };
  for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
  for (const m of plan.mounts) {
    if (m.type === 'volume') {
      args.push('--mount', `type=volume,target=${m.target}${m.readonly ? ',readonly' : ''}`);
    } else {
      args.push('-v', `${m.source}:${m.target}${m.readonly ? ':ro' : ''}`);
    }
  }
  for (const p of plan.ports) args.push('-p', p);
  for (const h of plan.addHosts) args.push('--add-host', h);
  if (override.network) args.push('--network', override.network);
  if (bridge) args.push('--entrypoint', METADATA_GUARD);
  args.push(plan.image, ...plan.argv);
  return args;
}

export function createBackend(bin: 'docker' | 'podman' = 'docker'): ContainerBackend {
  const ensure = async (tag: string, contextDir: string) => {
    if ((await quiet(bin, ['image', 'inspect', tag])) === 0) return;
    log.info('building image', { tag });
    const code = await run(bin, ['build', '-t', tag, contextDir]);
    if (code !== 0) throw new Error(`sandbox: failed to build ${tag}`);
  };

  return {
    bin,
    ensureImage: (tag) => ensure(tag, assetsRoot()),
    buildImages: async (sandboxTag) => {
      const root = assetsRoot();
      const a = await run(bin, ['build', '-t', sandboxTag, root]);
      if (a !== 0) return a;
      return run(bin, ['build', '-t', PROXY_IMAGE, join(root, 'proxy')]);
    },
    runPlan: (plan, override) => run(bin, renderRunArgs(plan, override)),
    withEgress: async (allow, fn, onDenials) => {
      await ensure(PROXY_IMAGE, join(assetsRoot(), 'proxy'));
      return withEgress(bin, PROXY_IMAGE, allow, fn, onDenials);
    },
  };
}
