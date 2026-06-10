import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { allowHosts, detectEgressHosts, detectRegistryHints, missingAllowHosts, renderAllowCommand, renderAllowlistSnippet } from '../src/registry.js';

describe('detectRegistryHints', () => {
  it('finds registry hosts and auth env refs from .npmrc text', () => {
    const hints = detectRegistryHints(`
registry=https://registry.npmjs.org/
@acme:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=\${GITHUB_TOKEN}
//registry.npmjs.org/:_authToken=\${NPM_TOKEN}
`);
    expect(hints).toEqual({
      hosts: ['npm.pkg.github.com', 'registry.npmjs.org'],
      authEnvNames: ['GITHUB_TOKEN', 'NPM_TOKEN'],
    });
  });
});

describe('allowlist helpers', () => {
  it('returns only hosts not already allowed', () => {
    expect(missingAllowHosts(['npmjs.org', 'npmjs.com'], ['npmjs.org', 'npm.pkg.github.com'])).toEqual(['npm.pkg.github.com']);
  });

  it('renders a copy-paste config snippet', () => {
    expect(renderAllowlistSnippet(['npmjs.org', 'npmjs.com'], ['npm.pkg.github.com'])).toBe(
      JSON.stringify({ egress: { allow: ['npm.pkg.github.com', 'npmjs.com', 'npmjs.org'] } }, null, 2),
    );
  });

  it('renders a sandbox allow command', () => {
    expect(renderAllowCommand(['nodejs.org', 'npm.pkg.github.com'])).toBe('sandbox allow nodejs.org npm.pkg.github.com');
  });

  it('adds hosts to egress.allow and writes the config back', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sbx-allow-'));
    writeFileSync(path.join(dir, 'sandbox.config.json'), '{}');
    const result = allowHosts(dir, ['nodejs.org', 'https://npm.pkg.github.com/path']);
    expect(result.added).toEqual(['nodejs.org', 'npm.pkg.github.com']);
    expect(JSON.parse(readFileSync(path.join(dir, 'sandbox.config.json'), 'utf8')).egress.allow).toEqual([
      'nodejs.org',
      'npm.pkg.github.com',
      'npmjs.com',
      'npmjs.org',
    ]);
  });

  it('normalizes scheme-relative and host:port forms to bare hosts', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sbx-allow-'));
    writeFileSync(path.join(dir, 'sandbox.config.json'), '{"egress":{"allow":[]}}');
    const result = allowHosts(dir, ['//registry.npmjs.org/:_authToken', 'registry.local:4873/path', '   ']);
    expect(result.added).toEqual(['registry.local:4873', 'registry.npmjs.org']);
  });
});

describe('detectEgressHosts', () => {
  const fixture = (files: Record<string, string>): string => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sbx-egress-'));
    for (const [name, body] of Object.entries(files)) writeFileSync(path.join(dir, name), body);
    return dir;
  };

  it('pulls a private registry host from .npmrc', () => {
    const dir = fixture({
      '.npmrc': '@acme:registry=https://npm.pkg.github.com\n',
      'package.json': '{"name":"x"}',
    });
    expect(detectEgressHosts(dir)).toContain('npm.pkg.github.com');
  });

  it('adds github hosts when a dependency is a git/github spec', () => {
    const dir = fixture({
      'package.json': JSON.stringify({ name: 'x', dependencies: { tool: 'github:owner/repo#main' } }),
    });
    const hosts = detectEgressHosts(dir);
    expect(hosts).toContain('github.com');
    expect(hosts).toContain('codeload.github.com');
  });

  it('returns nothing for a plain project with no .npmrc and registry deps', () => {
    const dir = fixture({ 'package.json': JSON.stringify({ name: 'x', dependencies: { zod: '^3.0.0' } }) });
    expect(detectEgressHosts(dir)).toEqual([]);
  });
});
