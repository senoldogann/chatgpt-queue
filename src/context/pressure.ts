import type { ConversationTurnSample } from '../adapter/chatgpt-adapter';
import type { ContextCapacity } from './capacity';

export type ContextPressureLevel = 'ok' | 'watch' | 'compact' | 'critical';

export interface ContextPressure {
  estimatedTokens: number;
  turnCount: number;
  capacity: ContextCapacity;
  /** Estimated tokens divided by the resolved capacity. Values above 1 mean the estimate exceeds it. */
  ratio: number;
  level: ContextPressureLevel;
}

/**
 * Characters per token is a uniform rough average. Real tokenization depends on the model and the
 * script, so every surface that shows this must label the number as an estimate.
 */
export const ESTIMATED_CHARS_PER_TOKEN = 4;

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

export const estimateTokens = (text: string): number => text.length === 0
  ? 0
  : Math.ceil(text.length / ESTIMATED_CHARS_PER_TOKEN);

export const contextPressureLevel = (ratio: number): ContextPressureLevel => {
  if (ratio >= CONTEXT_PRESSURE_THRESHOLDS.critical) return 'critical';
  if (ratio >= CONTEXT_PRESSURE_THRESHOLDS.compact) return 'compact';
  if (ratio >= CONTEXT_PRESSURE_THRESHOLDS.watch) return 'watch';
  return 'ok';
};

export function measureContextPressure(turns: ConversationTurnSample[], capacity: ContextCapacity): ContextPressure {
  const estimatedTokens = turns.reduce(
    (total, turn) => total + estimateTokens(turn.text) + TURN_OVERHEAD_TOKENS,
    0,
  );
  const ratio = capacity.usableTokens > 0 ? estimatedTokens / capacity.usableTokens : 0;
  return {
    estimatedTokens,
    turnCount: turns.length,
    capacity,
    ratio,
    level: contextPressureLevel(ratio),
  };
}

export const formatContextPressure = (pressure: ContextPressure): string => {
  const percent = Math.round(pressure.ratio * 100);
  return `~${percent}% of ${pressure.capacity.usableTokens.toLocaleString('en-US')} tokens (est. ${pressure.estimatedTokens.toLocaleString('en-US')} over ${pressure.turnCount} turns, ${pressure.capacity.label.toLowerCase()})`;
};
