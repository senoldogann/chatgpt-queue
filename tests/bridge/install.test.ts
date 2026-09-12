import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { doctorNativeBridge, installNativeBridge } from '../../src/bridge/install';

const extensionId = 'abcdefghijklmnopabcdefghijklmnop';

describe('native bridge installer', () => {
  it('installs a locked-down host, launcher, config, and Chrome manifest', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'flowrun-home-'));
    const source = join(homeDir, 'source-host.js');
    await import('node:fs/promises').then(({ writeFile }) => writeFile(source, 'console.log("host")'));

    const installed = await installNativeBridge({ extensionId, homeDir, nodePath: '/opt/homebrew/bin/node', hostSourcePath: source });
    const manifest = JSON.parse(await readFile(installed.manifestPath, 'utf8')) as any;
    const config = JSON.parse(await readFile(installed.configPath, 'utf8')) as any;

    expect(manifest.name).toBe('com.senoldogan.flowrun');
    expect(manifest.allowed_origins).toEqual([`chrome-extension://${extensionId}/`]);
    expect(manifest.path).toBe(installed.launcherPath);
    expect(config.secret).toMatch(/^[a-f0-9]{64}$/);
    expect((await stat(installed.launcherPath)).mode & 0o111).not.toBe(0);
  });

  it('doctor reports healthy and detects missing artifacts', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'flowrun-home-'));
    const source = join(homeDir, 'source-host.js');
    const fs = await import('node:fs/promises');
    await fs.writeFile(source, 'console.log("host")');
    await installNativeBridge({ extensionId, homeDir, nodePath: process.execPath, hostSourcePath: source });

    expect((await doctorNativeBridge({ homeDir, extensionId })).ok).toBe(true);
    await fs.rm(join(homeDir, '.flowrun', 'bridge', 'bin', 'flowrun-native-host.js'));
    const broken = await doctorNativeBridge({ homeDir, extensionId });
    expect(broken.ok).toBe(false);
    expect(broken.checks.some((check) => !check.ok && check.name === 'native-host')).toBe(true);
  });
});
