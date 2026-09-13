/**
 * Context capacity is resolved at runtime, never assumed.
 *
 * The extension cannot read server-side token accounting, and model limits change without any
 * signal in the page. So instead of baking a limit into the pressure maths, every consumer takes
 * a resolved {@link ContextCapacity} and the resolution order is explicit:
 *
 * 1. the user's explicit override (`user-configured`),
 * 2. a value the host page declares about itself (`runtime-declared`),
 * 3. a deliberately conservative fallback (`capability-default`).
 *
 * Only the third source is a constant, it is the last resort, and it is always labeled as such in
 * the UI so nobody mistakes an estimate for a measurement.
 */

export type ContextCapacitySource = 'runtime-declared' | 'user-configured' | 'capability-default';

export interface ContextCapacity {
  /** Stable identifier for where the value came from. */
  id: string;
  /** Human-readable origin, shown next to the estimate. */
  label: string;
  usableTokens: number;
  source: ContextCapacitySource;
}

export interface ContextCapacitySignals {
  runtimeDeclaredTokens?: number | undefined;
  configuredTokens?: number | undefined;
}

/**
 * Conservative last-resort capacity.
 *
 * It is intentionally *below* current long-context model windows: over-warning is recoverable,
 * silently running a conversation past its limit is not. Buyers of a real limit should set one.
 */
export const CONSERVATIVE_CONTEXT_TOKENS = 128_000;

export const MIN_CONTEXT_CAPACITY_TOKENS = 1_000;
export const MAX_CONTEXT_CAPACITY_TOKENS = 100_000_000;

export const isUsableContextCapacity = (value: unknown): value is number =>
  typeof value === 'number'
  && Number.isFinite(value)
  && value >= MIN_CONTEXT_CAPACITY_TOKENS
  && value <= MAX_CONTEXT_CAPACITY_TOKENS;

export function resolveContextCapacity(signals: ContextCapacitySignals = {}): ContextCapacity {
  if (isUsableContextCapacity(signals.configuredTokens)) {
    return {
      id: 'configured',
      label: 'Configured by you',
      usableTokens: Math.floor(signals.configuredTokens),
      source: 'user-configured',
    };
  }
  if (isUsableContextCapacity(signals.runtimeDeclaredTokens)) {
    return {
      id: 'runtime:declared',
      label: 'Reported by the page',
      usableTokens: Math.floor(signals.runtimeDeclaredTokens),
      source: 'runtime-declared',
    };
  }
  return {
    id: 'default:conservative',
    label: 'Conservative fallback',
    usableTokens: CONSERVATIVE_CONTEXT_TOKENS,
    source: 'capability-default',
  };
}

export const RUNTIME_CAPACITY_ATTRIBUTE = 'data-context-window-tokens';

/**
 * Reads a capacity the host page declares about itself.
 *
 * Returns `undefined` when the page declares nothing usable, which lets a lower-priority source
 * win. We never fabricate a value here.
 */
export function readRuntimeDeclaredCapacity(document: Document): number | undefined {
  const declared = [
    document.documentElement?.getAttribute(RUNTIME_CAPACITY_ATTRIBUTE) ?? null,
    document.querySelector(`[${RUNTIME_CAPACITY_ATTRIBUTE}]`)?.getAttribute(RUNTIME_CAPACITY_ATTRIBUTE) ?? null,
  ];
  for (const attribute of declared) {
    if (!attribute) continue;
    const parsed = Number.parseInt(attribute.trim(), 10);
    if (isUsableContextCapacity(parsed)) return parsed;
  }
  return undefined;
}
