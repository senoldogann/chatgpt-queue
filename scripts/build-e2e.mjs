import { build } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const outdir = resolve(root, 'dist-e2e');

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
  define: { __FLOWRUN_E2E__: 'true' },
});

const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['http://127.0.0.1/*'];
manifest.content_scripts = manifest.content_scripts.map((entry) => ({
  ...entry,
  matches: ['http://127.0.0.1/*'],
}));

await writeFile(resolve(outdir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
await cp(resolve(root, 'icon128.png'), resolve(outdir, 'icon128.png'));
