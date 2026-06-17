#!/usr/bin/env node
import path from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { confirm, isCancel, spinner } from '@clack/prompts';
import { createBackend } from './backend.js';
import { createBuildReporter, type BuildReporter } from './build-progress.js';
import type { SandboxConfig } from './config.js';
import { loadConfig, readConfig } from './config.js';
import { resolveProjectContext } from './context.js';
import { renderBadge } from './badge.js';
import { COMPLETION_SHELLS, completionScript, isCompletionShell } from './completion.js';
import { resolveBuildSpec } from './image.js';
import { runAuditVerify, runKeygen, runVerify, runVerifyReceipt, readSigningKey, signVerifyReceipt } from './verify.js';
import { BASE_IMAGE, resolveImageDigest, writeDevcontainer } from './devcontainer.js';
import { renderPlanSummary } from './dryrun.js';
import { isGlobalInstall, routePassthrough, type Route } from './dispatch.js';
import { runDoctor } from './doctor.js';
import { execute } from './execute.js';
import { classifyCommand } from './tamper.js';
import { findPendingBuilds, promptBuildApprovals, renderApproveBuildsCommand, writeBuildApprovals } from './build-approval.js';
import { runInit } from './init.js';
import { log } from './log.js';
import { lockfileName, pmAuditFixArgv, pmAuditSignaturesArgv, pmScriptArgv, pmUpdateArgv, resolvePackageManager, type PackageManager } from './package-manager.js';
import { planAdd, planAudit, planAuditFix, planAuditSignatures, planInstall, planRun, planUpdate, type PlanOptions, type RunPlan } from './plan.js';
import { probeProject, type ProjectFacts } from './project.js';
import { allowHosts, allowHostsLocal, projectRegistryHints } from './registry.js';
import { detectShell, installPath, SHELLS, statusPath, uninstallPath, type PathActionResult, type Shell } from './path-setup.js';
import { type AdvisoryHit, type AdvisorySeverityCounts, highestSeverity } from './advisory.js';
import { runPreflight, suggestPins, type PinSuggestion, type PreflightPolicy, type PreflightResult } from './preflight.js';
import { runScan } from './scan.js';
import { runDelta } from './delta.js';
import { feedCacheDir, loadKnownBad, PROJECT_ADVISORY_NAME, updateFeeds, type KnownBadHit } from './known-bad.js';
import { scanSecrets, type SecretFinding } from './secrets.js';
import { applyUpgrades, classifyUpgrades, defaultNcuRunner, mergeProposals, NCU_SPEC, ncuPasses, parseUpgrades, readDeclaredRanges, renderUpgradeTable, upgradeTargets, type NcuRunner, type ProposedUpgrade, type UpgradePolicy, type UpgradeTarget } from './upgrade.js';
import { execPackageTargets, parseLockfilePackages, parsePackageTargets, riskTargetsForInstall, riskTargetsForUpdate, type LockfilePackage, type ReleaseAgeViolation, type RiskHint, type RiskTarget } from './risk.js';
import { canPromptInteractively, nextPlanForBlockedEgressChoice, promptForBlockedEgress } from './interactive.js';
import { runSetup } from './setup.js';
import { makeCanary } from './canary.js';
import { networkPolicy } from './network.js';
import { demoPlan, runDemo, type DemoRunner } from './demo.js';
import { buildHostSuffixes } from './hosts.js';
import { disabledByEnv, refreshUpdateCache, scheduleUpdateCheck, selfVersion, updateBanner } from './update-check.js';
import type { ContainerBackend } from './backend.js';

interface Globals {
  config?: string;
  image?: string;
  backend: 'docker' | 'podman';
  json: boolean;
  format?: 'human' | 'json' | 'agent';
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
  /** Plant canary honeytokens and watch egress for them (overrides install.canaries). */
  canaries?: boolean;
  /** Suppress the "new version available" notice for this run (--no-update-check). */
  noUpdateCheck: boolean;
  /** Widen egress to the curated native-build/release hosts for this run (--allow-build-hosts). */
  allowBuildHosts: boolean;
  /** Approve every ignored dependency build script without prompting (--allow-all-builds). */
  allowAllBuilds: boolean;
}

const JSON_SAFE_ENV = new Set(['SANDBOX', 'CI', 'HOME', 'SSH_AUTH_SOCK', 'HOST']);

const HELP = `sandbox — put it in front of the npm/pnpm/yarn/bun command you already run

Usage: sandbox [globals] <command> [args]

Just add "sandbox" in front — same commands, fewer secrets exposed:
  sandbox dev                 auto-detect PM, run dev/start/serve with full network + dev ports
  sandbox test                auto-detect PM, run a package.json script natively
  sandbox script build        run a specific package.json script, even if it collides with a sandbox command
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
  dev                  auto-detect the package manager and run the first of
                       dev > start > serve from package.json. Passes through extra args.
  script <name>        run the named package.json script with native PM syntax.
                       Use this when the script name collides with a sandbox command
                       like build/scan/doctor/demo.
  allow <host...>      add host(s) to egress.allow in sandbox.config.json
  path [install|uninstall|status|print]   install shell wrappers (zsh/bash/fish/pwsh) so a bare
                       npm/pnpm/yarn/bun install + npx/bunx route through sandbox automatically —
                       the human equivalent of the agent hook. Also wires tab-completion. Bypass
                       once with 'command npm ...' or a whole shell with SANDBOX_OFF=1.
  completion <shell>   print a standalone tab-completion script for zsh|bash|fish (commands,
                       globals, --preset/--backend/--risk). \`sandbox path install\` already wires
                       this in; use this to install it on its own, e.g. for zsh:
                       \`sandbox completion zsh > "\${fpath[1]}/_sandbox"\`.
  approve-builds [pkg]  approve dependency build scripts pnpm left ignored (writes allowBuilds +
                       onlyBuiltDependencies, then re-installs). No args = approve all pending;
                       --deny records the opposite. Install also prompts on a TTY automatically.
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
  secrets [path]       offline scan for committed credentials (API keys, tokens, private keys, db
                       URLs). Read-only, no container; exits non-zero on any finding (CI tripwire).
                       Matched values are redacted — reports where, never the secret. Defaults to cwd.
                       ~40 provider patterns, checksum/decode validation (Luhn, JWT) to cut noise,
                       plus an entropy fallback for secret-ish values with no known shape.
  demo                 run real supply-chain attacks (credential theft, persistence, IMDS pivot,
                       egress exfil) against the sandbox in a THROWAWAY project and show each one
                       contained. No mocks; exits non-zero if any attack isn't contained.
  feeds <update|list>  manage malware FEEDS (install.malwareFeeds): \`update\` fetches + caches them so
                       the install-time blocklist check stays offline; \`list\` shows configured/cached
                       feeds. A package on a feed (or in sandbox.advisories.json) ALWAYS blocks installs.
  upgrade [--write]    move declared dependency RANGES to newer versions (npm-check-updates) —
                       NOT just within the range (that's \`sandbox npm update\`). Your release-age
                       gate drives ncu's --cooldown automatically, the proposed versions go through
                       the SAME gates as install, and --write rewrites package.json then installs in
                       the sandbox. --minor/--patch/--target to cap the jump; --reject <pat> to skip.
  doctor [--fix]       check config, package manager, backend, daemon, and image state.
                       --fix runs the safe remedies (currently: rebuild an absent/stale image).
  build                build (or rebuild) the sandbox + egress-proxy images
  verify [--scan]      exit non-zero unless this repo commits a real sandbox boundary and
       [--secrets]     no personal layer has loosened it — the CI gate behind the badge.
       [--sign]        --scan also runs the retroactive malware sweep (so the badge means
                       "boundary intact AND no installed dep is currently flagged as malware");
                       --secrets also fails if a credential is committed in the repo;
                       --sign emits an Ed25519-signed receipt of the green boundary to stdout
                       (needs SANDBOX_SIGNING_KEY → a key file from \`sandbox keygen\`)
  verify-receipt <f>   verify a signed receipt from \`verify --sign\`; --fingerprint <hex> (or
                       SANDBOX_TRUSTED_KEY) pins the signer so any other key is rejected
  keygen               generate an Ed25519 signing keypair: private key → CI secret
                       (SANDBOX_SIGNING_KEY), fingerprint → pin via SANDBOX_TRUSTED_KEY
  audit verify <log>   verify the hash-chained audit log is intact (no entry altered or removed).
                       Set SANDBOX_AUDIT_LOG=<path> on any run to append tamper-evident events
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
  version              print the installed sandbox version (also -v / --version)

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
  --canaries           plant fake AWS/Stripe/Slack credentials in the install container and watch
       --no-canaries   the egress proxy for them — if a planted token leaves the box it's caught as
                       an exfiltration attempt (fails the run). Allowlist egress only; on by default
                       in the strict/agent presets. --no-canaries turns it off for one run.
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
  --allow-all-builds   approve every ignored dependency build script without prompting (CI/agents)
  --allow-build-hosts  widen egress (this run) to the curated native-build/release hosts —
                       Node headers, GitHub releases, Prisma/Playwright/Cypress/Electron binaries
  --dry-run            preview what would be mounted, allowed, and run — then stop (human-readable)
  --json               print the resolved execution plan as JSON instead of running it
  --no-update-check    skip the once-a-day "new version available" check for this run
                       (also off via NO_UPDATE_NOTIFIER=1, CI=1, or updateCheck:false in config)

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
    noUpdateCheck: false,
    allowBuildHosts: false,
    allowAllBuilds: false,
  };
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config') globals.config = argv[++i];
    else if (a === '--image') globals.image = argv[++i];
    else if (a === '--backend') globals.backend = argv[++i] === 'podman' ? 'podman' : 'docker';
    else if (a === '--json') globals.json = true;
    else if (a === '--format') {
      const f = argv[++i];
      if (f === 'json') globals.json = true; // --format json is an alias for --json
      else if (f === 'agent' || f === 'ai') globals.format = 'agent';
      else if (f === 'human' || f === 'text') globals.format = 'human';
      else fail(`--format needs json, agent, or human (got '${f ?? ''}')`);
    }
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
    else if (a === '--canaries') globals.canaries = true;
    else if (a === '--no-canaries') globals.canaries = false;
    else if (a === '--no-update-check') globals.noUpdateCheck = true;
    else if (a === '--allow-build-hosts') globals.allowBuildHosts = true;
    else if (a === '--allow-all-builds') globals.allowAllBuilds = true;
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
 * One-off invocation modes, applied to the config for this run only:
 * `--allow-build-hosts` widens the egress allowlist to the curated native-build/release hosts;
 * `--dev` opens only run/shell networking + common dev ports;
 * `--full-network` also drops install/add egress back to the default bridge.
 */
function applyOneOffModes(config: SandboxConfig, globals: Globals): SandboxConfig {
  let cfg = config;
  if (globals.allowBuildHosts) {
    const extra = buildHostSuffixes().filter((h) => !cfg.egress.allow.includes(h));
    if (extra.length) cfg = { ...cfg, egress: { ...cfg.egress, allow: [...cfg.egress.allow, ...extra] } };
  }
  if (!globals.dev && !globals.fullNetwork) return cfg;
  const run = { ...cfg.run, network: 'on' as const, devPorts: globals.dev ? true : cfg.run.devPorts };
  if (!globals.fullNetwork) return { ...cfg, run };
  return { ...cfg, install: { ...cfg.install, network: 'on' }, run };
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
function resolveRoute(cmd: string, args: string[], facts: ProjectFacts): Route | undefined {
  switch (cmd) {
    case 'install':
      return { model: 'install', pm: facts.pm, frozen: false, args };
    case 'add':
      if (args.length === 0) fail('usage: sandbox add <pkg>...  (deliberate package.json change)');
      return { model: 'add', pm: facts.pm, pkgs: args };
    case 'script': {
      const [script, ...rest] = args;
      if (!script) fail('usage: sandbox script <name> [args]');
      return { model: 'run', argv: pmScriptArgv(facts.pm, script, rest) };
    }
    case 'run': {
      const argv = args[0] === '--' ? args.slice(1) : args;
      if (argv.length === 0) fail('usage: sandbox run -- <cmd...>');
      return { model: 'run', argv };
    }
    case 'shell':
      return { model: 'run', argv: ['bash', '-l'] };
    default: {
      // Transparent pass-through: `sandbox npm install`, `sandbox pnpm add zod`, `sandbox npm run dev`.
      return routePassthrough([cmd, ...args]);
    }
  }
}

/**
 * Resolve a command against the sandbox subcommands, passthrough PM/runners, and package.json
 * scripts. Scripts are the generic fallback: `sandbox test`, `sandbox lint`, `sandbox typecheck`,
 * etc. `dev` is just one script-shaped command that prefers `dev -> start -> serve`; its only other
 * semantic — dev-mode networking — lives in `main()`, where `sandbox dev` folds into `globals.dev`
 * so there is one effective config (see {@link applyOneOffModes}).
 */
function resolveCommand(cmd: string, args: string[], facts: ProjectFacts): Route {
  const route = resolveRoute(cmd, args, facts);
  if (route) return route;
  if (cmd === 'dev') {
    const scriptName = ['dev', 'start', 'serve'].find((s) => s in facts.scripts);
    if (!scriptName) fail('no "dev", "start", or "serve" script found in package.json');
    return { model: 'run', argv: pmScriptArgv(facts.pm, scriptName, args) };
  }
  if (facts.scripts[cmd]) return { model: 'run', argv: pmScriptArgv(facts.pm, cmd, args) };
  fail(`unknown command '${cmd}'\n  try a command you know:  sandbox npm install · sandbox pnpm add zod · sandbox npm run dev · sandbox dev\n  or a sandbox command:     init · setup · allow · doctor · build · install · add · script · run · shell`);
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

/**
 * Whether the gated targets are EXISTING dependencies (a bare install/update reproducing the
 * manifest/lockfile) rather than packages being added. When true, an age block is usually noise —
 * the versions are already committed — so we steer to `sandbox delta`, which gates only what a change
 * introduces.
 */
function gatingExistingDeps(route: Route): boolean {
  if (route.model === 'install') return parsePackageTargets(route.args).length === 0;
  return route.model === 'update' || route.model === 'auditFix';
}

function logReleaseAgeBlock(violations: ReleaseAgeViolation[], minDays: number, pm: PackageManager, suggestions: PinSuggestion[], reproduce = false): void {
  const pin = new Map(suggestions.map((s) => [s.name, s]));
  const lines = [
    `blocked by the release-age gate (min ${minDays} day${minDays === 1 ? '' : 's'})`,
    ...violations.map((v) => {
      const s = pin.get(v.name);
      const tail = s ? `\n    ↳ pin a known-good version: sandbox ${pm} add ${v.name}@${s.version} (published ${formatAge(s.ageMs)})` : '';
      return `  ${v.name}@${v.version} was published ${formatAge(v.ageMs)}${tail}`;
    }),
    'freshly-published versions are the supply-chain worm window. Options:',
    // For a bare reproduce-the-lockfile install, the right tool is the delta gate — lead with it.
    ...(reproduce ? ['  • these are existing dependencies, not new ones — review only what a change introduces: `sandbox delta` (diffs the lockfile against origin/main, skipping versions already committed)'] : []),
    suggestions.length ? '  • pin the suggested older version above' : '  • pin a known-good older version',
    '  • wait until it ages past the threshold, then retry',
    '  • override this once: add --min-release-age 0 before the command',
  ];
  log.error(lines.join('\n'));
}

function logAdvisoryHits(hits: AdvisoryHit[]): void {
  if (!hits.length) return;
  const grouped = new Map<string, AdvisoryHit[]>();
  for (const hit of hits) {
    const list = grouped.get(hit.name) ?? [];
    list.push(hit);
    grouped.set(hit.name, list);
  }
  // Sort by worst-first: malware > critical > high > moderate > low, then alphabetically
  const severityOf = (name: string): number => {
    const g = grouped.get(name)!;
    if (g.some((h) => h.malware)) return 0;
    const sev = highestSeverity(g.flatMap((h) => h.advisories ?? []));
    return sev === 'critical' ? 1 : sev === 'high' ? 2 : sev === 'moderate' ? 3 : 4;
  };
  const entries = [...grouped.entries()].sort(([a], [b]) => severityOf(a) - severityOf(b) || a.localeCompare(b));
  const hasMalware = (name: string) => grouped.get(name)!.some((h) => h.malware);
  const fmtIds = (h: AdvisoryHit): string => {
    const ids = h.ids.length <= 4 ? h.ids.join(', ') : `${h.ids.slice(0, 4).join(', ')}, … (+${h.ids.length - 4})`;
    const sev = highestSeverity(h.advisories ?? []);
    const tag = h.direct ? ' [direct]' : h.direct === false ? ' [transitive]' : '';
    const sevLabel = sev ? ` ${sev}` : '';
    return `${ids}${sevLabel}${tag}`;
  };
  for (const [name, group] of entries) {
    const level = hasMalware(name) ? 'error' : 'warn';
    const label = hasMalware(name) ? 'KNOWN MALWARE' : 'advisory';
    if (group.length === 1) {
      const h = group[0]!;
      log[level](`${h.name}@${h.version} — ${label} ${fmtIds(h)}`);
    } else {
      const header = `${name} (${group.length} version${group.length === 1 ? '' : 's'})`;
      const items = group.sort((a, b) => a.version.localeCompare(b.version)).map((h) => `  ${h.version} — ${fmtIds(h)}`);
      log[level]([header, ...items].join('\n'));
    }
  }
}

function logScanSummary(counts: AdvisorySeverityCounts, totalPackages: number, scanned: number, triaged: number): void {
  const parts: string[] = [];
  if (counts.critical) parts.push(`${counts.critical} critical`);
  if (counts.high) parts.push(`${counts.high} high`);
  if (counts.moderate) parts.push(`${counts.moderate} moderate`);
  if (counts.low) parts.push(`${counts.low} low`);
  if (!parts.length) return;
  const triageNote = triaged ? ` (${triaged} triaged)` : '';
  log.warn(`scan: ${parts.join(', ')} across ${totalPackages} package(s)${triageNote} (${scanned} scanned)`);
}

/** Generate an actionable fix line for a package. */
function formatFixLine(name: string, hit: AdvisoryHit, pm: PackageManager): string | undefined {
  if (hit.malware) {
    return `  → ${pm} remove ${name}@${hit.version} — flagged as malware`;
  }
  // Gather fix versions across all advisories (earliest >= current stable version wins)
  let bestFix: string | undefined;
  let bestParts: number[] | undefined;
  const parseVer = (v: string): number[] | undefined => {
    const m = v.match(/^(\d+)\.(\d+)\.(\d+)$/);
    return m ? [parseInt(m[1]!, 10), parseInt(m[2]!, 10), parseInt(m[3]!, 10)] : undefined;
  };
  const currentParts = parseVer(hit.version);
  for (const d of hit.advisories ?? []) {
    for (const fv of d.fixedVersions ?? []) {
      const parts = parseVer(fv);
      if (!parts) continue; // skip pre-releases and non-semver versions
      if (currentParts && (parts[0]! < currentParts[0]! || (parts[0] === currentParts[0] && parts[1]! < currentParts[1]!) || (parts[0] === currentParts[0] && parts[1] === currentParts[1] && parts[2]! <= currentParts[2]!))) continue;
      if (!bestParts || parts[0]! < bestParts[0]! || (parts[0] === bestParts[0] && parts[1]! < bestParts[1]!) || (parts[0] === bestParts[0] && parts[1] === bestParts[1] && parts[2]! < bestParts[2]!)) {
        bestFix = fv;
        bestParts = parts;
      }
    }
  }
  if (!bestFix) return undefined;
  if (hit.direct) {
    return `  → sandbox ${pm} update ${name}  (fix: ${bestFix})`;
  }
  // Transitive: suggest overrides
  switch (pm) {
    case 'pnpm':
      return `  → add to pnpm.overrides:  "${name}": "${bestFix}"`;
    case 'npm':
      return `  → add to overrides in package.json:  "${name}": "${bestFix}"`;
    case 'yarn':
      return `  → add to resolutions in package.json:  "${name}": "${bestFix}"`;
    case 'bun':
      return `  → pin transitive: install ${name}@${bestFix} as a direct dependency`;
  }
}

function logFixCommands(hits: AdvisoryHit[], pm: PackageManager): void {
  const deduped = new Map<string, AdvisoryHit>();
  for (const hit of hits) {
    const existing = deduped.get(hit.name);
    if (!existing || (hit.ids.length > existing.ids.length)) deduped.set(hit.name, hit);
  }
  const lines: string[] = [];
  for (const [name, hit] of deduped) {
    const line = formatFixLine(name, hit, pm);
    if (line) lines.push(line);
  }
  if (lines.length) {
    log.info(`fix:\n${lines.join('\n')}`);
  }
}

function formatAgentScan(result: { scanned: number; lockfileMissing: boolean; blocked: boolean; malware: { name: string; version: string; ids: string[] }[]; knownBadHits: { name: string; version: string; reason: string }[]; hits: AdvisoryHit[]; triaged: AdvisoryHit[]; severityCounts: AdvisorySeverityCounts }, pm: PackageManager): string {
  const lines: string[] = [];
  lines.push(`scanned:${result.scanned} blocked:${result.blocked}`);
  const sc = result.severityCounts;
  lines.push(`severity:critical=${sc.critical} high=${sc.high} moderate=${sc.moderate} low=${sc.low}`);
  if (result.triaged.length) lines.push(`triaged:${result.triaged.length}`);

  const grouped = new Map<string, AdvisoryHit[]>();
  for (const hit of result.hits) {
    const list = grouped.get(hit.name) ?? [];
    list.push(hit);
    grouped.set(hit.name, list);
  }
  for (const [name, group] of [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    for (const hit of group.sort((a, b) => a.version.localeCompare(b.version))) {
      const sev = highestSeverity(hit.advisories ?? []) ?? 'low';
      const deps = hit.direct ? 'direct' : hit.direct === false ? 'transitive' : '';
      const ids = hit.ids.join(',');
      const fixVersions = [...new Set(hit.advisories?.flatMap((d) => d.fixedVersions ?? []))].join(',');
      lines.push(`pkg:${hit.name}@${hit.version} ${deps} severity:${sev} malware:${hit.malware} advisories:${ids}${fixVersions ? ` fixed:${fixVersions}` : ''}`);
    }
    // Fix command
    const anyHit = group[0];
    if (anyHit) {
      const fixStr: string[] = [];
      if (anyHit.malware) {
        fixStr.push(`remove ${name}`);
      } else {
        const allFixed = [...new Set(group.flatMap((h) => h.advisories?.flatMap((d) => d.fixedVersions ?? [])))].join(',');
        if (allFixed) {
          if (anyHit.direct) {
            fixStr.push(`update ${name} (sandbox ${pm} update ${name})`);
          } else {
            fixStr.push(`override ${name}=${allFixed} (${pm === 'pnpm' ? 'pnpm.overrides' : pm === 'yarn' ? 'resolutions' : 'overrides'})`);
          }
        }
      }
      if (fixStr.length) lines.push(`fix:${name} ${fixStr.join(' ')}`);
    }
  }
  return lines.join('\n');
}

async function runScanCommand(globals: Globals, pm: PackageManager, cwd: string): Promise<number> {
  const isAgent = globals.format === 'agent';
  const tty = process.stderr.isTTY && !globals.json && !isAgent;
  const s = tty ? spinner({ output: process.stderr }) : undefined;
  if (s) s.start('scan: checking installed packages for advisories …');
  const result = await runScan({
    pm,
    cwd,
    knownBad: loadKnownBad(cwd),
    onProgress: s ? (done, total) => s.message(`scan: checking ${done}/${total} packages …`) : undefined,
  });
  if (s) s.stop('');

  const blocked = result.malware.length > 0 || result.knownBadHits.length > 0;

  if (isAgent) {
    console.log(formatAgentScan({ scanned: result.scanned, lockfileMissing: result.lockfileMissing, blocked, malware: result.malware, knownBadHits: result.knownBadHits, hits: result.hits, triaged: result.triaged, severityCounts: result.severityCounts }, pm));
    return blocked ? 1 : 0;
  }

  if (globals.json) {
    console.log(
      JSON.stringify(
        {
          scanned: result.scanned,
          lockfileMissing: result.lockfileMissing,
          blocked,
          severityCounts: result.severityCounts,
          malware: result.malware,
          knownBadHits: result.knownBadHits,
          advisories: result.hits.filter((h) => !h.malware),
          triaged: result.triaged,
        },
        null,
        2,
      ),
    );
    return blocked ? 1 : 0;
  }
  if (result.lockfileMissing) {
    log.warn(`scan: no parseable lockfile for ${pm} — nothing to scan (commit a lockfile; bun has no parser yet)`);
    return 0;
  }

  // Summary header
  const uniqueAffected = new Set(result.hits.map((h) => h.name)).size;
  logScanSummary(result.severityCounts, uniqueAffected, result.scanned, result.triaged.length);

  // Triaged advisories
  if (result.triaged.length) {
    const triagedNames = [...new Set(result.triaged.map((h) => h.name))].sort();
    log.info(`scan: ${result.triaged.length} advisory hit(s) triaged via .sandbox-audit-ignore (${triagedNames.join(', ')})`);
  }

  // Advisory details
  logAdvisoryHits(result.hits);
  if (result.knownBadHits.length) logKnownBadHits(result.knownBadHits);

  // Fix commands
  if (result.hits.length) logFixCommands(result.hits, pm);

  if (blocked) {
    if (result.malware.length) log.error(`scan: ${result.malware.length} installed package(s) are NOW flagged as malware in OSV — remove or upgrade them (scanned ${result.scanned})`);
    if (result.knownBadHits.length) log.error(`scan: ${result.knownBadHits.length} installed package(s) match your blocklist/feeds (scanned ${result.scanned})`);
    return 1;
  }
  log.info(`scan: clean — no installed package is currently flagged as malware or blocklisted (scanned ${result.scanned})`);
  return 0;
}

/** Report blocklist / malware-feed matches. These are an explicit team decision, so they always block. */
function logKnownBadHits(hits: KnownBadHit[]): void {
  if (!hits.length) return;
  const lines = [
    `blocked by your blocklist — ${hits.length} package(s) are listed as known-bad:`,
    ...hits.map((h) => `  ${h.name}@${h.version} [${h.severity}] — ${h.reason} (source: ${h.source})`),
    'options:',
    '  • remove or pin a different version of the package(s) above',
    `  • if this is a false positive, edit the matching entry in ${PROJECT_ADVISORY_NAME} (or your malware feed)`,
  ];
  log.error(lines.join('\n'));
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

function deprecatedHints(result: PreflightResult): RiskHint[] {
  return result.hints.filter((h) => h.code === 'deprecated');
}

function nothingToCheck(ap: ActivePolicy): boolean {
  return !ap.riskHints && !ap.failOnAdvisory && ap.minReleaseAgeDays === 0;
}

function blockExit(result: PreflightResult, ap: ActivePolicy): number | undefined {
  if (result.knownBadHits.length) return 1;
  if (result.ageViolations.length) return 1;
  if (result.advisoryHits.some((h) => h.malware)) return 1;
  if (ap.failOnDeprecated && deprecatedHints(result).length) return 1;
  if (ap.riskHints && result.hints.length && ap.failOnRisk) return 1;
  return undefined;
}

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
  const knownBad = loadKnownBad(facts.cwd);
  if (nothingToCheck(ap) && !knownBad.length) return undefined;

  const targets = riskTargetsForRoute(route, facts);
  const result = await runPreflight(targets, ap.policy, { pm: facts.pm, cwd: facts.cwd, knownBad });
  logDeep(ap, result, facts.pm);

  // Blocklist / malware-feed match — an explicit team decision, so it blocks ahead of everything.
  if (result.knownBadHits.length) {
    logKnownBadHits(result.knownBadHits);
    return 1;
  }
  // Release-age gate — the strongest control, so it blocks first.
  if (result.ageViolations.length) {
    const suggestions = await suggestPins(result.ageViolations, ap.minReleaseAgeDays);
    logReleaseAgeBlock(result.ageViolations, ap.minReleaseAgeDays, facts.pm, suggestions, gatingExistingDeps(route));
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
      knownBadHits: result.knownBadHits,
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
  const knownBad = loadKnownBad(facts.cwd);

  if (nothingToCheck(ap) && !knownBad.length) {
    if (globals.json) console.log(JSON.stringify({ blocked: false, gatesEnabled: false, checked: 0, hints: [], ageViolations: [], advisoryHits: [], knownBadHits: [], suggestions: [] }, null, 2));
    else log.info('no supply-chain gates enabled — pass --min-release-age, --fail-on-advisory, and/or --fail-on-risk (or `sandbox init --preset strict`)');
    return 0;
  }

  const result = await runPreflight(targets, ap.policy, { pm: facts.pm, cwd: facts.cwd, knownBad });
  const suggestions = result.ageViolations.length ? await suggestPins(result.ageViolations, ap.minReleaseAgeDays) : [];
  const exit = blockExit(result, ap) ?? 0;

  if (globals.json) {
    console.log(renderPreflightJson(result, suggestions, exit !== 0, facts.pm));
    return exit;
  }

  // Human report: log every finding (no short-circuit — this is a report, not a gate).
  logDeep(ap, result, facts.pm);
  if (result.knownBadHits.length) logKnownBadHits(result.knownBadHits);
  if (result.ageViolations.length) logReleaseAgeBlock(result.ageViolations, ap.minReleaseAgeDays, facts.pm, suggestions, gatingExistingDeps(route));
  if (result.advisoryHits.length) logAdvisoryHits(result.advisoryHits);
  logDeprecatedGate(deprecatedHints(result), ap.failOnDeprecated);
  if (ap.riskHints) logRiskHints(targets, result.hints);

  if (exit) log.error('preflight: would BLOCK this install — resolve the findings above, or re-run with an override flag');
  else log.info('preflight: no blocking findings — safe to install');
  return exit;
}

/**
 * `sandbox secrets [path]` — offline scan for committed credentials. The sandbox keeps host secrets
 * OUT of the install container, but can't stop a key being committed into the repo; this is the
 * visibility half of the credential mission. Read-only, no container. Exits non-zero on any finding
 * (a CI tripwire). Matched values are redacted — it reports where, never the secret itself.
 */
function runSecretsCommand(globals: Globals, root: string): number {
  let findings: SecretFinding[];
  try {
    findings = scanSecrets(root);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
  if (globals.json) {
    console.log(JSON.stringify({ root, found: findings.length, findings }, null, 2));
    return findings.length ? 1 : 0;
  }
  if (!findings.length) {
    log.info('secrets: clean — no credential patterns found in the scanned files');
    return 0;
  }
  for (const f of findings) log.error(`${f.file}:${f.line} — ${f.label} (${f.ruleId}): ${f.redacted}`);
  log.error(`secrets: ${findings.length} potential credential(s) found — rotate any real key, move it to an env var, and add the file to .gitignore`);
  return 1;
}

/**
 * `sandbox feeds update` — fetch the malware FEEDS in install.malwareFeeds and cache them locally so
 * the install-time blocklist check stays offline. Augments OSV (which has publish lag) with feeds the
 * team trusts. `sandbox feeds list` shows the configured feeds and what's cached.
 */
async function runFeedsCommand(globals: Globals, config: SandboxConfig, args: string[]): Promise<number> {
  const sub = args[0] ?? 'update';
  const feeds = config.install.malwareFeeds;
  if (sub === 'list') {
    if (globals.json) console.log(JSON.stringify({ feeds, cacheDir: feedCacheDir() }, null, 2));
    else {
      log.info(feeds.length ? `configured malware feeds (install.malwareFeeds):\n${feeds.map((f) => `  • ${f}`).join('\n')}` : 'no malware feeds configured — add URLs to install.malwareFeeds in sandbox.config.json');
      log.info(`feed cache: ${feedCacheDir()}`);
    }
    return 0;
  }
  if (sub !== 'update') fail('usage: sandbox feeds <update|list>');
  if (!feeds.length) {
    log.info('feeds: nothing to update — add malware feed URLs to install.malwareFeeds in sandbox.config.json first');
    return 0;
  }
  log.info(`feeds: fetching ${feeds.length} feed(s) …`);
  const results = await updateFeeds(feeds);
  if (globals.json) {
    console.log(JSON.stringify({ results, cacheDir: feedCacheDir() }, null, 2));
  } else {
    for (const r of results) {
      if (r.error) log.error(`  ✗ ${r.feed} — ${r.error}`);
      else log.info(`  ✓ ${r.feed} — ${r.count} package(s) cached`);
    }
  }
  return results.some((r) => r.error) ? 1 : 0;
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
    { pm: facts.pm, cwd: facts.cwd, base: base ?? [], baseMissing, knownBad: loadKnownBad(facts.cwd) },
  );

  const suggestions = result.ageViolations.length ? await suggestPins(result.ageViolations, minReleaseAgeDays) : [];
  const blocked = result.knownBadHits.length > 0 || result.ageViolations.length > 0 || result.advisoryHits.some((h) => h.malware) || (failOnDeprecated && result.deprecated.length > 0);

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
          knownBadHits: result.knownBadHits,
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
  if (result.knownBadHits.length) logKnownBadHits(result.knownBadHits);
  if (result.ageViolations.length) logReleaseAgeBlock(result.ageViolations, minReleaseAgeDays, facts.pm, suggestions);
  if (result.advisoryHits.length) logAdvisoryHits(result.advisoryHits);
  logDeprecatedGate(result.deprecated, failOnDeprecated);
  if (blocked) log.error('delta: would BLOCK this PR — a changed dependency above hit a gate');
  else log.info('delta: no blocking findings in the changed dependencies');
  return blocked ? 1 : 0;
}

const UPGRADE_TARGETS = ['latest', 'minor', 'patch', 'newest', 'greatest', 'semver'] as const;

interface UpgradeArgs {
  write: boolean;
  yes: boolean;
  target: UpgradeTarget;
  reject: string[];
}

function parseUpgradeArgs(args: string[]): UpgradeArgs {
  const out: UpgradeArgs = { write: false, yes: false, target: 'latest', reject: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--write' || a === '-w') out.write = true;
    else if (a === '--yes' || a === '-y') out.yes = true;
    else if (a === '--minor') out.target = 'minor';
    else if (a === '--patch') out.target = 'patch';
    else if (a === '--target') {
      const t = args[++i];
      if (!t || !(UPGRADE_TARGETS as readonly string[]).includes(t)) fail(`--target needs one of: ${UPGRADE_TARGETS.join('|')} (got '${t ?? ''}')`);
      out.target = t as UpgradeTarget;
    } else if (a === '--reject') out.reject.push(args[++i] ?? '');
    else fail(`unknown upgrade flag '${a}' — try: --write · --minor · --patch · --target <${UPGRADE_TARGETS.join('|')}> · --reject <pat> · --yes`);
  }
  out.reject = out.reject.filter(Boolean);
  return out;
}

/**
 * `sandbox upgrade` — move declared dependency RANGES to newer versions (what npm-check-updates does),
 * which `sandbox npm update` won't: update stays within the existing range. The release-age threshold
 * from sandbox.config.json drives ncu's `--cooldown`, so the user never re-types it and the two can't
 * drift. ncu (host-only: it just reads/writes package.json + queries the registry) proposes; the SAME
 * gate engine the install path uses vets the proposed versions; only on `--write` does it rewrite
 * package.json and then materialise the change through the JAILED install. Blocked upgrades never write.
 */
async function runUpgradeCommand(
  globals: Globals,
  config: SandboxConfig,
  facts: ProjectFacts,
  args: string[],
  materialize: () => Promise<number>,
  ncu: NcuRunner = defaultNcuRunner(),
): Promise<number> {
  const ua = parseUpgradeArgs(args);
  // One source of truth: the install gate's resolved policy. cooldown == the release-age threshold;
  // the cooldown-exempt set == the same packages the age gate exempts (config + --allow-recent).
  const ap = resolvePolicy(globals, config, { model: 'install', pm: facts.pm, frozen: false, args: [] });
  const cooldownDays = ap.minReleaseAgeDays;
  const exempt = ap.policy.releaseAgeExclude;
  const policy: UpgradePolicy = { cooldownDays, target: ua.target, reject: ua.reject, filter: [] };

  if (!globals.json) {
    const src = globals.minReleaseAge !== undefined ? '--min-release-age' : 'sandbox.config.json';
    const ex = exempt.length ? `, ${exempt.length} exempt` : '';
    const cd = cooldownDays > 0 ? ` · cooldown ${cooldownDays}d (from ${src}${ex})` : ' · no cooldown (release-age gate off)';
    log.info(`upgrade: checking ${facts.pm} for newer ${ua.target} versions${cd} …`);
  }

  // Discovery: one pass normally, two when a cooldown exemption must be honored (ncu's cooldown is
  // global). Proceed if ANY pass produced output; only error when every pass failed to run.
  const current = readDeclaredRanges(facts.cwd);
  const passes = ncuPasses(policy, exempt, facts.pm);
  const lists: ProposedUpgrade[][] = [];
  let ran = false;
  for (const argv of passes) {
    const r = ncu(argv, facts.cwd);
    if (r.code === 0 || r.stdout.trim()) {
      ran = true;
      lists.push(parseUpgrades(r.stdout, current));
    }
  }
  if (!ran) {
    log.error(`upgrade: ${NCU_SPEC} couldn't run — check the network and the npm-check-updates output above`);
    return 1;
  }
  const upgrades = mergeProposals(lists);

  if (upgrades.length === 0) {
    if (globals.json) console.log(JSON.stringify({ cooldownDays, target: ua.target, blocked: false, upgrades: [] }, null, 2));
    else log.info(`upgrade: every dependency is already at its newest eligible ${ua.target} version${cooldownDays ? ` within the ${cooldownDays}-day cooldown` : ''} — nothing to do`);
    return 0;
  }

  // Vet the proposed target versions through the install-path gates so `upgrade` carries identical
  // guarantees. Cooldown already filtered fresh publishes inside ncu; re-running the age gate here is
  // belt-and-suspenders and catches any reject/exclude drift. Direct targets only (no --deep tree).
  const gatePolicy: PreflightPolicy = { ...ap.policy, deep: false };
  const result = await runPreflight(upgradeTargets(upgrades), gatePolicy, { pm: facts.pm, cwd: facts.cwd, knownBad: loadKnownBad(facts.cwd) });
  const deps = deprecatedHints(result);
  const rows = classifyUpgrades(upgrades, {
    ageNames: new Set(result.ageViolations.map((v) => v.name)),
    malwareNames: new Set(result.advisoryHits.filter((h) => h.malware).map((h) => h.name)),
    deprecatedNames: new Set(deps.map((h) => h.package)),
  });
  const blocked = blockExit(result, ap) !== undefined;
  const suggestions = result.ageViolations.length ? await suggestPins(result.ageViolations, cooldownDays) : [];

  if (globals.json) {
    console.log(JSON.stringify({ cooldownDays, target: ua.target, blocked, upgrades: rows.map((r) => ({ name: r.name, from: r.from, to: r.to, gate: r.gate })) }, null, 2));
    return blocked ? 1 : 0;
  }

  log.info(`upgrade: ${rows.length} package(s) can move:\n${renderUpgradeTable(rows)}`);

  if (blocked) {
    if (result.knownBadHits.length) logKnownBadHits(result.knownBadHits);
    if (result.ageViolations.length) logReleaseAgeBlock(result.ageViolations, cooldownDays, facts.pm, suggestions);
    if (result.advisoryHits.length) logAdvisoryHits(result.advisoryHits);
    logDeprecatedGate(deps, ap.failOnDeprecated);
    log.error('upgrade: BLOCKED — a proposed upgrade hit a gate. package.json is untouched. Skip it with --reject <pkg>, or pin a known-good version.');
    return 1;
  }

  if (!ua.write) {
    log.info('upgrade: all proposed upgrades pass the gates. Apply them with:  sandbox upgrade --write');
    return 0;
  }

  if (!ua.yes && process.stdout.isTTY) {
    const ok = await confirm({ message: `Write these ${rows.length} upgrade(s) to package.json and install in the sandbox?` });
    if (isCancel(ok) || !ok) {
      log.info('upgrade: cancelled — package.json untouched');
      return 0;
    }
  }

  // Write exactly what was gated — apply the previewed `to` ranges directly, so no version published
  // between preview and write can slip in. (ncu is discovery-only; it never writes.)
  const pkgPath = path.join(facts.cwd, 'package.json');
  try {
    writeFileSync(pkgPath, applyUpgrades(readFileSync(pkgPath, 'utf8'), rows));
  } catch (e) {
    log.error(`upgrade: couldn't write package.json (${e instanceof Error ? e.message : String(e)}) — nothing changed`);
    return 1;
  }
  log.info(`upgrade: package.json updated (${rows.length} dep(s)) — installing in the sandbox to refresh the lockfile …`);
  return materialize();
}

/**
 * `sandbox demo` — run the attack scenarios against the real sandbox. Everything happens in a
 * THROWAWAY project (never the user's repo): a temp dir with a read-only `.git` so the persistence
 * attack has something to bounce off, and no `.env`/credentials so the theft attack finds nothing.
 * Each scenario runs through the same {@link execute} path a real install uses, so the result is a
 * genuine demonstration, not a script. Image/build settings come from the user's config (so it reuses
 * their sandbox image); the per-scenario network mode + canaries come from the scenario itself.
 */
async function runDemoCommand(backend: ContainerBackend, rootDir: string, configPath: string | undefined): Promise<number> {
  const baseConfig = readConfig(rootDir, configPath);
  const dir = mkdtempSync(path.join(tmpdir(), 'sbx-demo-'));
  mkdirSync(path.join(dir, '.git', 'hooks'), { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), '{"name":"sandbox-demo","private":true}\n');
  log.info('demo: running real supply-chain attacks against the sandbox (first run builds the image; nothing touches your repo)');
  try {
    const facts = probeProject(dir, baseConfig, { envFiles: [], envFileBaseDir: dir, configEnvFilesBaseDir: dir });
    const runner: DemoRunner = async (scenario) => {
      const plan = demoPlan(scenario, baseConfig, facts);
      const canary = scenario.needs.canaries ? makeCanary() : undefined;
      const result = await execute(plan, backend, { failOnEgress: false, ...(canary ? { canary } : {}) });
      return { code: result.code, deniedHosts: result.deniedHosts, canaryHits: result.canaryHits };
    };
    return await runDemo(runner);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Print the "new version available" notice (from cache — never blocks) and kick off the once-a-day
 * background refresh. Stays out of the way: only on an interactive stderr, and skipped for machine
 * output (--json/--dry-run), CI, and the documented opt-outs (--no-update-check, NO_UPDATE_NOTIFIER,
 * config `updateCheck: false`). `cliEntry` is this bin's path, used to re-spawn the detached checker.
 */
function maybeNotifyUpdate(globals: Globals, cliEntry: string, rootDir: string, configPath?: string): void {
  if (globals.json || globals.dryRun || globals.noUpdateCheck || disabledByEnv() || !process.stderr.isTTY) return;
  try {
    if (!readConfig(rootDir, configPath).updateCheck) return;
  } catch {
    // unreadable/invalid config — fall through; the check is harmless and env/flag opt-outs still apply
  }
  const current = selfVersion();
  if (!current) return;
  const banner = updateBanner(current);
  if (banner) process.stderr.write(banner);
  scheduleUpdateCheck(cliEntry);
}

async function main(): Promise<number> {
  const { globals, cmd, args } = parse(process.argv.slice(2));

  // Hidden re-entry: the detached background checker (spawned by scheduleUpdateCheck) runs one
  // registry lookup, writes the cache, and exits. Must short-circuit before any other dispatch.
  if (cmd === '__update-check') {
    await refreshUpdateCache();
    return 0;
  }

  if (cmd === undefined || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(HELP);
    return 0;
  }

  if (cmd === 'version' || cmd === '--version' || cmd === '-v' || cmd === '-V') {
    process.stdout.write(`${selfVersion() ?? 'unknown'}\n`);
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
  maybeNotifyUpdate(globals, process.argv[1] ?? '', context.rootDir, context.configPath);

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
    const wantSign = args.includes('--sign');
    // When signing, keep stdout clean for the receipt — route any --scan/--secrets findings to
    // stderr (human lines) rather than letting their --json output collide with the receipt.
    const gateGlobals = wantSign ? { ...globals, json: false } : globals;
    const checks = ['boundary'];
    let code = await runVerify(context.rootDir, context.configPath);
    // --scan: also run the retroactive malware sweep, so a green verify means
    // "boundary intact AND no installed dep is currently flagged as malware".
    if (args.includes('--scan')) {
      code = code || (await runScanCommand(gateGlobals, resolvePackageManager(context.rootDir), context.rootDir));
      checks.push('scan');
    }
    // --secrets: also fail if a credential is committed in the repo.
    if (args.includes('--secrets')) {
      code = code || runSecretsCommand(gateGlobals, context.rootDir);
      checks.push('secrets');
    }
    if (!wantSign) return code;
    // --sign: emit an Ed25519-signed receipt — but ONLY when every requested gate passed, so the
    // receipt can never attest a "green" boundary while --scan found malware or --secrets found a key.
    if (code !== 0) {
      log.error('verify --sign: not signing — a check above failed; fix it before requesting a receipt');
      return code;
    }
    const keyFile = process.env.SANDBOX_SIGNING_KEY;
    if (!keyFile) fail('verify --sign needs a signing key: generate one with `sandbox keygen`, then set SANDBOX_SIGNING_KEY to the private-key file');
    const receipt = signVerifyReceipt(context.rootDir, readSigningKey(keyFile), { configPath: context.configPath, now: new Date(), checks });
    if (!receipt) return runVerify(context.rootDir, context.configPath); // boundary regressed since the check above (shouldn't happen)
    console.log(JSON.stringify(receipt, null, 2));
    return 0;
  }

  if (cmd === 'verify-receipt') {
    const file = args.find((a) => !a.startsWith('-'));
    if (!file) fail('usage: sandbox verify-receipt <file.json> [--fingerprint <hex>]');
    const fpIdx = args.indexOf('--fingerprint');
    const trustedFingerprint = (fpIdx >= 0 ? args[fpIdx + 1] : undefined) ?? process.env.SANDBOX_TRUSTED_KEY;
    return runVerifyReceipt(path.resolve(invocationCwd, file), { trustedFingerprint, json: globals.json });
  }

  if (cmd === 'keygen') {
    return runKeygen({ json: globals.json });
  }

  if (cmd === 'audit') {
    const sub = args[0];
    if (sub !== 'verify') fail('usage: sandbox audit verify <log.jsonl>  (the hash-chained audit log; set SANDBOX_AUDIT_LOG to write one)');
    const file = args.slice(1).find((a) => !a.startsWith('-')) ?? process.env.SANDBOX_AUDIT_LOG;
    if (!file) fail('usage: sandbox audit verify <log.jsonl>  (or set SANDBOX_AUDIT_LOG)');
    return runAuditVerify(path.resolve(invocationCwd, file), { json: globals.json });
  }

  if (cmd === 'scan') {
    return runScanCommand(globals, resolvePackageManager(context.rootDir), context.rootDir);
  }

  if (cmd === 'secrets') {
    const target = args.find((a) => !a.startsWith('-'));
    return runSecretsCommand(globals, target ? path.resolve(invocationCwd, target) : context.rootDir);
  }

  if (cmd === 'feeds') {
    return runFeedsCommand(globals, readConfig(context.rootDir, context.configPath), args);
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

  if (cmd === 'demo') {
    return runDemoCommand(backend, context.rootDir, context.configPath);
  }

  if (cmd === 'build') {
    const loaded = loadConfig(context.rootDir, context.configPath);
    for (const warning of loaded.warnings) log.warn(warning);
    const tag = globals.image ?? loaded.config.image;
    if (globals.json) {
      console.log(JSON.stringify(resolveBuildSpec(loaded.config, tag, context.rootDir), null, 2));
      return 0;
    }
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
  // `sandbox dev` is sugar for `sandbox --dev <dev|start|serve>`: fold it into globals here so the
  // dev-mode network/devPorts open up in the ONE effective config every path below shares.
  if (cmd === 'dev') globals.dev = true;
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
    // Canaries only do anything where there's an egress proxy log to watch (allowlist mode); plant
    // them once and reuse across retries so the same honeytokens persist if we widen + re-run.
    const wantCanaries = globals.canaries ?? config.install.canaries;
    const canary = wantCanaries && networkPolicy(plan.network).useEgressProxy ? makeCanary() : undefined;
    if (wantCanaries && !canary) log.info(`canaries requested but inactive here — they need allowlist egress (the proxy that watches for leaked tokens); this phase runs network '${plan.network}'`);
    let buildApprovalTries = 0;
    for (;;) {
      const result = await execute(plan, backend, { failOnEgress: globals.failOnEgress, ...(canary ? { canary } : {}) });
      // pnpm refuses unknown dependency build scripts, records them under `allowBuilds:` in
      // pnpm-workspace.yaml as undecided, and exits non-zero. Resolve that here so the user never
      // hand-edits YAML: prompt on a TTY, auto-approve with --allow-all-builds, else print the
      // one-liner — then re-run so the approved scripts actually build.
      if (facts.pm === 'pnpm' && classifyCommand(plan.argv) !== 'other' && buildApprovalTries < 3) {
        const pending = findPendingBuilds(context.rootDir);
        if (pending.length) {
          buildApprovalTries++;
          if (globals.allowAllBuilds) {
            const r = writeBuildApprovals(context.rootDir, new Map(pending.map((n) => [n, true])));
            log.info(`approved build scripts (contained in the sandbox): ${r.allowed.join(', ')} — re-running install`);
            continue;
          }
          const ttyPrompt = Boolean(process.stdin.isTTY && process.stdout.isTTY) && !globals.json && !globals.dryRun;
          if (ttyPrompt) {
            const decisions = await promptBuildApprovals(pending);
            if (decisions) {
              const r = writeBuildApprovals(context.rootDir, decisions);
              const parts = [r.allowed.length ? `allowed ${r.allowed.join(', ')}` : '', r.denied.length ? `denied ${r.denied.join(', ')}` : ''].filter(Boolean);
              log.info(`updated pnpm-workspace.yaml (${parts.join('; ')}) — re-running install`);
              continue;
            }
          }
          log.warn(`${pending.length} package(s) want to run install scripts but aren't approved yet: ${pending.join(', ')}`);
          log.info(`approve (contained in the sandbox) and re-install:  ${renderApproveBuildsCommand(pending)}`);
          log.info('or approve all without prompting:  add --allow-all-builds to your install');
          return result.code === 0 ? 1 : result.code;
        }
      }
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

  if (cmd === 'approve-builds') {
    // Resolve pnpm's ignored dependency build scripts without hand-editing YAML. With no package
    // names, approves everything pnpm left pending; names can also pre-approve specific packages.
    // `--deny` records the opposite decision (don't build) so pnpm stops re-prompting.
    if (facts.pm !== 'pnpm') {
      log.warn(`approve-builds resolves pnpm's ignored build scripts; this project uses ${facts.pm}`);
      return 0;
    }
    const named = args.filter((a) => !a.startsWith('-'));
    const deny = args.includes('--deny') || args.includes('--none');
    const targets = named.length ? named : findPendingBuilds(context.rootDir);
    if (!targets.length) {
      log.info('no dependency build scripts are awaiting approval');
      return 0;
    }
    const r = writeBuildApprovals(context.rootDir, new Map(targets.map((n) => [n, !deny])));
    log.info(`${deny ? 'denied' : 'approved'} build scripts: ${(deny ? r.denied : r.allowed).join(', ')}`);
    if (deny) return 0;
    log.info('re-running install so the approved scripts build');
    return emit(planForRoute({ model: 'install', pm: facts.pm, frozen: false, args: [] }, config, facts, opts));
  }

  if (cmd === 'delta') {
    return runDeltaCommand(globals, config, facts, context.rootDir, args);
  }

  if (cmd === 'upgrade') {
    // On --write, materialise the rewritten package.json through the jailed install path.
    const materialize = () => emit(planForRoute({ model: 'install', pm: facts.pm, frozen: false, args: [] }, config, facts, opts));
    return runUpgradeCommand(globals, config, facts, args, materialize);
  }

  if (cmd === 'preflight') {
    // `sandbox preflight [cmd…]` checks WITHOUT installing. Default to the install surface; otherwise
    // resolve the same way the real command would (pm pass-through AND package.json scripts).
    const inner = args[0];
    const checkRoute = inner ? resolveCommand(inner, args.slice(1), facts) : resolveCommand('install', [], facts);
    return runPreflightCommand(globals, config, facts, checkRoute);
  }

  const route = resolveCommand(cmd, args, facts);
  // A global install is host tooling — running it in an ephemeral container installs nothing on the
  // host, so refuse with guidance rather than silently no-op (the path wrappers also pass these through).
  if (isGlobalInstall(cmd, route, args)) {
    log.warn('global installs run on the host, not in the sandbox — a -g install in an ephemeral container installs nothing on your machine');
    log.info(`run it on the host instead:  command ${cmd} ${args.join(' ')}    (or: SANDBOX_OFF=1 ${cmd} ${args.join(' ')})`);
    return 1;
  }
  const blocked = await preflightRoute(globals, config, facts, route);
  if (blocked !== undefined) return blocked;
  return emit(planForRoute(route, config, facts, opts));
}

main()
  .then((code) => process.exit(code))
  .catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));
