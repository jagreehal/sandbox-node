import path from 'node:path';
import type { NetworkMode, SandboxConfig } from './config.js';
import { type BuildSpec, resolveBuildSpec } from './image.js';
import { COMMON_DEV_PORTS, networkPolicy } from './network.js';
import { frozenInstallArgv, lockfileName, packageManagerCacheDir, pmArgv, type PackageManager } from './package-manager.js';
import { PERSISTENCE_PATHS, type ProjectFacts } from './project.js';

/**
 * A mount. `bind` exposes a host path; `volume` is a container volume. A volume with no `source`
 * is anonymous (used as a read-only block, e.g. to stop a postinstall *creating* a `.github/`
 * that isn't there); a volume *with* a `source` is a named, persistent volume (the package-manager
 * cache). Plan stays serializable.
 */
export interface Mount {
  type: 'bind' | 'volume';
  /** `bind`: host path (required). `volume`: the named-volume name, or omitted for an anonymous volume. */
  source?: string;
  target: string;
  readonly: boolean;
}

/** A fully-resolved, serializable description of one container invocation. */
export interface RunPlan {
  image: string;
  /** How to build {@link image} when it's missing (base, extras, or a custom Dockerfile). */
  build: BuildSpec;
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

function grantMounts(facts: ProjectFacts, config: SandboxConfig, opts: { claudeReadonly?: boolean } = {}): Mount[] {
  const { cwd, homedir } = facts;
  const mounts: Mount[] = [];
  if (config.grants['ssh-agent']) {
    mounts.push({ type: 'bind', source: '/run/host-services/ssh-auth.sock', target: '/ssh-agent', readonly: false });
  }
  if (config.grants.claude === 'project') {
    mounts.push({ type: 'bind', source: path.join(cwd, '.claude-sandbox'), target: `${CONTAINER_HOME}/.claude`, readonly: opts.claudeReadonly ?? false });
  } else if (config.grants.claude === 'home') {
    mounts.push({ type: 'bind', source: path.join(homedir, '.claude'), target: `${CONTAINER_HOME}/.claude`, readonly: opts.claudeReadonly ?? false });
  }
  for (const spec of config.grants.paths) {
    const { src, readonly } = parsePathSpec(spec, cwd, homedir);
    mounts.push({ type: 'bind', source: src, target: `/grants/${path.basename(src)}`, readonly });
  }
  return mounts;
}

function protectedPersistencePaths(config: SandboxConfig): string[] {
  return config.grants.claude === 'project' ? [...PERSISTENCE_PATHS, '.claude-sandbox'] : PERSISTENCE_PATHS;
}

/**
 * Read-only protection for persistence vectors (and, for `install`, the manifest).
 * Existing paths are bound read-only; missing ones get a read-only volume so they
 * can't be created. The package manager still gets a writable root for lockfile /
 * temp writes — what every PM (notably pnpm) needs.
 */
function protectionMounts(facts: ProjectFacts, config: SandboxConfig, opts: { protectManifest: boolean }): Mount[] {
  const mounts: Mount[] = [];
  for (const p of protectedPersistencePaths(config)) {
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
  const image = opts.image ?? config.image;
  return {
    image,
    build: resolveBuildSpec(config, image, facts.cwd),
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
 * A persistent, named cache volume for a package manager's download store. Shared per-manager
 * across projects — the normal way these caches work — so the second fetch of a dependency is a
 * copy from the volume, not a re-download. The name is stable and `--frozen`-safe (the cache dir
 * lives under HOME, never inside the read-only tree).
 */
function cacheVolume(pm: PackageManager): Mount {
  return { type: 'volume', source: `sandbox-cache-${pm}`, target: packageManagerCacheDir(pm), readonly: false };
}

/** Install-class cache: the project's package manager. Empty when caching is off. */
function cacheMounts(config: SandboxConfig, facts: ProjectFacts): Mount[] {
  return config.install.cache ? [cacheVolume(facts.pm)] : [];
}

/**
 * Fetch-and-run runners (`npx`, `bunx`, `pnpx`, `<pm> dlx`) download packages before running, so
 * they benefit from the same warm cache — keyed to the runner's own manager (npx → npm, bunx →
 * bun, …). Plain `npm test` / `npm run dev` / `node` install nothing, so they get no cache mount.
 */
function runnerPackageManager(argv: string[]): PackageManager | undefined {
  const [leader, second] = argv;
  if (leader === 'npx') return 'npm';
  if (leader === 'pnpx') return 'pnpm';
  if (leader === 'bunx') return 'bun';
  if ((leader === 'pnpm' || leader === 'yarn') && second === 'dlx') return leader;
  return undefined;
}

function runCacheMounts(config: SandboxConfig, argv: string[]): Mount[] {
  if (!config.install.cache) return [];
  const pm = runnerPackageManager(argv);
  return pm ? [cacheVolume(pm)] : [];
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
  const grants = grantMounts(facts, config, { claudeReadonly: true });
  const cache = cacheMounts(config, facts);
  if (fullReadOnly) {
    // Whole tree read-only; only node_modules writable. Nothing to persist into.
    return [
      { type: 'bind', source: facts.cwd, target: WORKSPACE_ROOT, readonly: true },
      { type: 'bind', source: path.join(facts.cwd, 'node_modules'), target: `${WORKSPACE_ROOT}/node_modules`, readonly: false },
      ...cache,
      ...grants,
    ];
  }
  const mounts: Mount[] = [workspace(facts.cwd), ...protectionMounts(facts, config, { protectManifest: true })];
  if (frozen && facts.hasLockfile) {
    // pnpm frozen: root must stay writable (temp), but the lockfile won't be written — lock it.
    const lf = lockfileName(facts.pm);
    mounts.push({ type: 'bind', source: path.join(facts.cwd, lf), target: `${WORKSPACE_ROOT}/${lf}`, readonly: true });
  }
  return [...mounts, ...cache, ...grants];
}

function planInstallClassMutation(config: SandboxConfig, facts: ProjectFacts, argv: string[], opts: PlanOptions = {}): RunPlan {
  return {
    ...commonPlan(config, facts, config.install.network, opts),
    workdir: WORKSPACE_ROOT,
    argv,
    mounts: [workspace(facts.cwd), ...protectionMounts(facts, config, { protectManifest: false }), ...cacheMounts(config, facts), ...grantMounts(facts, config, { claudeReadonly: true })],
    ports: [],
    interactive: false,
  };
}

/** Deliberate dependency change: package.json writable; persistence paths still locked. */
export function planAdd(config: SandboxConfig, facts: ProjectFacts, pkgs: string[], opts: PlanOptions = {}): RunPlan {
  return planInstallClassMutation(config, facts, pmArgv(facts.pm, 'add', pkgs), opts);
}

/**
 * Update existing deps to newer versions (`npm update`, `pnpm up`, `yarn upgrade`, `bun update`).
 * Install-class: registry egress (default-deny allowlist) so it can resolve, and manifest writable
 * like `add` — `--save`/`--latest` rewrite ranges, and update is itself a deliberate dep change.
 * `argv` is the resolved update command.
 */
export function planUpdate(config: SandboxConfig, facts: ProjectFacts, argv: string[], opts: PlanOptions = {}): RunPlan {
  return planInstallClassMutation(config, facts, argv, opts);
}

/** Audit remediation mutates the lockfile/tree, so it gets install-class isolation like update. */
export function planAuditFix(config: SandboxConfig, facts: ProjectFacts, argv: string[], opts: PlanOptions = {}): RunPlan {
  return planInstallClassMutation(config, facts, argv, opts);
}

/**
 * Read-only registry audit — `audit` (advisory report) and `audit signatures` (provenance check).
 * Both only read the tree, query the registry, and print, so the WHOLE tree is mounted READ-ONLY:
 * the strongest boundary that can't break a command that never writes. Egress is the default-deny
 * allowlist (it needs the registry, not the no-network run default). No install gates — nothing is
 * installed. If a package-manager path ever genuinely needs to write here, relax THAT path, not this.
 */
function planRegistryAudit(config: SandboxConfig, facts: ProjectFacts, argv: string[], opts: PlanOptions = {}): RunPlan {
  return {
    ...commonPlan(config, facts, config.install.network, opts),
    workdir: opts.workdir ?? WORKSPACE_ROOT,
    argv,
    mounts: [{ type: 'bind', source: facts.cwd, target: WORKSPACE_ROOT, readonly: true }, ...grantMounts(facts, config, { claudeReadonly: true })],
    ports: [],
    interactive: false,
  };
}

/** Report-only audit (`npm/pnpm/yarn/bun audit`): read-only tree, registry egress, no gates. */
export function planAudit(config: SandboxConfig, facts: ProjectFacts, argv: string[], opts: PlanOptions = {}): RunPlan {
  return planRegistryAudit(config, facts, argv, opts);
}

/** Signature/provenance verification (`audit signatures`): read-only tree, registry egress, no gates. */
export function planAuditSignatures(config: SandboxConfig, facts: ProjectFacts, argv: string[], opts: PlanOptions = {}): RunPlan {
  return planRegistryAudit(config, facts, argv, opts);
}

/** Dev loop: full read-write tree, ports, default no-network. `argv` is your command. */
export function planRun(config: SandboxConfig, facts: ProjectFacts, argv: string[], opts: PlanOptions = {}): RunPlan {
  const plan: RunPlan = {
    ...commonPlan(config, facts, config.run.network, opts),
    workdir: opts.workdir ?? WORKSPACE_ROOT, // run/shell honour the invocation sub-dir
    argv,
    mounts: [workspace(facts.cwd), ...runCacheMounts(config, argv), ...grantMounts(facts, config)],
    ports: runPorts(config),
    interactive: true,
  };
  if (config.run.devPorts && !plan.env.HOST) {
    plan.env.HOST = '0.0.0.0';
  }
  return plan;
}

/** The configured run ports plus, when `devPorts` is set, the common framework dev-server ports. */
function configuredPorts(config: SandboxConfig): string[] {
  const dev = config.run.devPorts ? COMMON_DEV_PORTS.map((p) => `${p}:${p}`) : [];
  return [...new Set([...config.run.ports, ...dev])];
}

/** Ports to publish for a run — empty when the network mode publishes nothing. */
function runPorts(config: SandboxConfig): string[] {
  return networkPolicy(config.run.network).publishPorts ? configuredPorts(config) : [];
}
