import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';

await mkdir('dist-native', { recursive: true });
await build({
  entryPoints: ['src/bridge/native-host.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: 'dist-native/flowrun-native-host.js',
  banner: { js: '#!/usr/bin/env node' },
  sourcemap: false,
});
