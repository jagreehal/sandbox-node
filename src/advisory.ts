import { createRegistryClient, mapPool, resolveRiskTargets, type RegistryClient, type ResolvedTarget, type RiskTarget } from './risk.js';

/**
 * "Known-bad" axis, complementing the release-age gate's "too-new" axis. Queries the OSV advisory
 * database for the exact version an install would pull and flags it when an advisory matches,
 * with malware advisories (`MAL-…` ids) called out as the high-signal block trigger. OSV publishes
 * npm malware advisories under the `MAL-` id prefix; that's the reliable malware signal.
 */

export const ADVISORY_TIMEOUT_MS = 5000;

export interface AdvisoryClient {
  /** Return the advisory ids affecting `name@version` (empty when none). */
  query(name: string, version: string): Promise<string[]>;
}

export interface AdvisoryHit {
  name: string;
  version: string;
  ids: string[];
  /** True when any advisory is a malware report (`MAL-…`). */
  malware: boolean;
}

/** OSV uses the `MAL-` id prefix for malicious-package advisories. */
export function isMalwareId(id: string): boolean {
  return id.toUpperCase().startsWith('MAL-');
}

export function createAdvisoryClient(fetchImpl: typeof fetch = fetch, baseUrl = process.env.SANDBOX_OSV_API ?? 'https://api.osv.dev', timeoutMs = ADVISORY_TIMEOUT_MS): AdvisoryClient {
  return {
    async query(name: string, version: string): Promise<string[]> {
      const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/v1/query`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ version, package: { name, ecosystem: 'npm' } }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`OSV query failed for ${name}@${version}: ${response.status}`);
      const body = (await response.json()) as { vulns?: Array<{ id?: unknown }> };
      return (body.vulns ?? []).map((v) => v.id).filter((id): id is string => typeof id === 'string');
    },
  };
}

/**
 * Resolve `targets` to exact versions and query OSV for each. Returns one {@link AdvisoryHit} per
 * package that has at least one advisory. The caller decides whether a malware hit blocks (it does
 * under `--fail-on-advisory` / the strict preset). A query error throws, so the caller can fail open.
 */
export async function checkAdvisories(targets: RiskTarget[], opts: { registryClient?: RegistryClient; advisoryClient?: AdvisoryClient } = {}): Promise<AdvisoryHit[]> {
  const registry = opts.registryClient ?? createRegistryClient();
  const resolved = await resolveRiskTargets(targets, registry);
  return advisoriesForResolved(resolved, opts.advisoryClient ?? createAdvisoryClient());
}

/**
 * Query OSV for already-resolved (name, version) pairs. Split from {@link checkAdvisories} so the
 * preflight can reuse one shared registry resolution rather than resolving again just for advisories.
 */
export async function advisoriesForResolved(resolved: ResolvedTarget[], advisory: AdvisoryClient): Promise<AdvisoryHit[]> {
  const hits: AdvisoryHit[] = [];
  for (const pkg of resolved) {
    const ids = await advisory.query(pkg.name, pkg.version);
    if (ids.length) hits.push({ name: pkg.name, version: pkg.version, ids, malware: ids.some(isMalwareId) });
  }
  return hits;
}

/**
 * Query OSV for a (possibly large) list of (name, version) pairs — the `--deep` transitive tree.
 * De-duplicates by name@version and runs the lookups with bounded concurrency so a big tree doesn't
 * open hundreds of simultaneous OSV requests. Fails open per package: an OSV error for one name drops
 * that package's result rather than the whole scan.
 */
export async function advisoriesForPackages(packages: Array<{ name: string; version: string }>, advisory: AdvisoryClient, concurrency = 8): Promise<AdvisoryHit[]> {
  const seen = new Set<string>();
  const unique = packages.filter((p) => {
    const key = `${p.name}@${p.version}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const hits = await mapPool(unique, concurrency, async (pkg): Promise<AdvisoryHit | undefined> => {
    let ids: string[];
    try {
      ids = await advisory.query(pkg.name, pkg.version);
    } catch {
      return undefined; // fail open per package
    }
    return ids.length ? { name: pkg.name, version: pkg.version, ids, malware: ids.some(isMalwareId) } : undefined;
  });
  return hits.filter((h): h is AdvisoryHit => Boolean(h));
}
