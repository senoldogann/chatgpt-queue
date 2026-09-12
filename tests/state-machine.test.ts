import { describe, expect, it } from 'vitest';
import { evaluateRuntime } from '../src/domain/state-machine';
import type { PageSnapshot, RuntimePhase } from '../src/domain/types';

const safe = (overrides: Partial<PageSnapshot> = {}): PageSnapshot => ({
  domRecognized: true,
  isGenerating: false,
  composerReady: true,
  sendControlPresent: true,
  assistantMessageCount: 1,
  assistantCompletionControlPresent: false,
  domStable: false,
  confirmationVisible: false,
  blockingReason: null,
  ...overrides,
});

const decide = (phase: RuntimePhase, snapshot: PageSnapshot, baseline = 1, generationObserved = false) =>
  evaluateRuntime({ phase, snapshot, baselineAssistantCount: baseline, generationObserved });

describe('runtime state machine', () => {
  it('moves ready state to send only when the page is safe', () => {
    expect(decide('ready_to_send', safe()).action).toBe('send');
  });

  it('allows dispatch when the authenticated composer is ready but send control is not rendered yet', () => {
    expect(decide('ready_to_send', safe({ sendControlPresent: false }))).toEqual({ action: 'send' });
  });

  it('treats an assistant placeholder as generation evidence without claiming the control was observed', () => {
    expect(decide('waiting_generation_start', safe({ assistantMessageCount: 2, isGenerating: false }), 1, false)).toEqual({
      action: 'generation_started',
      controlObserved: false,
    });
    expect(decide('generating', safe({ assistantMessageCount: 2, isGenerating: false, domStable: true }), 1, false)).toEqual({ action: 'wait' });
  });

  it('accepts a completed assistant turn as fallback evidence when the stop control was missed', () => {
    expect(decide('generating', safe({
      assistantMessageCount: 2,
      assistantCompletionControlPresent: true,
    }), 1, false)).toEqual({ action: 'wait_for_stability' });

    expect(decide('waiting_stable_completion', safe({
      assistantMessageCount: 2,
      assistantCompletionControlPresent: true,
      domStable: true,
    }), 1, false)).toEqual({ action: 'complete' });
  });

  it('recognizes generation start after send', () => {
    expect(decide('waiting_generation_start', safe({ isGenerating: true }))).toEqual({ action: 'generation_started', controlObserved: true });
  });

  it('waits for stable completion after generation ends', () => {
    const result = decide('generating', safe({ assistantMessageCount: 2 }), 1, true);
    expect(result.action).toBe('wait_for_stability');
  });

  it('completes only when a new assistant response exists and DOM is stable', () => {
    expect(decide('waiting_stable_completion', safe({ assistantMessageCount: 2, domStable: true }), 1, true).action).toBe('complete');
    expect(decide('waiting_stable_completion', safe({ assistantMessageCount: 1, domStable: true }), 1, true).action).toBe('wait');
  });

  it('waits through a transient unrecognized DOM until it becomes stable', () => {
    expect(decide('generating', safe({ domRecognized: false, domStable: false }), 1, true)).toEqual({ action: 'wait' });
    expect(decide('waiting_stable_completion', safe({ domRecognized: false, domStable: false, assistantMessageCount: 2 }), 1, true)).toEqual({ action: 'wait' });
  });

  it('blocks on ambiguous DOM, confirmation, and explicit blocking errors', () => {
    expect(decide('generating', safe({ domRecognized: false, domStable: true }), 1, true)).toEqual({ action: 'block', reason: 'dom-unrecognized' });
    expect(decide('generating', safe({ confirmationVisible: true }), 1, true)).toEqual({ action: 'block', reason: 'confirmation-required' });
    expect(decide('generating', safe({ blockingReason: 'rate-limit' }), 1, true)).toEqual({ action: 'block', reason: 'rate-limit' });
  });

  it('blocks if the page becomes send-ready without evidence that generation ever started', () => {
    expect(decide('waiting_generation_start', safe(), 1, false)).toEqual({ action: 'block', reason: 'generation-start-not-observed' });
  });
  it('detects a new assistant turn even when virtualization keeps the assistant count unchanged', () => {
    const generating = evaluateRuntime({
      phase: 'generating',
      snapshot: safe({
        assistantMessageCount: 50,
        assistantCompletionControlPresent: true,
        latestAssistantTurnKey: 'turn-new',
      }),
      baselineAssistantCount: 50,
      baselineAssistantTurnKey: 'turn-old',
      generationObserved: true,
    });
    expect(generating).toEqual({ action: 'wait_for_stability' });

    const stable = evaluateRuntime({
      phase: 'waiting_stable_completion',
      snapshot: safe({
        assistantMessageCount: 50,
        assistantCompletionControlPresent: true,
        latestAssistantTurnKey: 'turn-new',
        domStable: true,
      }),
      baselineAssistantCount: 50,
      baselineAssistantTurnKey: 'turn-old',
      generationObserved: true,
    });
    expect(stable).toEqual({ action: 'complete' });
  });

  it('does not treat the same assistant turn as new when the count is unchanged', () => {
    expect(evaluateRuntime({
      phase: 'waiting_stable_completion',
      snapshot: safe({
        assistantMessageCount: 50,
        assistantCompletionControlPresent: true,
        latestAssistantTurnKey: 'turn-old',
        domStable: true,
      }),
      baselineAssistantCount: 50,
      baselineAssistantTurnKey: 'turn-old',
      generationObserved: true,
    })).toEqual({ action: 'wait' });
  });

  it('can reconcile a legacy running item without a stored turn key when generation was observed and the latest turn is completed', () => {
    expect(evaluateRuntime({
      phase: 'waiting_stable_completion',
      snapshot: safe({
        assistantMessageCount: 50,
        assistantCompletionControlPresent: true,
        latestAssistantTurnKey: 'turn-current',
        domStable: true,
      }),
      baselineAssistantCount: 50,
      generationObserved: true,
    })).toEqual({ action: 'complete' });
  });

  it('allows only an explicitly eligible legacy runtime to enter completion stability without turn identity', () => {
    const legacySnapshot = safe({
      assistantMessageCount: 3,
      latestAssistantTurnKey: 'assistant:3:final',
      assistantCompletionControlPresent: false,
    });
    expect(evaluateRuntime({
      phase: 'generating',
      snapshot: legacySnapshot,
      baselineAssistantCount: 3,
      generationObserved: true,
      legacyCompletionRecoveryEligible: true,
    })).toEqual({ action: 'wait_for_stability' });

    expect(evaluateRuntime({
      phase: 'generating',
      snapshot: legacySnapshot,
      baselineAssistantCount: 3,
      generationObserved: true,
      legacyCompletionRecoveryEligible: false,
    })).toEqual({ action: 'wait' });
  });

});
