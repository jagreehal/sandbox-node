import path from 'node:path';
import { capture, quiet } from './exec.js';
import { readConfig, type SandboxConfig } from './config.js';
import { lockfileName, lockfilePresent, resolvePackageManager } from './package-manager.js';
import { missingAllowHosts, projectRegistryHints, renderAllowCommand, renderAllowlistSnippet } from './registry.js';
import { runtimeVulnerabilities } from './runtime-cve.js';

export interface DoctorOptions {
  config?: string;
  image?: string;
  backend: 'docker' | 'podman';
  invocationCwd?: string;
  runWorkdir?: string;
}

interface Check {
  level: 'ok' | 'fail' | 'info';
  label: string;
  detail: string;
  fixes?: string[];
}

function print(check: Check): void {
  console.log(`[${check.level}] ${check.label}: ${check.detail}`);
  for (const fix of check.fixes ?? []) console.log(`  fix: ${fix}`);
}

function installCommand(backend: 'docker' | 'podman'): string {
  if (process.platform === 'darwin') return backend === 'docker' ? 'brew install --cask docker' : 'brew install podman';
  return backend === 'docker' ? 'install Docker and ensure `docker` is on PATH' : 'install Podman and ensure `podman` is on PATH';
}

function startCommand(backend: 'docker' | 'podman'): string {
  if (process.platform === 'darwin') return backend === 'docker' ? 'open -a Docker' : 'podman machine start';
  return backend === 'docker' ? 'sudo systemctl start docker' : 'start the Podman service or machine for this host';
}

export async function runDoctor(cwd: string, opts: DoctorOptions): Promise<number> {
  const checks: Check[] = [];
  let failed = false;

  let config: SandboxConfig | undefined;
  try {
    config = readConfig(cwd, opts.config);
    checks.push({
      level: 'ok',
      label: 'config',
      detail: opts.config ?? path.join(cwd, 'sandbox.config.json'),
    });
  } catch (e) {
    failed = true;
    checks.push({
      level: 'fail',
      label: 'config',
      detail: e instanceof Error ? e.message.replace(/^sandbox:\s*/, '') : String(e),
    });
  }

  const pm = resolvePackageManager(cwd);
  const lockfile = lockfileName(pm);
  const hasLockfile = lockfilePresent(cwd, pm);
  checks.push({
    level: hasLockfile ? 'ok' : 'info',
    label: 'package manager',
    detail: hasLockfile ? `${pm} (${lockfile})` : `${pm} (no ${lockfile} yet)`,
    fixes: hasLockfile ? undefined : [`run \`sandbox ${pm} install\` to create ${lockfile}`],
  });
  if (opts.invocationCwd && opts.invocationCwd !== cwd) {
    checks.push({ level: 'info', label: 'workspace root', detail: cwd });
    if (opts.runWorkdir) checks.push({ level: 'info', label: 'package workdir', detail: opts.runWorkdir });
  }
  if (config) {
    const registry = projectRegistryHints(cwd);
    if (registry.hosts.length) {
      const missing = missingAllowHosts(config.egress.allow, registry.hosts);
      checks.push({
        level: missing.length ? 'info' : 'ok',
        label: 'registry hosts',
        detail: missing.length
          ? `${registry.hosts.join(', ')} (.npmrc; missing from egress.allow: ${missing.join(', ')})`
          : `${registry.hosts.join(', ')} (.npmrc; covered by egress.allow)`,
        fixes: missing.length ? [renderAllowCommand(missing), renderAllowlistSnippet(config.egress.allow, missing)] : undefined,
      });
    }
    if (registry.authEnvNames.length) {
      const missingEnvGrants = registry.authEnvNames.filter((name) => !config.grants.env.includes(name));
      const unsetHostEnv = registry.authEnvNames.filter((name) => process.env[name] === undefined);
      checks.push({
        level: missingEnvGrants.length || unsetHostEnv.length ? 'info' : 'ok',
        label: 'registry auth',
        detail: `${registry.authEnvNames.join(', ')} referenced in .npmrc`,
        fixes: [
          ...(missingEnvGrants.length ? [`add to config: ${JSON.stringify({ grants: { env: [...config.grants.env, ...missingEnvGrants].sort() } })}`] : []),
          ...(unsetHostEnv.length ? unsetHostEnv.map((name) => `export ${name}=...`) : []),
        ],
      });
    }
  }

  const version = await capture(opts.backend, ['--version']);
  if (version.code !== 0) {
    failed = true;
    checks.push({
      level: 'fail',
      label: 'backend',
      detail: version.stderr.trim() || version.stdout.trim() || `${opts.backend} not found`,
      fixes: [installCommand(opts.backend), 'rerun: sandbox doctor'],
    });
  } else {
    checks.push({
      level: 'ok',
      label: 'backend',
      detail: version.stdout.trim() || version.stderr.trim(),
    });

    const info = await capture(opts.backend, ['info']);
    if (info.code !== 0) {
      failed = true;
      checks.push({
        level: 'fail',
        label: 'daemon',
        detail: info.stderr.trim() || info.stdout.trim() || `${opts.backend} info failed`,
        fixes: [startCommand(opts.backend), 'rerun: sandbox doctor'],
      });
    } else {
      checks.push({ level: 'ok', label: 'daemon', detail: 'reachable' });

      // A container-escape CVE in the runtime defeats every containment guarantee, so
      // flag a stale one. Prefer the runc version (often a commit hash in `info`, which
      // simply falls through); else use the Docker engine version. runc only for docker.
      const runcMatch = /runc version:\s*(\S+)/i.exec(info.stdout);
      const vulns = runtimeVulnerabilities({
        engine: opts.backend === 'docker' ? version.stdout : undefined,
        runc: runcMatch?.[1],
      });
      if (vulns.length) {
        for (const v of vulns) {
          checks.push({ level: 'info', label: 'runtime security', detail: `${v.name} (${v.id}): ${v.detail}`, fixes: [v.fix] });
        }
      } else {
        checks.push({ level: 'ok', label: 'runtime security', detail: 'no known container-escape CVE for the reported runtime' });
      }
    }

    if (config) {
      const image = opts.image ?? config.image;
      const cached = await quiet(opts.backend, ['image', 'inspect', image]);
      checks.push({
        level: cached === 0 ? 'ok' : 'info',
        label: 'image',
        detail: cached === 0 ? `${image} is present` : `${image} will build on first use`,
        fixes: cached === 0 ? undefined : ['run `sandbox build` to build it now'],
      });
      checks.push({
        level: 'info',
        label: 'policy',
        detail: `install=${config.install.network}${config.install.frozen ? ', frozen' : ''}; run=${config.run.network}`,
      });
    }
  }

  for (const check of checks) print(check);
  return failed ? 1 : 0;
}
