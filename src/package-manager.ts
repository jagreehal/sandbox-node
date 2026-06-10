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

/**
 * The command to run inside the container. npm uses `install` for both modes
 * (`npm install <pkg>` adds); pnpm/yarn/bun use `add`. Args are appended verbatim.
 */
export function pmArgv(pm: PackageManager, mode: InstallMode, args: string[]): string[] {
  const verb = mode === 'add' ? 'add' : 'install';
  switch (pm) {
    case 'npm':
      return ['npm', 'install', ...args];
    case 'pnpm':
      return ['corepack', 'pnpm', verb, ...args];
    case 'yarn':
      return ['corepack', 'yarn', verb, ...args];
    case 'bun':
      return ['bun', verb, ...args];
  }
}

/** Yarn Berry (>=2) projects carry a .yarnrc.yml and use `--immutable`, not `--frozen-lockfile`. */
export function isYarnBerry(cwd: string): boolean {
  return existsSync(path.join(cwd, '.yarnrc.yml'));
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
