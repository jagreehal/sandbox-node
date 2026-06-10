import { existsSync } from 'node:fs';
import path from 'node:path';
import { createBackend } from './backend.js';
import { readConfig } from './config.js';
import { capture, quiet } from './exec.js';
import { mergeDetectedEgress, printInitSummary, printUnwiredHookWarning, writeAgentArtifacts, writeSandboxConfig } from './init.js';
import { PRESET_NAMES, presetConfig, type PresetName } from './presets.js';

export interface SetupOptions {
  preset?: string;
  force?: boolean;
  backend: 'docker' | 'podman';
  image?: string;
}

function backendInstallHint(backend: 'docker' | 'podman'): string {
  if (process.platform === 'darwin') return backend === 'docker' ? 'brew install --cask docker' : 'brew install podman';
  return backend === 'docker' ? 'install Docker and ensure `docker` is on PATH' : 'install Podman and ensure `podman` is on PATH';
}

function backendStartHint(backend: 'docker' | 'podman'): string {
  if (process.platform === 'darwin') return backend === 'docker' ? 'open -a Docker' : 'podman machine start';
  return backend === 'docker' ? 'sudo systemctl start docker' : 'start the Podman service or machine for this host';
}

export async function runSetup(cwd: string, opts: SetupOptions): Promise<number> {
  const configPath = path.join(cwd, 'sandbox.config.json');
  const preset = (opts.preset ?? 'balanced') as PresetName;
  if (!PRESET_NAMES.includes(preset)) {
    console.error(`sandbox: unknown preset '${opts.preset}' (use: ${PRESET_NAMES.join(' | ')})`);
    return 1;
  }

  let config = readConfig(cwd);
  if (!existsSync(configPath) || opts.force) {
    const fresh = presetConfig(preset);
    const addedHosts = mergeDetectedEgress(cwd, fresh);
    const configFile = writeSandboxConfig(cwd, fresh);
    const agent = preset === 'agent' ? writeAgentArtifacts(cwd) : undefined;
    printInitSummary(preset, configFile, agent, addedHosts);
    config = readConfig(cwd);
  } else {
    console.log(`sandbox: using existing ${path.basename(configPath)}`);
    if (preset === 'agent') {
      const { agentFile, hook } = writeAgentArtifacts(cwd);
      console.log(`sandbox: wrote ${path.relative(cwd, agentFile)} (paste into your agent's project instructions)`);
      console.log(`sandbox: wrote ${path.relative(cwd, hook.script)}`);
      if (hook.wired) {
        console.log(`sandbox: wired ${path.relative(cwd, hook.settings)} — a PreToolUse hook blocks bare npm/pnpm/yarn/bun/npx, and .env/secrets are denied to the agent`);
      } else {
        printUnwiredHookWarning(path.relative(cwd, hook.settings));
      }
    }
  }

  const version = await capture(opts.backend, ['--version']);
  if (version.code !== 0) {
    console.log(`sandbox: backend check failed: ${version.stderr.trim() || version.stdout.trim() || `${opts.backend} not found`}`);
    console.log(`sandbox: install it with: ${backendInstallHint(opts.backend)}`);
    return 1;
  }
  console.log(`sandbox: backend ready: ${(version.stdout.trim() || version.stderr.trim()).trim()}`);

  const info = await capture(opts.backend, ['info']);
  if (info.code !== 0) {
    console.log(`sandbox: backend daemon is not reachable: ${info.stderr.trim() || info.stdout.trim() || `${opts.backend} info failed`}`);
    console.log(`sandbox: start it with: ${backendStartHint(opts.backend)}`);
    return 1;
  }

  const image = opts.image ?? config.image;
  if ((await quiet(opts.backend, ['image', 'inspect', image])) !== 0) {
    console.log(`sandbox: building ${image} and the egress proxy image`);
    const code = await createBackend(opts.backend).buildImages(image);
    if (code !== 0) return code;
    console.log('sandbox: images are ready');
  } else {
    console.log(`sandbox: image ready: ${image}`);
  }

  const secrets = config.grants['ssh-agent'] || config.grants.claude !== 'none' || config.grants.paths.length || config.grants.env.length || config.grants.envFiles.length
    ? 'custom grants configured'
    : 'blocked (~/.ssh, ~/.npmrc, ~/.aws, home)';
  console.log('');
  console.log(`sandbox: ${preset} preset`);
  console.log(`network: ${config.run.network}${config.run.devPorts ? ' for dev server' : ''}`);
  if (config.run.devPorts) console.log('ports: common dev ports -> localhost');
  console.log(`secrets: ${secrets}`);
  console.log('');
  console.log('Next:');
  for (const command of preset === 'vibe' || preset === 'agent' || preset === 'trusted' ? ['sandbox npm install', 'sandbox npm run dev'] : ['sandbox npm install', 'sandbox npm test']) {
    console.log(`  ${command}`);
  }
  return 0;
}
