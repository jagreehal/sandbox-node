import type { PackageManager } from './package-manager.js';

/**
 * The transparent pass-through surface: `sandbox <command…>` where `<command>` is a
 * package manager or runner the user already knows. We translate it to one of the
 * three containment models — install / add / run — so the user never learns our
 * command vocabulary; they put `sandbox` in front of what they'd type anyway.
 *
 * `install`/`add` carry the explicitly-named `pm` so `sandbox pnpm add zod` honours
 * pnpm even if the lockfile probe would have guessed otherwise; `run` carries the
 * literal argv so it executes verbatim.
 */
export type Route =
  | { model: 'install'; pm: PackageManager; frozen: boolean; args: string[] }
  | { model: 'add'; pm: PackageManager; pkgs: string[] }
  | { model: 'run'; argv: string[] };

/** Package managers we route by verb (install/add/frozen) rather than running raw. */
const PM_LEADERS: Record<string, PackageManager> = { npm: 'npm', pnpm: 'pnpm', yarn: 'yarn', bun: 'bun' };

/** Other leaders that are always a `run` (dev servers, one-off tools, scripts). `bunx` is bun's
 *  fetch-and-run runner (≈ `npx`); the `bun` package-manager verbs are routed above. */
const RUN_LEADERS = new Set(['npx', 'pnpx', 'pnpm-exec', 'yarn-dlx', 'bunx', 'node', 'tsx', 'deno', 'vite', 'next', 'astro']);

const FROZEN_FLAGS = new Set(['--frozen-lockfile', '--immutable']);

/** A positional (non-flag) token after the verb means packages were named → it's an add. */
function hasPositional(args: string[]): boolean {
  return args.some((a) => a.length > 0 && !a.startsWith('-'));
}

function routePm(pm: PackageManager, rest: string[]): Route {
  const verb = rest[0];
  const after = rest.slice(1);

  // Bare `yarn` is `yarn install`; bare `npm`/`pnpm` just print help → run them.
  if (verb === undefined) return pm === 'yarn' ? { model: 'install', pm, frozen: false, args: [] } : { model: 'run', argv: [pm] };

  if (verb === 'add') return { model: 'add', pm, pkgs: after };
  if (pm === 'npm' && verb === 'ci') return { model: 'install', pm, frozen: true, args: after };

  if (verb === 'install' || verb === 'i') {
    // `npm install lodash`, `pnpm i -D zod` → adding deps (writes the manifest).
    if (hasPositional(after)) return { model: 'add', pm, pkgs: after };
    return { model: 'install', pm, frozen: after.some((a) => FROZEN_FLAGS.has(a)), args: after };
  }

  // run/test/dev/start/exec/dlx/… → run the command exactly as typed.
  return { model: 'run', argv: [pm, ...rest] };
}

/**
 * Classify a pass-through command. Returns `undefined` when the leading token isn't a
 * recognized package manager or runner — the caller then treats it as an unknown
 * sandbox subcommand.
 */
export function routePassthrough(argv: string[]): Route | undefined {
  const [leader, ...rest] = argv;
  if (leader === undefined) return undefined;
  if (leader in PM_LEADERS) return routePm(PM_LEADERS[leader]!, rest);
  if (RUN_LEADERS.has(leader)) return { model: 'run', argv };
  return undefined;
}
