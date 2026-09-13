#!/usr/bin/env node
// Fails when package.json, manifest.json, and the release tag disagree.
// This is the single version contract for local runs and the Release workflow.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { validateRelease } from './lib/version.mjs';

const root = resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);

function option(name) {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

const explicitTag = option('--tag');
const tag = explicitTag ?? (process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : undefined);

const [packageJson, manifest] = await Promise.all(
  ['package.json', 'manifest.json'].map(async (file) =>
    JSON.parse(await readFile(resolve(root, file), 'utf8')),
  ),
);

const result = validateRelease({
  packageVersion: packageJson.version,
  manifestVersion: manifest.version,
  tag,
});

if (!result.ok) {
  console.error('version-check: FAILED');
  for (const error of result.errors) console.error(`- ${error}`);
  process.exit(1);
}

const suffix = result.release
  ? ` (tag ${result.release.tag} ships extension version ${result.release.baseVersion})`
  : '';
console.log(
  `version-check: ok — package.json ${packageJson.version} = manifest.json ${manifest.version}${suffix}`,
);
