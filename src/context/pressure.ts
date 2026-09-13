import type { ConversationTurnSample } from '../adapter/chatgpt-adapter';
import type { ContextCapacity } from './capacity';

export type ContextPressureLevel = 'ok' | 'watch' | 'compact' | 'critical';

export interface ContextPressure {
  estimatedTokens: number;
  turnCount: number;
  capacity: ContextCapacity;
  /** True when older visible turns were deliberately omitted from the bounded DOM sample. */
  sampleTruncated: boolean;
  /** Estimated tokens divided by the resolved capacity. Values above 1 mean the estimate exceeds it. */
  ratio: number;
  level: ContextPressureLevel;
}

export interface ContextPressureOptions {
  sampleTruncated?: boolean;
}

/**
 * Four UTF-8 bytes per token is still only a heuristic, but unlike JavaScript string length it does
 * not make non-ASCII text look artificially cheap. A lexical floor below also gives punctuation-
 * heavy code a little more weight. Every surface that shows this must still call it an estimate.
 */
export const ESTIMATED_UTF8_BYTES_PER_TOKEN = 4;
/** Kept as a compatibility alias for callers that imported the original heuristic constant. */
export const ESTIMATED_CHARS_PER_TOKEN = ESTIMATED_UTF8_BYTES_PER_TOKEN;

const TOKENISH_UNIT = /[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;
const utf8Encoder = new TextEncoder();

/** Per-message conversational overhead the raw text does not account for. */
export const TURN_OVERHEAD_TOKENS = 6;

/**
 * Levels are fractions of the *resolved* capacity, so a bigger configured or page-declared window
 * automatically moves the thresholds instead of requiring new constants.
 */
export const CONTEXT_PRESSURE_THRESHOLDS: Record<Exclude<ContextPressureLevel, 'ok'>, number> = {
  watch: 0.5,
  compact: 0.7,
  critical: 0.85,
};

export const estimateTokens = (text: string): number => {
  if (text.length === 0) return 0;
  const byteEstimate = Math.ceil(utf8Encoder.encode(text).byteLength / ESTIMATED_UTF8_BYTES_PER_TOKEN);
  const lexicalFloor = text.match(TOKENISH_UNIT)?.length ?? 0;
  return Math.max(byteEstimate, lexicalFloor);
};

export const contextPressureLevel = (ratio: number): ContextPressureLevel => {
  if (ratio >= CONTEXT_PRESSURE_THRESHOLDS.critical) return 'critical';
  if (ratio >= CONTEXT_PRESSURE_THRESHOLDS.compact) return 'compact';
  if (ratio >= CONTEXT_PRESSURE_THRESHOLDS.watch) return 'watch';
  return 'ok';
};

export function measureContextPressure(
  turns: ConversationTurnSample[],
  capacity: ContextCapacity,
  options: ContextPressureOptions = {},
): ContextPressure {
  const estimatedTokens = turns.reduce(
    (total, turn) => total + estimateTokens(turn.text) + TURN_OVERHEAD_TOKENS,
    0,
  );
  const ratio = capacity.usableTokens > 0 ? estimatedTokens / capacity.usableTokens : 0;
  return {
    estimatedTokens,
    turnCount: turns.length,
    capacity,
    sampleTruncated: options.sampleTruncated === true,
    ratio,
    level: contextPressureLevel(ratio),
  };
}

export const formatContextPressure = (pressure: ContextPressure): string => {
  const percent = Math.round(pressure.ratio * 100);
  const prefix = pressure.sampleTruncated ? 'at least ' : '';
  const turnScope = pressure.sampleTruncated
    ? `the most recent ${pressure.turnCount} visible turns; older visible turns omitted`
    : `${pressure.turnCount} visible turns`;
  return `${prefix}~${percent}% of ${pressure.capacity.usableTokens.toLocaleString('en-US')} tokens (est. ${pressure.estimatedTokens.toLocaleString('en-US')} over ${turnScope}, ${pressure.capacity.label.toLowerCase()})`;
};
