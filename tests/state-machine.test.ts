import { describe, expect, it } from 'vitest';
import { evaluateRuntime } from '../src/domain/state-machine';
import type { PageSnapshot, RuntimePhase } from '../src/domain/types';

const safe = (overrides: Partial<PageSnapshot> = {}): PageSnapshot => ({
  domRecognized: true,
  isGenerating: false,
  composerReady: true,
  sendControlPresent: true,
  assistantMessageCount: 1,
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

  it('recognizes generation start after send', () => {
    expect(decide('waiting_generation_start', safe({ isGenerating: true }))).toEqual({ action: 'generation_started' });
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
});
