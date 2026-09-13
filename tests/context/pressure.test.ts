import { describe, expect, it } from 'vitest';
import type { ConversationTurnSample } from '../../src/adapter/chatgpt-adapter';
import { resolveContextCapacity } from '../../src/context/capacity';
import {
  CONTEXT_PRESSURE_THRESHOLDS,
  estimateTokens,
  formatContextPressure,
  measureContextPressure,
} from '../../src/context/pressure';

const turns = (length: number, charsPerTurn: number): ConversationTurnSample[] =>
  Array.from({ length }, (_, index) => ({
    role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
    text: 'x'.repeat(charsPerTurn),
  }));

describe('context pressure', () => {
  it('estimates tokens from visible text length', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
    expect(estimateTokens('şşşş')).toBeGreaterThan(1);
    expect(estimateTokens('const value = foo.bar();')).toBeGreaterThan(4);
  });

  it('moves the thresholds with the resolved capacity instead of a fixed token limit', () => {
    const small = resolveContextCapacity({ configuredTokens: 2_500 });
    const large = resolveContextCapacity({ configuredTokens: 1_310_000 });
    const conversation = turns(8, 1_000); // 8k characters, ~2k tokens plus overhead

    const underSmall = measureContextPressure(conversation, small);
    const underLarge = measureContextPressure(conversation, large);

    expect(underSmall.estimatedTokens).toBe(underLarge.estimatedTokens);
    expect(underSmall.level).toBe('compact');
    expect(underLarge.level).toBe('ok');
    expect(underLarge.ratio).toBeLessThan(CONTEXT_PRESSURE_THRESHOLDS.watch);
  });

  it('counts per-turn overhead and reports the level for each band', () => {
    const capacity = resolveContextCapacity({ configuredTokens: 1_000 });
    expect(measureContextPressure([], capacity).level).toBe('ok');
    expect(measureContextPressure(turns(10, 200), capacity).level).toBe('watch');
    expect(measureContextPressure(turns(20, 200), capacity).level).toBe('critical');
    expect(measureContextPressure(turns(1, 4), capacity).turnCount).toBe(1);
  });

  it('labels the reading as an estimate and names the capacity source', () => {
    const capacity = resolveContextCapacity({ configuredTokens: 1_310_000 });
    const reading = measureContextPressure(turns(2, 400), capacity);

    expect(reading.ratio).toBeCloseTo(reading.estimatedTokens / 1_310_000, 6);
    expect(formatContextPressure(reading)).toContain('(est.');
    expect(formatContextPressure(reading)).toContain('configured by you');
    expect(formatContextPressure(reading)).toContain('1,310,000');
  });

  it('marks a bounded visible-turn sample as a lower bound', () => {
    const capacity = resolveContextCapacity({ configuredTokens: 128_000 });
    const reading = measureContextPressure(turns(400, 200), capacity, { sampleTruncated: true });

    expect(reading.sampleTruncated).toBe(true);
    expect(formatContextPressure(reading)).toContain('at least');
  });
});
