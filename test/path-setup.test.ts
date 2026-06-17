import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { routePassthrough } from '../src/dispatch.js';
import {
  applyBlock,
  blockState,
  detectShell,
  FETCH_RUN_VERBS,
  installPath,
  PATH_WRAPPER_VERSION,
  rcFileFor,
  removeBlock,
  renderManagedBlock,
  renderWrapperBody,
  statusPath,
  uninstallPath,
  WRAP_VERBS,
} from '../src/path-setup.js';
import type { PackageManager } from '../src/package-manager.js';

describe('detectShell', () => {
  it('reads the shell from $SHELL, falling back to bash (posix) / pwsh (win)', () => {
    expect(detectShell({ SHELL: '/usr/bin/zsh' })).toBe('zsh');
    expect(detectShell({ SHELL: '/bin/bash' })).toBe('bash');
    expect(detectShell({ SHELL: '/opt/homebrew/bin/fish' })).toBe('fish');
    expect(detectShell({}, 'win32')).toBe('pwsh');
    expect(detectShell({}, 'linux')).toBe('bash');
  });
});

describe('rcFileFor', () => {
  it('maps each shell to its rc file (pwsh is print-only)', () => {
    expect(rcFileFor('zsh', '/home/d')).toBe('/home/d/.zshrc');
    expect(rcFileFor('bash', '/home/d')).toBe('/home/d/.bashrc');
    expect(rcFileFor('fish', '/home/d')).toBe('/home/d/.config/fish/config.fish');
    expect(rcFileFor('pwsh', '/home/d')).toBeUndefined();
  });
});

describe('wrapper / dispatch consistency', () => {
  // Every verb the shell wrapper redirects MUST be an install-class (mutating) route in the
  // real router — otherwise the wrapper would sandbox something `sandbox <pm>` treats as a plain
  // host command. This fails if dispatch's verb sets and WRAP_VERBS ever drift apart.
  const MUTATING = new Set(['install', 'add', 'update', 'auditFix']);
  it('only redirects verbs the router treats as install-class', () => {
    for (const pm of Object.keys(WRAP_VERBS) as PackageManager[]) {
      for (const verb of WRAP_VERBS[pm]) {
        const route = routePassthrough([pm, verb]);
        expect(route, `${pm} ${verb}`).toBeDefined();
        expect(MUTATING.has(route!.model), `${pm} ${verb} → ${route!.model}`).toBe(true);
      }
    }
  });

  it('does NOT redirect read-only / run verbs (those stay on the host tool)', () => {
    const body = renderWrapperBody('bash');
    // The wrapper passes these straight through; they must not appear as redirected case patterns.
    expect(body).not.toContain('"npm ls"');
    expect(body).not.toContain('"npm publish"');
    expect(body).not.toContain('"npm run"');
  });

  it('covers the fetch-and-run surface dispatch knows about (dlx/exec → run model)', () => {
    // The reviewer gap: `pnpm dlx`, `yarn dlx`, `npm exec` are fetch-and-run too. The router routes
    // them to `run`; the wrapper must redirect them so the habit-guard isn't silently partial.
    for (const verb of FETCH_RUN_VERBS) {
      expect(routePassthrough(['pnpm', verb, 'some-tool'])?.model, `pnpm ${verb}`).toBe('run');
    }
    for (const shell of ['bash', 'fish', 'pwsh'] as const) {
      const body = renderWrapperBody(shell);
      for (const verb of FETCH_RUN_VERBS) expect(body, `${shell}:${verb}`).toContain(verb);
      // pnpx is wrapped as a standalone runner alongside npx/bunx.
      expect(body, `${shell}:pnpx`).toContain('pnpx');
    }
  });
});

describe('global installs bypass the sandbox (-g is host tooling)', () => {
  // The bug: `npm install -g foo` routed through the wrapper ran the install INSIDE the ephemeral
  // container, so nothing landed on the host. A global install must pass straight through.
  function runBashWrapper(line: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'sbx-g-'));
    for (const [name, marker] of [['npm', 'REAL-NPM'], ['sandbox', 'SANDBOX']] as const) {
      const f = path.join(dir, name);
      writeFileSync(f, `#!/bin/sh\necho "${marker}: $*"\n`);
      chmodSync(f, 0o755);
    }
    const script = `export PATH="${dir}:$PATH"\n${renderWrapperBody('bash')}\n${line}\n`;
    // The wrapper honours SANDBOX_OFF as an intentional whole-shell bypass. This harness
    // asserts the *routing*, so scrub it from the inherited env — otherwise running the suite
    // from a shell that has SANDBOX_OFF set (e.g. to dodge the path guard) flakes the test.
    const env = { ...process.env };
    delete env.SANDBOX_OFF;
    return execFileSync('bash', ['-c', script], { encoding: 'utf8', env });
  }

  it('routes a normal install but passes a -g install through to the real tool', () => {
    expect(runBashWrapper('npm install lodash')).toContain('SANDBOX:');
    const g = runBashWrapper('npm install -g typescript');
    expect(g).toContain('REAL-NPM: install -g typescript');
    expect(g).not.toContain('SANDBOX:');
  });

  it('also bypasses --global and --location=global', () => {
    expect(runBashWrapper('npm i --global typescript')).toContain('REAL-NPM:');
    expect(runBashWrapper('npm install --location=global typescript')).toContain('REAL-NPM:');
  });

  it('every dialect carries the global-bypass guard', () => {
    for (const shell of ['bash', 'fish', 'pwsh'] as const) {
      const body = renderWrapperBody(shell);
      expect(body, `${shell}:--global`).toContain('--global');
      expect(body, `${shell}:--location=global`).toContain('--location=global');
    }
  });
});

describe('managed block install/update/remove', () => {
  const home = () => mkdtempSync(path.join(tmpdir(), 'sbx-path-'));

  it('installs the block into a fresh rc and reports it', () => {
    const dir = home();
    const res = installPath({ shell: 'zsh', homedir: dir });
    const text = readFileSync(res.file!, 'utf8');
    expect(blockState(text)).toBe('current');
    expect(text).toContain('__sandbox_pm');
    expect(statusPath({ shell: 'zsh', homedir: dir }).messages[0]).toMatch(/installed and current/);
  });

  it('is idempotent — re-running updates in place without duplicating', () => {
    const dir = home();
    installPath({ shell: 'zsh', homedir: dir });
    const res = installPath({ shell: 'zsh', homedir: dir });
    const text = readFileSync(res.file!, 'utf8');
    expect(text.match(/__sandbox_pm\(\)/g)?.length).toBe(1);
  });

  it('preserves surrounding rc content on install and restores it on uninstall', () => {
    const dir = home();
    const file = path.join(dir, '.zshrc');
    writeFileSync(file, 'export EDITOR=vim\nalias g=git\n');
    installPath({ shell: 'zsh', homedir: dir });
    expect(readFileSync(file, 'utf8')).toContain('alias g=git');
    uninstallPath({ shell: 'zsh', homedir: dir });
    const after = readFileSync(file, 'utf8');
    expect(after).toContain('alias g=git');
    expect(after).not.toContain('__sandbox_pm');
    expect(blockState(after)).toBe('absent');
  });

  it('detects a stale (older-version) block', () => {
    const stale = renderManagedBlock('zsh').replace(`# sandbox-path-version: ${PATH_WRAPPER_VERSION}`, '# sandbox-path-version: 0');
    expect(blockState(stale)).toBe('stale');
  });

  it('print mode and pwsh return the snippet without touching disk', () => {
    const printed = installPath({ shell: 'bash', print: true });
    expect(printed.file).toBeUndefined();
    expect(printed.snippet).toContain('__sandbox_pm');
    const pwsh = installPath({ shell: 'pwsh' });
    expect(pwsh.file).toBeUndefined();
    expect(pwsh.snippet).toContain('__Sandbox-Pm');
  });
});

describe('managed block ships shell completion', () => {
  it('wires tab-completion for each real-shell dialect', () => {
    // zsh: guarded compdef (inline-safe — no bare #compdef header that only fpath files may carry)
    const zsh = renderManagedBlock('zsh');
    expect(zsh).toContain('compdef _sandbox sandbox sandbox-node');
    expect(zsh).toContain('$+functions[compdef]');
    expect(zsh).not.toContain('#compdef');
    // bash + fish: their native completion entry points
    expect(renderManagedBlock('bash')).toContain('complete -F _sandbox');
    expect(renderManagedBlock('fish')).toContain('complete -c sandbox');
  });

  it('omits completion for pwsh (no zsh/bash/fish completer applies)', () => {
    const pwsh = renderManagedBlock('pwsh');
    expect(pwsh).not.toContain('compdef');
    expect(pwsh).not.toContain('complete -c sandbox');
  });

  it('installs completion alongside the wrappers in one rc edit', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sbx-path-'));
    const res = installPath({ shell: 'bash', homedir: dir });
    const text = readFileSync(res.file!, 'utf8');
    expect(text).toContain('__sandbox_pm');
    expect(text).toContain('complete -F _sandbox');
  });
});

describe('applyBlock / removeBlock primitives', () => {
  it('appends with a clean separator and round-trips to empty', () => {
    const block = renderManagedBlock('bash');
    const applied = applyBlock('', block);
    expect(applied.endsWith('\n')).toBe(true);
    expect(removeBlock(applied).includes('__sandbox_pm')).toBe(false);
  });
});
