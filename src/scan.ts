import { advisoriesForPackages, createAdvisoryClient, type AdvisoryClient, type AdvisoryHit } from './advisory.js';
import { readAllPackagesFromLockfile, type LockfilePackage } from './risk.js';
import type { PackageManager } from './package-manager.js';

/**
 * Retroactive supply-chain scan. The install-time gates only know what's flagged *at install*; the
 * dominant way a compromise surfaces is later — OSV publishes a `MAL-` advisory for a version you
 * already have. `runScan` re-queries OSV for the currently-resolved lockfile tree so a dependency
 * that turned malicious *after* it was installed is caught on the next scan (CI, cron, or on demand).
 *
 * Pure of logging/exit codes by design (mirrors {@link runPreflight}): the {@link ScanResult} is the
 * test surface; the CLI shell decides what to print and what blocks. Per-package OSV lookups fail
 * OPEN (a query error drops that package, never the whole scan).
 */
export interface ScanResult {
  /** Distinct `name@version` pairs examined from the lockfile. */
  scanned: number;
  /** Every advisory hit (malware and non-malware). */
  hits: AdvisoryHit[];
  /** The subset flagged as malware (`MAL-…`) — the high-signal block trigger. */
  malware: AdvisoryHit[];
  /** No parseable lockfile (none committed, or bun, which has no parser yet). */
  lockfileMissing: boolean;
}

export interface ScanContext {
  pm: PackageManager;
  cwd: string;
  advisoryClient?: AdvisoryClient;
  /** Override lockfile reading (tests); defaults to reading `cwd`'s lockfile. */
  readLockfile?: (cwd: string, pm: PackageManager) => LockfilePackage[];
}

export async function runScan(ctx: ScanContext): Promise<ScanResult> {
  let packages: LockfilePackage[];
  try {
    packages = (ctx.readLockfile ?? readAllPackagesFromLockfile)(ctx.cwd, ctx.pm);
  } catch {
    packages = [];
  }
  if (packages.length === 0) {
    return { scanned: 0, hits: [], malware: [], lockfileMissing: true };
  }
  const scanned = new Set(packages.map((p) => `${p.name}@${p.version}`)).size;
  const hits = await advisoriesForPackages(packages, ctx.advisoryClient ?? createAdvisoryClient());
  return { scanned, hits, malware: hits.filter((h) => h.malware), lockfileMissing: false };
}
