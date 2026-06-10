import path from 'node:path';
import type { NetworkMode, SandboxConfig } from './config.js';
import { COMMON_DEV_PORTS, networkPolicy } from './network.js';
import { frozenInstallArgv, lockfileName, pmArgv } from './package-manager.js';
import { PERSISTENCE_PATHS, type ProjectFacts } from './project.js';

/**
 * A mount. `bind` exposes a host path; `volume` is an anonymous volume used as a
 * read-only block (e.g. to stop a postinstall *creating* a `.github/` that isn't
 * there). Plan stays serializable.
 */
export interface Mount {
  type: 'bind' | 'volume';
  /** Host path — required for `bind`, omitted for `volume`. */
  source?: string;
  target: string;
  readonly: boolean;
}

/** A fully-resolved, serializable description of one container invocation. */
export interface RunPlan {
  image: string;
  argv: string[];
  env: Record<string, string>;
  mounts: Mount[];
  ports: string[];
  workdir: string;
  network: NetworkMode;
  /** Domains permitted when `network === 'allowlist'`. */
  egressAllow: string[];
  /** Interactive: `execute` upgrades to a TTY when the host stdio is one. */
  interactive: boolean;
  capDrop: string[];
  securityOpt: string[];
  addHosts: string[];
}

export interface PlanOptions {
  image?: string;
  /** Reproducible install (overrides `config.install.frozen`). */
  frozen?: boolean;
  /**
   * Sub-directory (inside `/workspace`) to run `run`/`shell` from when invoked from a
   * package in a monorepo. `install`/`add` ignore it — they always run at the workspace
   * root, so the planner owns that and the caller can't aim them at a sub-dir by mistake.
   */
  workdir?: string;
  /** Extra host env var names to forward for this invocation (selected from `facts.hostEnv`). */
  envNames?: string[];
}

const CONTAINER_HOME = '/root';
const WORKSPACE_ROOT = '/workspace';

function parsePathSpec(spec: string, cwd: string, homedir: string): { src: string; readonly: boolean } {
  const sep = spec.lastIndexOf(':');
  const hasMode = sep > 1;
  let raw = hasMode ? spec.slice(0, sep) : spec;
  const mode = hasMode ? spec.slice(sep + 1) : 'ro';
  if (raw.startsWith('~')) raw = path.join(homedir, raw.slice(1));
  const src = path.isAbsolute(raw) ? raw : path.join(cwd, raw);
  return { src, readonly: mode !== 'rw' };
}

function grantMounts(facts: ProjectFacts, config: SandboxConfig): Mount[] {
  const { cwd, homedir } = facts;
  const mounts: Mount[] = [];
  if (config.grants['ssh-agent']) {
    mounts.push({ type: 'bind', source: '/run/host-services/ssh-auth.sock', target: '/ssh-agent', readonly: false });
  }
  if (config.grants.claude === 'project') {
    mounts.push({ type: 'bind', source: path.join(cwd, '.claude-sandbox'), target: `${CONTAINER_HOME}/.claude`, readonly: false });
  } else if (config.grants.claude === 'home') {
    mounts.push({ type: 'bind', source: path.join(homedir, '.claude'), target: `${CONTAINER_HOME}/.claude`, readonly: false });
  }
  for (const spec of config.grants.paths) {
    const { src, readonly } = parsePathSpec(spec, cwd, homedir);
    mounts.push({ type: 'bind', source: src, target: `/grants/${path.basename(src)}`, readonly });
  }
  return mounts;
}

/**
 * Read-only protection for persistence vectors (and, for `install`, the manifest).
 * Existing paths are bound read-only; missing ones get a read-only volume so they
 * can't be created. The package manager still gets a writable root for lockfile /
 * temp writes — what every PM (notably pnpm) needs.
 */
function protectionMounts(facts: ProjectFacts, opts: { protectManifest: boolean }): Mount[] {
  const mounts: Mount[] = [];
  for (const p of PERSISTENCE_PATHS) {
    mounts.push(
      facts.existingPersistencePaths.includes(p)
        ? { type: 'bind', source: path.join(facts.cwd, p), target: `${WORKSPACE_ROOT}/${p}`, readonly: true }
        : { type: 'volume', target: `${WORKSPACE_ROOT}/${p}`, readonly: true },
    );
  }
  if (opts.protectManifest && facts.hasPackageJson) {
    mounts.push({ type: 'bind', source: path.join(facts.cwd, 'package.json'), target: `${WORKSPACE_ROOT}/package.json`, readonly: true });
  }
  return mounts;
}

function baseEnv(config: SandboxConfig, facts: ProjectFacts, opts: PlanOptions): Record<string, string> {
  const env: Record<string, string> = { SANDBOX: '1', CI: '', HOME: CONTAINER_HOME };
  if (config.grants['ssh-agent']) env.SSH_AUTH_SOCK = '/ssh-agent';
  Object.assign(env, facts.envFileValues);
  for (const name of new Set([...config.grants.env, ...(opts.envNames ?? [])])) {
    const value = facts.hostEnv[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

function commonPlan(config: SandboxConfig, facts: ProjectFacts, network: NetworkMode, opts: PlanOptions): Omit<RunPlan, 'argv' | 'mounts' | 'ports' | 'interactive' | 'workdir'> {
  return {
    image: opts.image ?? config.image,
    env: baseEnv(config, facts, opts),
    network,
    egressAllow: config.egress.allow,
    capDrop: ['ALL'],
    securityOpt: ['no-new-privileges'],
    addHosts: networkPolicy(network).hostGateway ? ['host.docker.internal:host-gateway'] : [],
  };
}

function workspace(cwd: string): Mount {
  return { type: 'bind', source: cwd, target: WORKSPACE_ROOT, readonly: false };
}

/**
 * Install from the manifest/lockfile.
 *
 * Default: writable root (pnpm needs it) with persistence paths + manifest read-only.
 * `frozen`: a reproducible install that writes only node_modules — so for every package
 * manager except pnpm (npm, yarn, bun) the **entire source tree is read-only** (the strongest
 * mode). pnpm still writes a root temp even when frozen, so it keeps the writable-root model
 * (with the lockfile locked too).
 */
export function planInstall(config: SandboxConfig, facts: ProjectFacts, args: string[] = [], opts: PlanOptions = {}): RunPlan {
  const frozen = opts.frozen ?? config.install.frozen;
  const fullReadOnly = frozen && facts.pm !== 'pnpm';
  return {
    ...commonPlan(config, facts, config.install.network, opts),
    workdir: WORKSPACE_ROOT, // install always runs at the root, never a sub-dir
    argv: frozen ? frozenInstallArgv(facts.pm, facts.isYarnBerry, args) : pmArgv(facts.pm, 'install', args),
    mounts: installMounts(config, facts, { frozen, fullReadOnly }),
    ports: [],
    interactive: false,
  };
}

function installMounts(config: SandboxConfig, facts: ProjectFacts, { frozen, fullReadOnly }: { frozen: boolean; fullReadOnly: boolean }): Mount[] {
  const grants = grantMounts(facts, config);
  if (fullReadOnly) {
    // Whole tree read-only; only node_modules writable. Nothing to persist into.
    return [
      { type: 'bind', source: facts.cwd, target: WORKSPACE_ROOT, readonly: true },
      { type: 'bind', source: path.join(facts.cwd, 'node_modules'), target: `${WORKSPACE_ROOT}/node_modules`, readonly: false },
      ...grants,
    ];
  }
  const mounts: Mount[] = [workspace(facts.cwd), ...protectionMounts(facts, { protectManifest: true })];
  if (frozen && facts.hasLockfile) {
    // pnpm frozen: root must stay writable (temp), but the lockfile won't be written — lock it.
    const lf = lockfileName(facts.pm);
    mounts.push({ type: 'bind', source: path.join(facts.cwd, lf), target: `${WORKSPACE_ROOT}/${lf}`, readonly: true });
  }
  return [...mounts, ...grants];
}

/** Deliberate dependency change: package.json writable; persistence paths still locked. */
export function planAdd(config: SandboxConfig, facts: ProjectFacts, pkgs: string[], opts: PlanOptions = {}): RunPlan {
  return {
    ...commonPlan(config, facts, config.install.network, opts),
    workdir: WORKSPACE_ROOT, // add mutates the root manifest — always run at the root
    argv: pmArgv(facts.pm, 'add', pkgs),
    mounts: [workspace(facts.cwd), ...protectionMounts(facts, { protectManifest: false }), ...grantMounts(facts, config)],
    ports: [],
    interactive: false,
  };
}

/** Dev loop: full read-write tree, ports, default no-network. `argv` is your command. */
export function planRun(config: SandboxConfig, facts: ProjectFacts, argv: string[], opts: PlanOptions = {}): RunPlan {
  return {
    ...commonPlan(config, facts, config.run.network, opts),
    workdir: opts.workdir ?? WORKSPACE_ROOT, // run/shell honour the invocation sub-dir
    argv,
    mounts: [workspace(facts.cwd), ...grantMounts(facts, config)],
    ports: runPorts(config),
    interactive: true,
  };
}

/** Ports to publish for a run: the configured list plus, when `devPorts` is set, the
 * common framework dev-server ports. Empty when the network mode publishes nothing. */
function runPorts(config: SandboxConfig): string[] {
  if (!networkPolicy(config.run.network).publishPorts) return [];
  const dev = config.run.devPorts ? COMMON_DEV_PORTS.map((p) => `${p}:${p}`) : [];
  return [...new Set([...config.run.ports, ...dev])];
}
