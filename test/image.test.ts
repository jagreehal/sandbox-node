import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SandboxConfigSchema } from '../src/config.js';
import {
  DEFAULT_BASE_IMAGE,
  customDockerfileWarnings,
  derivedDockerfile,
  extraStepsNeedRepoContext,
  hasExtraLayer,
  isCustomBuild,
  resolveBaseImage,
  resolveBuildSpec,
  specFingerprint,
} from '../src/image.js';

/** A fully-defaulted config with an optional `build` override applied. */
function configWith(build: Record<string, unknown> = {}) {
  return SandboxConfigSchema.parse({ build });
}

/** Project root used as the extra-steps build context in these specs. */
const CTX = path.resolve('/project');

describe('resolveBaseImage', () => {
  it('defaults to the bundled base', () => {
    expect(resolveBaseImage(configWith().build)).toBe(DEFAULT_BASE_IMAGE);
  });
  it('derives from nodeVersion', () => {
    expect(resolveBaseImage(configWith({ nodeVersion: '22' }).build)).toBe('node:22-bookworm-slim');
  });
  it('baseImage wins over nodeVersion', () => {
    expect(resolveBaseImage(configWith({ baseImage: 'custom:1', nodeVersion: '22' }).build)).toBe('custom:1');
  });
});

describe('resolveBuildSpec', () => {
  it('a plain config is not a custom build', () => {
    const spec = resolveBuildSpec(configWith(), 'tag:1', CTX);
    expect(spec).toMatchObject({ tag: 'tag:1', baseImage: DEFAULT_BASE_IMAGE, extraPackages: [], extraSteps: [] });
    expect(isCustomBuild(spec)).toBe(false);
    expect(hasExtraLayer(spec)).toBe(false);
  });

  it('a changed base counts as custom but needs no extra layer', () => {
    const spec = resolveBuildSpec(configWith({ nodeVersion: '20' }), 'tag:1', CTX);
    expect(isCustomBuild(spec)).toBe(true);
    expect(hasExtraLayer(spec)).toBe(false);
  });

  it('extra packages/steps require a layer', () => {
    const spec = resolveBuildSpec(configWith({ extraPackages: ['ffmpeg'], extraSteps: ['ENV X=1'] }), 'tag:1', CTX);
    expect(hasExtraLayer(spec)).toBe(true);
    expect(isCustomBuild(spec)).toBe(true);
  });

  it('carries the project root as the extra-steps build context (so COPY/ADD can reach repo files)', () => {
    const spec = resolveBuildSpec(configWith({ extraSteps: ['COPY ./cert.pem /etc/cert.pem'] }), 'tag:1', CTX);
    expect(spec.buildContext).toBe(CTX);
  });

  it('resolves customDockerfileUnsafe to an absolute path', () => {
    const spec = resolveBuildSpec(configWith({ customDockerfileUnsafe: 'docker/My.Dockerfile' }), 'tag:1', CTX);
    expect(spec.customDockerfile).toBe(path.resolve('docker/My.Dockerfile'));
    expect(isCustomBuild(spec)).toBe(true);
  });
});

describe('extraStepsNeedRepoContext', () => {
  it('is true only when a step COPY/ADDs (case-insensitive, leading whitespace ok)', () => {
    expect(extraStepsNeedRepoContext(['COPY ./a /a'])).toBe(true);
    expect(extraStepsNeedRepoContext(['  add ./a /a'])).toBe(true);
    expect(extraStepsNeedRepoContext(['RUN echo hi', 'ENV X=1'])).toBe(false);
    expect(extraStepsNeedRepoContext([])).toBe(false);
  });

  it('does not match COPY/ADD appearing mid-instruction (e.g. inside a RUN)', () => {
    expect(extraStepsNeedRepoContext(['RUN echo "COPY this"'])).toBe(false);
  });
});

describe('derivedDockerfile', () => {
  it('layers extras on top of the already-built base tag', () => {
    const spec = resolveBuildSpec(configWith({ extraPackages: ['ffmpeg', 'imagemagick'], extraSteps: ['ENV FOO=bar'] }), 'tag:1', CTX);
    const out = derivedDockerfile('tag:1-base', spec);
    expect(out.startsWith('FROM tag:1-base\n')).toBe(true);
    expect(out).toContain('ffmpeg imagemagick');
    expect(out).toContain('ENV FOO=bar');
  });
});

describe('specFingerprint', () => {
  const spec = (build: Record<string, unknown>) => resolveBuildSpec(configWith(build), 'tag:1', CTX);

  it('is stable for the same spec and ignores the tag', () => {
    expect(specFingerprint(spec({}))).toBe(specFingerprint(resolveBuildSpec(configWith(), 'other:tag', CTX)));
  });

  it('changes when the base, packages, or steps change', () => {
    const base = specFingerprint(spec({}));
    expect(specFingerprint(spec({ nodeVersion: '20' }))).not.toBe(base);
    expect(specFingerprint(spec({ extraPackages: ['ffmpeg'] }))).not.toBe(base);
    expect(specFingerprint(spec({ extraSteps: ['ENV X=1'] }))).not.toBe(base);
  });

  it('changes when the custom Dockerfile CONTENTS change (not just its path)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sbx-fp-'));
    const file = path.join(dir, 'My.Dockerfile');
    writeFileSync(file, 'FROM node:24\n');
    const before = specFingerprint(spec({ customDockerfileUnsafe: file }));
    writeFileSync(file, 'FROM node:24\nRUN echo changed\n');
    expect(specFingerprint(spec({ customDockerfileUnsafe: file }))).not.toBe(before);
  });
});

describe('customDockerfileWarnings', () => {
  it('flags every dropped security layer', () => {
    const warnings = customDockerfileWarnings('FROM node:24\nRUN echo hi\n');
    expect(warnings.some((w) => /sbx-net-guard/.test(w))).toBe(true);
    expect(warnings.some((w) => /libcap2-bin/.test(w))).toBe(true);
    expect(warnings.some((w) => /corepack/.test(w))).toBe(true);
  });

  it('stays quiet when the markers are present', () => {
    const content = 'FROM node:24\nRUN apt-get install -y libcap2-bin\nCOPY net-guard.sh /usr/local/bin/sbx-net-guard\nRUN corepack enable\n';
    expect(customDockerfileWarnings(content)).toEqual([]);
  });
});
