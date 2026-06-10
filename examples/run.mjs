#!/usr/bin/env node
// Drives the sandbox CLI against each example project as a proof fixture rather than a
// casual demo. Plan mode proves the resolved boundary (PM, egress, read-only mounts,
// caps, HOME). `--real` then runs the install for real: one registry dep must install,
// and one malicious local postinstall probe must run yet fail to escape the boundary.
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '..', 'dist', 'cli.mjs');
const real = process.argv.includes('--real');
const sentinel = path.join('node_modules', '.sandbox-example-probe-ran');

if (!existsSync(cli)) {
  console.error(`sandbox CLI not built — run \`npm run build\` first (looked for ${cli})`);
  process.exit(1);
}

const examples = [
  { dir: 'npm', lead: ['npm'], egress: ['npmjs.org', 'npmjs.com'], frozenLead: ['npm', 'ci'], frozenRootReadonly: true, frozenLockfile: 'package-lock.json' },
  { dir: 'pnpm', lead: ['corepack', 'pnpm'], egress: ['npmjs.org', 'npmjs.com'], frozenLead: ['corepack', 'pnpm', 'install', '--frozen-lockfile'], frozenRootReadonly: false, frozenLockfile: 'pnpm-lock.yaml' },
  { dir: 'yarn', lead: ['corepack', 'yarn'], egress: ['npmjs.org', 'npmjs.com', 'registry.yarnpkg.com'], frozenLead: ['corepack', 'yarn', 'install', '--frozen-lockfile'], frozenRootReadonly: true, frozenLockfile: 'yarn.lock' },
  { dir: 'bun', lead: ['bun'], egress: ['npmjs.org', 'npmjs.com'], frozenLead: ['bun', 'install', '--frozen-lockfile'], frozenRootReadonly: true, frozenLockfile: 'bun.lock' },
];

const execProofs = [
  { label: 'npm-exec', cwd: 'npm', planArgs: ['npx', '--yes', 'cowsay', 'sandbox'], realArgs: ['--risk', 'off', '--full-network', 'npx', '--yes', 'cowsay', 'sandbox'], expectArgv: ['npx', '--yes', 'cowsay', 'sandbox'] },
  { label: 'pnpm-dlx', cwd: 'pnpm', planArgs: ['pnpm', 'dlx', 'cowsay', 'sandbox'], realArgs: ['--risk', 'off', '--full-network', 'pnpm', 'dlx', 'cowsay', 'sandbox'], expectArgv: ['pnpm', 'dlx', 'cowsay', 'sandbox'] },
  { label: 'yarn-dlx', cwd: 'yarn', planArgs: ['yarn', 'dlx', 'cowsay', 'sandbox'], expectArgv: ['yarn', 'dlx', 'cowsay', 'sandbox'] },
  { label: 'bunx', cwd: 'bun', planArgs: ['bunx', 'cowsay', 'sandbox'], realArgs: ['--risk', 'off', '--full-network', 'bunx', 'cowsay', 'sandbox'], expectArgv: ['bunx', 'cowsay', 'sandbox'] },
];

function exampleDir(dir) {
  return path.join(here, dir);
}

function plan(dir) {
  const out = execFileSync('node', [cli, '--json', dir, 'install'], { cwd: path.join(here, dir), encoding: 'utf8' });
  return JSON.parse(out);
}

function planCommand(cwdRel, argv, globals = ['--json']) {
  const out = execFileSync('node', [cli, ...globals, ...argv], { cwd: exampleDir(cwdRel), encoding: 'utf8' });
  return JSON.parse(out);
}

function startsWith(argv, lead) {
  return lead.every((token, i) => argv[i] === token);
}

function hasReadonlyTarget(plan, target) {
  return plan.mounts.some((m) => m.target === target && m.readonly === true);
}

function hasWritableTarget(plan, target) {
  return plan.mounts.some((m) => m.target === target && m.readonly === false);
}

function assertPlan(dir, lead, egress) {
  const resolved = plan(dir);
  const problems = [];
  if (!startsWith(resolved.argv, lead)) problems.push(`argv starts with ${resolved.argv.join(' ')} (expected ${lead.join(' ')})`);
  if (resolved.network !== 'allowlist') problems.push(`network=${resolved.network} (expected allowlist)`);
  if (!resolved.capDrop.includes('ALL')) problems.push('cap-drop ALL missing');
  if (!resolved.securityOpt.includes('no-new-privileges')) problems.push('no-new-privileges missing');
  if (resolved.env.HOME !== '/root') problems.push(`HOME=${resolved.env.HOME} (expected /root)`);
  if (!hasReadonlyTarget(resolved, '/workspace/package.json')) problems.push('package.json is not read-only');
  for (const target of ['/workspace/.git', '/workspace/.github', '/workspace/.husky', '/workspace/.claude']) {
    if (!hasReadonlyTarget(resolved, target)) problems.push(`${target} is not protected read-only`);
  }
  for (const host of egress) {
    if (!resolved.egressAllow.includes(host)) problems.push(`egress.allow missing ${host}`);
  }
  return { resolved, problems };
}

function frozenPlan(dir) {
  const out = execFileSync('node', [cli, '--json', '--frozen', dir, 'install'], { cwd: exampleDir(dir), encoding: 'utf8' });
  return JSON.parse(out);
}

function assertFrozenPlan(dir, frozenLead, frozenRootReadonly, frozenLockfile) {
  const resolved = frozenPlan(dir);
  const problems = [];
  if (!startsWith(resolved.argv, frozenLead)) problems.push(`frozen argv starts with ${resolved.argv.join(' ')} (expected ${frozenLead.join(' ')})`);
  const rootReadonly = hasReadonlyTarget(resolved, '/workspace');
  const rootWritable = hasWritableTarget(resolved, '/workspace');
  if (frozenRootReadonly && !rootReadonly) problems.push('frozen plan should make /workspace read-only');
  if (!frozenRootReadonly && !rootWritable) problems.push('frozen plan should keep /workspace writable for this package manager');
  if (frozenRootReadonly && !hasWritableTarget(resolved, '/workspace/node_modules')) {
    problems.push('frozen plan should keep node_modules writable when /workspace is read-only');
  }
  if (!frozenRootReadonly && !hasReadonlyTarget(resolved, `/workspace/${frozenLockfile}`)) {
    problems.push(`frozen plan should lock ${frozenLockfile} read-only`);
  }
  return { resolved, problems };
}

function cleanRealArtifacts(dir) {
  const cwd = exampleDir(dir);
  for (const name of ['node_modules', '.pnpm-store', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', sentinel]) {
    rmSync(path.join(cwd, name), { recursive: true, force: true });
  }
}

function assertExecPlan({ label, cwd, planArgs, expectArgv }) {
  const resolved = planCommand(cwd, planArgs);
  const problems = [];
  if (resolved.network !== 'none') problems.push(`network=${resolved.network} (expected none by default for fetch-and-run)`);
  if (!startsWith(resolved.argv, expectArgv)) problems.push(`argv starts with ${resolved.argv.join(' ')} (expected ${expectArgv.join(' ')})`);
  if (resolved.workdir !== '/workspace') problems.push(`workdir=${resolved.workdir} (expected /workspace)`);
  return { label, resolved, problems };
}

function assertExecReal({ cwd, realArgs, label }) {
  if (!realArgs) return { skipped: true };
  const output = execFileSync('node', [cli, ...realArgs], { cwd: exampleDir(cwd), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const problems = [];
  if (!output.includes('sandbox')) problems.push(`${label} output did not include the fetched tool result`);
  return { skipped: false, problems };
}

function cleanWorkspaceArtifacts() {
  const root = exampleDir('workspace');
  for (const name of ['node_modules', 'package-lock.json', path.join('apps', 'web', 'node_modules')]) {
    rmSync(path.join(root, name), { recursive: true, force: true });
  }
}

function assertWorkspacePlan() {
  const installPlan = planCommand(path.join('workspace', 'apps', 'web'), ['npm', 'install']);
  const runPlan = planCommand(path.join('workspace', 'apps', 'web'), ['npm', 'run', 'whereami']);
  const root = exampleDir('workspace');
  const problems = [];
  const rootMount = installPlan.mounts.find((m) => m.target === '/workspace');
  if (installPlan.workdir !== '/workspace') problems.push(`workspace install workdir=${installPlan.workdir} (expected /workspace)`);
  if (rootMount?.source !== root) problems.push(`workspace install mounted ${rootMount?.source} (expected ${root})`);
  if (runPlan.workdir !== '/workspace/apps/web') problems.push(`workspace run workdir=${runPlan.workdir} (expected /workspace/apps/web)`);
  return { installPlan, runPlan, problems };
}

function assertWorkspaceReal() {
  const cwd = exampleDir(path.join('workspace', 'apps', 'web'));
  const root = exampleDir('workspace');
  cleanWorkspaceArtifacts();
  execFileSync('node', [cli, '--risk', 'off', 'npm', 'install'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const runOut = execFileSync('node', [cli, 'npm', 'run', 'whereami'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const problems = [];
  if (!existsSync(path.join(root, 'package-lock.json'))) problems.push('workspace install did not create the root package-lock.json');
  if (!existsSync(path.join(root, 'node_modules', 'is-odd'))) problems.push('workspace install did not populate root node_modules/is-odd');
  if (!runOut.includes('/workspace/apps/web')) problems.push('workspace run did not execute in /workspace/apps/web');
  return { problems };
}

function assertRealInstall(dir, frozenLead, frozenRootReadonly, frozenLockfile) {
  const cwd = exampleDir(dir);
  cleanRealArtifacts(dir);
  const output = execFileSync('node', [cli, '--risk', 'off', dir, 'install'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  const problems = [];
  if (!existsSync(path.join(cwd, 'node_modules', 'is-odd'))) problems.push('registry dependency is-odd was not installed');
  const probeRan = existsSync(path.join(cwd, sentinel));
  const bunBlocked = dir === 'bun' && output.includes('Blocked 1 postinstall');
  if (!probeRan && !bunBlocked) problems.push('postinstall probe neither ran nor was explicitly blocked');
  if (existsSync(path.join(cwd, '.github'))) problems.push('.github was created by the probe');
  if (!existsSync(path.join(cwd, frozenLockfile))) problems.push(`expected seeded lockfile ${frozenLockfile} was not created`);

  const { problems: frozenPlanProblems } = assertFrozenPlan(dir, frozenLead, frozenRootReadonly, frozenLockfile);
  problems.push(...frozenPlanProblems);

  const frozenOutput = execFileSync('node', [cli, '--risk', 'off', '--frozen', dir, 'install'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { problems, output, frozenOutput, probeRan, bunBlocked };
}

let failures = 0;
let checks = 0;
for (const { dir, lead, egress, frozenLead, frozenRootReadonly, frozenLockfile } of examples) {
  checks += 1;
  const { resolved, problems } = assertPlan(dir, lead, egress);
  const ok = problems.length === 0;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${dir.padEnd(4)} plan -> ${resolved.argv.join(' ')}`);
  if (!ok) {
    failures += 1;
    for (const problem of problems) console.error(`     ${problem}`);
    continue;
  }
  if (real) {
    console.log(`     running for real in examples/${dir} ...`);
    try {
      const { problems: realProblems, probeRan, bunBlocked } = assertRealInstall(dir, frozenLead, frozenRootReadonly, frozenLockfile);
      if (realProblems.length) {
        failures += 1;
        for (const problem of realProblems) console.error(`     ${problem}`);
      } else if (probeRan) {
        console.log('     proof: registry install + malicious postinstall + frozen reinstall all passed safely');
      } else if (bunBlocked) {
        console.log('     proof: registry install + frozen reinstall passed, and bun explicitly blocked the untrusted postinstall');
      }
    } catch (error) {
      failures += 1;
      console.error(`     real install failed in examples/${dir}`);
      if (error && typeof error === 'object' && 'status' in error) {
        console.error(`     exit status: ${error.status}`);
      }
      if (error && typeof error === 'object' && 'stdout' in error && typeof error.stdout === 'string' && error.stdout) {
        process.stderr.write(error.stdout);
      }
      if (error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string' && error.stderr) {
        process.stderr.write(error.stderr);
      }
    }
  }
}

for (const proof of execProofs) {
  checks += 1;
  const { label, resolved, problems } = assertExecPlan(proof);
  const ok = problems.length === 0;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(8)} plan -> ${resolved.argv.join(' ')}`);
  if (!ok) {
    failures += 1;
    for (const problem of problems) console.error(`     ${problem}`);
    continue;
  }
  if (real) {
    console.log(`     running fetch-and-run proof in examples/${proof.cwd} ...`);
    try {
      const result = assertExecReal(proof);
      if (result.skipped) {
        console.log('     plan-only proof: this package-manager variant is not executed in real mode here');
      } else if (result.problems.length) {
        failures += 1;
        for (const problem of result.problems) console.error(`     ${problem}`);
      } else {
        console.log('     proof: fetch-and-run works once run networking is deliberately widened');
      }
    } catch (error) {
      failures += 1;
      console.error(`     real fetch-and-run failed for ${label}`);
      if (error && typeof error === 'object' && 'status' in error) console.error(`     exit status: ${error.status}`);
    }
  }
}

{
  checks += 1;
  const { installPlan, runPlan, problems } = assertWorkspacePlan();
  const ok = problems.length === 0;
  console.log(`${ok ? 'ok  ' : 'FAIL'} workspace plan -> install:${installPlan.workdir} run:${runPlan.workdir}`);
  if (!ok) {
    failures += 1;
    for (const problem of problems) console.error(`     ${problem}`);
  } else if (real) {
    console.log('     running workspace proof in examples/workspace/apps/web ...');
    try {
      const { problems: realProblems } = assertWorkspaceReal();
      if (realProblems.length) {
        failures += 1;
        for (const problem of realProblems) console.error(`     ${problem}`);
      } else {
        console.log('     proof: workspace install resolves to root and run stays in the leaf package');
      }
    } catch (error) {
      failures += 1;
      console.error('     real workspace proof failed');
      if (error && typeof error === 'object' && 'status' in error) console.error(`     exit status: ${error.status}`);
    }
  }
}

console.log(failures ? `\n${failures} proof check(s) failed` : `\nall ${checks} proof checks passed`);
process.exit(failures ? 1 : 0);
