import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyConfig } from '../src/verify.js';

/** A project dir with a committed config (+ optional personal local override). Returns the dir. */
function project(json: string, local?: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'sbx-verify-'));
  writeFileSync(path.join(dir, 'sandbox.config.json'), json);
  if (local !== undefined) writeFileSync(path.join(dir, 'sandbox.config.local.json'), local);
  return dir;
}

const configIn = (dir: string) => path.join(dir, 'sandbox.config.json');

describe('verifyConfig', () => {
  // Isolate the user-global layer so a real file can't sway the gate.
  let savedXdg: string | undefined;
  beforeAll(() => {
    savedXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = mkdtempSync(path.join(tmpdir(), 'sbx-xdg-'));
  });
  afterAll(() => {
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
  });

  it('fails when there is genuinely no committed config (cwd has none)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sbx-verify-empty-'));
    const res = verifyConfig(dir, undefined);
    expect(res.ok).toBe(false);
    expect(res.problems[0]).toMatch(/no committed sandbox\.config\.json/);
  });

  it('default usage (cwd only) resolves cwd/sandbox.config.json and passes when it exists', () => {
    const dir = project('{ "install": { "network": "allowlist" }, "run": { "network": "none" } }');
    const res = verifyConfig(dir); // no explicit configPath — the regression case
    expect(res.ok).toBe(true);
    expect(res.problems).toEqual([]);
  });

  it('default usage still catches a personal local layer loosening the boundary', () => {
    const dir = project('{ "run": { "network": "none" } }', '{ "run": { "network": "on" } }');
    const res = verifyConfig(dir); // cwd only
    expect(res.ok).toBe(false);
    expect(res.problems.some((p) => /run\.network widened/.test(p))).toBe(true);
  });

  it('passes for a committed config with no personal loosening, and reports the boundary', () => {
    const dir = project('{ "install": { "network": "allowlist" }, "run": { "network": "none" } }');
    const res = verifyConfig(dir, configIn(dir));
    expect(res.ok).toBe(true);
    expect(res.problems).toEqual([]);
    expect(res.summary.join('\n')).toMatch(/install network : allowlist/);
  });

  it('fails when a personal local layer loosens the boundary', () => {
    const dir = project('{ "run": { "network": "none" } }', '{ "run": { "network": "on" }, "grants": { "ssh-agent": true } }');
    const res = verifyConfig(dir, configIn(dir));
    expect(res.ok).toBe(false);
    expect(res.problems.some((p) => /run\.network widened/.test(p))).toBe(true);
    expect(res.problems.some((p) => /ssh-agent/.test(p))).toBe(true);
  });

  it('fails clearly on an invalid committed config', () => {
    const dir = project('{ "rnu": {} }'); // typo'd section
    const res = verifyConfig(dir, configIn(dir));
    expect(res.ok).toBe(false);
    expect(res.problems[0]).toMatch(/invalid config/i);
  });
});
