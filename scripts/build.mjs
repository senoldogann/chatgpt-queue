import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const outdir = resolve(root, 'dist');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await build({
  entryPoints: {
    background: resolve(root, 'src/background.ts'),
    content: resolve(root, 'src/content.ts'),
  },
  outdir,
  bundle: true,
  format: 'esm',
  target: 'chrome120',
  sourcemap: false,
  minify: false,
  legalComments: 'none',
});

await cp(resolve(root, 'manifest.json'), resolve(outdir, 'manifest.json'));
await cp(resolve(root, 'icon128.png'), resolve(outdir, 'icon128.png'));
