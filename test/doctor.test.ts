import { describe, expect, it } from 'vitest';
import { autoFixActions, type Check } from '../src/doctor.js';

const ok = (label: string): Check => ({ level: 'ok', label, detail: 'fine' });

describe('autoFixActions', () => {
  it('is empty when every check passes', () => {
    expect(autoFixActions([ok('config'), ok('backend'), ok('image')])).toEqual([]);
  });

  it('returns a build action for an absent or stale image', () => {
    const checks: Check[] = [
      ok('backend'),
      { level: 'info', label: 'image', detail: 'present but out of date', autoFix: 'build' },
    ];
    expect(autoFixActions(checks)).toEqual(['build']);
  });

  it('does not try to auto-fix a non-automatable failure (e.g. a down daemon)', () => {
    const checks: Check[] = [
      { level: 'fail', label: 'daemon', detail: 'not reachable', fixes: ['open -a Docker'] },
    ];
    expect(autoFixActions(checks)).toEqual([]);
  });

  it('deduplicates so a single build runs even if several checks request it', () => {
    const checks: Check[] = [
      { level: 'info', label: 'image', detail: 'absent', autoFix: 'build' },
      { level: 'info', label: 'image', detail: 'stale', autoFix: 'build' },
    ];
    expect(autoFixActions(checks)).toEqual(['build']);
  });
});
