import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export type CommandKind = 'install' | 'add' | 'other';

export interface TreeSnapshot {
  files: Map<string, string>;
}

function normalize(rel: string): string {
  return rel.split(path.sep).join('/');
}

function shouldSkip(rel: string): boolean {
  const file = normalize(rel);
  return file === 'node_modules' || file.startsWith('node_modules/');
}

function signature(file: string): string {
  const stat = lstatSync(file);
  if (!stat.isFile()) return `kind:${stat.isDirectory() ? 'dir' : 'other'}`;
  const hash = createHash('sha256').update(readFileSync(file)).digest('hex');
  return `file:${stat.mode}:${stat.size}:${hash}`;
}

function walk(root: string, rel: string, out: Map<string, string>): void {
  const full = rel ? path.join(root, rel) : root;
  if (!existsSync(full)) return;
  const stat = lstatSync(full);
  if (!rel) {
    for (const entry of readdirSync(full)) walk(root, entry, out);
    return;
  }
  if (shouldSkip(rel)) return;
  const norm = normalize(rel);
  if (stat.isDirectory()) {
    for (const entry of readdirSync(full)) walk(root, path.join(rel, entry), out);
    return;
  }
  out.set(norm, signature(full));
}

export function snapshotTree(root: string): TreeSnapshot {
  const files = new Map<string, string>();
  walk(root, '', files);
  return { files };
}

export function classifyCommand(argv: string[]): CommandKind {
  if (argv.includes('add')) return 'add';
  if (argv.includes('install') || argv.includes('ci')) return 'install';
  return 'other';
}

function isExpectedProjectWrite(rel: string, kind: CommandKind): boolean {
  const file = normalize(rel);
  if (kind === 'other') return false;
  if (kind === 'add' && file === 'package.json') return true;
  if (file === 'package-lock.json' || file === 'pnpm-lock.yaml' || file === 'yarn.lock' || file === 'npm-shrinkwrap.json') return true;
  if (file === '.pnp.cjs' || file === '.pnp.loader.mjs') return true;
  if (file === '.yarn/install-state.gz' || file === '.yarn/build-state.yml') return true;
  if (file.startsWith('.yarn/cache/') || file.startsWith('.yarn/unplugged/')) return true;
  return false;
}

export function summarizeUnexpectedChanges(before: TreeSnapshot, after: TreeSnapshot, kind: CommandKind): string[] {
  const changed = new Set<string>();
  for (const [file, sig] of after.files) {
    if (before.files.get(file) !== sig) changed.add(file);
  }
  for (const file of before.files.keys()) {
    if (!after.files.has(file)) changed.add(file);
  }
  return [...changed].filter((file) => !shouldSkip(file) && !isExpectedProjectWrite(file, kind)).sort();
}
