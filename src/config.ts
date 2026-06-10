import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/** Network policy for a phase: no egress, full bridge, or default-deny allowlist. */
export const NetworkMode = z.enum(['none', 'on', 'allowlist']);
export type NetworkMode = z.infer<typeof NetworkMode>;

export const SandboxConfigSchema = z
  .object({
    /** Editor JSON Schema reference (enables autocomplete/validation in the config file). */
    $schema: z.string().optional(),
    /** Image tag for the sandbox container (override per project if needed). */
    image: z.string().default('node-install-sandbox:latest'),
    grants: z
      .object({
        'ssh-agent': z.boolean().default(false),
        claude: z.enum(['none', 'project', 'home']).default('none'),
        paths: z.array(z.string()).default([]),
        env: z.array(z.string()).default([]),
        envFiles: z.array(z.string()).default([]),
      })
      .strict()
      .default({
        'ssh-agent': false,
        claude: 'none',
        paths: [],
        env: [],
        envFiles: [],
      }),
    install: z
      // Default-deny egress: installs reach only `egress.allow` (the registry),
      // so a malicious lifecycle script can't exfiltrate. Set "on" to opt out.
      // `frozen` = reproducible install (npm ci / --frozen-lockfile); enables a
      // fully read-only source tree on every package manager except pnpm. Requires a committed lockfile.
      .object({
        network: NetworkMode.default('allowlist'),
        frozen: z.boolean().default(false),
        // Pre-install registry signals. "basic" (default) runs the fast packument-only checks
        // (install scripts, fresh/new versions, bins, deprecation, typosquatting, provenance
        // regression, maintainer takeover). "thorough" adds the noisier/network-backed signals
        // (missing metadata, low download counts, expired maintainer domains). "off" disables them.
        riskHints: z.enum(['off', 'basic', 'thorough']).default('basic'),
        failOnRisk: z.boolean().default(false),
        // Release-age gate (the control the 2026-06-04 incident named most effective): refuse to
        // install a package version published fewer than this many days ago. 0 = off. Blocking,
        // not advisory — defeats publish-and-detonate worms by closing the fresh-version window.
        minReleaseAgeDays: z.number().int().min(0).default(0),
        // Package-name patterns exempt from the release-age gate (e.g. your own freshly-published
        // scope). Supports `*` globs: ["@myscope/*", "internal-*"]. The gate would otherwise block
        // your own publishes — this is what the incident response itself had to add.
        minReleaseAgeExclude: z.array(z.string()).default([]),
        // Block installs that pull a version flagged as malware in the OSV advisory database.
        // Different axis from the age gate: "known bad" rather than "too new". Advisory lookups
        // run when riskHints is on; this turns a malware hit into a hard preflight failure.
        failOnAdvisory: z.boolean().default(false),
        // Refuse to install a version the maintainer has DEPRECATED. A deprecated version is
        // abandoned — it won't get security fixes and is a standing supply-chain risk — so we
        // never resolve to one. On by default; `--allow-deprecated` overrides for one run. Rides
        // on riskHints (the same registry resolve), so `--risk off` also disables it.
        failOnDeprecated: z.boolean().default(true),
      })
      .strict()
      .default({ network: 'allowlist', frozen: false, riskHints: 'basic', failOnRisk: false, minReleaseAgeDays: 0, minReleaseAgeExclude: [], failOnAdvisory: false, failOnDeprecated: true }),
    egress: z
      .object({ allow: z.array(z.string()).default(['npmjs.org', 'npmjs.com']) })
      .strict()
      .default({ allow: ['npmjs.org', 'npmjs.com'] }),
    run: z
      .object({
        network: NetworkMode.default('none'),
        ports: z.array(z.string()).default([]),
        // Publish the common framework dev-server ports (Vite/Next/Astro/…) to the host
        // so `npm run dev` is reachable without listing each one. Only takes effect when
        // `network` isn't 'none'. The `vibe`/`agent` presets turn this on.
        devPorts: z.boolean().default(false),
      })
      .strict()
      .default({ network: 'none', ports: [], devPorts: false }),
  })
  .strict();

export type SandboxConfig = z.infer<typeof SandboxConfigSchema>;
export const SANDBOX_SCHEMA_REF = './node_modules/@jagreehal/sandbox-node/sandbox.schema.json';

/**
 * Strip JSONC comments (`// line` and `/* block *​/`) while preserving any `//`
 * that appears inside a string literal (e.g. a URL or path). This makes the
 * inline-comment manifest examples in the docs actually parse.
 */
export function stripJsonComments(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const next = text[i + 1];
    if (inLine) {
      if (c === '\n') {
        inLine = false;
        out += c;
      }
      continue;
    }
    if (inBlock) {
      if (c === '*' && next === '/') {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
    } else if (c === '/' && next === '/') {
      inLine = true;
      i++;
    } else if (c === '/' && next === '*') {
      inBlock = true;
      i++;
    } else {
      out += c;
    }
  }
  return out;
}

/** Recursively drop `"//"`-prefixed keys (the JSON "note field" convention). */
function dropNoteKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dropNoteKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => !k.startsWith('//'))
        .map(([k, v]) => [k, dropNoteKeys(v)]),
    );
  }
  return value;
}

/**
 * Load and validate `sandbox.config.json` (or `configPath`). Supports JSONC
 * comments. A missing file is valid — every field has a safe default. Unknown
 * keys are rejected so typos surface instead of silently doing nothing.
 */
export function readConfig(cwd: string, configPath?: string): SandboxConfig {
  const file = configPath ?? path.join(cwd, 'sandbox.config.json');
  let raw: unknown = {};
  if (existsSync(file)) {
    try {
      raw = JSON.parse(stripJsonComments(readFileSync(file, 'utf8')));
    } catch (e) {
      throw new Error(`sandbox: invalid JSON in ${file}: ${(e as Error).message}`);
    }
  }
  const parsed = SandboxConfigSchema.safeParse(dropNoteKeys(raw));
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`sandbox: invalid config (${file}):\n${issues}`);
  }
  return parsed.data;
}

/** Write a normalized config file with the shipped JSON Schema ref. */
export function writeConfig(file: string, config: SandboxConfig): string {
  writeFileSync(file, `${JSON.stringify({ $schema: SANDBOX_SCHEMA_REF, ...config }, null, 2)}\n`);
  return file;
}
