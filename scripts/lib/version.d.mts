export declare const CHROME_EXTENSION_VERSION_PATTERN: RegExp;

export interface ReleaseTag {
  tag: string;
  version: string;
  baseVersion: string;
  prerelease: string;
}

export interface ReleaseValidation {
  ok: boolean;
  errors: string[];
  release?: ReleaseTag;
}

export declare function isChromeExtensionVersion(value: unknown): value is string;
export declare function describeReleaseTag(tag: unknown): ReleaseTag | undefined;
export declare function validateRelease(input?: {
  packageVersion?: string | undefined;
  manifestVersion?: string | undefined;
  tag?: string | undefined;
}): ReleaseValidation;
