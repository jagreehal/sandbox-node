import { describe, expect, it } from 'vitest';
import { classifyHost, describeBlockedHosts, renderBlockedHostLines } from '../src/hosts.js';

describe('classifyHost', () => {
  it('marks the public registries as common registry hosts', () => {
    expect(classifyHost('registry.npmjs.org')).toMatchObject({ category: 'registry', commonForInstall: true });
    expect(classifyHost('npmjs.com')).toMatchObject({ category: 'registry', commonForInstall: true });
  });

  it('recognises nodejs.org as the native-build headers host', () => {
    const c = classifyHost('nodejs.org');
    expect(c.category).toBe('native-build');
    expect(c.commonForInstall).toBe(true);
    expect(c.why).toMatch(/node-gyp/);
  });

  it('recognises common vendor binary CDNs', () => {
    expect(classifyHost('binaries.prisma.sh').category).toBe('native-build');
    expect(classifyHost('cdn.playwright.dev').category).toBe('native-build');
  });

  it('anchors the suffix match so lookalike hosts are NOT trusted', () => {
    const evil = classifyHost('npmjs.org.evil.com');
    expect(evil.category).toBe('unknown');
    expect(evil.commonForInstall).toBe(false);
  });

  it('treats an unknown host as not-common with a cautionary reason', () => {
    const c = classifyHost('exfil.example.com');
    expect(c.category).toBe('unknown');
    expect(c.commonForInstall).toBe(false);
    expect(c.why).toMatch(/unusual/);
  });

  it('normalises case, port, and trailing dot', () => {
    expect(classifyHost('REGISTRY.NPMJS.ORG:443.').host).toBe('registry.npmjs.org');
  });
});

describe('describeBlockedHosts', () => {
  it('labels the project\'s configured registry as expected', () => {
    const [c] = describeBlockedHosts(['npm.pkg.github.com'], { registryHosts: ['npm.pkg.github.com'] });
    expect(c?.category).toBe('registry');
    expect(c?.commonForInstall).toBe(true);
    expect(c?.why).toMatch(/your configured registry/);
  });

  it('falls back to classification for hosts that are not the project registry', () => {
    const [c] = describeBlockedHosts(['exfil.example.com'], { registryHosts: ['npm.pkg.github.com'] });
    expect(c?.commonForInstall).toBe(false);
  });

  it('renders a glyphed line per host', () => {
    const lines = renderBlockedHostLines(describeBlockedHosts(['nodejs.org', 'exfil.example.com']));
    expect(lines).toContain('✓ nodejs.org');
    expect(lines).toContain('⚠ exfil.example.com');
  });
});
