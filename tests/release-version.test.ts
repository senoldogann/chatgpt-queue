import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  describeReleaseTag,
  isChromeExtensionVersion,
  validateRelease,
} from '../scripts/lib/version.mjs';

describe('release version contract', () => {
  it('keeps the shipped package.json and manifest.json versions identical', async () => {
    const root = resolve(import.meta.dirname, '..');
    const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
    const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));

    expect(validateRelease({
      packageVersion: packageJson.version,
      manifestVersion: manifest.version,
    })).toEqual({ ok: true, errors: [] });
    expect(isChromeExtensionVersion(manifest.version)).toBe(true);
  });

  it('accepts a release candidate tag whose base version matches the extension version', () => {
    const result = validateRelease({
      packageVersion: '0.1.0',
      manifestVersion: '0.1.0',
      tag: 'v0.1.0-rc.3',
    });

    expect(result.ok).toBe(true);
    expect(result.release).toEqual({
      tag: 'v0.1.0-rc.3',
      version: '0.1.0-rc.3',
      baseVersion: '0.1.0',
      prerelease: 'rc.3',
    });
  });

  it('rejects a tag that points at a different extension version', () => {
    const result = validateRelease({
      packageVersion: '0.1.0',
      manifestVersion: '0.1.0',
      tag: 'v0.2.0-rc.1',
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      expect.stringContaining('targets version 0.2.0'),
    ]);
  });

  it('rejects version drift between package.json and manifest.json', () => {
    const result = validateRelease({ packageVersion: '0.1.0', manifestVersion: '0.1.1' });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      expect.stringContaining('does not match package.json version'),
    ]);
  });

  it('reports malformed versions and tags instead of guessing', () => {
    expect(validateRelease({ packageVersion: 'v0.1.0', manifestVersion: 'v0.1.0' }).errors).toEqual([
      expect.stringContaining('not a valid Chrome extension version'),
    ]);
    expect(describeReleaseTag('0.1.0')).toBeUndefined();
    expect(describeReleaseTag('v0.1.0-rc.3')).toBeDefined();
    expect(validateRelease({ packageVersion: '0.1.0', manifestVersion: '0.1.0', tag: 'release-0.1.0' }).errors).toEqual([
      expect.stringContaining('must look like v<major>.<minor>.<patch>'),
    ]);
  });
});
