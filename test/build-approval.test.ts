import { describe, expect, it } from 'vitest';
import { applyBuildApprovals, parsePendingBuilds, renderApproveBuildsCommand } from '../src/build-approval.js';

describe('parsePendingBuilds', () => {
  it('flags allowBuilds entries with pnpm’s placeholder value', () => {
    const text = `allowBuilds:
  esbuild: true
  protobufjs: set this to true or false
  sharp: false
`;
    expect(parsePendingBuilds(text)).toEqual(['protobufjs']);
  });

  it('returns nothing when every entry is decided', () => {
    const text = `allowBuilds:
  esbuild: true
  sharp: false
`;
    expect(parsePendingBuilds(text)).toEqual([]);
  });

  it('ignores entries outside the allowBuilds section', () => {
    const text = `onlyBuiltDependencies:
  - esbuild
allowBuilds:
  protobufjs: set this to true or false
confirmModulesPurge: false
`;
    expect(parsePendingBuilds(text)).toEqual(['protobufjs']);
  });

  it('returns [] when there is no allowBuilds section', () => {
    expect(parsePendingBuilds('onlyBuiltDependencies:\n  - esbuild\n')).toEqual([]);
  });
});

describe('applyBuildApprovals', () => {
  it('approves: sets true and adds to onlyBuiltDependencies', () => {
    const text = `onlyBuiltDependencies:
  - esbuild
allowBuilds:
  esbuild: true
  protobufjs: set this to true or false
`;
    const { text: out, allowed, denied } = applyBuildApprovals(text, new Map([['protobufjs', true]]));
    expect(allowed).toEqual(['protobufjs']);
    expect(denied).toEqual([]);
    expect(out).toContain('protobufjs: true');
    expect(out).not.toContain('set this to true or false');
    // added to the sequence section exactly once
    expect(out.match(/-\s+protobufjs/g)).toHaveLength(1);
  });

  it('denies: sets false and does NOT add to onlyBuiltDependencies', () => {
    const text = `onlyBuiltDependencies:
  - esbuild
allowBuilds:
  protobufjs: set this to true or false
`;
    const { text: out, allowed, denied } = applyBuildApprovals(text, new Map([['protobufjs', false]]));
    expect(allowed).toEqual([]);
    expect(denied).toEqual(['protobufjs']);
    expect(out).toContain('protobufjs: false');
    expect(out).not.toMatch(/-\s+protobufjs/);
  });

  it('denies: removes a package already present in onlyBuiltDependencies', () => {
    const text = `onlyBuiltDependencies:
  - esbuild
  - protobufjs
allowBuilds:
  protobufjs: true
`;
    const out = applyBuildApprovals(text, new Map([['protobufjs', false]])).text;
    expect(out).toContain('protobufjs: false');
    expect(out).not.toMatch(/-\s+protobufjs/);
    expect(out).toMatch(/-\s+esbuild/);
  });

  it('creates both sections when neither exists (pre-approving a named package)', () => {
    const out = applyBuildApprovals('', new Map([['protobufjs', true]])).text;
    expect(out).toContain('allowBuilds:');
    expect(out).toContain('protobufjs: true');
    expect(out).toContain('onlyBuiltDependencies:');
    expect(out).toMatch(/-\s+protobufjs/);
  });

  it('does not duplicate an onlyBuiltDependencies entry already present', () => {
    const text = `onlyBuiltDependencies:
  - protobufjs
allowBuilds:
  protobufjs: set this to true or false
`;
    const out = applyBuildApprovals(text, new Map([['protobufjs', true]])).text;
    expect(out.match(/-\s+protobufjs/g)).toHaveLength(1);
  });
});

describe('renderApproveBuildsCommand', () => {
  it('renders a ready-to-run one-liner', () => {
    expect(renderApproveBuildsCommand(['protobufjs', 'esbuild'])).toBe('sandbox approve-builds protobufjs esbuild');
  });
});
