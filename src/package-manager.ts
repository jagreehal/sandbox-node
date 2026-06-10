import { existsSync } from 'node:fs';
import path from 'node:path';

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';
export type InstallMode = 'install' | 'add';

const LOCKFILES: Record<PackageManager, string> = {
  npm: 'package-lock.json',
  pnpm: 'pnpm-lock.yaml',
  yarn: 'yarn.lock',
  bun: 'bun.lock',
};

/** bun writes either the text `bun.lock` (default since 1.2) or the legacy binary `bun.lockb`. */
const BUN_LOCKFILES = ['bun.lock', 'bun.lockb'] as const;

const EXACT_FLAGS = new Set(['--save-exact', '--exact', '-E', '-e']);
const YARN_RANGE_FLAGS = new Set(['--caret', '-C', '--tilde', '-T', '--exact', '-E']);

function lockfileCandidates(pm: PackageManager): readonly string[] {
  return pm === 'bun' ? BUN_LOCKFILES : [LOCKFILES[pm]];
}

/** Detect the package manager from the lockfile present in `cwd` (npm fallback). */
export function resolvePackageManager(cwd: string): PackageManager {
  if (existsSync(path.join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(path.join(cwd, 'yarn.lock'))) return 'yarn';
  if (BUN_LOCKFILES.some((f) => existsSync(path.join(cwd, f)))) return 'bun';
  return 'npm';
}

/** The canonical lockfile name for messages (bun reports the modern `bun.lock`). */
export function lockfileName(pm: PackageManager): string {
  return LOCKFILES[pm];
}

/** Whether a committed lockfile is present — accepts either bun spelling. */
export function lockfilePresent(cwd: string, pm: PackageManager): boolean {
  return lockfileCandidates(pm).some((f) => existsSync(path.join(cwd, f)));
}

function defaultExactArgs(pm: PackageManager, args: string[]): string[] {
  if (pm === 'yarn') {
    return args.some((a) => YARN_RANGE_FLAGS.has(a)) ? args : ['--exact', ...args];
  }
  return args.some((a) => EXACT_FLAGS.has(a))
    ? args
    : [pm === 'bun' ? '--exact' : '--save-exact', ...args];
}

/**
 * The command to run inside the container. npm uses `install` for both modes
 * (`npm install <pkg>` adds); pnpm/yarn/bun use `add`. Dependency adds are saved as exact
 * versions by default across all package managers; explicit yarn range flags still win.
 */
export function pmArgv(pm: PackageManager, mode: InstallMode, args: string[]): string[] {
  const verb = mode === 'add' ? 'add' : 'install';
  const rest = mode === 'add' ? defaultExactArgs(pm, args) : args;
  switch (pm) {
    case 'npm':
      return ['npm', 'install', ...rest];
    case 'pnpm':
      return ['corepack', 'pnpm', verb, ...rest];
    case 'yarn':
      return ['corepack', 'yarn', verb, ...rest];
    case 'bun':
      return ['bun', verb, ...rest];
  }
}

/** Yarn Berry (>=2) projects carry a .yarnrc.yml and use `--immutable`, not `--frozen-lockfile`. */
export function isYarnBerry(cwd: string): boolean {
  return existsSync(path.join(cwd, '.yarnrc.yml'));
}

/**
 * The container path each package manager keeps its download cache / content store in (under
 * `HOME=/root`). Persisting this in a named volume across runs avoids re-downloading tarballs; it
 * lives outside `/workspace`, so it works even under a fully read-only `--frozen` tree.
 *
 * Why a single shared (per-manager) volume is sound: every entry is **content-addressed** — the
 * key is the package's integrity hash (npm cacache / pnpm store / yarn / bun all do this). A
 * tampered entry hashes to a different key, so it can't be substituted for the real package and a
 * mismatched entry is refetched. That's the cache-*poisoning* threat closed, and it's exactly how
 * these tools natively share one global store across every project on a dev machine. It does NOT
 * isolate *contents* between repos: a sandboxed install in one repo can read private-registry
 * tarballs another repo cached here (default-deny egress still stops it leaving). For installs that
 * must be fully isolated from each other, set `install.cache: false`.
 */
export function packageManagerCacheDir(pm: PackageManager): string {
  switch (pm) {
    case 'npm':
      return '/root/.npm';
    case 'pnpm':
      return '/root/.local/share/pnpm/store';
    case 'yarn':
      return '/root/.cache/yarn';
    case 'bun':
      return '/root/.bun/install/cache';
  }
}

/**
 * Build the update argv, preserving the verb the user typed (`npm up` vs `npm update`, `yarn
 * upgrade` vs `yarn up`). pnpm/yarn run through corepack like the other verbs.
 */
export function pmUpdateArgv(pm: PackageManager, verb: string, args: string[]): string[] {
  switch (pm) {
    case 'npm':
      return ['npm', verb, ...args];
    case 'pnpm':
      return ['corepack', 'pnpm', verb, ...args];
    case 'yarn':
      return ['corepack', 'yarn', verb, ...args];
    case 'bun':
      return ['bun', verb, ...args];
  }
}

/**
 * The audit-fix argv for package managers that support an in-place remediation command. npm uses
 * the positional `fix` subcommand; pnpm uses `--fix` / `--fix=update`. `fixToken` is preserved so
 * callers keep the exact repair mode the user requested.
 */
export function pmAuditFixArgv(pm: PackageManager, fixToken: string, args: string[]): string[] {
  switch (pm) {
    case 'npm':
      return ['npm', 'audit', fixToken, ...args];
    case 'pnpm':
      return ['corepack', 'pnpm', 'audit', fixToken, ...args];
    case 'yarn':
    case 'bun':
      throw new Error(`sandbox: ${pm} does not support an install-class audit fix command`);
  }
}

/**
 * Read-only signature/provenance verification against the configured registries. This talks to
 * registry key endpoints but does not mutate the manifest, lockfile, or dependency tree.
 */
export function pmAuditSignaturesArgv(pm: PackageManager, args: string[]): string[] {
  switch (pm) {
    case 'npm':
      return ['npm', 'audit', 'signatures', ...args];
    case 'pnpm':
      return ['corepack', 'pnpm', 'audit', 'signatures', ...args];
    case 'yarn':
    case 'bun':
      throw new Error(`sandbox: ${pm} does not support audit signatures`);
  }
}

/**
 * Reproducible install that writes ONLY node_modules (never the lockfile): `npm ci`,
 * `pnpm install --frozen-lockfile`, `yarn --frozen-lockfile`/`--immutable`. Requires a
 * committed, in-sync lockfile. Enables a fully read-only source tree (every PM except pnpm).
 * `yarnBerry` selects Yarn 2+'s `--immutable` (probed up-front by {@link ProjectFacts}).
 */
export function frozenInstallArgv(pm: PackageManager, yarnBerry: boolean, args: string[]): string[] {
  switch (pm) {
    case 'npm':
      return ['npm', 'ci', ...args];
    case 'pnpm':
      return ['corepack', 'pnpm', 'install', '--frozen-lockfile', ...args];
    case 'yarn':
      return ['corepack', 'yarn', 'install', yarnBerry ? '--immutable' : '--frozen-lockfile', ...args];
    case 'bun':
      return ['bun', 'install', '--frozen-lockfile', ...args];
  }
}
