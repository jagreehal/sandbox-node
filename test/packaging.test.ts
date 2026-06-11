import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Regression guard for the 0.3.0 packaging bug: the root Dockerfile did
// `COPY net-guard.sh ...` but net-guard.sh was absent from package.json "files",
// so it never shipped — and the first `sandbox npm install` on a fresh machine
// failed at image build with `"/net-guard.sh": not found`.
//
// This test asserts every Dockerfile COPY source is actually present in the
// published tarball, by reading the real `npm pack --dry-run --json` output.

const root = process.cwd();

/** Repo-relative paths npm will actually publish. */
function publishedFiles(): Set<string> {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const parsed = JSON.parse(out) as Array<{ files: Array<{ path: string }> }>;
  return new Set((parsed[0]?.files ?? []).map((f) => f.path));
}

/** COPY <src...> <dest> sources from a Dockerfile, ignoring --flags and stage refs. */
function copySources(dockerfile: string): string[] {
  const text = readFileSync(path.join(root, dockerfile), 'utf8');
  const sources: string[] = [];
  for (const line of text.split('\n')) {
    const m = /^\s*COPY\s+(.+)$/i.exec(line);
    if (!m) continue;
    const tokens = m[1]!.split(/\s+/).filter((t) => !t.startsWith('--'));
    if (tokens.some((t) => t.startsWith('--from'))) continue; // copies from another build stage, not the context
    // last token is the destination; the rest are sources
    for (const src of tokens.slice(0, -1)) sources.push(src);
  }
  return sources;
}

// The Docker build context is the directory containing each Dockerfile, so a
// COPY source resolves to <dirname(dockerfile)>/<src> relative to the repo root.
const dockerfiles = ['Dockerfile', 'proxy/Dockerfile'].filter((f) =>
  existsSync(path.join(root, f)),
);

describe('packaging: every Dockerfile COPY source is published', () => {
  const published = publishedFiles();

  for (const dockerfile of dockerfiles) {
    for (const src of copySources(dockerfile)) {
      const repoRelative = path.posix.join(path.posix.dirname(dockerfile), src);
      it(`${dockerfile} COPY ${src} → ${repoRelative} ships in the npm package`, () => {
        expect(published.has(repoRelative)).toBe(true);
      });
    }
  }
});
