import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureLocalConfigIgnored } from '../src/init.js';

function tmp(): string {
  return mkdtempSync(path.join(tmpdir(), 'sbx-init-'));
}

describe('ensureLocalConfigIgnored', () => {
  it('creates .gitignore with the local override entry when none exists', () => {
    const dir = tmp();
    expect(ensureLocalConfigIgnored(dir)).toBe(true);
    expect(readFileSync(path.join(dir, '.gitignore'), 'utf8')).toContain('sandbox.config.local.json');
  });

  it('appends to an existing .gitignore without clobbering it', () => {
    const dir = tmp();
    writeFileSync(path.join(dir, '.gitignore'), 'node_modules\n');
    expect(ensureLocalConfigIgnored(dir)).toBe(true);
    const body = readFileSync(path.join(dir, '.gitignore'), 'utf8');
    expect(body).toContain('node_modules');
    expect(body).toContain('sandbox.config.local.json');
  });

  it('is idempotent — no change when the entry is already present', () => {
    const dir = tmp();
    writeFileSync(path.join(dir, '.gitignore'), 'sandbox.config.local.json\n');
    expect(ensureLocalConfigIgnored(dir)).toBe(false);
  });

  it('does not create a .gitignore for an unrelated call path', () => {
    const dir = tmp();
    expect(existsSync(path.join(dir, '.gitignore'))).toBe(false); // sanity: starts clean
    ensureLocalConfigIgnored(dir);
    expect(existsSync(path.join(dir, '.gitignore'))).toBe(true);
  });
});
