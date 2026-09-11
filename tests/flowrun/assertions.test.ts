import { describe, expect, it } from 'vitest';
import { evaluateAssertions } from '../../src/flowrun/assertions';
import { createRunEvent } from '../../src/flowrun/events';
import type { StepAssertion } from '../../src/flowrun/schema';

const assertions = (...values: StepAssertion[]) => values;

describe('FlowRun assertions and events', () => {
  it('passes output_not_empty only for non-whitespace output', () => {
    expect(evaluateAssertions('result', assertions({ type: 'output_not_empty' }))).toEqual({ ok: true });
    expect(evaluateAssertions('   ', assertions({ type: 'output_not_empty' }))).toEqual({
      ok: false,
      failed: { type: 'output_not_empty' },
    });
  });

  it('uses case-sensitive output_contains and reports the first failed assertion', () => {
    expect(evaluateAssertions('Hello World', assertions({ type: 'output_contains', value: 'World' }))).toEqual({ ok: true });
    expect(evaluateAssertions('Hello World', assertions(
      { type: 'output_not_empty' },
      { type: 'output_contains', value: 'world' },
      { type: 'output_contains', value: 'Hello' },
    ))).toEqual({
      ok: false,
      failed: { type: 'output_contains', value: 'world' },
    });
  });

  it('creates immutable-shape run events with explicit metadata', () => {
    const event = createRunEvent({
      id: 'event-1',
      runId: 'run-1',
      at: 123,
      kind: 'step.ready',
      stepId: 'review',
      data: { promptLength: 42 },
    });
    expect(event).toEqual({
      id: 'event-1',
      runId: 'run-1',
      at: 123,
      kind: 'step.ready',
      stepId: 'review',
      data: { promptLength: 42 },
    });
  });
});
