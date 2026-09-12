import { describe, expect, it } from 'vitest';
import { QueueRunner, type RunnerBackend } from '../src/runtime/queue-runner';
import type { ChatGPTAdapter, SendResult } from '../src/adapter/chatgpt-adapter';
import type { ConversationQueue, PageSnapshot, QueueItem } from '../src/domain/types';

const baseSnapshot: PageSnapshot = {
  domRecognized: true,
  isGenerating: false,
  composerReady: true,
  sendControlPresent: true,
  assistantMessageCount: 1,
  assistantCompletionControlPresent: false,
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
  getLatestCompletedAssistantArtifact() { return null; }
  async sendMessage(content: string) { this.sent.push(content); return this.result; }
}

class FakeBackend implements RunnerBackend {
  calls: string[] = [];
  reserveArgs?: [string, number, string | undefined];
  constructor(public current: ConversationQueue) {}
  async get() { return this.current; }
  async reserve(key: string, count: number, turnKey?: string) { this.calls.push('reserve'); this.reserveArgs = [key, count, turnKey]; return { itemId: 'i', content: 'hello', dispatchToken: 'd' }; }
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

  it('persists the latest assistant turn identity when reserving a send', async () => {
    const backend = new FakeBackend(queue('ready_to_send'));
    const adapter = new FakeAdapter({ ...baseSnapshot, latestAssistantTurnKey: 'turn-before-send' });
    await new QueueRunner(adapter, backend).evaluate('conv:a', false);
    expect(backend.reserveArgs).toEqual(['conv:a', 1, 'turn-before-send']);
  });

  it('confirms generation only after page evidence appears', async () => {
    const backend = new FakeBackend(queue('sending', 'sending'));
    const adapter = new FakeAdapter({ ...baseSnapshot, isGenerating: true, sendControlPresent: false });
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

  it('continues observing a paused active item through completion without dispatching a new item', async () => {
    const paused = { ...queue('waiting_stable_completion', 'running'), status: 'paused' as const };
    const backend = new FakeBackend(paused);
    const adapter = new FakeAdapter({ ...baseSnapshot, assistantMessageCount: 2, assistantCompletionControlPresent: true });

    await new QueueRunner(adapter, backend).evaluate('conv:a', true);

    expect(backend.calls).toEqual(['complete']);
    expect(adapter.sent).toEqual([]);
  });

  it('never dispatches a new item while the queue is paused', async () => {
    const paused = { ...queue('ready_to_send'), status: 'paused' as const };
    const backend = new FakeBackend(paused);
    const adapter = new FakeAdapter(baseSnapshot);

    await new QueueRunner(adapter, backend).evaluate('conv:a', true);

    expect(backend.calls).toEqual([]);
    expect(adapter.sent).toEqual([]);
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

  it('completes a proven completion once the bounded quiet grace elapses without a stable DOM', async () => {
    const backend = new FakeBackend(queue('waiting_stable_completion', 'running'));
    backend.current.items[0]!.startedAt = 0;
    const adapter = new FakeAdapter({ ...baseSnapshot, assistantMessageCount: 2 });

    await new QueueRunner(adapter, backend, { now: () => 10_000 }).evaluate('conv:a', false);

    expect(backend.calls).toEqual(['complete']);
  });

  it('keeps waiting for the quiet window before the grace elapses', async () => {
    const backend = new FakeBackend(queue('waiting_stable_completion', 'running'));
    backend.current.items[0]!.startedAt = 9_000;
    const adapter = new FakeAdapter({ ...baseSnapshot, assistantMessageCount: 2 });

    await new QueueRunner(adapter, backend, { now: () => 10_000 }).evaluate('conv:a', false);

    expect(backend.calls).toEqual([]);
  });

  it('reconciles an old generating item after a conservative legacy recovery age', async () => {
    const legacy = queue('generating', 'running');
    legacy.runtime.generationObserved = true;
    legacy.runtime.baselineAssistantCount = 3;
    delete legacy.runtime.baselineAssistantTurnKey;
    legacy.items[0]!.startedAt = 1_000;
    const backend = new FakeBackend(legacy);
    const adapter = new FakeAdapter({
      ...baseSnapshot,
      assistantMessageCount: 3,
      latestAssistantTurnKey: 'assistant:3:final',
      assistantCompletionControlPresent: false,
      isGenerating: false,
      composerReady: true,
    });

    await new QueueRunner(adapter, backend, { now: () => 31_001 }).evaluate('conv:a', false);
    expect(backend.calls).toEqual(['waitingStable']);
  });

  it('finishes a recovered legacy item through the bounded quiet grace instead of a stable DOM', async () => {
    const legacy = queue('generating', 'running');
    legacy.runtime.generationObserved = true;
    legacy.runtime.baselineAssistantCount = 3;
    delete legacy.runtime.baselineAssistantTurnKey;
    legacy.items[0]!.startedAt = 1_000;
    const backend = new FakeBackend(legacy);
    const adapter = new FakeAdapter({
      ...baseSnapshot,
      assistantMessageCount: 3,
      latestAssistantTurnKey: 'assistant:3:final',
      assistantCompletionControlPresent: false,
      isGenerating: false,
      composerReady: true,
    });

    await new QueueRunner(adapter, backend, { now: () => 31_001 }).evaluate('conv:a', false);
    expect(backend.calls).toEqual(['waitingStable']);

    backend.calls.length = 0;
    backend.current.runtime.phase = 'waiting_stable_completion';
    backend.current.runtime.stableWaitStartedAt = 31_001;
    await new QueueRunner(adapter, backend, { now: () => 36_500 }).evaluate('conv:a', false);
    expect(backend.calls).toEqual(['complete']);
  });

  it('does not use legacy recovery for a modern item with a baseline turn identity', async () => {
    const modern = queue('generating', 'running');
    modern.runtime.generationObserved = true;
    modern.runtime.baselineAssistantCount = 3;
    modern.runtime.baselineAssistantTurnKey = 'turn-same';
    modern.items[0]!.startedAt = 1_000;
    const backend = new FakeBackend(modern);
    const adapter = new FakeAdapter({
      ...baseSnapshot,
      assistantMessageCount: 3,
      latestAssistantTurnKey: 'turn-same',
      assistantCompletionControlPresent: false,
      isGenerating: false,
      composerReady: true,
    });

    await new QueueRunner(adapter, backend, { now: () => 120_000 }).evaluate('conv:a', false);
    expect(backend.calls).toEqual([]);
  });
});
