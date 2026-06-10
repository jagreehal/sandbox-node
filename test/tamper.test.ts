import { describe, expect, it } from 'vitest';
import { classifyCommand, summarizeUnexpectedChanges, type TreeSnapshot } from '../src/tamper.js';

function snap(files: Record<string, string>): TreeSnapshot {
  return { files: new Map(Object.entries(files)) };
}

describe('classifyCommand', () => {
  it('classifies install and add plans', () => {
    expect(classifyCommand(['npm', 'install'])).toBe('install');
    expect(classifyCommand(['corepack', 'pnpm', 'add', 'zod'])).toBe('add');
    expect(classifyCommand(['node', 'server.js'])).toBe('other');
  });
});

describe('summarizeUnexpectedChanges', () => {
  it('ignores expected lockfile and dependency output writes', () => {
    const before = snap({ 'package.json': 'a', 'src/index.ts': '1' });
    const after = snap({
      'package.json': 'a',
      'package-lock.json': 'new',
      'node_modules/is-number/package.json': 'x',
      'src/index.ts': '1',
    });
    expect(summarizeUnexpectedChanges(before, after, 'install')).toEqual([]);
  });

  it('reports source-tree tampering during install', () => {
    const before = snap({ 'package.json': 'a', 'src/index.ts': '1' });
    const after = snap({ 'package.json': 'a', 'src/index.ts': '2', 'src/persist.js': 'x' });
    expect(summarizeUnexpectedChanges(before, after, 'install')).toEqual(['src/index.ts', 'src/persist.js']);
  });

  it('allows package.json changes only for add', () => {
    const before = snap({ 'package.json': 'a' });
    const after = snap({ 'package.json': 'b' });
    expect(summarizeUnexpectedChanges(before, after, 'install')).toEqual(['package.json']);
    expect(summarizeUnexpectedChanges(before, after, 'add')).toEqual([]);
  });
});
