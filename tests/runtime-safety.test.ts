import { describe, expect, it } from 'vitest';
import { pauseQueue, resumeQueue } from '../src/domain/queue-engine';
import { evaluateRuntime } from '../src/domain/state-machine';
import type { ConversationQueue, PageSnapshot } from '../src/domain/types';

const snapshot = (overrides: Partial<PageSnapshot> = {}): PageSnapshot => ({
  domRecognized: true,
  isGenerating: false,
  composerReady: true,
  sendReady: true,
  assistantMessageCount: 1,
  domStable: false,
  confirmationVisible: false,
  blockingReason: null,
  ...overrides,
});

describe('runtime safety', () => {
  it('keeps an attempted dispatch in sending until generation evidence appears', () => {
    expect(evaluateRuntime({
      phase: 'sending',
      snapshot: snapshot({ isGenerating: true }),
      baselineAssistantCount: 1,
      generationObserved: false,
    })).toEqual({ action: 'generation_started' });
  });

  it('blocks an attempted dispatch after the DOM stabilizes with no send evidence', () => {
    expect(evaluateRuntime({
      phase: 'sending',
      snapshot: snapshot({ domStable: true }),
      baselineAssistantCount: 1,
      generationObserved: false,
    })).toEqual({ action: 'block', reason: 'send-not-confirmed' });
  });

  it('blocks a stable disabled composer when generation never appears', () => {
    expect(evaluateRuntime({
      phase: 'sending',
      snapshot: snapshot({ domStable: true, composerReady: false, sendReady: false }),
      baselineAssistantCount: 1,
      generationObserved: false,
    })).toEqual({ action: 'block', reason: 'send-not-confirmed' });
  });

  it('pausing an active item preserves the observation phase for resume', () => {
    const queue: ConversationQueue = {
      version: 1,
      id: 'q',
      conversationKey: 'conv:a',
      status: 'running',
      items: [{ id: 'i', content: 'x', state: 'running', createdAt: 1, updatedAt: 1, dispatchToken: 'd' }],
      runtime: { phase: 'generating', activeItemId: 'i', baselineAssistantCount: 2, generationObserved: true },
      createdAt: 1,
      updatedAt: 1,
    };
    const paused = pauseQueue(queue, 2);
    const resumed = resumeQueue(paused, 3);
    expect(paused.runtime.phase).toBe('generating');
    expect(resumed.runtime.phase).toBe('generating');
  });
});
