import { chmod, copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { NATIVE_HOST_NAME } from './protocol';
const EXTENSION_ID = /^[a-p]{32}$/;

export interface InstallNativeBridgeOptions {
  extensionId: string;
  homeDir: string;
  nodePath: string;
  hostSourcePath: string;
}

export interface InstalledBridgePaths {
  bridgeRoot: string;
  hostPath: string;
  launcherPath: string;
  configPath: string;
  manifestPath: string;
}

export interface BridgeDoctorCheck { name: string; ok: boolean; detail?: string }
export interface BridgeDoctorResult { ok: boolean; checks: BridgeDoctorCheck[] }

export const bridgePaths = (homeDir: string): InstalledBridgePaths => {
  const bridgeRoot = join(homeDir, '.flowrun', 'bridge');
  const bin = join(bridgeRoot, 'bin');
  return {
    bridgeRoot,
    hostPath: join(bin, 'flowrun-native-host.js'),
    launcherPath: join(bin, 'flowrun-native-host'),
    configPath: join(bridgeRoot, 'config.json'),
    manifestPath: join(homeDir, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts', `${NATIVE_HOST_NAME}.json`),
  };
};

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;

export async function installNativeBridge(options: InstallNativeBridgeOptions): Promise<InstalledBridgePaths> {
  if (!EXTENSION_ID.test(options.extensionId)) throw new Error('bridge.invalid-extension-id');
  const paths = bridgePaths(options.homeDir);
  await mkdir(join(paths.bridgeRoot, 'bin'), { recursive: true, mode: 0o700 });
  await mkdir(join(paths.bridgeRoot, 'inbox'), { recursive: true, mode: 0o700 });
  await mkdir(join(paths.bridgeRoot, 'events'), { recursive: true, mode: 0o700 });
  await mkdir(join(paths.bridgeRoot, 'results'), { recursive: true, mode: 0o700 });
  await mkdir(join(options.homeDir, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts'), { recursive: true, mode: 0o700 });

  await copyFile(options.hostSourcePath, paths.hostPath);
  await chmod(paths.hostPath, 0o600);

  const launcher = `#!/bin/sh\nexec ${shellQuote(options.nodePath)} ${shellQuote(paths.hostPath)}\n`;
  await writeFile(paths.launcherPath, launcher, { encoding: 'utf8', mode: 0o700 });
  await chmod(paths.launcherPath, 0o700);

  const config = {
    version: 1,
    secret: randomBytes(32).toString('hex'),
    bridgeRoot: paths.bridgeRoot,
    extensionId: options.extensionId,
  };
  await writeFile(paths.configPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(paths.configPath, 0o600);

  const manifest = {
    name: NATIVE_HOST_NAME,
    description: 'FlowRun local CLI bridge',
    path: paths.launcherPath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${options.extensionId}/`],
  };
  await writeFile(paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return paths;
}

const exists = async (path: string): Promise<boolean> => {
  try { await stat(path); return true; } catch { return false; }
};

export async function doctorNativeBridge(options: { homeDir: string; extensionId?: string }): Promise<BridgeDoctorResult> {
  const paths = bridgePaths(options.homeDir);
  const checks: BridgeDoctorCheck[] = [];
  checks.push({ name: 'native-host', ok: await exists(paths.hostPath), detail: paths.hostPath });
  checks.push({ name: 'launcher', ok: await exists(paths.launcherPath), detail: paths.launcherPath });

  let config: any;
  try {
    config = JSON.parse(await readFile(paths.configPath, 'utf8'));
    checks.push({ name: 'config', ok: config?.version === 1 && typeof config?.secret === 'string' && /^[a-f0-9]{64}$/.test(config.secret), detail: paths.configPath });
  } catch {
    checks.push({ name: 'config', ok: false, detail: paths.configPath });
  }

  try {
    const manifest = JSON.parse(await readFile(paths.manifestPath, 'utf8')) as any;
    const expectedOrigin = options.extensionId ? `chrome-extension://${options.extensionId}/` : undefined;
    const ok = manifest?.name === NATIVE_HOST_NAME
      && manifest?.path === paths.launcherPath
      && Array.isArray(manifest?.allowed_origins)
      && (expectedOrigin === undefined || (manifest.allowed_origins.length === 1 && manifest.allowed_origins[0] === expectedOrigin));
    checks.push({ name: 'manifest', ok, detail: paths.manifestPath });
  } catch {
    checks.push({ name: 'manifest', ok: false, detail: paths.manifestPath });
  }

  return { ok: checks.every((check) => check.ok), checks };
}
