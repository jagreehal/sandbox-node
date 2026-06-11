#!/usr/bin/env node
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { spinner } from '@clack/prompts';
import { createBackend } from './backend.js';
import { createBuildReporter, type BuildReporter } from './build-progress.js';
import type { SandboxConfig } from './config.js';
import { loadConfig, readConfig } from './config.js';
import { resolveProjectContext } from './context.js';
import { renderBadge } from './badge.js';
import { COMPLETION_SHELLS, completionScript, isCompletionShell } from './completion.js';
import { resolveBuildSpec } from './image.js';
import { runVerify } from './verify.js';
import { BASE_IMAGE, resolveImageDigest, writeDevcontainer } from './devcontainer.js';
import { renderPlanSummary } from './dryrun.js';
import { routePassthrough, type Route } from './dispatch.js';
import { runDoctor } from './doctor.js';
import { execute } from './index.js';
import { runInit } from './init.js';
import { log } from './log.js';
import { lockfileName, pmAuditFixArgv, pmAuditSignaturesArgv, pmUpdateArgv, resolvePackageManager, type PackageManager } from './package-manager.js';
import { planAdd, planAudit, planAuditFix, planAuditSignatures, planInstall, planRun, planUpdate, type PlanOptions, type RunPlan } from './plan.js';
import { probeProject, type ProjectFacts } from './project.js';
import { allowHosts, allowHostsLocal, projectRegistryHints } from './registry.js';
import { detectShell, installPath, SHELLS, statusPath, uninstallPath, type PathActionResult, type Shell } from './path-setup.js';
import { type AdvisoryHit } from './advisory.js';
import { runPreflight, suggestPins, type PinSuggestion, type PreflightPolicy, type PreflightResult } from './preflight.js';
import { runScan } from './scan.js';
import { runDelta } from './delta.js';
import { execPackageTargets, parseLockfilePackages, parsePackageTargets, riskTargetsForInstall, riskTargetsForUpdate, type LockfilePackage, type ReleaseAgeViolation, type RiskHint, type RiskTarget } from './risk.js';
import { canPromptInteractively, nextPlanForBlockedEgressChoice, promptForBlockedEgress } from './interactive.js';
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
  /** Local TTY mode: prompt before widening the boundary after a block. */
  interactive: boolean;
  /** Block on a known-malware advisory (overrides config). */
  failOnAdvisory?: boolean;
  /** Allow installing a maintainer-deprecated version for this run (overrides the default block). */
  failOnDeprecated?: boolean;
}

const JSON_SAFE_ENV = new Set(['SANDBOX', 'CI', 'HOME', 'SSH_AUTH_SOCK', 'HOST']);

const HELP = `sandbox — put it in front of the npm/pnpm/yarn/bun command you already run

Usage: sandbox [globals] <command> [args]

Just add "sandbox" in front — same commands, fewer secrets exposed:
  sandbox setup --vibe         one-button setup for vibe/dev work
  sandbox npm install          install deps in the sandbox (lifecycle scripts contained)
  sandbox pnpm add zod         add a dependency (saved exact by default)
  sandbox npm update           update deps — gated + sandboxed like install (pnpm up / yarn upgrade too)
  sandbox npm audit fix        remediate vulnerabilities under install-class isolation
  sandbox npm audit signatures verify registry signatures/provenance for installed packages
  sandbox npm run dev          run a script (dev server, tests, build, …)
  sandbox npx vite             run a one-off tool
Works with npm, pnpm, yarn, and bun — install/ci/add/update, npm audit fix, pnpm audit --fix,
report-only audit commands, \`npm audit signatures\`, \`pnpm audit signatures\`, and any run/exec
script. Your SSH keys, npm token, cloud creds, and editor/agent state stay out unless you grant
them.

Sandbox commands:
  init [--preset N]    create sandbox.config.json from a preset (interactive picker,
                       or non-interactive with --preset strict|balanced|vibe|agent|trusted [--force])
  setup [--preset N]   one-button onboarding: write config if needed, check backend,
                       build images if needed, then print the next commands
  allow <host...>      add host(s) to egress.allow in sandbox.config.json
  path [install|uninstall|status|print]   install shell wrappers (zsh/bash/fish/pwsh) so a bare
                       npm/pnpm/yarn/bun install + npx/bunx route through sandbox automatically —
                       the human equivalent of the agent hook. Also wires tab-completion. Bypass
                       once with 'command npm ...' or a whole shell with SANDBOX_OFF=1.
  completion <shell>   print a standalone tab-completion script for zsh|bash|fish (commands,
                       globals, --preset/--backend/--risk). \`sandbox path install\` already wires
                       this in; use this to install it on its own, e.g. for zsh:
                       \`sandbox completion zsh > "\${fpath[1]}/_sandbox"\`.
  preflight [pm cmd]   supply-chain review WITHOUT installing: run the gates over what the
                       command would pull, print every finding (+ a pin suggestion per blocked
                       package), and exit non-zero exactly when that install would be blocked.
                       e.g. sandbox --min-release-age 7 --fail-on-advisory preflight npm install
  scan                 RETROACTIVE malware sweep: re-query OSV for the versions in your committed
                       lockfile and exit non-zero if any installed package is NOW flagged as
                       malware. Catches deps that turned malicious AFTER you installed them — the
                       gap install-time gating can't cover. No container needed. Run in CI/cron.
  delta [--base <ref>] gate ONLY the dependency changes a PR introduces: diff the lockfile against
                       <ref> (default origin/main; or --base-lockfile <path>) and run the release-age,
                       malware, and deprecation gates over just the added/bumped versions. Honors
                       --min-release-age / --fail-on-advisory. Fast, low-noise PR check.
  doctor [--fix]       check config, package manager, backend, daemon, and image state.
                       --fix runs the safe remedies (currently: rebuild an absent/stale image).
  build                build (or rebuild) the sandbox + egress-proxy images
  verify [--scan]      exit non-zero unless this repo commits a real sandbox boundary and
                       no personal layer has loosened it — the CI gate behind the badge.
                       --scan also runs the retroactive malware sweep (so the badge means
                       "boundary intact AND no installed dep is currently flagged as malware")
  badge [--workflow F] print a markdown "sandboxed" badge. Bare = static provenance badge;
                       --workflow sandbox.yml = the CI-backed verified badge (--repo to override)
  devcontainer init    generate a .devcontainer/ from sandbox.config.json — the persistent
                       (per-session) form of the same policy: run the agent + editor INSIDE
                       the jail, with the same egress allowlist. Add --force to overwrite.

Expert (explicit) commands — same models the pass-through maps onto:
  install [pm-args]    install deps. Persistence paths (.git/.github/.husky/.claude/…)
                       and package.json are read-only; root stays writable. No host
                       creds. Egress default-deny (allowlist: registry only).
  add <pkg...>         add dependency(ies) — the only command that writes package.json,
                       and saves them as exact versions by default
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
  --interactive        local TTY mode: when egress is blocked, show what each host is and
                       prompt to allow once, save for the team (sandbox.config.json), save just
                       for you (sandbox.config.local.json), or retry once with full network
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
    interactive: false,
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
    else if (a === '--interactive' || a === '--prompt') globals.interactive = true;
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

/**
 * The reporter the CLI hands the backend for the one-time image build: a clack spinner on a TTY
 * (drawn on stderr so stdout — JSON/plan/container output — stays clean), and plain stderr lines in
 * CI or when piped. Lazy: the spinner only animates if `ensureImage` actually starts a build.
 */
function ttyBuildReporter(): BuildReporter {
  if (!process.stderr.isTTY) return createBuildReporter();
  const s = spinner({ output: process.stderr });
  let active = false;
  return createBuildReporter({
    start: (m) => { s.start(m); active = true; },
    succeed: (m) => { if (active) { s.stop(m); active = false; } },
    fail: (m) => { if (active) { s.error(m); active = false; } },
  });
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
    case 'update':
      return planUpdate(config, { ...facts, pm: route.pm }, pmUpdateArgv(route.pm, route.verb, route.args), opts);
    case 'auditFix':
      return planAuditFix(config, { ...facts, pm: route.pm }, pmAuditFixArgv(route.pm, route.fixToken, route.args), opts);
    case 'audit':
      return planAudit(config, facts, route.argv, opts);
    case 'auditSignatures':
      return planAuditSignatures(config, { ...facts, pm: route.pm }, pmAuditSignaturesArgv(route.pm, route.args), opts);
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
    case 'update': {
      const latest = route.args.some((a) => a === '--latest' || a === '-L');
      const names = parsePackageTargets(route.args).map((t) => t.name);
      return riskTargetsForUpdate({ ...facts, pm: route.pm }, names, latest);
    }
    case 'auditFix':
      return riskTargetsForUpdate({ ...facts, pm: route.pm }, parsePackageTargets(route.args).map((t) => t.name), false);
    case 'audit':
    case 'auditSignatures':
      return []; // read-only verification: installs nothing, so there's no supply-chain surface to gate
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
  const deep = globals.deep && (route.model === 'install' || route.model === 'add' || route.model === 'update' || route.model === 'auditFix');
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

/**
 * `sandbox scan` — RETROACTIVE malware sweep over the committed lockfile. Where preflight gates what
 * an install WOULD pull, scan re-checks what's ALREADY pinned, so a dependency OSV flagged *after*
 * you installed it is caught on the next run (CI/cron). Malware blocks (exit 1); other advisories are
 * reported as warnings. Network-only (no container); fails open per package on an OSV error.
 */
async function runScanCommand(globals: Globals, pm: PackageManager, cwd: string): Promise<number> {
  const result = await runScan({ pm, cwd });
  if (globals.json) {
    console.log(
      JSON.stringify(
        { scanned: result.scanned, lockfileMissing: result.lockfileMissing, blocked: result.malware.length > 0, malware: result.malware, advisories: result.hits.filter((h) => !h.malware) },
        null,
        2,
      ),
    );
    return result.malware.length ? 1 : 0;
  }
  if (result.lockfileMissing) {
    log.warn(`scan: no parseable lockfile for ${pm} — nothing to scan (commit a lockfile; bun has no parser yet)`);
    return 0;
  }
  logAdvisoryHits(result.hits);
  if (result.malware.length) {
    log.error(`scan: ${result.malware.length} installed package(s) are NOW flagged as malware in OSV — remove or upgrade them (scanned ${result.scanned})`);
    return 1;
  }
  log.info(`scan: clean — no installed package is currently flagged as malware (scanned ${result.scanned}${result.hits.length ? `; ${result.hits.length} non-malware advisory hint(s) above` : ''})`);
  return 0;
}

/** Read the base (merge-target) lockfile for `delta`: an explicit file, else `git show <ref>:<lockfile>`. */
function readBaseLockfile(rootDir: string, pm: PackageManager, baseRef: string, baseFile?: string): LockfilePackage[] | undefined {
  try {
    const text = baseFile
      ? readFileSync(baseFile, 'utf8')
      : execFileSync('git', ['show', `${baseRef}:${lockfileName(pm)}`], { cwd: rootDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return parseLockfilePackages(text, pm);
  } catch {
    return undefined; // missing ref/file/git → caller treats every head package as changed (gate-all)
  }
}

/**
 * `sandbox delta` — gate only the dependency changes a PR introduces. Diffs the head lockfile against
 * `--base` (default origin/main) or `--base-lockfile`, then runs the same blocking gates as the
 * install path over just the added/bumped versions. Low-noise PR check: judges what it introduces.
 */
async function runDeltaCommand(globals: Globals, config: SandboxConfig, facts: ProjectFacts, rootDir: string, args: string[]): Promise<number> {
  let baseRef = 'origin/main';
  let baseFile: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--base') baseRef = args[++i] ?? baseRef;
    else if (args[i] === '--base-lockfile') baseFile = args[++i];
  }

  const minReleaseAgeDays = globals.minReleaseAge ?? config.install.minReleaseAgeDays;
  const advisories = globals.failOnAdvisory ?? config.install.failOnAdvisory;
  const failOnDeprecated = globals.failOnDeprecated ?? config.install.failOnDeprecated;
  if (minReleaseAgeDays === 0 && !advisories) {
    log.info('delta: no blocking gates enabled — pass --min-release-age and/or --fail-on-advisory (or `sandbox init --preset strict`)');
  }

  const base = readBaseLockfile(rootDir, facts.pm, baseRef, baseFile);
  const baseMissing = base === undefined;
  const result = await runDelta(
    { minReleaseAgeDays, releaseAgeExclude: [...config.install.minReleaseAgeExclude, ...globals.allowRecent], advisories },
    { pm: facts.pm, cwd: facts.cwd, base: base ?? [], baseMissing },
  );

  const suggestions = result.ageViolations.length ? await suggestPins(result.ageViolations, minReleaseAgeDays) : [];
  const blocked = result.ageViolations.length > 0 || result.advisoryHits.some((h) => h.malware) || (failOnDeprecated && result.deprecated.length > 0);

  if (globals.json) {
    const days = (ms: number): number => Math.floor(ms / (24 * 60 * 60 * 1000));
    console.log(
      JSON.stringify(
        {
          base: baseFile ?? baseRef,
          baseMissing,
          changed: result.changed.length,
          blocked,
          ageViolations: result.ageViolations.map((v) => ({ name: v.name, version: v.version, publishedAt: v.publishedAt.toISOString(), ageDays: days(v.ageMs) })),
          advisoryHits: result.advisoryHits,
          deprecations: result.deprecated.map((h) => ({ name: h.package, version: h.version, message: h.message })),
          suggestions: suggestions.map((s) => ({ name: s.name, version: s.version, pin: `sandbox ${facts.pm} add ${s.name}@${s.version}`, ageDays: days(s.ageMs) })),
        },
        null,
        2,
      ),
    );
    return blocked ? 1 : 0;
  }

  if (baseMissing) log.warn(`delta: couldn't read the base lockfile (${baseFile ?? baseRef}) — gating ALL ${result.changed.length} resolved packages as a precaution`);
  if (result.changed.length === 0) {
    log.info(`delta: no dependency changes vs ${baseFile ?? baseRef} — nothing to gate`);
    return 0;
  }
  log.info(`delta: ${result.changed.length} added/changed package(s) vs ${baseFile ?? baseRef}`);
  if (result.ageViolations.length) logReleaseAgeBlock(result.ageViolations, minReleaseAgeDays, facts.pm, suggestions);
  if (result.advisoryHits.length) logAdvisoryHits(result.advisoryHits);
  logDeprecatedGate(result.deprecated, failOnDeprecated);
  if (blocked) log.error('delta: would BLOCK this PR — a changed dependency above hit a gate');
  else log.info('delta: no blocking findings in the changed dependencies');
  return blocked ? 1 : 0;
}

async function main(): Promise<number> {
  const { globals, cmd, args } = parse(process.argv.slice(2));

  if (cmd === undefined || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(HELP);
    return 0;
  }

  if (cmd === 'completion') {
    const shell = args.find((a) => !a.startsWith('-'));
    if (!shell) fail(`usage: sandbox completion <${COMPLETION_SHELLS.join('|')}>`);
    if (!isCompletionShell(shell)) fail(`unknown shell '${shell}' (use: ${COMPLETION_SHELLS.join(' | ')})`);
    process.stdout.write(completionScript(shell));
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

  if (cmd === 'verify') {
    const code = await runVerify(context.rootDir, context.configPath);
    if (!args.includes('--scan')) return code;
    // --scan: also run the retroactive malware sweep, so a green verify means
    // "boundary intact AND no installed dep is currently flagged as malware".
    const scanCode = await runScanCommand(globals, resolvePackageManager(context.rootDir), context.rootDir);
    return code || scanCode;
  }

  if (cmd === 'scan') {
    return runScanCommand(globals, resolvePackageManager(context.rootDir), context.rootDir);
  }

  if (cmd === 'badge') {
    let workflow: string | undefined;
    let slug: string | undefined;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--workflow') workflow = args[++i];
      else if (args[i] === '--repo') slug = args[++i];
    }
    console.log(renderBadge(context.rootDir, { workflow, slug }));
    return 0;
  }

  const backend = createBackend(globals.backend, { buildReporter: ttyBuildReporter() });

  if (cmd === 'build') {
    const loaded = loadConfig(context.rootDir, context.configPath);
    for (const warning of loaded.warnings) log.warn(warning);
    const tag = globals.image ?? loaded.config.image;
    return backend.buildImages(resolveBuildSpec(loaded.config, tag, context.rootDir));
  }

  if (cmd === 'doctor') {
    return runDoctor(context.rootDir, {
      config: context.configPath,
      image: globals.image,
      backend: globals.backend,
      invocationCwd,
      runWorkdir: context.runWorkdir,
      fix: args.includes('--fix'),
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

  if (cmd === 'path') {
    const action = args.find((a) => !a.startsWith('-')) ?? 'install';
    const shellIdx = args.indexOf('--shell');
    const shellArg = shellIdx >= 0 ? args[shellIdx + 1] : undefined;
    if (shellArg !== undefined && !SHELLS.includes(shellArg as Shell)) fail(`unknown --shell '${shellArg}' (use: ${SHELLS.join(' | ')})`);
    const shell: Shell = (shellArg as Shell | undefined) ?? detectShell();
    const print = args.includes('--print');
    let result: PathActionResult;
    switch (action) {
      case 'install':
        result = installPath({ shell, print });
        break;
      case 'print':
        result = installPath({ shell, print: true });
        break;
      case 'uninstall':
      case 'remove':
        result = uninstallPath({ shell });
        break;
      case 'status':
        result = statusPath({ shell });
        break;
      default:
        fail('usage: sandbox path <install|uninstall|status|print> [--shell zsh|bash|fish|pwsh] [--print]');
    }
    for (const m of result.messages) console.log(m);
    if (result.snippet) console.log(`\n${result.snippet}\n`);
    return 0;
  }

  const loaded = loadConfig(context.rootDir, context.configPath);
  for (const warning of loaded.warnings) log.warn(warning);
  const config = applyOneOffModes(loaded.config, globals);
  const facts = probeProject(context.rootDir, config, {
    envFiles: globals.envFiles.filter(Boolean),
    envFileBaseDir: context.cwd,
    configEnvFilesBaseDir: context.rootDir,
  });
  const opts: PlanOptions = { workdir: context.runWorkdir, envNames: globals.envNames.filter(Boolean) };
  if (globals.image) opts.image = globals.image;
  if (globals.frozen) opts.frozen = true;

  const emit = async (initialPlan: RunPlan): Promise<number> => {
    let plan = initialPlan;
    if (globals.dryRun) {
      console.log(renderPlanSummary(plan));
      return 0;
    }
    if (globals.json) {
      console.log(JSON.stringify(redactPlanEnv(plan), null, 2));
      return 0;
    }
    const canPrompt = canPromptInteractively(globals.interactive);
    if (globals.interactive && !canPrompt) log.info('--interactive requested, but no TTY is attached — continuing non-interactively');
    // The project's own registry hosts (from .npmrc) so the prompt can label them as expected.
    const registryHosts = projectRegistryHints(context.rootDir).hosts;
    for (;;) {
      const result = await execute(plan, backend, { failOnEgress: globals.failOnEgress });
      if (!result.deniedHosts.length || !canPrompt) return result.code;
      const deniedHosts = [...new Set(result.deniedHosts)].sort();
      const choice = await promptForBlockedEgress(deniedHosts, { registryHosts });
      if (choice === 'cancel') return 1;
      if (choice === 'allow-project') {
        const r = allowHosts(context.rootDir, deniedHosts, context.configPath);
        log.info(`saved ${(r.added.length ? r.added : deniedHosts).join(', ')} to ${path.basename(r.file)} (team) — retrying`);
      } else if (choice === 'allow-local') {
        const r = allowHostsLocal(context.rootDir, deniedHosts, context.configPath);
        log.info(`saved ${(r.added.length ? r.added : deniedHosts).join(', ')} to ${path.basename(r.file)} (personal, git-ignored) — retrying`);
      }
      const retry = nextPlanForBlockedEgressChoice(plan, deniedHosts, choice);
      if (!retry) return result.code;
      plan = retry;
    }
  };

  if (cmd === 'delta') {
    return runDeltaCommand(globals, config, facts, context.rootDir, args);
  }

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
