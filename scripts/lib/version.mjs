// Shared release version rules. Used by scripts/check-version.mjs and
// scripts/package-release.mjs so local runs and the Release workflow enforce
// exactly the same contract.

/** Chrome MV3 manifest versions are 1-4 dot-separated integers: 1, 1.2, 1.2.3, 1.2.3.4. */
export const CHROME_EXTENSION_VERSION_PATTERN = /^\d{1,5}(\.\d{1,5}){0,3}$/;

const RELEASE_TAG_PATTERN = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?)$/;

export function isChromeExtensionVersion(value) {
  return typeof value === 'string' && CHROME_EXTENSION_VERSION_PATTERN.test(value);
}

/**
 * Parses a release tag such as `v0.1.0-rc.3`.
 *
 * The packaged extension version is always the base version, because a Chrome
 * MV3 manifest version cannot carry a prerelease suffix. The candidate number
 * therefore lives only in the tag: tag `v0.1.0-rc.3` ships manifest version
 * `0.1.0`.
 */
export function describeReleaseTag(tag) {
  const match = RELEASE_TAG_PATTERN.exec(typeof tag === 'string' ? tag.trim() : '');
  if (!match) return undefined;
  const version = match[1];
  const separator = version.indexOf('-');
  return {
    tag: typeof tag === 'string' ? tag.trim() : '',
    version,
    baseVersion: separator === -1 ? version : version.slice(0, separator),
    prerelease: separator === -1 ? '' : version.slice(separator + 1),
  };
}

/**
 * Checks that package.json, manifest.json, and (when supplied) the release tag
 * all describe the same version.
 */
export function validateRelease({ packageVersion, manifestVersion, tag } = {}) {
  const errors = [];

  if (!isChromeExtensionVersion(packageVersion)) {
    errors.push(
      `package.json version "${packageVersion}" is not a valid Chrome extension version`,
    );
  }
  if (manifestVersion !== packageVersion) {
    errors.push(
      `manifest.json version "${manifestVersion}" does not match package.json version "${packageVersion}"`,
    );
  }

  let release;
  if (tag !== undefined && tag !== null && tag !== '') {
    release = describeReleaseTag(tag);
    if (!release) {
      errors.push(
        `release tag "${tag}" must look like v<major>.<minor>.<patch> with an optional prerelease suffix, for example v0.1.0-rc.4`,
      );
    } else if (release.baseVersion !== manifestVersion) {
      errors.push(
        `release tag "${tag}" targets version ${release.baseVersion} but manifest.json and package.json are ${manifestVersion}`,
      );
    } else if (!isChromeExtensionVersion(release.baseVersion)) {
      errors.push(
        `release tag "${tag}" base version ${release.baseVersion} is not a valid Chrome extension version`,
      );
    }
  }

  return { ok: errors.length === 0, errors, release };
}
