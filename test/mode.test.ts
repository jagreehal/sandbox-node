import { describe, expect, it } from 'vitest';
import { classifyProjectMode, crossModeWarning, orientLine } from '../src/mode.js';

describe('crossModeWarning', () => {
  it('warns when a host-native tree is about to be clobbered by a contained install', () => {
    const w = crossModeWarning({ hostOs: 'darwin', hostNativeCount: () => 3, pm: 'pnpm' });
    expect(w).toBeDefined();
    expect(w).toContain('currently uses host-native node_modules');
    expect(w).toContain('Keep host-native deps: `pnpm install`');
    expect(w).toContain('remove node_modules'); // and the deliberate switch
  });

  it('stays quiet when the tree has no host-native packages (container tree or pure-JS)', () => {
    expect(crossModeWarning({ hostOs: 'darwin', hostNativeCount: () => 0, pm: 'pnpm' })).toBeUndefined();
  });

  it('stays quiet on Linux, where container and host share a platform (no mismatch to warn about)', () => {
    // Even with host-native packages present, a Linux container tree loads on a Linux host.
    expect(crossModeWarning({ hostOs: 'linux', hostNativeCount: () => 5, pm: 'pnpm' })).toBeUndefined();
  });

  it('skips the (potentially expensive) scan entirely on Linux: the count thunk is never called', () => {
    let scanned = false;
    crossModeWarning({
      hostOs: 'linux',
      hostNativeCount: () => {
        scanned = true;
        return 5;
      },
      pm: 'pnpm',
    });
    expect(scanned).toBe(false);
  });

  it('is stale-proof by construction: it reads the live count, never a persisted marker', () => {
    // A host install after a contained one brings host-native packages back, so the count rises and
    // the warning fires again. A sentinel file would have stayed and wrongly suppressed it.
    expect(crossModeWarning({ hostOs: 'win32', hostNativeCount: () => 2, pm: 'npm' })).toBeDefined();
  });

  it('names the project package manager in the warning', () => {
    expect(crossModeWarning({ hostOs: 'darwin', hostNativeCount: () => 1, pm: 'yarn' })).toContain('yarn');
    expect(crossModeWarning({ hostOs: 'darwin', hostNativeCount: () => 1, pm: 'bun' })).toContain('bun');
  });
});

describe('classifyProjectMode', () => {
  it('reports no-deps when nothing is installed (other signals irrelevant)', () => {
    expect(classifyProjectMode({ hasDeps: false, hostNative: true, foreignNative: true })).toBe('no-deps');
  });

  it('host-native wins over foreign (a host-native tree is the one a contained install would clobber)', () => {
    expect(classifyProjectMode({ hasDeps: true, hostNative: true, foreignNative: true })).toBe('host-native');
  });

  it('container-built when only foreign (Linux-native) binaries are present', () => {
    expect(classifyProjectMode({ hasDeps: true, hostNative: false, foreignNative: true })).toBe('container-built');
  });

  it('deps-without-native-signal when a tree exists but carries no platform-specific packages', () => {
    expect(classifyProjectMode({ hasDeps: true, hostNative: false, foreignNative: false })).toBe('deps-without-native-signal');
  });
});

describe('orientLine', () => {
  it('is one terse clause: pm, mode, containment', () => {
    expect(orientLine({ pm: 'pnpm', mode: 'container-built', contained: true })).toBe('pnpm · container-built deps · contained');
  });

  it('reflects each mode and the package manager', () => {
    expect(orientLine({ pm: 'npm', mode: 'no-deps', contained: true })).toBe('npm · no deps yet · contained');
    expect(orientLine({ pm: 'yarn', mode: 'host-native', contained: true })).toBe('yarn · host-native deps · contained');
    expect(orientLine({ pm: 'bun', mode: 'deps-without-native-signal', contained: true })).toBe('bun · deps installed · contained');
  });

  it('says containment off when not contained, and uses no em dash', () => {
    const line = orientLine({ pm: 'pnpm', mode: 'host-native', contained: false });
    expect(line).toBe('pnpm · host-native deps · containment off');
    expect(line).not.toContain('—');
  });
});
