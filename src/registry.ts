import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { readConfig, writeConfig } from './config.js';

export interface RegistryHints {
  hosts: string[];
  authEnvNames: string[];
}

/**
 * The bare host (`registry.npmjs.org`, with port if present) from any of the forms a
 * registry/allowlist entry takes: a full URL (`https://registry.npmjs.org/`), an npmrc
 * scheme-relative auth line (`//registry.npmjs.org/:_authToken=…`), or a bare host
 * (`registry.npmjs.org`, `registry.local:4873/path`). One parser so `sandbox allow` and
 * the `.npmrc` detector agree on what a host is.
 */
function hostFrom(raw: string): string | undefined {
  const value = raw.trim();
  if (!value) return undefined;
  if (value.includes('://')) {
    try {
      return new URL(value).host || undefined;
    } catch {
      return undefined;
    }
  }
  return value.replace(/^\/\//, '').replace(/\/.*$/, '') || undefined;
}

export function readProjectNpmrc(cwd: string): string | undefined {
  const file = path.join(cwd, '.npmrc');
  if (!existsSync(file)) return undefined;
  return readFileSync(file, 'utf8');
}

export function detectRegistryHints(text: string): RegistryHints {
  const hosts = new Set<string>();
  const authEnvNames = new Set<string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const [key, ...rest] = line.split('=');
    if (!key || rest.length === 0) continue;
    const value = rest.join('=').trim();
    if (key === 'registry' || key.endsWith(':registry')) {
      const host = hostFrom(value);
      if (host) hosts.add(host);
    }
    const envRefs = value.matchAll(/\$\{([A-Z0-9_]+)\}/g);
    for (const match of envRefs) {
      const name = match[1];
      if (name) authEnvNames.add(name);
    }
  }
  return {
    hosts: [...hosts].sort(),
    authEnvNames: [...authEnvNames].sort(),
  };
}

export function projectRegistryHints(cwd: string): RegistryHints {
  const npmrc = readProjectNpmrc(cwd);
  return npmrc ? detectRegistryHints(npmrc) : { hosts: [], authEnvNames: [] };
}

/**
 * Hosts an install in `cwd` is likely to need beyond the npm registry, so `init`/`setup` can
 * pre-fill `egress.allow` and the first run "just works" instead of failing on a blocked host.
 * Sources: a private/scoped registry in `.npmrc`, and `github.com`/`codeload.github.com` when any
 * dependency is a git/github spec. Native-module hosts (`nodejs.org`) aren't auto-detected; add
 * them with `sandbox allow` if a build needs them.
 */
export function detectEgressHosts(cwd: string): string[] {
  const hosts = new Set<string>(projectRegistryHints(cwd).hosts);
  try {
    const pkg = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8')) as Record<string, unknown>;
    const specs: string[] = [];
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      const group = pkg[field];
      if (group && typeof group === 'object') specs.push(...Object.values(group as Record<string, unknown>).filter((v): v is string => typeof v === 'string'));
    }
    if (specs.some((spec) => /^(github:|git\+|git:)/.test(spec) || spec.includes('github.com'))) {
      hosts.add('github.com');
      hosts.add('codeload.github.com');
    }
  } catch {
    // no/invalid package.json — registry hints alone
  }
  return [...hosts].sort();
}

export function missingAllowHosts(currentAllow: string[], wantedHosts: string[]): string[] {
  const allow = new Set(currentAllow.map((host) => host.toLowerCase()));
  return [...new Set(wantedHosts)]
    .filter((host) => !allow.has(host.toLowerCase()))
    .sort();
}

export function renderAllowCommand(hosts: string[]): string {
  return `sandbox allow ${hosts.join(' ')}`;
}

export function renderAllowlistSnippet(currentAllow: string[], addHosts: string[]): string {
  const next = [...new Set([...currentAllow, ...addHosts])].sort();
  return JSON.stringify({ egress: { allow: next } }, null, 2);
}

export function allowHosts(cwd: string, hosts: string[], configPath?: string): { file: string; added: string[]; allow: string[] } {
  const file = configPath ?? path.join(cwd, 'sandbox.config.json');
  const config = readConfig(cwd, configPath);
  const normalized = hosts.map(hostFrom).filter((host): host is string => Boolean(host));
  const added = missingAllowHosts(config.egress.allow, normalized);
  const allow = [...new Set([...config.egress.allow, ...normalized])].sort();
  writeConfig(file, { ...config, egress: { ...config.egress, allow } });
  return { file, added, allow };
}
