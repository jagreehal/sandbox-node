import { existsSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { log } from './log.js';

export interface VerifyResult {
  ok: boolean;
  /** What was verified (effective boundary) — printed so the CI log shows the policy. */
  summary: string[];
  /** Why it failed, if it did. Empty on success. */
  problems: string[];
}

/**
 * The check behind the verified badge: confirm this repo commits a real sandbox boundary and
 * that no personal layer has loosened it. Designed to run in CI as an exit-code gate — green
 * means "installs here actually go through a default-deny sandbox," which is what the badge claims.
 */
export function verifyConfig(cwd: string, configPath?: string): VerifyResult {
  const summary: string[] = [];
  const problems: string[] = [];

  // Resolve the project config the same way readConfig/loadConfig do, so a caller that passes only
  // `cwd` still finds `cwd/sandbox.config.json`. The gate fails only when that file truly doesn't exist.
  const projectFile = configPath ?? path.join(cwd, 'sandbox.config.json');
  if (!existsSync(projectFile)) {
    return { ok: false, summary, problems: [`no committed sandbox.config.json found at ${projectFile} — run \`sandbox init\` and commit it`] };
  }

  let loaded;
  try {
    loaded = loadConfig(cwd, projectFile);
  } catch (e) {
    return { ok: false, summary, problems: [e instanceof Error ? e.message.replace(/^sandbox:\s*/, '') : String(e)] };
  }

  // A personal layer (user-global or *.local.json) loosening past the committed boundary fails
  // the gate — that's the un-reviewed widening the badge must not vouch for.
  for (const w of loaded.warnings) problems.push(`boundary loosened beyond committed config: ${w}`);

  const c = loaded.config;
  summary.push(
    `install network : ${c.install.network}`,
    `run network     : ${c.run.network}`,
    `egress allow    : ${c.egress.allow.join(', ') || '(none)'}`,
    `credential grants: ${grantsSummary(c)}`,
  );
  return { ok: problems.length === 0, summary, problems };
}

function grantsSummary(c: ReturnType<typeof loadConfig>['config']): string {
  const g = c.grants;
  const on = [
    ...(g['ssh-agent'] ? ['ssh-agent'] : []),
    ...(g.claude !== 'none' ? [`claude:${g.claude}`] : []),
    ...(g.paths.length ? [`paths×${g.paths.length}`] : []),
    ...(g.env.length ? [`env×${g.env.length}`] : []),
    ...(g.envFiles.length ? [`envFiles×${g.envFiles.length}`] : []),
  ];
  return on.length ? on.join(', ') : 'none';
}

/** CLI entry: print the verdict and return an exit code (0 = boundary verified). */
export function runVerify(cwd: string, configPath?: string): number {
  const { ok, summary, problems } = verifyConfig(cwd, configPath);
  for (const line of summary) log.info(`  ${line}`);
  if (ok) {
    log.info('verified: installs run through a committed sandbox boundary');
    return 0;
  }
  for (const p of problems) log.error(p);
  return 1;
}
