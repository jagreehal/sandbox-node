import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderRunArgs } from '../src/backend.js';
import { SandboxConfigSchema } from '../src/config.js';
import { planAdd, planInstall, planRun, type Mount } from '../src/plan.js';
import type { ProjectFacts } from '../src/project.js';

const cfg = (over: object = {}) => SandboxConfigSchema.parse(over);

const CWD = '/proj';

/** A pure ProjectFacts — the planners read nothing else from the host. */
function facts(over: Partial<ProjectFacts> = {}): ProjectFacts {
  return {
    cwd: CWD,
    pm: 'npm',
    isYarnBerry: false,
    hasLockfile: false,
    hasPackageJson: false,
    directDependencies: [],
    existingPersistencePaths: [],
    homedir: '/home/dev',
    hostEnv: {},
    envFileValues: {},
    ...over,
  };
}

const find = (mounts: Mount[], target: string) => mounts.find((m) => m.target === target);

describe('planInstall', () => {
  it('keeps a writable root but read-only manifest + persistence paths', () => {
    const plan = planInstall(cfg(), facts({ hasPackageJson: true }), []);

    expect(find(plan.mounts, '/workspace')?.readonly).toBe(false); // pnpm needs a writable root
    expect(find(plan.mounts, '/workspace/package.json')?.readonly).toBe(true); // install never mutates the manifest
    expect(find(plan.mounts, '/workspace/.github')?.readonly).toBe(true); // persistence vector locked
    expect(find(plan.mounts, '/workspace/.git')?.readonly).toBe(true);
    expect(plan.argv).toEqual(['npm', 'install']);
    expect(plan.env.SANDBOX).toBe('1');
    expect(plan.interactive).toBe(false);
  });

  it('blocks creation of a missing persistence dir via a read-only volume', () => {
    const plan = planInstall(cfg(), facts(), []); // no .github in facts
    const gh = find(plan.mounts, '/workspace/.github');
    expect(gh).toMatchObject({ type: 'volume', readonly: true });
    expect(gh?.source).toBeUndefined();
  });

  it('binds an existing persistence dir read-only', () => {
    const gh = find(planInstall(cfg(), facts({ existingPersistencePaths: ['.github'] }), []).mounts, '/workspace/.github');
    expect(gh).toMatchObject({ type: 'bind', readonly: true, source: path.join(CWD, '.github') });
  });

  it('emits the package manager argv from the probed facts', () => {
    expect(planInstall(cfg(), facts({ pm: 'pnpm' }), []).argv).toEqual(['corepack', 'pnpm', 'install']);
    expect(planInstall(cfg(), facts({ pm: 'yarn' }), []).argv).toEqual(['corepack', 'yarn', 'install']);
    expect(planInstall(cfg(), facts({ pm: 'bun' }), []).argv).toEqual(['bun', 'install']); // bun is a standalone binary — no corepack
  });

  it('passes extra args verbatim', () => {
    const plan = planInstall(cfg(), facts(), ['--workspace', 'api']);
    expect(plan.argv).toEqual(['npm', 'install', '--workspace', 'api']);
  });
});

describe('planAdd', () => {
  it('leaves package.json writable but still locks persistence paths', () => {
    const plan = planAdd(cfg(), facts({ pm: 'pnpm', hasPackageJson: true }), ['is-number']);
    expect(find(plan.mounts, '/workspace/package.json')).toBeUndefined(); // inherits the writable root
    expect(find(plan.mounts, '/workspace')?.readonly).toBe(false);
    expect(find(plan.mounts, '/workspace/.github')?.readonly).toBe(true);
    expect(plan.argv).toEqual(['corepack', 'pnpm', 'add', 'is-number']);
  });
});

describe('frozen install', () => {
  it('npm: fully read-only source tree, runs npm ci', () => {
    const plan = planInstall(cfg(), facts({ pm: 'npm', hasPackageJson: true, hasLockfile: true }), [], { frozen: true });
    expect(plan.argv).toEqual(['npm', 'ci']);
    expect(find(plan.mounts, '/workspace')?.readonly).toBe(true);
    expect(find(plan.mounts, '/workspace/node_modules')?.readonly).toBe(false);
    expect(find(plan.mounts, '/workspace/.github')).toBeUndefined(); // whole tree already ro
  });

  it('pnpm: keeps a writable root (it needs one) but locks the lockfile', () => {
    const plan = planInstall(cfg(), facts({ pm: 'pnpm', hasPackageJson: true, hasLockfile: true }), [], { frozen: true });
    expect(plan.argv).toEqual(['corepack', 'pnpm', 'install', '--frozen-lockfile']);
    expect(find(plan.mounts, '/workspace')?.readonly).toBe(false);
    expect(find(plan.mounts, '/workspace/pnpm-lock.yaml')?.readonly).toBe(true);
    expect(find(plan.mounts, '/workspace/.github')?.readonly).toBe(true);
  });

  it('yarn berry uses --immutable', () => {
    expect(planInstall(cfg(), facts({ pm: 'yarn', isYarnBerry: true }), [], { frozen: true }).argv).toEqual(['corepack', 'yarn', 'install', '--immutable']);
  });

  it('bun: fully read-only source tree, runs bun install --frozen-lockfile', () => {
    const plan = planInstall(cfg(), facts({ pm: 'bun', hasPackageJson: true, hasLockfile: true }), [], { frozen: true });
    expect(plan.argv).toEqual(['bun', 'install', '--frozen-lockfile']);
    expect(find(plan.mounts, '/workspace')?.readonly).toBe(true);
    expect(find(plan.mounts, '/workspace/node_modules')?.readonly).toBe(false);
  });
});

describe('planRun', () => {
  it('mounts the tree read-write and is interactive', () => {
    const plan = planRun(cfg(), facts(), ['node', 'x.js']);
    expect(find(plan.mounts, '/workspace')?.readonly).toBe(false);
    expect(plan.argv).toEqual(['node', 'x.js']);
    expect(plan.interactive).toBe(true);
  });

  it('drops ports when network is none, keeps them when on', () => {
    const ports = { run: { ports: ['8077:8077'] } };
    expect(planRun(cfg({ run: { network: 'none', ...ports.run } }), facts(), ['x']).ports).toEqual([]);
    const on = planRun(cfg({ run: { network: 'on', ...ports.run } }), facts(), ['x']);
    expect(on.ports).toEqual(['8077:8077']);
    expect(on.addHosts).toContain('host.docker.internal:host-gateway');
  });

  it('publishes common dev ports when devPorts is on (alongside explicit ports)', () => {
    const plan = planRun(cfg({ run: { network: 'on', devPorts: true, ports: ['9229:9229'] } }), facts(), ['x']);
    expect(plan.ports).toContain('5173:5173'); // vite
    expect(plan.ports).toContain('3000:3000'); // next/remix
    expect(plan.ports).toContain('9229:9229'); // explicit port preserved
  });

  it('never publishes dev ports when the network is none', () => {
    expect(planRun(cfg({ run: { network: 'none', devPorts: true } }), facts(), ['x']).ports).toEqual([]);
  });
});

describe('grants', () => {
  it('forwards the ssh agent socket and sets SSH_AUTH_SOCK', () => {
    const plan = planRun(cfg({ grants: { 'ssh-agent': true } }), facts(), ['x']);
    expect(find(plan.mounts, '/ssh-agent')).toBeTruthy();
    expect(plan.env.SSH_AUTH_SOCK).toBe('/ssh-agent');
  });

  it('mounts a project-scoped claude dir at /root/.claude', () => {
    const plan = planRun(cfg({ grants: { claude: 'project' } }), facts(), ['x']);
    expect(find(plan.mounts, '/root/.claude')?.source).toBe(path.join(CWD, '.claude-sandbox'));
  });

  it('expands a home Claude grant against the probed homedir', () => {
    const plan = planRun(cfg({ grants: { claude: 'home' } }), facts({ homedir: '/home/dev' }), ['x']);
    expect(find(plan.mounts, '/root/.claude')?.source).toBe('/home/dev/.claude');
  });

  it('parses path specs (ro default, rw opt-in, ~ expansion)', () => {
    const plan = planRun(cfg({ grants: { paths: ['./data:rw', './secrets', '~/keys'] } }), facts({ homedir: '/home/dev' }), ['x']);
    expect(find(plan.mounts, '/grants/data')?.readonly).toBe(false);
    expect(find(plan.mounts, '/grants/secrets')?.readonly).toBe(true);
    expect(find(plan.mounts, '/grants/keys')?.source).toBe('/home/dev/keys'); // ~ expands against facts.homedir
  });

  it('passes named env vars from the host only when present', () => {
    const plan = planRun(cfg({ grants: { env: ['MY_TOKEN', 'ABSENT'] } }), facts({ hostEnv: { MY_TOKEN: 'abc' } }), ['x']);
    expect(plan.env.MY_TOKEN).toBe('abc');
    expect(plan.env.ABSENT).toBeUndefined();
  });

  it('injects env-file values, with named host env vars taking precedence', () => {
    const plan = planRun(cfg({ grants: { env: ['API_URL'] } }), facts({
      hostEnv: { API_URL: 'http://host' },
      envFileValues: { API_URL: 'http://file', FEATURE_FLAG: 'true' },
    }), ['x']);
    expect(plan.env.FEATURE_FLAG).toBe('true');
    expect(plan.env.API_URL).toBe('http://host'); // explicit host grant overrides the env file
  });
});

describe('renderRunArgs', () => {
  it('renders binds, ro-volumes, env, security, and an explicit network', () => {
    const plan = planInstall(cfg(), facts({ hasPackageJson: true }), []);
    const args = renderRunArgs(plan, { network: 'none' });
    const joined = args.join(' ');
    expect(args.slice(0, 2)).toEqual(['run', '--rm']);
    expect(args).toContain('--cap-drop');
    expect(args).toContain('ALL');
    expect(joined).toContain('--network none');
    expect(joined).toContain(':/workspace/package.json:ro'); // manifest locked
    expect(joined).toContain('type=volume,target=/workspace/.github,readonly'); // missing vector blocked
    expect(args[args.length - 2]).toBe('npm'); // image precedes argv
  });

  it('merges egress proxy env supplied at run time', () => {
    const plan = planInstall(cfg(), facts(), []);
    const args = renderRunArgs(plan, { network: 'sbx_int_x', extraEnv: { HTTP_PROXY: 'http://p:8888' } });
    expect(args.join(' ')).toContain('HTTP_PROXY=http://p:8888');
    expect(args.join(' ')).toContain('--network sbx_int_x');
  });

  it('bridge mode ("on") adds the metadata guard: net caps + guard entrypoint', () => {
    const plan = planRun(cfg({ run: { network: 'on' } }), facts(), ['npm', 'run', 'dev']);
    const args = renderRunArgs(plan); // no override.network == default bridge, the "on" path
    const joined = args.join(' ');
    expect(joined).toContain('--cap-add NET_ADMIN');
    expect(joined).toContain('--cap-add SETPCAP');
    const gi = args.indexOf('--entrypoint');
    expect(args[gi + 1]).toBe('/usr/local/bin/sbx-net-guard');
    expect(gi).toBeLessThan(args.indexOf(plan.image)); // the entrypoint flag precedes the image
  });

  it('isolated and proxy modes do NOT add the metadata guard (no host route to block)', () => {
    const plan = planInstall(cfg(), facts(), []);
    for (const network of ['none', 'sbx_int_x']) {
      const joined = renderRunArgs(plan, { network }).join(' ');
      expect(joined).not.toContain('NET_ADMIN');
      expect(joined).not.toContain('sbx-net-guard');
    }
  });
});
