import { describe, expect, it } from 'vitest';
import { routePassthrough, type Route } from '../src/dispatch.js';

const route = (cmd: string): Route | undefined => routePassthrough(cmd.split(' ').filter(Boolean));

describe('routePassthrough — install', () => {
  it('routes a plain install for each package manager', () => {
    expect(route('npm install')).toEqual({ model: 'install', pm: 'npm', frozen: false, args: [] });
    expect(route('npm i')).toEqual({ model: 'install', pm: 'npm', frozen: false, args: [] });
    expect(route('pnpm install')).toEqual({ model: 'install', pm: 'pnpm', frozen: false, args: [] });
    expect(route('yarn install')).toEqual({ model: 'install', pm: 'yarn', frozen: false, args: [] });
  });

  it('treats a bare `yarn` as install but bare npm/pnpm as run (they print help)', () => {
    expect(route('yarn')).toEqual({ model: 'install', pm: 'yarn', frozen: false, args: [] });
    expect(route('npm')).toEqual({ model: 'run', argv: ['npm'] });
    expect(route('pnpm')).toEqual({ model: 'run', argv: ['pnpm'] });
  });

  it('detects reproducible installs', () => {
    expect(route('npm ci')).toEqual({ model: 'install', pm: 'npm', frozen: true, args: [] });
    expect(route('pnpm install --frozen-lockfile')).toEqual({ model: 'install', pm: 'pnpm', frozen: true, args: ['--frozen-lockfile'] });
    expect(route('yarn install --immutable')).toEqual({ model: 'install', pm: 'yarn', frozen: true, args: ['--immutable'] });
  });

  it('passes install flags through', () => {
    expect(route('npm install --legacy-peer-deps')).toEqual({ model: 'install', pm: 'npm', frozen: false, args: ['--legacy-peer-deps'] });
  });
});

describe('routePassthrough — add', () => {
  it('routes explicit adds', () => {
    expect(route('pnpm add zod')).toEqual({ model: 'add', pm: 'pnpm', pkgs: ['zod'] });
    expect(route('yarn add react react-dom')).toEqual({ model: 'add', pm: 'yarn', pkgs: ['react', 'react-dom'] });
  });

  it('treats `npm install <pkg>` (and flagged variants) as an add', () => {
    expect(route('npm install lodash')).toEqual({ model: 'add', pm: 'npm', pkgs: ['lodash'] });
    expect(route('npm i -D vitest')).toEqual({ model: 'add', pm: 'npm', pkgs: ['-D', 'vitest'] });
    expect(route('pnpm add -D typescript')).toEqual({ model: 'add', pm: 'pnpm', pkgs: ['-D', 'typescript'] });
  });
});

describe('routePassthrough — run', () => {
  it('routes scripts and tools verbatim', () => {
    expect(route('npm run dev')).toEqual({ model: 'run', argv: ['npm', 'run', 'dev'] });
    expect(route('pnpm dev')).toEqual({ model: 'run', argv: ['pnpm', 'dev'] });
    expect(route('npm test')).toEqual({ model: 'run', argv: ['npm', 'test'] });
    expect(route('yarn start')).toEqual({ model: 'run', argv: ['yarn', 'start'] });
    expect(route('npx vite')).toEqual({ model: 'run', argv: ['npx', 'vite'] });
    expect(route('node server.js')).toEqual({ model: 'run', argv: ['node', 'server.js'] });
  });

  it('routes pm exec/dlx as run', () => {
    expect(route('pnpm dlx cowsay hi')).toEqual({ model: 'run', argv: ['pnpm', 'dlx', 'cowsay', 'hi'] });
    expect(route('npm exec -- tsc')).toEqual({ model: 'run', argv: ['npm', 'exec', '--', 'tsc'] });
  });
});

describe('routePassthrough — bun', () => {
  it('routes bun install/add through the install + add models', () => {
    expect(route('bun install')).toEqual({ model: 'install', pm: 'bun', frozen: false, args: [] });
    expect(route('bun i')).toEqual({ model: 'install', pm: 'bun', frozen: false, args: [] });
    expect(route('bun add zod')).toEqual({ model: 'add', pm: 'bun', pkgs: ['zod'] });
    expect(route('bun install lodash')).toEqual({ model: 'add', pm: 'bun', pkgs: ['lodash'] });
    expect(route('bun install --frozen-lockfile')).toEqual({ model: 'install', pm: 'bun', frozen: true, args: ['--frozen-lockfile'] });
  });

  it('routes bun scripts and runners verbatim (bunx is the exec runner, not the pm)', () => {
    expect(route('bun run dev')).toEqual({ model: 'run', argv: ['bun', 'run', 'dev'] });
    expect(route('bun test')).toEqual({ model: 'run', argv: ['bun', 'test'] });
    expect(route('bun x cowsay hi')).toEqual({ model: 'run', argv: ['bun', 'x', 'cowsay', 'hi'] });
    expect(route('bunx create-vite my-app')).toEqual({ model: 'run', argv: ['bunx', 'create-vite', 'my-app'] });
  });
});

describe('routePassthrough — not a pass-through', () => {
  it('returns undefined for unrecognized leaders and empty input', () => {
    expect(route('frobnicate the widgets')).toBeUndefined();
    expect(route('')).toBeUndefined();
  });
});
