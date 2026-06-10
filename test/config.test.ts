import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readConfig } from '../src/config.js';

function withConfig(json: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'sbx-cfg-'));
  writeFileSync(path.join(dir, 'sandbox.config.json'), json);
  return dir;
}

describe('readConfig', () => {
  it('returns safe defaults when no file exists', () => {
    const c = readConfig(mkdtempSync(path.join(tmpdir(), 'sbx-empty-')));
    expect(c.image).toBe('node-install-sandbox:latest');
    expect(c.install.network).toBe('allowlist'); // default-deny egress during install
    expect(c.install.riskHints).toBe('basic');
    expect(c.install.failOnRisk).toBe(false);
    expect(c.run.network).toBe('none');
    expect(c.egress.allow).toEqual(['npmjs.org', 'npmjs.com']);
    expect(c.grants.claude).toBe('none');
    expect(c.grants.envFiles).toEqual([]);
  });

  it('strips //-comment keys', () => {
    const c = readConfig(withConfig('{ "//": "a note", "install": { "network": "allowlist" } }'));
    expect(c.install.network).toBe('allowlist');
  });

  it('supports JSONC inline // and /* */ comments', () => {
    const c = readConfig(
      withConfig(`{
        // line comment
        "install": { "network": "allowlist" }, // trailing comment
        /* block
           comment */
        "run": { "network": "on" }
      }`),
    );
    expect(c.install.network).toBe('allowlist');
    expect(c.run.network).toBe('on');
  });

  it('preserves // inside string values', () => {
    const c = readConfig(withConfig('{ "grants": { "paths": ["~/x//y:ro"], "envFiles": [".env.local"] } }'));
    expect(c.grants.paths).toEqual(['~/x//y:ro']);
    expect(c.grants.envFiles).toEqual(['.env.local']);
  });

  it('rejects unknown keys (typo protection)', () => {
    // cspell:disable-next-line -- "grnats" is an intentional typo of "grants" (typo-protection test)
    expect(() => readConfig(withConfig('{ "grnats": {} }'))).toThrow(/invalid config/i);
  });

  it('rejects an invalid network mode', () => {
    expect(() => readConfig(withConfig('{ "run": { "network": "wide-open" } }'))).toThrow(/invalid config/i);
  });

  it('accepts install risk settings', () => {
    const c = readConfig(withConfig('{ "install": { "riskHints": "off", "failOnRisk": true } }'));
    expect(c.install.riskHints).toBe('off');
    expect(c.install.failOnRisk).toBe(true);
  });

  it('reports invalid JSON clearly', () => {
    expect(() => readConfig(withConfig('{ not json'))).toThrow(/invalid JSON/i);
  });
});
