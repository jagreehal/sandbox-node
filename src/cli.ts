#!/usr/bin/env node
import path from 'node:path';
import { createBackend } from './backend.js';
import type { SandboxConfig } from './config.js';
import { readConfig } from './config.js';
import { resolveProjectContext } from './context.js';
import { BASE_IMAGE, resolveImageDigest, writeDevcontainer } from './devcontainer.js';
import { renderPlanSummary } from './dryrun.js';
import { routePassthrough, type Route } from './dispatch.js';
import { runDoctor } from './doctor.js';
import { execute } from './index.js';
import { runInit } from './init.js';
import { log } from './log.js';
import { lockfileName, type PackageManager } from './package-manager.js';
import { planAdd, planInstall, planRun, type PlanOptions, type RunPlan } from './plan.js';
import { probeProject, type ProjectFacts } from './project.js';
import { allowHosts } from './registry.js';
import { type AdvisoryHit } from './advisory.js';
import { runPreflight, suggestPins, type PinSuggestion, type PreflightPolicy, type PreflightResult } from './preflight.js';
import { execPackageTargets, parsePackageTargets, riskTargetsForInstall, type ReleaseAgeViolation, type RiskHint, type RiskTarget } from './risk.js';
import { runSetup } from './setup.js';

interface Globals {
  config?: string;
  image?: string;
  backend: 'docker' | 'podman';
  json: boolean;
  frozen: boolean;
  dev: boolean;
  failOnEgress: boolean;
  failOnRisk?: boolean;
  fullNetwork: boolean;
  risk?: 'off' | 'basic' | 'thorough';
  envNames: string[];
  envFiles: string[];
  dryRun: boolean;
  /** Release-age gate threshold in days (overrides config; 0 disables). */
  minReleaseAge?: number;
  /** Package-name patterns exempt from the release-age gate (merged with config). */
  allowRecent: string[];
  /** Gate the whole resolved tree from the lockfile, not just direct deps. */
  deep: boolean;
  /** Block on a known-malware advisory (overrides config). */
  failOnAdvisory?: boolean;
  /** Allow installing a maintainer-deprecated version for this run (overrides the default block). */
  failOnDeprecated?: boolean;
}

const JSON_SAFE_ENV = new Set(['SANDBOX', 'CI', 'HOME', 'SSH_AUTH_SOCK']);

const HELP = `sandbox — put it in front of the npm/pnpm/yarn/bun command you already run

Usage: sandbox [globals] <command> [args]

Just add "sandbox" in front — same commands, fewer secrets exposed:
  sandbox setup --vibe         one-button setup for vibe/dev work
  sandbox npm install          install deps in the sandbox (lifecycle scripts contained)
  sandbox pnpm add zod         add a dependency
  sandbox npm run dev          run a script (dev server, tests, build, …)
  sandbox npx vite             run a one-off tool
Works with npm, pnpm, yarn, and bun — install/ci/add and any run/exec script. Your SSH keys,
npm token, cloud creds, and editor/agent state stay out unless you grant them.

Sandbox commands:
  init [--preset N]    create sandbox.config.json from a preset (interactive picker,
                       or non-interactive with --preset strict|balanced|vibe|agent|trusted [--force])
  setup [--preset N]   one-button onboarding: write config if needed, check backend,
                       build images if needed, then print the next commands
  allow <host...>      add host(s) to egress.allow in sandbox.config.json
  preflight [pm cmd]   supply-chain review WITHOUT installing: run the gates over what the
                       command would pull, print every finding (+ a pin suggestion per blocked
                       package), and exit non-zero exactly when that install would be blocked.
                       e.g. sandbox --min-release-age 7 --fail-on-advisory preflight npm install
  doctor               check config, package manager, backend, daemon, and image state
  build                build (or rebuild) the sandbox + egress-proxy images
  devcontainer init    generate a .devcontainer/ from sandbox.config.json — the persistent
                       (per-session) form of the same policy: run the agent + editor INSIDE
                       the jail, with the same egress allowlist. Add --force to overwrite.

Expert (explicit) commands — same models the pass-through maps onto:
  install [pm-args]    install deps. Persistence paths (.git/.github/.husky/.claude/…)
                       and package.json are read-only; root stays writable. No host
                       creds. Egress default-deny (allowlist: registry only).
  add <pkg...>         add dependency(ies) — the only command that writes package.json
  run -- <cmd...>      run a command in the container (network: none by default)
  shell                interactive shell in the container

Globals (before the command):
  --config <path>      use a specific sandbox.config.json
  --image <tag>        override the sandbox image tag
  --backend <docker|podman>   container runtime (default docker; or $SANDBOX_BACKEND)
  --env <NAME>         forward one host env var by name for this invocation
  --env-from <path>    parse one env file on the host and inject its values; append
                       :KEY1,KEY2 to inject only those keys (e.g. .env:FOO,BAR).
                       Named --env-from because Node ≥20.6 reserves --env-file.
  --dev                one-off dev mode: run network on + common dev ports; no extra secrets
  --frozen             reproducible install (npm ci / --frozen-lockfile); on every package
                       manager except pnpm the ENTIRE source tree is read-only. Needs a
                       committed lockfile.
  --fail-on-egress     exit non-zero if the proxy blocked any egress (CI tripwire)
  --risk <off|basic|thorough>  registry risk hints: off; basic (packument-only: typosquat,
                       provenance regression, maintainer takeover, …); thorough adds
                       network checks (missing metadata, low downloads, expired domains)
  --fail-on-risk       exit non-zero when risk hints are found (blocks before running)
  --min-release-age <days>   BLOCK installing any version published fewer than <days> ago
                       (overrides config; 0 disables). The strongest control against
                       publish-and-detonate supply-chain worms. The strict preset sets 7.
  --allow-recent <pat> exempt a package-name pattern from the release-age gate (repeatable;
                       globs allowed, e.g. @myscope/*). Merges with install.minReleaseAgeExclude.
  --deep               extend the blocking gates (release-age, deprecated, and malware when
                       --fail-on-advisory is set) to the whole resolved tree (transitive),
                       read from the lockfile (npm + pnpm + yarn), not just direct deps
  --fail-on-advisory   BLOCK when a version is flagged as malware in the OSV advisory DB
                       (the strict preset sets this)
  --allow-deprecated   allow installing a maintainer-DEPRECATED version (off by default:
                       deprecated versions are abandoned and a supply-chain risk, so they
                       are blocked). Rides on risk hints, so --risk off also disables it.
  --full-network       scarier escape hatch: run this once with full network (no egress
                       allowlist); with run/shell it also enables common dev ports
  --dry-run            preview what would be mounted, allowed, and run — then stop (human-readable)
  --json               print the resolved execution plan as JSON instead of running it

Logging: human lines on stderr by default; set SANDBOX_LOG=json for NDJSON,
SANDBOX_LOG_LEVEL=debug|info|warn|error to filter.
`;

/** Parse global flags that appear BEFORE the command (so they never clash with `run --`). */
function parse(argv: string[]): { globals: Globals; cmd?: string; args: string[] } {
  const backendEnv = process.env.SANDBOX_BACKEND;
  const globals: Globals = {
    backend: backendEnv === 'podman' ? 'podman' : 'docker',
    json: false,
    frozen: false,
    dev: false,
    failOnEgress: false,
    fullNetwork: false,
    envNames: [],
    envFiles: [],
    dryRun: false,
    allowRecent: [],
    deep: false,
  };
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config') globals.config = argv[++i];
    else if (a === '--image') globals.image = argv[++i];
    else if (a === '--backend') globals.backend = argv[++i] === 'podman' ? 'podman' : 'docker';
    else if (a === '--json') globals.json = true;
    else if (a === '--env') globals.envNames.push(argv[++i] ?? '');
    else if (a === '--env-from' || a === '--env-file') globals.envFiles.push(argv[++i] ?? ''); // --env-file kept as a legacy alias; Node ≥20.6 reserves it, so --env-from is preferred
    else if (a === '--dev') globals.dev = true;
    else if (a === '--frozen') globals.frozen = true;
    else if (a === '--fail-on-egress') globals.failOnEgress = true;
    else if (a === '--risk') {
      const v = argv[++i];
      globals.risk = v === 'off' ? 'off' : v === 'thorough' ? 'thorough' : 'basic';
    }
    else if (a === '--fail-on-risk') globals.failOnRisk = true;
    else if (a === '--full-network') globals.fullNetwork = true;
    else if (a === '--dry-run') globals.dryRun = true;
    else if (a === '--min-release-age') {
      const raw = argv[++i];
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0) fail(`--min-release-age needs a non-negative whole number of days (got '${raw ?? ''}')`);
      globals.minReleaseAge = n;
    } else if (a === '--allow-recent') globals.allowRecent.push(argv[++i] ?? '');
    else if (a === '--deep') globals.deep = true;
    else if (a === '--fail-on-advisory') globals.failOnAdvisory = true;
    else if (a === '--allow-deprecated') globals.failOnDeprecated = false;
    else break;
  }
  return { globals, cmd: argv[i], args: argv.slice(i + 1) };
}

function fail(msg: string): never {
  console.error(`sandbox: ${msg}`);
  process.exit(1);
}

function redactPlanEnv(plan: RunPlan): RunPlan {
  return {
    ...plan,
    env: Object.fromEntries(
      Object.entries(plan.env).map(([key, value]) => [key, JSON_SAFE_ENV.has(key) ? value : '[redacted]']),
    ),
  };
}

/**
 * One-off invocation modes:
 * `--dev` opens only run/shell networking + common dev ports;
 * `--full-network` also drops install/add egress back to the default bridge.
 */
function applyOneOffModes(config: SandboxConfig, globals: Globals): SandboxConfig {
  if (!globals.dev && !globals.fullNetwork) return config;
  const run = { ...config.run, network: 'on' as const, devPorts: true };
  if (!globals.fullNetwork) return { ...config, run };
  return { ...config, install: { ...config.install, network: 'on' }, run };
}

/** A frozen install needs a committed lockfile for the (possibly explicitly-named) pm. */
function requireLockfileForFrozen(facts: ProjectFacts, frozen: boolean): void {
  if (frozen && !facts.hasLockfile) {
    const lf = lockfileName(facts.pm);
    fail(`reproducible install needs a committed ${lf} — run \`sandbox ${facts.pm} install <pkg>\` to create one, or drop --frozen`);
  }
}

/**
 * Every plan-producing command reduces to one of three containment models. The explicit
 * subcommands (`install`/`add`/`run`/`shell`) and the transparent `sandbox <npm|pnpm|yarn|
 * npx|…>` pass-through all resolve here, so risk-checking and planning happen once, in one
 * place, instead of being re-derived per command. Bad input and unknown commands `fail()`.
 */
function resolveRoute(cmd: string, args: string[], facts: ProjectFacts): Route {
  switch (cmd) {
    case 'install':
      return { model: 'install', pm: facts.pm, frozen: false, args };
    case 'add':
      if (args.length === 0) fail('usage: sandbox add <pkg>...  (deliberate package.json change)');
      return { model: 'add', pm: facts.pm, pkgs: args };
    case 'run': {
      const argv = args[0] === '--' ? args.slice(1) : args;
      if (argv.length === 0) fail('usage: sandbox run -- <cmd...>');
      return { model: 'run', argv };
    }
    case 'shell':
      return { model: 'run', argv: ['bash', '-l'] };
    default: {
      // Transparent pass-through: `sandbox npm install`, `sandbox pnpm add zod`, `sandbox npm run dev`.
      const route = routePassthrough([cmd, ...args]);
      if (!route) {
        fail(`unknown command '${cmd}'\n  try a command you know:  sandbox npm install · sandbox pnpm add zod · sandbox npm run dev\n  or a sandbox command:     init · setup · allow · doctor · build · install · add · run · shell`);
      }
      return route;
    }
  }
}

/**
 * Turn a {@link Route} into a plan. install/add honour the pm the user actually typed
 * (`sandbox pnpm add zod` stays pnpm regardless of the lockfile probe); run executes the
 * command verbatim. The frozen-needs-a-lockfile invariant lives here, the one planning seam.
 */
function planForRoute(route: Route, config: SandboxConfig, facts: ProjectFacts, opts: PlanOptions): RunPlan {
  switch (route.model) {
    case 'install': {
      const f = { ...facts, pm: route.pm };
      const frozen = route.frozen || (opts.frozen ?? config.install.frozen);
      requireLockfileForFrozen(f, frozen);
      return planInstall(config, f, route.args, { ...opts, frozen });
    }
    case 'add':
      return planAdd(config, { ...facts, pm: route.pm }, route.pkgs, opts);
    case 'run':
      return planRun(config, facts, route.argv, opts);
  }
}

function formatRiskPackage(hint: RiskHint): string {
  return `${hint.package}${hint.version ? `@${hint.version}` : ''}`;
}

function riskDetailLine(hint: RiskHint): string {
  if (hint.code === 'bin_exposed') return `adds bin: ${hint.detail.bin}`;
  if (hint.code === 'recent_version') return hint.detail.severity === 'strong' ? `!! ${hint.message}` : hint.message;
  // High-signal codes (typosquat, provenance regression, maintainer takeover, expired domain) are
  // error-level — flag them with the same `!!` emphasis as a very-fresh version.
  return hint.level === 'error' ? `!! ${hint.message}` : hint.message;
}

function logRiskHints(targets: RiskTarget[], allHints: RiskHint[]): void {
  if (targets.length) log.info(`checked ${targets.length} package${targets.length === 1 ? '' : 's'} for registry risk hints`);
  const hints = allHints.filter((h) => h.code !== 'deprecated'); // deprecated has its own gate/message
  if (!hints.length) return;
  log.warn(`${hints.length} risk hint${hints.length === 1 ? '' : 's'}`);
  const grouped = new Map<string, RiskHint[]>();
  for (const hint of hints) {
    const key = formatRiskPackage(hint);
    grouped.set(key, [...(grouped.get(key) ?? []), hint]);
  }
  for (const [pkg, pkgHints] of grouped) {
    const level = pkgHints.some((hint) => hint.level === 'error') ? 'error' : 'warn';
    const lines = [pkg, ...pkgHints.map((hint) => `  ${riskDetailLine(hint)}`)];
    if (level === 'error') log.error(lines.join('\n'));
    else log.warn(lines.join('\n'));
  }
  log.info('continuing inside containment');
}

/**
 * The packages a route would pull from the registry — the supply-chain surface to check:
 * `add`/`install` look at the named (or lockfile-pinned) deps; `run` looks only at what a
 * fetch-and-run command (`npx`/`dlx`/`bunx`/`npm exec`) would fetch, so running your own
 * code (`node`, `vite`, a script) yields nothing.
 */
function riskTargetsForRoute(route: Route, facts: ProjectFacts): RiskTarget[] {
  switch (route.model) {
    case 'add':
      return parsePackageTargets(route.pkgs);
    case 'install': {
      const named = parsePackageTargets(route.args);
      return named.length ? named : riskTargetsForInstall(facts);
    }
    case 'run':
      return execPackageTargets(route.argv);
  }
}

function formatAge(ms: number): string {
  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

function logReleaseAgeBlock(violations: ReleaseAgeViolation[], minDays: number, pm: PackageManager, suggestions: PinSuggestion[]): void {
  const pin = new Map(suggestions.map((s) => [s.name, s]));
  const lines = [
    `blocked by the release-age gate (min ${minDays} day${minDays === 1 ? '' : 's'})`,
    ...violations.map((v) => {
      const s = pin.get(v.name);
      const tail = s ? `\n    ↳ pin a known-good version: sandbox ${pm} add ${v.name}@${s.version} (published ${formatAge(s.ageMs)})` : '';
      return `  ${v.name}@${v.version} was published ${formatAge(v.ageMs)}${tail}`;
    }),
    'freshly-published versions are the supply-chain worm window. Options:',
    suggestions.length ? '  • pin the suggested older version above' : '  • pin a known-good older version',
    '  • wait until it ages past the threshold, then retry',
    '  • override this once: add --min-release-age 0 before the command',
  ];
  log.error(lines.join('\n'));
}

function logAdvisoryHits(hits: AdvisoryHit[]): void {
  for (const hit of hits) {
    const ids = hit.ids.join(', ');
    if (hit.malware) log.error(`${hit.name}@${hit.version} — KNOWN MALWARE advisory (${ids})`);
    else log.warn(`${hit.name}@${hit.version} — advisory ${ids}`);
  }
}

/** The gate policy resolved for one route — flags override config, config fills the rest. */
interface ActivePolicy {
  riskHints: boolean;
  minReleaseAgeDays: number;
  failOnAdvisory: boolean;
  failOnDeprecated: boolean;
  failOnRisk: boolean;
  deep: boolean;
  policy: PreflightPolicy;
}

/** Resolve the active gate policy once, so the install path and the `preflight` command agree. */
function resolvePolicy(globals: Globals, config: SandboxConfig, route: Route): ActivePolicy {
  const riskLevel = globals.risk ?? config.install.riskHints;
  const riskHints = riskLevel !== 'off';
  const thorough = riskLevel === 'thorough';
  const minReleaseAgeDays = globals.minReleaseAge ?? config.install.minReleaseAgeDays;
  const failOnAdvisory = globals.failOnAdvisory ?? config.install.failOnAdvisory;
  const failOnDeprecated = globals.failOnDeprecated ?? config.install.failOnDeprecated;
  const failOnRisk = globals.failOnRisk ?? config.install.failOnRisk;
  const deep = globals.deep && (route.model === 'install' || route.model === 'add');
  return {
    riskHints,
    minReleaseAgeDays,
    failOnAdvisory,
    failOnDeprecated,
    failOnRisk,
    deep,
    policy: {
      riskHints,
      thorough,
      minReleaseAgeDays,
      releaseAgeExclude: [...config.install.minReleaseAgeExclude, ...globals.allowRecent],
      deep,
      advisories: failOnAdvisory,
    },
  };
}

/** The deprecated-version findings (a maintainer-flagged version we must never install). */
function deprecatedHints(result: PreflightResult): RiskHint[] {
  return result.hints.filter((h) => h.code === 'deprecated');
}

/** No gate is active — nothing to resolve or check. */
function nothingToCheck(ap: ActivePolicy): boolean {
  return !ap.riskHints && !ap.failOnAdvisory && ap.minReleaseAgeDays === 0;
}

/**
 * The blocking decision, pure over the findings. Precedence matches the install gate: release-age
 * first (the strongest control), then known malware, then deprecated versions (blocked by default),
 * then risk hints under `--fail-on-risk`. Returns the exit code to block with, or undefined to proceed.
 */
function blockExit(result: PreflightResult, ap: ActivePolicy): number | undefined {
  if (result.ageViolations.length) return 1;
  if (result.advisoryHits.some((h) => h.malware)) return 1;
  if (ap.failOnDeprecated && deprecatedHints(result).length) return 1;
  if (ap.riskHints && result.hints.length && ap.failOnRisk) return 1;
  return undefined;
}

/**
 * Log the deprecated-version gate. Deprecated versions are abandoned (no security fixes, a standing
 * supply-chain risk), so the default is to BLOCK — and the message says how to override. When the
 * user has explicitly allowed them (`--allow-deprecated`), they're downgraded to a warning. Returns
 * the blocking exit code, or undefined to proceed.
 */
function logDeprecatedGate(hints: RiskHint[], failOnDeprecated: boolean): number | undefined {
  if (!hints.length) return undefined;
  const list = hints.map((h) => `  ${h.package}${h.version ? `@${h.version}` : ''} — ${h.message}`);
  if (!failOnDeprecated) {
    log.warn(['deprecated version(s) allowed via --allow-deprecated:', ...list].join('\n'));
    return undefined;
  }
  log.error(
    [
      'blocked: a maintainer-deprecated version would be installed — deprecated versions are abandoned and a supply-chain risk',
      ...list,
      'options:',
      '  • upgrade to a non-deprecated version',
      '  • override this once: add --allow-deprecated before the command',
    ].join('\n'),
  );
  return 1;
}

function logDeep(ap: ActivePolicy, result: PreflightResult, pm: PackageManager): void {
  if (!ap.deep) return;
  if (result.deepCount === 0) log.warn(`--deep: no lockfile tree for ${pm}; gated the direct deps instead`);
  else if (result.deepCount) log.info(`--deep: scanned ${result.deepCount} resolved packages from the lockfile (release age, deprecations, malware as enabled)`);
}

/**
 * The supply-chain preflight on the *install* path. Resolves the registry ONCE (in
 * {@link runPreflight}), runs every active gate over that one result, logs findings, and returns the
 * blocking exit code. Logging short-circuits at the first block (release-age → malware →
 * `--fail-on-risk`). Everything fails open on a lookup error. `--json`/`--dry-run` skip it entirely.
 */
async function preflightRoute(globals: Globals, config: SandboxConfig, facts: ProjectFacts, route: Route): Promise<number | undefined> {
  if (globals.json || globals.dryRun) return undefined;
  const ap = resolvePolicy(globals, config, route);
  if (nothingToCheck(ap)) return undefined;

  const targets = riskTargetsForRoute(route, facts);
  const result = await runPreflight(targets, ap.policy, { pm: facts.pm, cwd: facts.cwd });
  logDeep(ap, result, facts.pm);

  // Release-age gate — the strongest control, so it blocks first.
  if (result.ageViolations.length) {
    const suggestions = await suggestPins(result.ageViolations, ap.minReleaseAgeDays);
    logReleaseAgeBlock(result.ageViolations, ap.minReleaseAgeDays, facts.pm, suggestions);
    return 1;
  }
  // Known-malware advisory.
  if (result.advisoryHits.length) {
    logAdvisoryHits(result.advisoryHits);
    if (result.advisoryHits.some((h) => h.malware)) {
      log.error('blocking: a version is flagged as malware and --fail-on-advisory is set');
      return 1;
    }
  }
  // Deprecated version — its own gate, blocked by default.
  const depExit = logDeprecatedGate(deprecatedHints(result), ap.failOnDeprecated);
  if (depExit !== undefined) return depExit;
  // Advisory/risk hints — advisory by default, blocking only with --fail-on-risk.
  if (ap.riskHints) {
    logRiskHints(targets, result.hints);
    if (result.hints.length && ap.failOnRisk) {
      log.error('blocking because --fail-on-risk is set');
      return 1;
    }
  }
  return undefined;
}

function renderPreflightJson(result: PreflightResult, suggestions: PinSuggestion[], blocked: boolean, pm: PackageManager): string {
  const days = (ms: number): number => Math.floor(ms / (24 * 60 * 60 * 1000));
  return JSON.stringify(
    {
      blocked,
      checked: result.checkedCount,
      deepChecked: result.deepCount ?? 0,
      hints: result.hints.filter((h) => h.code !== 'deprecated'), // deprecated reported in its own field
      ageViolations: result.ageViolations.map((v) => ({ name: v.name, version: v.version, publishedAt: v.publishedAt.toISOString(), ageDays: days(v.ageMs) })),
      advisoryHits: result.advisoryHits,
      deprecations: deprecatedHints(result).map((h) => ({ name: h.package, version: h.version, reason: h.code === 'deprecated' ? h.detail.deprecated : h.message })),
      suggestions: suggestions.map((s) => ({ name: s.name, version: s.version, pin: `sandbox ${pm} add ${s.name}@${s.version}`, ageDays: days(s.ageMs) })),
    },
    null,
    2,
  );
}

/**
 * The read-only `preflight` command: run the same gates as the install path but NEVER install —
 * report every finding (no short-circuit) and exit non-zero exactly when the matching install would
 * have been blocked. This is the review pass an agent/skill runs before deciding what flags to use,
 * and the human equivalent of "show me the risk before I commit". `--json` emits the findings plus
 * a concrete pin suggestion per blocked package; otherwise the same human lines as the install path.
 */
async function runPreflightCommand(globals: Globals, config: SandboxConfig, facts: ProjectFacts, route: Route): Promise<number> {
  const ap = resolvePolicy(globals, config, route);
  const targets = riskTargetsForRoute(route, facts);

  if (nothingToCheck(ap)) {
    if (globals.json) console.log(JSON.stringify({ blocked: false, gatesEnabled: false, checked: 0, hints: [], ageViolations: [], advisoryHits: [], suggestions: [] }, null, 2));
    else log.info('no supply-chain gates enabled — pass --min-release-age, --fail-on-advisory, and/or --fail-on-risk (or `sandbox init --preset strict`)');
    return 0;
  }

  const result = await runPreflight(targets, ap.policy, { pm: facts.pm, cwd: facts.cwd });
  const suggestions = result.ageViolations.length ? await suggestPins(result.ageViolations, ap.minReleaseAgeDays) : [];
  const exit = blockExit(result, ap) ?? 0;

  if (globals.json) {
    console.log(renderPreflightJson(result, suggestions, exit !== 0, facts.pm));
    return exit;
  }

  // Human report: log every finding (no short-circuit — this is a report, not a gate).
  logDeep(ap, result, facts.pm);
  if (result.ageViolations.length) logReleaseAgeBlock(result.ageViolations, ap.minReleaseAgeDays, facts.pm, suggestions);
  if (result.advisoryHits.length) logAdvisoryHits(result.advisoryHits);
  logDeprecatedGate(deprecatedHints(result), ap.failOnDeprecated);
  if (ap.riskHints) logRiskHints(targets, result.hints);

  if (exit) log.error('preflight: would BLOCK this install — resolve the findings above, or re-run with an override flag');
  else log.info('preflight: no blocking findings — safe to install');
  return exit;
}

async function main(): Promise<number> {
  const { globals, cmd, args } = parse(process.argv.slice(2));

  if (cmd === undefined || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(HELP);
    return 0;
  }

  const invocationCwd = process.cwd();
  const context = resolveProjectContext(invocationCwd, globals.config);

  if (cmd === 'init') {
    let preset: string | undefined;
    let force = false;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--preset') preset = args[++i];
      else if (args[i] === '--vibe') preset = 'vibe'; // sugar for the common "explore + run dev" setup
      else if (args[i] === '--agent') preset = 'agent'; // sugar for the coding-agent setup
      else if (args[i] === '--force') force = true;
    }
    return runInit(context.rootDir, { preset, force });
  }

  if (cmd === 'setup') {
    let preset: string | undefined;
    let force = false;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--preset') preset = args[++i];
      else if (args[i] === '--vibe') preset = 'vibe';
      else if (args[i] === '--agent') preset = 'agent';
      else if (args[i] === '--force') force = true;
    }
    return runSetup(context.rootDir, {
      preset,
      force,
      backend: globals.backend,
      image: globals.image,
    });
  }

  const backend = createBackend(globals.backend);

  if (cmd === 'build') {
    const config = readConfig(context.rootDir, context.configPath);
    return backend.buildImages(globals.image ?? config.image);
  }

  if (cmd === 'doctor') {
    return runDoctor(context.rootDir, {
      config: context.configPath,
      image: globals.image,
      backend: globals.backend,
      invocationCwd,
      runWorkdir: context.runWorkdir,
    });
  }

  if (cmd === 'devcontainer') {
    const sub = args[0];
    if (sub !== 'init') fail('usage: sandbox devcontainer init [--force]');
    const force = args.includes('--force');
    const config = readConfig(context.rootDir, context.configPath);
    try {
      const digest = await resolveImageDigest(globals.backend, BASE_IMAGE);
      const baseImage = digest ? `${BASE_IMAGE}@${digest}` : BASE_IMAGE;
      const { files, firewall, pinned } = writeDevcontainer(context.rootDir, config, { force, baseImage });
      console.log('sandbox: wrote a persistent devcontainer from sandbox.config.json');
      for (const f of files) console.log(`  ${path.relative(context.rootDir, f)}`);
      console.log('');
      console.log(pinned ? 'Base image: pinned by digest (a # renovate: annotation lets Renovate keep it current, if this repo uses Renovate).' : `Base image: ${BASE_IMAGE} (tag only; couldn't reach the registry to pin a digest). Re-run \`sandbox devcontainer init --force\` while online to pin it.`);
      console.log(firewall ? 'Egress firewall: ON (same allowlist as your install egress + Claude domains).' : 'Egress firewall: off (config allows full network).');
      console.log('');
      console.log('Next:');
      console.log('  1. Open this folder in VS Code → "Reopen in Container" (or Codespaces).');
      console.log('  2. Inside the container: run `claude`, then plain `npm install`. The whole');
      console.log('     environment IS the sandbox, so do NOT use `sandbox npm install` in here.');
      return 0;
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }
  }

  if (cmd === 'allow') {
    const hosts = args.filter(Boolean);
    if (!hosts.length) fail('usage: sandbox allow <host...>');
    const result = allowHosts(context.rootDir, hosts, context.configPath);
    console.log(`sandbox: updated ${context.configPath ?? 'sandbox.config.json'}`);
    console.log(result.added.length ? `sandbox: allowed ${result.added.join(', ')}` : 'sandbox: no new hosts added (already covered)');
    return 0;
  }

  const config = applyOneOffModes(readConfig(context.rootDir, context.configPath), globals);
  const facts = probeProject(context.rootDir, config, {
    envFiles: globals.envFiles.filter(Boolean),
    envFileBaseDir: context.cwd,
    configEnvFilesBaseDir: context.rootDir,
  });
  const opts: PlanOptions = { workdir: context.runWorkdir, envNames: globals.envNames.filter(Boolean) };
  if (globals.image) opts.image = globals.image;
  if (globals.frozen) opts.frozen = true;

  const emit = (plan: RunPlan): Promise<number> => {
    if (globals.dryRun) {
      console.log(renderPlanSummary(plan));
      return Promise.resolve(0);
    }
    if (globals.json) {
      console.log(JSON.stringify(redactPlanEnv(plan), null, 2));
      return Promise.resolve(0);
    }
    return execute(plan, backend, { failOnEgress: globals.failOnEgress });
  };

  if (cmd === 'preflight') {
    // `sandbox preflight [pm cmd…]` checks WITHOUT installing. Default to the install surface.
    const inner = args[0];
    const checkRoute = inner ? resolveRoute(inner, args.slice(1), facts) : resolveRoute('install', [], facts);
    return runPreflightCommand(globals, config, facts, checkRoute);
  }

  const route = resolveRoute(cmd, args, facts);
  const blocked = await preflightRoute(globals, config, facts, route);
  if (blocked !== undefined) return blocked;
  return emit(planForRoute(route, config, facts, opts));
}

main()
  .then((code) => process.exit(code))
  .catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));
