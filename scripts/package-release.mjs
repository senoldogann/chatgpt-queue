#!/usr/bin/env node
// Packages the already-built production extension into the release assets:
//   release/chatgpt-queue-<tag>.zip
//   release/chatgpt-queue-<tag>.zip.sha256
// The same script runs locally and inside the Release workflow, so a release
// asset is always reproducible from a verified build.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { validateRelease } from './lib/version.mjs';

const root = resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);

function option(name, fallback) {
  const index = argv.indexOf(name);
  return index === -1 ? fallback : argv[index + 1];
}

function fail(message, details = []) {
  console.error(`package-release: FAILED — ${message}`);
  for (const detail of details) console.error(`- ${detail}`);
  process.exit(1);
}

const tag = option('--tag', process.env.RELEASE_TAG ?? '');
const distDir = resolve(root, option('--dist', 'dist'));
const outDir = resolve(root, option('--out', 'release'));
// Fixed timestamp keeps the archive byte-identical for identical builds.
const FIXED_TIME = new Date('2020-01-01T00:00:00Z');

if (!tag) {
  fail('missing --tag (for example: npm run package:release -- --tag v0.1.0-rc.4)');
}

const [packageJson, manifest] = await Promise.all(
  ['package.json', 'manifest.json'].map(async (file) =>
    JSON.parse(await readFile(resolve(root, file), 'utf8')),
  ),
);

const validation = validateRelease({
  packageVersion: packageJson.version,
  manifestVersion: manifest.version,
  tag,
});
if (!validation.ok) {
  fail('version contract violated', validation.errors);
}
const release = validation.release;

// The archive must contain every file the packaged manifest points at.
const entries = new Set(['manifest.json']);
if (manifest.background?.service_worker) entries.add(manifest.background.service_worker);
for (const script of manifest.content_scripts ?? []) {
  for (const file of script.js ?? []) entries.add(file);
}
for (const file of Object.values(manifest.icons ?? {})) entries.add(file);
const names = [...entries].sort();

const missing = [];
for (const name of names) {
  try {
    await stat(join(distDir, name));
  } catch {
    missing.push(name);
  }
}
if (missing.length > 0) {
  fail(`build in ${distDir} is incomplete`, missing.map((name) => `missing ${name}`));
}

const staging = await mkdtemp(join(tmpdir(), 'chatgpt-queue-release-'));
const zipName = `chatgpt-queue-${release.tag}.zip`;
const zipPath = join(outDir, zipName);
const shaPath = `${zipPath}.sha256`;

try {
  for (const name of names) {
    const staged = join(staging, basename(name));
    await copyFile(join(distDir, name), staged);
    await utimes(staged, FIXED_TIME, FIXED_TIME);
  }

  await mkdir(outDir, { recursive: true });
  await rm(zipPath, { force: true });
  await rm(shaPath, { force: true });

  const zipped = spawnSync('zip', ['-X', '-q', '-D', zipPath, ...names], {
    cwd: staging,
    encoding: 'utf8',
    env: { ...process.env, TZ: 'UTC' },
  });
  if (zipped.error) fail(`could not run the zip command: ${zipped.error.message}`);
  if (zipped.status !== 0) fail('zip command failed', [zipped.stderr?.trim() ?? '']);

  const listed = spawnSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' });
  if (listed.error) fail(`could not run the unzip command: ${listed.error.message}`);
  if (listed.status !== 0) fail('could not read back the created archive', [listed.stderr?.trim() ?? '']);
  const archived = listed.stdout.split('\n').map((line) => line.trim()).filter(Boolean).sort();
  if (archived.length !== names.length || archived.some((name, index) => name !== names[index])) {
    fail('archive contents do not match the packaged manifest', [
      `expected: ${names.join(', ')}`,
      `found: ${archived.join(', ')}`,
    ]);
  }

  const digest = createHash('sha256').update(await readFile(zipPath)).digest('hex');
  await writeFile(shaPath, `${digest}  ${zipName}\n`);

  const prerelease = release.prerelease ? release.prerelease : '(none)';
  console.log('package-release: ok');
  console.log(`tag: ${release.tag}`);
  console.log(`extension version: ${release.baseVersion}`);
  console.log(`prerelease: ${prerelease}`);
  console.log(`entries: ${names.join(', ')}`);
  console.log(`zip: ${zipPath}`);
  console.log(`sha256: ${digest}`);

  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    await writeFile(
      summary,
      [
        '## Packaged release assets',
        '',
        `| field | value |`,
        `| --- | --- |`,
        `| tag | \`${release.tag}\` |`,
        `| extension version | \`${release.baseVersion}\` |`,
        `| prerelease | \`${prerelease}\` |`,
        `| archive entries | ${names.map((name) => `\`${name}\``).join(', ')} |`,
        `| sha256 | \`${digest}\` |`,
        '',
      ].join('\n'),
      { flag: 'a' },
    );
  }
} finally {
  await rm(staging, { recursive: true, force: true });
}
