import { describe, expect, it } from 'vitest';
import { pmAuditFixArgv, pmAuditSignaturesArgv, pmUpdateArgv } from '../src/package-manager.js';

describe('pmUpdateArgv', () => {
  it('preserves the verb the user typed, routing pnpm/yarn through corepack', () => {
    expect(pmUpdateArgv('npm', 'update', [])).toEqual(['npm', 'update']);
    expect(pmUpdateArgv('npm', 'up', ['lodash'])).toEqual(['npm', 'up', 'lodash']);
    expect(pmUpdateArgv('pnpm', 'up', ['--latest'])).toEqual(['corepack', 'pnpm', 'up', '--latest']);
    expect(pmUpdateArgv('yarn', 'upgrade', [])).toEqual(['corepack', 'yarn', 'upgrade']);
    expect(pmUpdateArgv('bun', 'update', [])).toEqual(['bun', 'update']);
  });
});

describe('pmAuditFixArgv', () => {
  it('builds the in-place remediation command for npm (positional fix) and pnpm (--fix flag)', () => {
    expect(pmAuditFixArgv('npm', 'fix', [])).toEqual(['npm', 'audit', 'fix']);
    expect(pmAuditFixArgv('npm', 'fix', ['--force'])).toEqual(['npm', 'audit', 'fix', '--force']);
    expect(pmAuditFixArgv('pnpm', '--fix', [])).toEqual(['corepack', 'pnpm', 'audit', '--fix']);
    expect(pmAuditFixArgv('pnpm', '--fix=update', ['--prod'])).toEqual(['corepack', 'pnpm', 'audit', '--fix=update', '--prod']);
  });

  it('throws for yarn and bun, which have no install-class audit-fix command', () => {
    expect(() => pmAuditFixArgv('yarn', 'fix', [])).toThrow(/does not support/i);
    expect(() => pmAuditFixArgv('bun', 'fix', [])).toThrow(/does not support/i);
  });
});

describe('pmAuditSignaturesArgv', () => {
  it('builds the registry signature-verification command for npm and pnpm', () => {
    expect(pmAuditSignaturesArgv('npm', [])).toEqual(['npm', 'audit', 'signatures']);
    expect(pmAuditSignaturesArgv('pnpm', ['--json'])).toEqual(['corepack', 'pnpm', 'audit', 'signatures', '--json']);
  });

  it('throws for yarn and bun, which have no audit signatures command', () => {
    expect(() => pmAuditSignaturesArgv('yarn', [])).toThrow(/does not support/i);
    expect(() => pmAuditSignaturesArgv('bun', [])).toThrow(/does not support/i);
  });
});
