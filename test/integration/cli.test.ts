import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fixture, runCli } from './helpers.js';

function fakeDocker(dir: string): string {
  const bin = path.join(dir, 'docker');
  writeFileSync(
    bin,
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "Docker version 27.0.0"
  exit 0
fi
if [ "$1" = "info" ]; then
  echo "server ready"
  exit 0
fi
if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then
  exit 1
fi
if [ "$1" = "build" ]; then
  exit 0
fi
exit 0
`,
  );
  chmodSync(bin, 0o755);
  return dir;
}

async function withRegistry(packuments: Record<string, unknown>, run: (url: string) => Promise<void>): Promise<void> {
  const server = createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? '/').slice(1));
    const body = packuments[name];
    if (!body) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind registry test server');
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

describe('cli (golden, no docker)', () => {
  it('prints help with all commands and globals', async () => {
    const { code, stdout } = await runCli(process.cwd(), ['help']);
    expect(code).toBe(0);
    for (const token of ['init', 'setup', 'allow', 'preflight', 'doctor', 'build', 'install', 'add', 'run', 'shell', '--config', '--image', '--backend', '--dev', '--interactive', '--full-network', '--frozen', '--risk', '--fail-on-risk', '--json']) {
      expect(stdout).toContain(token);
    }
  });

  it('surfaces registry risk hints before install and can block on them', async () => {
    const dir = fixture({ 'package.json': '{"name":"x"}' });
    // Publish time is relative to now so the "<24h" strong signal fires deterministically;
    // a fixed date would silently stop triggering once real time drifts past the window.
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    await withRegistry(
      {
        sharp: {
          name: 'sharp',
          'dist-tags': { latest: '0.33.5' },
          time: {
            created: '2024-01-01T00:00:00.000Z',
            '0.33.5': threeHoursAgo,
          },
          versions: {
            '0.33.5': {
              scripts: { postinstall: 'node install/check.js' },
              bin: { sharp: './cli.js' },
            },
          },
        },
      },
      async (url) => {
        const { code, stderr } = await runCli(dir, ['--fail-on-risk', 'npm', 'install', 'sharp@0.33.5'], {
          SANDBOX_NPM_REGISTRY: url,
        });
        expect(code).toBe(1);
        expect(stderr).toContain('checked 1 package');
        expect(stderr.match(/sharp@0\.33\.5/g)?.length).toBe(1);
        expect(stderr).toContain('has postinstall script — contained in sandbox');
        expect(stderr).toContain('!! very recently published');
        expect(stderr).toContain('adds bin: sharp -> ./cli.js');
        expect(stderr).toContain('blocking because --fail-on-risk is set');
      },
    );
  });

  it('checks direct package.json deps for install commands with only flags', async () => {
    const dir = fixture({
      'package.json': JSON.stringify({
        name: 'x',
        dependencies: { sharp: '^0.33.0' },
      }),
    });
    await withRegistry(
      {
        sharp: {
          name: 'sharp',
          'dist-tags': { latest: '0.33.5' },
          time: {
            created: '2024-01-01T00:00:00.000Z',
            '0.33.5': '2026-06-08T06:00:00.000Z',
          },
          versions: {
            '0.33.0': {},
            '0.33.5': {
              scripts: { postinstall: 'node install/check.js' },
            },
          },
        },
      },
      async (url) => {
        const { code, stderr } = await runCli(dir, ['--fail-on-risk', 'npm', 'install', '--foreground-scripts'], {
          SANDBOX_NPM_REGISTRY: url,
        });
        expect(code).toBe(1);
        expect(stderr).toContain('checked 1 package');
        expect(stderr.match(/sharp@0\.33\.5/g)?.length).toBe(1);
      },
    );
  });

  it('risk-checks the package an npx/dlx command would fetch and run', async () => {
    const dir = fixture({ 'package.json': '{"name":"x"}' });
    await withRegistry(
      {
        sharp: {
          name: 'sharp',
          'dist-tags': { latest: '0.33.5' },
          time: { created: '2024-01-01T00:00:00.000Z', '0.33.5': '2026-06-08T06:00:00.000Z' },
          versions: { '0.33.5': { scripts: { postinstall: 'node install/check.js' } } },
        },
      },
      async (url) => {
        const { code, stderr } = await runCli(dir, ['--fail-on-risk', 'npx', 'sharp@0.33.5'], { SANDBOX_NPM_REGISTRY: url });
        expect(code).toBe(1); // blocked before the container runs
        expect(stderr).toContain('checked 1 package');
        expect(stderr).toContain('has postinstall script — contained in sandbox');
        expect(stderr).toContain('blocking because --fail-on-risk is set');
      },
    );
  });

  it('preflight blocks WITHOUT installing and suggests a known-good older version to pin', async () => {
    const dir = fixture({ 'package.json': '{"name":"x"}' });
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    await withRegistry(
      {
        'left-pad': {
          name: 'left-pad',
          'dist-tags': { latest: '1.3.0' },
          time: { created: '2020-01-01T00:00:00.000Z', '1.2.0': '2024-01-01T00:00:00.000Z', '1.3.0': threeHoursAgo },
          versions: { '1.2.0': {}, '1.3.0': {} },
        },
      },
      async (url) => {
        const { code, stderr } = await runCli(dir, ['--min-release-age', '7', 'preflight', 'npm', 'install', 'left-pad'], { SANDBOX_NPM_REGISTRY: url });
        expect(code).toBe(1); // would block — but nothing installed (no backend invoked)
        expect(stderr).toContain('blocked by the release-age gate (min 7 days)');
        expect(stderr).toContain('sandbox npm add left-pad@1.2.0'); // the concrete pin
        expect(stderr).toContain('would BLOCK this install');
      },
    );
  });

  it('preflight --json emits the findings plus a pin suggestion for the skill/agent', async () => {
    const dir = fixture({ 'package.json': '{"name":"x"}' });
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    await withRegistry(
      {
        'left-pad': {
          name: 'left-pad',
          'dist-tags': { latest: '1.3.0' },
          time: { created: '2020-01-01T00:00:00.000Z', '1.2.0': '2024-01-01T00:00:00.000Z', '1.3.0': threeHoursAgo },
          versions: { '1.2.0': {}, '1.3.0': {} },
        },
      },
      async (url) => {
        const { code, stdout } = await runCli(dir, ['--json', '--min-release-age', '7', 'preflight', 'npm', 'install', 'left-pad'], { SANDBOX_NPM_REGISTRY: url });
        expect(code).toBe(1);
        const report = JSON.parse(stdout);
        expect(report.blocked).toBe(true);
        expect(report.ageViolations[0]).toMatchObject({ name: 'left-pad', version: '1.3.0' });
        expect(report.suggestions[0]).toMatchObject({ name: 'left-pad', version: '1.2.0', pin: 'sandbox npm add left-pad@1.2.0' });
      },
    );
  });

  it('preflight exits 0 with a clean report when nothing is blocked', async () => {
    const dir = fixture({ 'package.json': '{"name":"x"}' });
    await withRegistry(
      {
        'is-odd': {
          name: 'is-odd',
          'dist-tags': { latest: '1.0.0' },
          time: { created: '2020-01-01T00:00:00.000Z', '1.0.0': '2024-01-01T00:00:00.000Z' },
          versions: { '1.0.0': {} },
        },
      },
      async (url) => {
        const { code, stderr } = await runCli(dir, ['--min-release-age', '7', 'preflight', 'npm', 'install', 'is-odd'], { SANDBOX_NPM_REGISTRY: url });
        expect(code).toBe(0);
        expect(stderr).toContain('no blocking findings — safe to install');
      },
    );
  });

  const deprecatedRegistry = {
    'old-lib': {
      name: 'old-lib',
      'dist-tags': { latest: '2.0.0' },
      time: { created: '2020-01-01T00:00:00.000Z', '2.0.0': '2022-01-01T00:00:00.000Z' },
      versions: { '2.0.0': { deprecated: 'no longer maintained' } },
    },
  };

  it('blocks a maintainer-deprecated version by default — never install an abandoned version', async () => {
    const dir = fixture({ 'package.json': '{"name":"x"}' });
    await withRegistry(deprecatedRegistry, async (url) => {
      // No gate flags: riskHints basic is on by default, so the deprecated gate blocks.
      const { code, stderr } = await runCli(dir, ['npm', 'install', 'old-lib'], { SANDBOX_NPM_REGISTRY: url });
      expect(code).toBe(1); // blocked before the container runs
      expect(stderr).toContain('blocked: a maintainer-deprecated version');
      expect(stderr).toContain('old-lib@2.0.0 — deprecated: no longer maintained');
      expect(stderr).toContain('--allow-deprecated');
    });
  });

  it('--allow-deprecated downgrades the deprecated block to a warning', async () => {
    const dir = fixture({ 'package.json': '{"name":"x"}' });
    await withRegistry(deprecatedRegistry, async (url) => {
      const { code, stderr } = await runCli(dir, ['--allow-deprecated', 'preflight', 'npm', 'install', 'old-lib'], { SANDBOX_NPM_REGISTRY: url });
      expect(code).toBe(0);
      expect(stderr).toContain('deprecated version(s) allowed via --allow-deprecated');
    });
  });

  it('preflight --json reports deprecations in their own field and blocks', async () => {
    const dir = fixture({ 'package.json': '{"name":"x"}' });
    await withRegistry(deprecatedRegistry, async (url) => {
      const { code, stdout } = await runCli(dir, ['--json', 'preflight', 'npm', 'install', 'old-lib'], { SANDBOX_NPM_REGISTRY: url });
      expect(code).toBe(1);
      const report = JSON.parse(stdout);
      expect(report.blocked).toBe(true);
      expect(report.deprecations[0]).toMatchObject({ name: 'old-lib', version: '2.0.0', reason: 'no longer maintained' });
    });
  });

  it('--risk off disables the deprecated gate (it rides on the risk resolution)', async () => {
    const dir = fixture({ 'package.json': '{"name":"x"}' });
    await withRegistry(deprecatedRegistry, async (url) => {
      const { code } = await runCli(dir, ['--risk', 'off', 'preflight', 'npm', 'install', 'old-lib'], { SANDBOX_NPM_REGISTRY: url });
      expect(code).toBe(0); // no risk resolution → no deprecated finding → nothing to block
    });
  });

  it('a monorepo preflight checks the workspace packages’ deps, not just the root manifest', async () => {
    const dir = fixture({
      'package.json': JSON.stringify({ name: 'root' }), // root has NO deps — the real surface is in the packages
      'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
      'packages/db/package.json': JSON.stringify({ dependencies: { 'old-lib': '^2.0.0', '@me/x': 'workspace:*' } }),
    });
    await withRegistry(deprecatedRegistry, async (url) => {
      // The deprecated dep lives in packages/db, and the install resolves to the root — the gate still catches it.
      // The local `@me/x: workspace:*` dep is dropped (never resolved against the registry).
      const { code, stderr } = await runCli(dir, ['preflight', 'pnpm', 'install'], { SANDBOX_NPM_REGISTRY: url });
      expect(code).toBe(1);
      expect(stderr).toContain('old-lib@2.0.0 — deprecated: no longer maintained');
    });
  });

  it('--deep catches a deprecated TRANSITIVE dep read from the lockfile', async () => {
    const dir = fixture({
      'package.json': JSON.stringify({ name: 'app' }), // no direct deps — the deprecated one is transitive
      'package-lock.json': JSON.stringify({ packages: { '': {}, 'node_modules/buried-dep': { version: '1.0.0' } } }),
    });
    await withRegistry(
      {
        'buried-dep': {
          name: 'buried-dep',
          'dist-tags': { latest: '1.0.0' },
          time: { created: '2020-01-01T00:00:00.000Z', '1.0.0': '2024-01-01T00:00:00.000Z' },
          versions: { '1.0.0': { deprecated: 'unmaintained — do not use' } },
        },
      },
      async (url) => {
        const { code, stderr } = await runCli(dir, ['--deep', 'preflight', 'npm', 'install'], { SANDBOX_NPM_REGISTRY: url });
        expect(code).toBe(1); // a deprecated dep nobody declared directly still blocks under --deep
        expect(stderr).toContain('scanned 1 resolved packages');
        expect(stderr).toContain('buried-dep@1.0.0 — deprecated: unmaintained — do not use');
      },
    );
  });

  it('--dev opens only run networking + dev ports for one run', async () => {
    const dir = fixture({ 'package.json': '{"name":"x"}' });
    const install = JSON.parse((await runCli(dir, ['--json', '--dev', 'npm', 'install'])).stdout);
    expect(install.network).toBe('allowlist');
    const dev = JSON.parse((await runCli(dir, ['--json', '--dev', 'npm', 'run', 'dev'])).stdout);
    expect(dev.network).toBe('on');
    expect(dev.ports).toContain('5173:5173');
  });

  it('--full-network opens install egress and run dev ports for one run', async () => {
    const dir = fixture({ 'package.json': '{"name":"x"}' });
    const install = JSON.parse((await runCli(dir, ['--json', '--full-network', 'npm', 'install'])).stdout);
    expect(install.network).toBe('on');
    const dev = JSON.parse((await runCli(dir, ['--json', '--full-network', 'npm', 'run', 'dev'])).stdout);
    expect(dev.network).toBe('on');
    expect(dev.ports).toContain('5173:5173');
  });

  it('--json install: writable root, locked manifest + persistence paths', async () => {
    const dir = fixture({ 'package-lock.json': '{}', 'package.json': '{"name":"x"}' });
    const { code, stdout } = await runCli(dir, ['--json', 'install']);
    expect(code).toBe(0);
    const plan = JSON.parse(stdout.replaceAll(dir, '<cwd>'));
    expect(plan).toMatchObject({
      image: 'node-install-sandbox:latest',
      argv: ['npm', 'install'],
      env: { SANDBOX: '1', CI: '', HOME: '/root' },
      ports: [],
      workdir: '/workspace',
      network: 'allowlist', // default-deny egress
      egressAllow: ['npmjs.org', 'npmjs.com'],
      interactive: false,
      capDrop: ['ALL'],
      securityOpt: ['no-new-privileges'],
      addHosts: [], // addHosts only on bridge ("on")
    });
    expect(plan.mounts).toContainEqual({ type: 'bind', source: '<cwd>', target: '/workspace', readonly: false });
    expect(plan.mounts).toContainEqual({ type: 'bind', source: '<cwd>/package.json', target: '/workspace/package.json', readonly: true });
    expect(plan.mounts).toContainEqual({ type: 'volume', target: '/workspace/.github', readonly: true });
  });

  it('--json add leaves package.json writable and uses the add args', async () => {
    const dir = fixture({ 'pnpm-lock.yaml': '', 'package.json': '{"name":"x"}' });
    const { code, stdout } = await runCli(dir, ['--json', 'add', 'is-number']);
    expect(code).toBe(0);
    const plan = JSON.parse(stdout);
    expect(plan.argv).toEqual(['corepack', 'pnpm', 'add', '--save-exact', 'is-number']);
    expect(plan.mounts.find((m: { target: string }) => m.target === '/workspace/package.json')).toBeUndefined();
    expect(plan.mounts).toContainEqual({ type: 'volume', target: '/workspace/.github', readonly: true });
  });

  it('--json run loads env files from the invocation directory but redacts their values', async () => {
    const dir = fixture({
      '.env.local': 'FROM_FILE=local\nOVERRIDE=file\n',
      'package.json': '{"name":"x"}',
    });
    const { code, stdout } = await runCli(dir, ['--env', 'OVERRIDE', '--env-file', '.env.local', '--json', 'run', '--', 'node', 'x.js'], {
      OVERRIDE: 'host',
    });
    expect(code).toBe(0);
    const plan = JSON.parse(stdout);
    expect(plan.env.FROM_FILE).toBe('[redacted]');
    expect(plan.env.OVERRIDE).toBe('[redacted]');
    expect(plan.env.HOME).toBe('/root');
  });

  it('config env files resolve from the project root even when invoked from a leaf workspace package', async () => {
    const dir = fixture({
      'sandbox.config.json': JSON.stringify({ grants: { envFiles: ['.env'] } }),
      '.env': 'FROM_ROOT=1\n',
      'package.json': JSON.stringify({ private: true, workspaces: ['apps/*'] }),
      'apps/web/package.json': '{"name":"web"}',
    });
    const { code, stdout } = await runCli(path.join(dir, 'apps', 'web'), ['--json', 'run', '--', 'node', 'x.js']);
    expect(code).toBe(0);
    const plan = JSON.parse(stdout);
    expect(plan.env.FROM_ROOT).toBe('[redacted]');
  });

  it('pass-through: `npm install` maps to the install containment model', async () => {
    const dir = fixture({ 'package-lock.json': '{}', 'package.json': '{"name":"x"}' });
    const { code, stdout } = await runCli(dir, ['--json', 'npm', 'install']);
    expect(code).toBe(0);
    const plan = JSON.parse(stdout.replaceAll(dir, '<cwd>'));
    expect(plan.argv).toEqual(['npm', 'install']);
    expect(plan.workdir).toBe('/workspace');
    expect(plan.mounts).toContainEqual({ type: 'bind', source: '<cwd>/package.json', target: '/workspace/package.json', readonly: true });
  });

  it('pass-through: `pnpm add` honours the named pm and maps to the add model', async () => {
    // npm lockfile present, but the user explicitly typed pnpm → pnpm wins.
    const dir = fixture({ 'package-lock.json': '{}', 'package.json': '{"name":"x"}' });
    const { code, stdout } = await runCli(dir, ['--json', 'pnpm', 'add', 'zod']);
    expect(code).toBe(0);
    const plan = JSON.parse(stdout);
    expect(plan.argv).toEqual(['corepack', 'pnpm', 'add', '--save-exact', 'zod']);
    expect(plan.mounts.find((m: { target: string }) => m.target === '/workspace/package.json')).toBeUndefined(); // writable manifest
  });

  it('pass-through: `npm run dev` maps to the run model', async () => {
    const dir = fixture({ 'package.json': '{"name":"x"}' });
    const { code, stdout } = await runCli(dir, ['--json', 'npm', 'run', 'dev']);
    expect(code).toBe(0);
    const plan = JSON.parse(stdout);
    expect(plan.argv).toEqual(['npm', 'run', 'dev']);
    expect(plan.interactive).toBe(true);
  });

  it('pass-through: `npm audit fix` maps to the install-class audit-fix model', async () => {
    const dir = fixture({ 'package-lock.json': '{}', 'package.json': '{"name":"x"}' });
    const { code, stdout } = await runCli(dir, ['--json', 'npm', 'audit', 'fix', '--package-lock-only']);
    expect(code).toBe(0);
    const plan = JSON.parse(stdout.replaceAll(dir, '<cwd>'));
    expect(plan.argv).toEqual(['npm', 'audit', 'fix', '--package-lock-only']);
    expect(plan.network).toBe('allowlist');
    expect(plan.workdir).toBe('/workspace');
    expect(plan.mounts.find((m: { target: string }) => m.target === '/workspace/package.json')).toBeUndefined();
  });

  it('pass-through: `pnpm audit --fix=update` honours the named pm and stays install-class', async () => {
    const dir = fixture({ 'package-lock.json': '{}', 'package.json': '{"name":"x"}' });
    const { code, stdout } = await runCli(dir, ['--json', 'pnpm', 'audit', '--fix=update', '--prod']);
    expect(code).toBe(0);
    const plan = JSON.parse(stdout);
    expect(plan.argv).toEqual(['corepack', 'pnpm', 'audit', '--fix=update', '--prod']);
    expect(plan.network).toBe('allowlist');
    expect(plan.interactive).toBe(false);
  });

  it('pass-through: `npm audit` uses registry egress but keeps the whole tree read-only', async () => {
    const dir = fixture({ 'package-lock.json': '{}', 'package.json': '{"name":"x"}' });
    const { code, stdout } = await runCli(dir, ['--json', 'npm', 'audit', '--json']);
    expect(code).toBe(0);
    const plan = JSON.parse(stdout.replaceAll(dir, '<cwd>'));
    expect(plan.argv).toEqual(['npm', 'audit', '--json']);
    expect(plan.network).toBe('allowlist');
    expect(plan.mounts).toContainEqual({ type: 'bind', source: '<cwd>', target: '/workspace', readonly: true });
  });

  it('pass-through: `npm audit signatures` uses registry egress with protected persistence mounts', async () => {
    const dir = fixture({ 'package-lock.json': '{}', 'package.json': '{"name":"x"}' });
    const { code, stdout } = await runCli(dir, ['--json', 'npm', 'audit', 'signatures', '--json']);
    expect(code).toBe(0);
    const plan = JSON.parse(stdout.replaceAll(dir, '<cwd>'));
    expect(plan.argv).toEqual(['npm', 'audit', 'signatures', '--json']);
    expect(plan.network).toBe('allowlist');
    expect(plan.mounts).toContainEqual({ type: 'bind', source: '<cwd>/package.json', target: '/workspace/package.json', readonly: true });
    expect(plan.mounts).toContainEqual({ type: 'volume', target: '/workspace/.github', readonly: true });
  });

  it('pass-through: `pnpm audit signatures` honours the named pm and stays read-only to the manifest', async () => {
    const dir = fixture({ 'pnpm-lock.yaml': '', 'package.json': '{"name":"x"}' });
    const { code, stdout } = await runCli(dir, ['--json', 'pnpm', 'audit', 'signatures']);
    expect(code).toBe(0);
    const plan = JSON.parse(stdout);
    expect(plan.argv).toEqual(['corepack', 'pnpm', 'audit', 'signatures']);
    expect(plan.network).toBe('allowlist');
    expect(plan.mounts.find((m: { target: string }) => m.target === '/workspace/package.json')).toMatchObject({ readonly: true });
    expect(plan.interactive).toBe(false);
  });

  it('audit-fix preflight gates the incoming vulnerable direct dependency versions before running', async () => {
    const dir = fixture({
      'package.json': JSON.stringify({ name: 'x', dependencies: { 'old-lib': '^2.0.0' } }),
      'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { 'old-lib': '^2.0.0' } }, 'node_modules/old-lib': { version: '2.0.0' } } }),
    });
    await withRegistry(deprecatedRegistry, async (url) => {
      const { code, stderr } = await runCli(dir, ['npm', 'audit', 'fix'], { SANDBOX_NPM_REGISTRY: url });
      expect(code).toBe(1);
      expect(stderr).toContain('old-lib@2.0.0 — deprecated: no longer maintained');
    });
  });

  it('init --preset writes a valid config (and won’t clobber without --force)', async () => {
    const dir = fixture({});
    const first = await runCli(dir, ['init', '--preset', 'strict']);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain('sandbox: wrote sandbox.config.json using the strict preset');
    expect(first.stdout).toContain('sandbox npm install');
    const cfg = JSON.parse(readFileSync(path.join(dir, 'sandbox.config.json'), 'utf8'));
    expect(cfg.install).toEqual({ network: 'allowlist', frozen: true, riskHints: 'thorough', failOnRisk: false, minReleaseAgeDays: 7, minReleaseAgeExclude: [], failOnAdvisory: true, failOnDeprecated: true });
    expect(cfg.run.network).toBe('none');

    const clobber = await runCli(dir, ['init', '--preset', 'trusted']);
    expect(clobber.code).toBe(1);
    expect(clobber.stderr).toMatch(/already exists/);

    const forced = await runCli(dir, ['init', '--preset', 'trusted', '--force']);
    expect(forced.code).toBe(0);
    expect(JSON.parse(readFileSync(path.join(dir, 'sandbox.config.json'), 'utf8')).install.network).toBe('on');
  });

  it('init --agent writes repo instructions and wires the enforcement hook', async () => {
    const dir = fixture({});
    const { code, stdout } = await runCli(dir, ['init', '--agent']);
    expect(code).toBe(0);
    expect(stdout).toContain('sandbox: wrote .sandbox/AGENT.md');
    expect(stdout).toContain('wired .claude/settings.json');
    expect(readFileSync(path.join(dir, '.sandbox', 'AGENT.md'), 'utf8')).toContain('Use `sandbox npm install`, not `npm install`');
    expect(readFileSync(path.join(dir, '.sandbox', 'hooks', 'enforce-sandbox.mjs'), 'utf8')).toContain('Blocked by sandbox');
    expect(JSON.parse(readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8')).hooks.PreToolUse[0].hooks[0].command).toContain('enforce-sandbox.mjs');
  });

  it('setup --vibe writes config, checks the backend, builds images, and prints next commands', async () => {
    const dir = fixture({});
    const fakePath = fakeDocker(dir);
    const { code, stdout } = await runCli(dir, ['setup', '--vibe'], { PATH: `${fakePath}:${process.env.PATH ?? ''}` });
    expect(code).toBe(0);
    expect(stdout).toContain('sandbox: wrote sandbox.config.json using the vibe preset');
    expect(stdout).toContain('sandbox: backend ready: Docker version 27.0.0');
    expect(stdout).toContain('sandbox: building node-install-sandbox:latest and the egress proxy image');
    expect(stdout).toContain('sandbox: vibe preset');
    expect(stdout).toContain('sandbox npm install');
    expect(stdout).toContain('sandbox npm run dev');
    expect(existsSync(path.join(dir, 'sandbox.config.json'))).toBe(true);
  });

  it('allow adds hosts to egress.allow', async () => {
    const dir = fixture({ 'sandbox.config.json': '{}' });
    const { code, stdout } = await runCli(dir, ['allow', 'nodejs.org', 'https://npm.pkg.github.com/path']);
    expect(code).toBe(0);
    expect(stdout).toContain('allowed nodejs.org, npm.pkg.github.com');
    const cfg = JSON.parse(readFileSync(path.join(dir, 'sandbox.config.json'), 'utf8'));
    expect(cfg.egress.allow).toEqual(['nodejs.org', 'npm.pkg.github.com', 'npmjs.com', 'npmjs.org']);
  });

  it('init rejects an unknown preset', async () => {
    const { code, stderr } = await runCli(fixture({}), ['init', '--preset', 'nope']);
    expect(code).toBe(1);
    expect(stderr).toMatch(/unknown preset/);
  });

  it('doctor reports a missing backend clearly', async () => {
    const { code, stdout } = await runCli(fixture({}), ['doctor'], { PATH: '' });
    expect(code).toBe(1);
    expect(stdout).toContain('[ok] config:');
    expect(stdout).toContain('[info] package manager:');
    expect(stdout).toContain('[fail] backend:');
    expect(stdout).toContain('fix:');
  });

  it('doctor reports workspace root and package workdir from a monorepo package', async () => {
    const dir = fixture({
      'pnpm-workspace.yaml': 'packages:\n  - apps/*\n',
      'sandbox.config.json': '{}',
      'apps/web/package.json': '{"name":"web"}',
    });
    const { code, stdout } = await runCli(path.join(dir, 'apps', 'web'), ['doctor'], { PATH: '' });
    expect(code).toBe(1);
    expect(stdout).toContain(`[info] workspace root: ${dir}`);
    expect(stdout).toContain('[info] package workdir: /workspace/apps/web');
  });

  it('doctor suggests private registry allowlist and auth grants from .npmrc', async () => {
    const dir = fixture({
      '.npmrc': '@acme:registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}\n',
      'sandbox.config.json': '{}',
    });
    const { stdout } = await runCli(dir, ['doctor'], { PATH: '' });
    expect(stdout).toContain('npm.pkg.github.com');
    expect(stdout).toContain('missing from egress.allow');
    expect(stdout).toContain('sandbox allow npm.pkg.github.com');
    expect(stdout).toContain('GITHUB_TOKEN');
    expect(stdout).toContain('"egress": {');
    expect(stdout).toContain('"grants":{"env"');
  });

  it('rejects `add` with no packages', async () => {
    const { code, stderr } = await runCli(fixture({}), ['add']);
    expect(code).toBe(1);
    expect(stderr).toMatch(/usage: sandbox add/);
  });

  it('rejects an unknown command', async () => {
    const { code, stderr } = await runCli(fixture({}), ['frobnicate']);
    expect(code).toBe(1);
    expect(stderr).toMatch(/unknown command/);
  });

  it('reports an invalid config instead of running', async () => {
    const dir = fixture({ 'sandbox.config.json': '{ "run": { "network": "wide-open" } }' });
    const { code, stderr } = await runCli(dir, ['--json', 'install']);
    expect(code).toBe(1);
    expect(stderr).toMatch(/invalid config/i);
  });
});
