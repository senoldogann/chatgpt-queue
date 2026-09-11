import { build } from 'esbuild';
import { chmod, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const outdir = resolve(root, 'dist-cli');
const outfile = resolve(outdir, 'flowrun.js');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await build({
  entryPoints: [resolve(root, 'src/cli/flowrun.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: false,
  minify: false,
  legalComments: 'none',
  banner: { js: '#!/usr/bin/env node' },
});

await chmod(outfile, 0o755);
