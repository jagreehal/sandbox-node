import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { completionScript, isCompletionShell } from './completion.js';
import type { PackageManager } from './package-manager.js';

/**
 * "Put sandbox in front of npm" as a standing default, not a thing you remember to type. This
 * installs shell *functions* (not a $PATH change, despite the command name) that route the
 * supply-chain mutation commands — install / add / ci / update / upgrade, `audit fix`, and the
 * `npx`/`bunx` runners — through `sandbox`, while letting read-only, build, run, and publish
 * commands hit the real tool untouched. It's the human-shell equivalent of the `--agent`
 * PreToolUse hook: a boundary set once beats remembering on every command.
 *
 * Deliberately narrow and escapable. It wraps the package-manager FRONT-ENDS, never `node`
 * itself (running host Node against Linux-built modules is a separate, explicit choice). Any
 * single call bypasses with `command npm …`; a whole shell bypasses with `export SANDBOX_OFF=1`;
 * and the managed block is a clearly-delimited, reversible region you can read in your rc file.
 */

export type Shell = 'zsh' | 'bash' | 'fish' | 'pwsh';
export const SHELLS: readonly Shell[] = ['zsh', 'bash', 'fish', 'pwsh'];

/** Bump when the managed block changes, so `sandbox path status` can flag a stale installed block. */
export const PATH_WRAPPER_VERSION = 3;

const MARKER_BEGIN = '# >>> sandbox path (managed block — edit via `sandbox path`, not by hand) >>>';
const MARKER_END = '# <<< sandbox path <<<';
const VERSION_LINE = `# sandbox-path-version: ${PATH_WRAPPER_VERSION}`;

/**
 * Per-manager verbs the wrapper redirects to `sandbox`. This is the supply-chain mutation surface
 * (install-class) — kept in lockstep with `routePassthrough` by a unit test, so adding an install
 * verb to the router fails the test until it's mirrored here. `audit fix` is handled separately
 * (the verb is `audit`, the fix is the next token), and bare `yarn` (= `yarn install`) too.
 */
export const WRAP_VERBS: Record<PackageManager, readonly string[]> = {
  npm: ['install', 'i', 'ci', 'add', 'update', 'up', 'upgrade', 'uninstall', 'remove', 'rm', 'un', 'dedupe', 'ddp'],
  pnpm: ['install', 'i', 'add', 'update', 'up', 'upgrade', 'remove', 'rm', 'uninstall', 'un', 'dedupe'],
  yarn: ['install', 'add', 'up', 'upgrade', 'remove', 'dedupe'],
  bun: ['install', 'i', 'add', 'update', 'remove', 'rm'],
};

/**
 * Fetch-and-run verbs — `npm exec`, `pnpm dlx`/`pnpm exec`, `yarn dlx`/`yarn exec`. They download
 * (or run) a package the same way `npx`/`bunx`/`pnpx` do, so the wrapper redirects them too: a
 * "download then run" command is exactly the supply-chain surface a habit-guard must cover. These
 * route to `sandbox`'s `run` model (not install-class), so they're tracked separately from
 * {@link WRAP_VERBS}.
 */
export const FETCH_RUN_VERBS: readonly string[] = ['dlx', 'exec'];

/** Standalone fetch-and-run runners that are their own command (not a `<pm> <verb>` pair). */
export const RUNNER_COMMANDS: readonly string[] = ['npx', 'bunx', 'pnpx'];

export function detectShell(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Shell {
  const s = (env.SHELL ?? '').toLowerCase();
  if (s.includes('zsh')) return 'zsh';
  if (s.includes('fish')) return 'fish';
  if (s.includes('bash')) return 'bash';
  if (platform === 'win32') return 'pwsh';
  return 'bash';
}

/** Which dialect a shell uses for the wrapper body. zsh and bash share POSIX syntax. */
function dialect(shell: Shell): 'posix' | 'fish' | 'pwsh' {
  if (shell === 'fish') return 'fish';
  if (shell === 'pwsh') return 'pwsh';
  return 'posix';
}

/**
 * The rc file a managed block is written to. Returns `undefined` for PowerShell: its `$PROFILE`
 * path varies by host/version and isn't reliably resolvable from Node, so pwsh is print-and-paste.
 */
export function rcFileFor(shell: Shell, homedir: string = os.homedir()): string | undefined {
  switch (shell) {
    case 'zsh':
      return path.join(homedir, '.zshrc');
    case 'bash':
      return path.join(homedir, '.bashrc');
    case 'fish':
      return path.join(homedir, '.config', 'fish', 'config.fish');
    case 'pwsh':
      return undefined;
  }
}

// NOTE: shell bodies are built from arrays of plain strings (joined with \n), NOT template
// literals — shell parameter expansions like ${SANDBOX_OFF:-} would otherwise be parsed as JS
// interpolation. Each line picks the JS quote style that avoids escaping its shell quotes.

function posixWrapCases(): string {
  const cases: string[] = [];
  for (const pm of Object.keys(WRAP_VERBS) as PackageManager[]) {
    for (const verb of WRAP_VERBS[pm]) cases.push(`"${pm} ${verb}"`);
  }
  return cases.join('|'); // POSIX `case` patterns are `|`-separated.
}

function posixBody(): string {
  return [
    '__sandbox_go() {',
    "  printf 'sandbox: %s%s \\342\\206\\222 sandboxed (command %s or SANDBOX_OFF=1 to bypass)\\n' \"$1\" \"${2:+ $2}\" \"$1\" >&2",
    '  sandbox "$@"',
    '}',
    '__sandbox_pm() {',
    '  local pm=$1; shift',
    '  if [ -n "${SANDBOX_OFF:-}" ] || ! command -v sandbox >/dev/null 2>&1; then command "$pm" "$@"; return; fi',
    '  # Global installs are host tooling — never sandbox them (a -g install in an ephemeral container does nothing on the host).',
    '  local a; for a in "$@"; do case "$a" in -g|--global|--location=global) command "$pm" "$@"; return ;; esac; done',
    '  local verb=${1:-}',
    '  if [ "$pm" = yarn ] && [ -z "$verb" ]; then __sandbox_go yarn; return; fi',
    '  case "$pm $verb" in',
    `    ${posixWrapCases()}) __sandbox_go "$pm" "$@"; return ;;`,
    '  esac',
    `  case "$verb" in ${FETCH_RUN_VERBS.join('|')}) __sandbox_go "$pm" "$@"; return ;; esac`,
    '  if [ "$verb" = audit ]; then',
    '    case "${2:-}" in fix|--fix|--fix=*) __sandbox_go "$pm" "$@"; return ;; esac',
    '  fi',
    '  command "$pm" "$@"',
    '}',
    '__sandbox_run() {',
    '  if [ -n "${SANDBOX_OFF:-}" ] || ! command -v sandbox >/dev/null 2>&1; then command "$@"; else __sandbox_go "$@"; fi',
    '}',
    'npm()  { __sandbox_pm npm  "$@"; }',
    'pnpm() { __sandbox_pm pnpm "$@"; }',
    'yarn() { __sandbox_pm yarn "$@"; }',
    'bun()  { __sandbox_pm bun  "$@"; }',
    'npx()  { __sandbox_run npx  "$@"; }',
    'bunx() { __sandbox_run bunx "$@"; }',
    'pnpx() { __sandbox_run pnpx "$@"; }',
  ].join('\n');
}

function fishList(pm: PackageManager): string {
  return WRAP_VERBS[pm].join(' ');
}

function fishBody(): string {
  return [
    'function __sandbox_go',
    '    echo "sandbox: $argv -> sandboxed (command $argv[1] or SANDBOX_OFF=1 to bypass)" >&2',
    '    sandbox $argv',
    'end',
    'function __sandbox_run',
    '    if set -q SANDBOX_OFF; or not command -v sandbox >/dev/null 2>&1',
    '        command $argv',
    '    else',
    '        __sandbox_go $argv',
    '    end',
    'end',
    'function __sandbox_pm',
    '    set -l pm $argv[1]',
    '    set -e argv[1]',
    '    if set -q SANDBOX_OFF; or not command -v sandbox >/dev/null 2>&1',
    '        command $pm $argv; return',
    '    end',
    '    # Global installs are host tooling — never sandbox them.',
    '    for __a in $argv',
    '        switch $__a; case -g --global --location=global; command $pm $argv; return; end',
    '    end',
    '    set -l verb ""',
    '    if test (count $argv) -ge 1; set verb $argv[1]; end',
    '    if test "$pm" = yarn; and test -z "$verb"; __sandbox_go yarn; return; end',
    '    set -l verbs',
    '    switch $pm',
    `        case npm; set verbs ${fishList('npm')}`,
    `        case pnpm; set verbs ${fishList('pnpm')}`,
    `        case yarn; set verbs ${fishList('yarn')}`,
    `        case bun; set verbs ${fishList('bun')}`,
    '    end',
    '    if contains -- $verb $verbs; __sandbox_go $pm $argv; return; end',
    `    if contains -- $verb ${FETCH_RUN_VERBS.join(' ')}; __sandbox_go $pm $argv; return; end`,
    '    if test "$verb" = audit; and test (count $argv) -ge 2',
    "        switch $argv[2]; case fix --fix '--fix=*'; __sandbox_go $pm $argv; return; end",
    '    end',
    '    command $pm $argv',
    'end',
    'function npm; __sandbox_pm npm $argv; end',
    'function pnpm; __sandbox_pm pnpm $argv; end',
    'function yarn; __sandbox_pm yarn $argv; end',
    'function bun; __sandbox_pm bun $argv; end',
    'function npx; __sandbox_run npx $argv; end',
    'function bunx; __sandbox_run bunx $argv; end',
    'function pnpx; __sandbox_run pnpx $argv; end',
  ].join('\n');
}

function pwshList(pm: PackageManager): string {
  return WRAP_VERBS[pm].map((v) => `'${v}'`).join(',');
}

function pwshBody(): string {
  return [
    '$script:SandboxWrapVerbs = @{',
    `  npm  = @(${pwshList('npm')})`,
    `  pnpm = @(${pwshList('pnpm')})`,
    `  yarn = @(${pwshList('yarn')})`,
    `  bun  = @(${pwshList('bun')})`,
    '}',
    'function __Sandbox-Real($Name) {',
    '  Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1',
    '}',
    'function __Sandbox-Pm {',
    '  param([string]$Pm, [Parameter(ValueFromRemainingArguments=$true)]$Rest)',
    '  $real = __Sandbox-Real $Pm',
    '  if ($env:SANDBOX_OFF -or -not (Get-Command sandbox -ErrorAction SilentlyContinue)) { if ($real) { & $real @Rest }; return }',
    "  # Global installs are host tooling — never sandbox them.",
    "  if ($Rest | Where-Object { $_ -eq '-g' -or $_ -eq '--global' -or $_ -eq '--location=global' }) { if ($real) { & $real @Rest }; return }",
    "  $verb = if ($Rest.Count -ge 1) { [string]$Rest[0] } else { '' }",
    '  $go = $false',
    "  if ($Pm -eq 'yarn' -and $Rest.Count -eq 0) { $go = $true }",
    '  elseif ($script:SandboxWrapVerbs[$Pm] -contains $verb) { $go = $true }',
    `  elseif (@(${FETCH_RUN_VERBS.map((v) => `'${v}'`).join(',')}) -contains $verb) { $go = $true }`,
    "  elseif ($verb -eq 'audit' -and $Rest.Count -ge 2 -and ($Rest[1] -eq 'fix' -or $Rest[1] -eq '--fix' -or $Rest[1] -like '--fix=*')) { $go = $true }",
    '  if ($go) {',
    '    Write-Host "sandbox: $Pm $verb -> sandboxed (command $Pm or SANDBOX_OFF=1 to bypass)" -ForegroundColor DarkGray',
    '    sandbox $Pm @Rest',
    '  } elseif ($real) { & $real @Rest }',
    '}',
    'function __Sandbox-Run {',
    '  param([string]$Name, [Parameter(ValueFromRemainingArguments=$true)]$Rest)',
    '  $real = __Sandbox-Real $Name',
    '  if ($env:SANDBOX_OFF -or -not (Get-Command sandbox -ErrorAction SilentlyContinue)) { if ($real) { & $real @Rest }; return }',
    '  sandbox $Name @Rest',
    '}',
    'function npm  { __Sandbox-Pm npm  @args }',
    'function pnpm { __Sandbox-Pm pnpm @args }',
    'function yarn { __Sandbox-Pm yarn @args }',
    'function bun  { __Sandbox-Pm bun  @args }',
    'function npx  { __Sandbox-Run npx  @args }',
    'function bunx { __Sandbox-Run bunx @args }',
    'function pnpx { __Sandbox-Run pnpx @args }',
  ].join('\n');
}

/** Render the wrapper function body for a shell (no markers). Pure — same shell ⇒ same text. */
export function renderWrapperBody(shell: Shell): string {
  switch (dialect(shell)) {
    case 'posix':
      return posixBody();
    case 'fish':
      return fishBody();
    case 'pwsh':
      return pwshBody();
  }
}

const HEADER = [
  '# Routes install/add/ci/update/upgrade, `audit fix`, and the fetch-and-run commands',
  '# (npx, bunx, pnpx, `<pm> dlx`, `<pm> exec`) through `sandbox`, so a bare `npm install` or',
  '# `pnpm dlx <tool>` never runs un-sandboxed by habit. Read-only/build/run/publish commands pass',
  '# straight through. Bypass once: `command npm …`. Bypass a shell: `export SANDBOX_OFF=1`.',
].join('\n');

/**
 * The inline (rc-sourced) completion for a shell, or `undefined` when none applies — pwsh uses a
 * different mechanism and isn't generated. Folded into the managed block so `sandbox path install`
 * wires both the wrappers AND tab-completion in a single, reversible rc edit.
 */
function completionSection(shell: Shell): string | undefined {
  if (!isCompletionShell(shell)) return undefined;
  return ['# tab-completion for sandbox commands, globals, and --preset/--backend/--risk', completionScript(shell, { inline: true }).trimEnd()].join('\n');
}

/** The full managed block (markers + version + header + wrapper + completion) for a shell. */
export function renderManagedBlock(shell: Shell): string {
  const parts = [MARKER_BEGIN, VERSION_LINE, HEADER, renderWrapperBody(shell)];
  const completion = completionSection(shell);
  if (completion) parts.push(completion);
  parts.push(MARKER_END);
  return parts.join('\n');
}

export type BlockState = 'absent' | 'current' | 'stale';

const BLOCK_RE = new RegExp(`${escapeRe(MARKER_BEGIN)}[\\s\\S]*?${escapeRe(MARKER_END)}\\n?`, 'm');

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whether an rc's text has our block, and if so whether it's the current version. */
export function blockState(text: string): BlockState {
  const m = BLOCK_RE.exec(text);
  if (!m) return 'absent';
  return m[0].includes(VERSION_LINE) ? 'current' : 'stale';
}

/** Insert or replace the managed block. Idempotent: re-running updates in place, never duplicates. */
export function applyBlock(text: string, block: string): string {
  if (BLOCK_RE.test(text)) return text.replace(BLOCK_RE, `${block}\n`);
  const sep = text.length === 0 || text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
  return `${text}${sep}${block}\n`;
}

/** Remove the managed block (and a trailing blank line it leaves). Returns text unchanged if absent. */
export function removeBlock(text: string): string {
  return text.replace(BLOCK_RE, '').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
}

export interface PathActionResult {
  shell: Shell;
  /** The rc file acted on, or `undefined` for pwsh (print-only). */
  file?: string;
  /** Human-readable outcome lines to print. */
  messages: string[];
  /** When set, the snippet to show the user (print mode, or pwsh). */
  snippet?: string;
}

function reloadHint(shell: Shell, file: string): string {
  if (shell === 'fish') return `source ${file}`;
  return `source ${file}   # or open a new terminal`;
}

/** `sandbox path install` — write/update the managed block (or, with print, just show it). */
export function installPath(opts: { shell: Shell; homedir?: string; print?: boolean }): PathActionResult {
  const { shell } = opts;
  const block = renderManagedBlock(shell);
  if (opts.print || shell === 'pwsh') {
    const where = shell === 'pwsh' ? 'add this to your PowerShell $PROFILE (run `notepad $PROFILE`)' : 'add this to your shell rc file';
    return { shell, messages: [`# ${where}:`], snippet: block };
  }
  const file = rcFileFor(shell, opts.homedir)!;
  mkdirSync(path.dirname(file), { recursive: true });
  const before = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const state = blockState(before);
  writeFileSync(file, applyBlock(before, block));
  const verb = state === 'absent' ? 'installed' : 'updated';
  return {
    shell,
    file,
    messages: [
      `sandbox: ${verb} the shell wrappers + tab-completion in ${file}`,
      `sandbox: npm/pnpm/yarn/bun install + npx/bunx now route through sandbox in new ${shell} shells`,
      `sandbox: \`sandbox <tab>\` now completes commands, globals, and --preset/--backend/--risk`,
      `sandbox: reload now with: ${reloadHint(shell, file)}`,
      'sandbox: bypass once with `command npm …`, or a whole shell with `export SANDBOX_OFF=1`',
    ],
  };
}

/** `sandbox path uninstall` — strip the managed block. */
export function uninstallPath(opts: { shell: Shell; homedir?: string }): PathActionResult {
  const { shell } = opts;
  if (shell === 'pwsh') return { shell, messages: ['sandbox: remove the sandbox block from your PowerShell $PROFILE by hand (open with `notepad $PROFILE`).'] };
  const file = rcFileFor(shell, opts.homedir)!;
  if (!existsSync(file)) return { shell, file, messages: [`sandbox: nothing to remove — ${file} does not exist`] };
  const before = readFileSync(file, 'utf8');
  if (blockState(before) === 'absent') return { shell, file, messages: [`sandbox: no sandbox wrappers found in ${file}`] };
  writeFileSync(file, removeBlock(before));
  return { shell, file, messages: [`sandbox: removed the shell wrappers from ${file}`, `sandbox: reload with: ${reloadHint(shell, file)}`] };
}

/** `sandbox path status` — report whether the block is present and current. */
export function statusPath(opts: { shell: Shell; homedir?: string }): PathActionResult {
  const { shell } = opts;
  if (shell === 'pwsh') return { shell, messages: ['sandbox: PowerShell is print-only — run `sandbox path print --shell pwsh` and check your $PROFILE.'] };
  const file = rcFileFor(shell, opts.homedir)!;
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const state = blockState(text);
  const line = {
    absent: `sandbox: not installed in ${file} — run \`sandbox path install\``,
    current: `sandbox: installed and current in ${file}`,
    stale: `sandbox: installed but OUT OF DATE in ${file} — re-run \`sandbox path install\` to refresh`,
  }[state];
  return { shell, file, messages: [line] };
}
