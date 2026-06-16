import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Cross-platform native-dependency detection.
 *
 * The sandbox runs installs inside a Linux container. Package managers resolve
 * platform-specific optional dependencies for the *running* platform, so on a
 * macOS or Windows host the resulting `node_modules` carries Linux-native
 * binaries (`@rollup/rollup-linux-arm64-gnu`, `@esbuild/linux-x64`, …) and the
 * host's own toolchain can't load them. We detect that after an install and
 * point the user at the fix, rather than letting `vitest`/`vite`/`tsx` fail on
 * the host with a cryptic "Cannot find module @rollup/rollup-darwin-arm64".
 */

export interface HostPlatform {
  os: NodeJS.Platform;
  cpu: string;
}

export function hostPlatform(): HostPlatform {
  return { os: process.platform, cpu: process.arch };
}

/** Tokens that platform-specific native packages carry in their directory name. */
const OS_NAME_TOKENS = ['linux', 'darwin', 'win32', 'windows', 'freebsd', 'android'];

interface PlatformManifest {
  os?: string | string[];
  cpu?: string | string[];
}

function fieldSatisfies(field: string | string[] | undefined, value: string): boolean {
  if (field === undefined) return true;
  const list = Array.isArray(field) ? field : [field];
  if (list.length === 0) return true;
  const negations = list.filter((e) => e.startsWith('!')).map((e) => e.slice(1));
  if (negations.includes(value)) return false;
  const positives = list.filter((e) => !e.startsWith('!'));
  if (positives.length === 0) return true; // only negations present → anything not negated passes
  return positives.includes(value);
}

/**
 * Does `host` satisfy a package's `os`/`cpu` constraints? Follows npm semantics:
 * absent/empty = any platform; a list matches when it contains the value; a
 * `!`-prefixed entry excludes that value.
 */
export function hostSatisfies(manifest: PlatformManifest, host: HostPlatform): boolean {
  return fieldSatisfies(manifest.os, host.os) && fieldSatisfies(manifest.cpu, host.cpu);
}

function looksPlatformSpecific(dirName: string): boolean {
  const lower = dirName.toLowerCase();
  return OS_NAME_TOKENS.some((token) => lower.includes(token));
}

function readManifest(dir: string): PlatformManifest | undefined {
  try {
    return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as PlatformManifest;
  } catch {
    return undefined;
  }
}

function safeReadDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function inspectPackageDir(dir: string, name: string, host: HostPlatform, found: Set<string>): void {
  const manifest = readManifest(dir);
  // No platform constraint at all -> not a platform-bound package.
  if (!manifest || (manifest.os === undefined && manifest.cpu === undefined)) return;
  if (!hostSatisfies(manifest, host)) found.add(name);
}

function scanNodeModulesDir(nodeModulesDir: string, host: HostPlatform, found: Set<string>): void {
  for (const entry of safeReadDir(nodeModulesDir)) {
    if (entry === '.pnpm') {
      scanPnpmVirtualStore(path.join(nodeModulesDir, entry), host, found);
      continue;
    }
    if (entry.startsWith('.')) continue;
    const full = path.join(nodeModulesDir, entry);

    if (entry.startsWith('@')) {
      for (const inner of safeReadDir(full)) {
        const pkgDir = path.join(full, inner);
        if (!isDirectory(pkgDir)) continue;
        if (looksPlatformSpecific(inner)) inspectPackageDir(pkgDir, `${entry}/${inner}`, host, found);
        const nested = path.join(pkgDir, 'node_modules');
        if (existsSync(nested)) scanNodeModulesDir(nested, host, found);
      }
      continue;
    }

    if (!isDirectory(full)) continue;
    if (looksPlatformSpecific(entry)) inspectPackageDir(full, entry, host, found);
    const nested = path.join(full, 'node_modules');
    if (existsSync(nested)) scanNodeModulesDir(nested, host, found);
  }
}

function scanPnpmVirtualStore(storeDir: string, host: HostPlatform, found: Set<string>): void {
  for (const entry of safeReadDir(storeDir)) {
    const nestedNodeModules = path.join(storeDir, entry, 'node_modules');
    if (!existsSync(nestedNodeModules)) continue;
    scanNodeModulesDir(nestedNodeModules, host, found);
  }
}

/**
 * Find installed packages that can't load on `host` because their declared
 * `os`/`cpu` excludes it — i.e. native optional deps fetched for a different
 * platform (typically the Linux sandbox, when the host is macOS/Windows).
 *
 * Returns the sorted package names. Self-gating: when the install platform and
 * the host match, every installed variant satisfies the host and the result is
 * empty. Only packages whose directory name carries a platform token are
 * inspected (the universal naming convention for these deps), so this stays
 * cheap even on large trees.
 */
export function findHostIncompatiblePackages(nodeModulesDir: string, host: HostPlatform): string[] {
  if (!existsSync(nodeModulesDir)) return [];
  const found = new Set<string>();
  scanNodeModulesDir(nodeModulesDir, host, found);
  return [...found].sort();
}

function collectWorkspaceNodeModulesDirs(root: string, out: string[]): void {
  if (!existsSync(root) || !isDirectory(root)) return;
  for (const entry of safeReadDir(root)) {
    if (entry === 'node_modules') {
      const nodeModulesDir = path.join(root, entry);
      if (isDirectory(nodeModulesDir)) out.push(nodeModulesDir);
      continue;
    }
    if (entry.startsWith('.')) continue;
    const child = path.join(root, entry);
    if (isDirectory(child)) collectWorkspaceNodeModulesDirs(child, out);
  }
}

export function findHostIncompatiblePackagesInWorkspace(workspaceRoot: string, host: HostPlatform): string[] {
  const nodeModulesDirs: string[] = [];
  collectWorkspaceNodeModulesDirs(workspaceRoot, nodeModulesDirs);
  const found = new Set<string>();
  for (const nodeModulesDir of nodeModulesDirs) {
    for (const pkg of findHostIncompatiblePackages(nodeModulesDir, host)) found.add(pkg);
  }
  return [...found].sort();
}
