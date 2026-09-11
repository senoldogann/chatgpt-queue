import { describe, expect, it } from 'vitest';
import { QueueRunner, type RunnerBackend } from '../src/runtime/queue-runner';
import type { ChatGPTAdapter, SendResult } from '../src/adapter/chatgpt-adapter';
import type { ConversationQueue, PageSnapshot, QueueItem } from '../src/domain/types';

const baseSnapshot: PageSnapshot = {
  domRecognized: true,
  isGenerating: false,
  composerReady: true,
  sendReady: true,
  assistantMessageCount: 1,
  domStable: false,
  confirmationVisible: false,
  blockingReason: null,
};

const queue = (phase: ConversationQueue['runtime']['phase'], itemState: 'queued' | 'sending' | 'running' = 'queued'): ConversationQueue => {
  const base: QueueItem = { id: 'i', content: 'hello', state: itemState, createdAt: 1, updatedAt: 1 };
  const item: QueueItem = itemState === 'queued' ? base : { ...base, dispatchToken: 'd' };
  return {
    version: 1,
    id: 'q',
    conversationKey: 'conv:a',
    status: 'running',
    items: [item],
    runtime: phase === 'ready_to_send'
      ? { phase }
      : { phase, activeItemId: 'i', baselineAssistantCount: 1, generationObserved: phase !== 'sending' },
    createdAt: 1,
    updatedAt: 1,
  };
};

class FakeAdapter implements ChatGPTAdapter {
  sent: string[] = [];
  constructor(public snapshot: PageSnapshot, private result: SendResult = { attempted: true }) {}
  getState(domStable: boolean) { return { ...this.snapshot, domStable }; }
  async sendMessage(content: string) { this.sent.push(content); return this.result; }
}

class FakeBackend implements RunnerBackend {
  calls: string[] = [];
  constructor(public current: ConversationQueue) {}
  async get() { return this.current; }
  async reserve() { this.calls.push('reserve'); return { itemId: 'i', content: 'hello', dispatchToken: 'd' }; }
  async generationStarted() { this.calls.push('generationStarted'); }
  async waitingStable() { this.calls.push('waitingStable'); }
  async complete() { this.calls.push('complete'); }
  async block(_key: string, reason: string) { this.calls.push(`block:${reason}`); }
}

describe('QueueRunner', () => {
  it('reserves before attempting a send and does not mark it running immediately', async () => {
    const backend = new FakeBackend(queue('ready_to_send'));
    const adapter = new FakeAdapter(baseSnapshot);
    await new QueueRunner(adapter, backend).evaluate('conv:a', false);
    expect(backend.calls).toEqual(['reserve']);
    expect(adapter.sent).toEqual(['hello']);
  });

  it('confirms generation only after page evidence appears', async () => {
    const backend = new FakeBackend(queue('sending', 'sending'));
    const adapter = new FakeAdapter({ ...baseSnapshot, isGenerating: true, sendReady: false });
    await new QueueRunner(adapter, backend).evaluate('conv:a', false);
    expect(backend.calls).toEqual(['generationStarted']);
    expect(adapter.sent).toEqual([]);
  });

  it('moves ended generation to stability wait and then completes on stable DOM', async () => {
    const backend = new FakeBackend(queue('generating', 'running'));
    const adapter = new FakeAdapter({ ...baseSnapshot, assistantMessageCount: 2 });
    const runner = new QueueRunner(adapter, backend);
    await runner.evaluate('conv:a', false);
    expect(backend.calls).toEqual(['waitingStable']);

    backend.current = queue('waiting_stable_completion', 'running');
    await runner.evaluate('conv:a', true);
    expect(backend.calls).toEqual(['waitingStable', 'complete']);
  });

  it('blocks confirmation/error states without sending', async () => {
    const backend = new FakeBackend(queue('ready_to_send'));
    const adapter = new FakeAdapter({ ...baseSnapshot, confirmationVisible: true });
    await new QueueRunner(adapter, backend).evaluate('conv:a', false);
    expect(backend.calls).toEqual(['block:confirmation-required']);
    expect(adapter.sent).toEqual([]);
  });

  it('blocks when a reserved send cannot be attempted', async () => {
    const backend = new FakeBackend(queue('ready_to_send'));
    const adapter = new FakeAdapter(baseSnapshot, { attempted: false, reason: 'composer-or-send-not-ready' });
    await new QueueRunner(adapter, backend).evaluate('conv:a', false);
    expect(backend.calls).toEqual(['reserve', 'block:send-not-attempted']);
  });
});
