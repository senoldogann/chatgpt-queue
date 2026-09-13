// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  CONSERVATIVE_CONTEXT_TOKENS,
  isUsableContextCapacity,
  readRuntimeDeclaredCapacity,
  resolveContextCapacity,
} from '../../src/context/capacity';

describe('context capacity resolution', () => {
  it('prefers a value the page declares over everything else', () => {
    const capacity = resolveContextCapacity({ runtimeDeclaredTokens: 1_310_000, configuredTokens: 200_000 });

    expect(capacity).toEqual({
      id: 'runtime:declared',
      label: 'Reported by the page',
      usableTokens: 1_310_000,
      source: 'runtime-declared',
    });
  });

  it('uses the user configuration when the page declares nothing', () => {
    const capacity = resolveContextCapacity({ configuredTokens: 400_000 });

    expect(capacity.usableTokens).toBe(400_000);
    expect(capacity.source).toBe('user-configured');
  });

  it('falls back to a clearly labeled conservative default instead of assuming a model limit', () => {
    const capacity = resolveContextCapacity({});

    expect(capacity.usableTokens).toBe(CONSERVATIVE_CONTEXT_TOKENS);
    expect(capacity.source).toBe('capability-default');
    expect(capacity.label).toBe('Conservative fallback');
  });

  it('ignores unusable declarations rather than trusting them', () => {
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 10, 1e12]) {
      expect(isUsableContextCapacity(value)).toBe(false);
      expect(resolveContextCapacity({ runtimeDeclaredTokens: value, configuredTokens: 250_000 }).source).toBe('user-configured');
    }
  });

  it('reads a capacity the host page declares, and reports nothing when it declares none', () => {
    document.body.innerHTML = '<main></main>';
    expect(readRuntimeDeclaredCapacity(document)).toBeUndefined();

    document.documentElement.setAttribute('data-context-window-tokens', 'not-a-number');
    expect(readRuntimeDeclaredCapacity(document)).toBeUndefined();

    document.documentElement.setAttribute('data-context-window-tokens', '1310000');
    expect(readRuntimeDeclaredCapacity(document)).toBe(1_310_000);
  });

  it('also accepts a declaration on a descendant element', () => {
    document.documentElement.removeAttribute('data-context-window-tokens');
    document.body.innerHTML = '<main data-context-window-tokens="64000"></main>';

    expect(readRuntimeDeclaredCapacity(document)).toBe(64_000);
  });
});
