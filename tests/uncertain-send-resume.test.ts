import { describe, expect, it } from 'vitest';
import type { ChatGPTAdapter, SendResult } from '../src/adapter/chatgpt-adapter';
import { QueueCoordinator } from '../src/coordinator/queue-coordinator';
import type { ConversationQueue, PageSnapshot } from '../src/domain/types';
import { QueueRunner, type RunnerBackend } from '../src/runtime/queue-runner';
import { QueueRepository, type StorageAreaLike } from '../src/storage/queue-repository';

class MemoryStorage implements StorageAreaLike {
  data: Record<string, unknown> = {};
  async get(key: string) { return { [key]: this.data[key] }; }
  async set(values: Record<string, unknown>) { Object.assign(this.data, values); }
}

class FakeAdapter implements ChatGPTAdapter {
  sent: string[] = [];

  constructor(private readonly snapshot: PageSnapshot) {}

  getState(domStable: boolean) { return { ...this.snapshot, domStable }; }
  getLatestCompletedAssistantArtifact() { return null; }
  inspectInterface() {
    return {
      health: 'ok' as const,
      recognized: true,
      composer: { status: 'ok' as const, matchedSelector: '#prompt-textarea' },
      sendControl: { status: 'ok' as const, matchedSelector: 'button[data-testid="send-button"]' },
      stopControl: { status: 'missing' as const, matchedSelector: null },
      transcript: { status: 'ok' as const, matchedSelector: 'main' },
      assistantTurn: { status: 'missing' as const, matchedSelector: null },
      isGenerating: false,
      composerReady: true,
      sendControlPresent: true,
      blockingReason: null,
      confirmationVisible: false,
    };
  }
  getConversationTurns() { return []; }
  getDiagnosticSummary() { return 'composer=ok'; }
  async sendMessage(content: string): Promise<SendResult> {
    this.sent.push(content);
    return { attempted: true };
  }
}

class FakeBackend implements RunnerBackend {
  calls: string[] = [];

  constructor(private readonly current: ConversationQueue) {}

  async get() { return this.current; }
  async reserve() { this.calls.push('reserve'); return null; }
  async generationStarted() { this.calls.push('generationStarted'); }
  async waitingStable() { this.calls.push('waitingStable'); }
  async complete() { this.calls.push('complete'); }
  async block(_key: string, reason: string) { this.calls.push(`block:${reason}`); }
}

const idleSnapshot: PageSnapshot = {
  domRecognized: true,
  isGenerating: false,
  composerReady: true,
  sendControlPresent: true,
  assistantMessageCount: 4,
  assistantCompletionControlPresent: false,
  domStable: true,
  confirmationVisible: false,
  blockingReason: null,
  latestAssistantTurnKey: 'turn-before-send',
};

describe('uncertain-send resume', () => {
  it('resumes the existing sending reservation without reserving a replacement', async () => {
    const storage = new MemoryStorage();
    const repo = new QueueRepository(storage);
    let now = 1000;
    let seq = 0;
    const coordinator = new QueueCoordinator(repo, {
      now: () => now,
      uuid: () => `id-${++seq}`,
      leaseMs: 100,
    });

    await coordinator.add('conv:a', ['one']);
    await coordinator.claim('conv:a', 1);
    await coordinator.start('conv:a', 1);
    await coordinator.reserveNext('conv:a', 1, 4, 'turn-before-send');

    now = 1050;
    const restarted = new QueueCoordinator(new QueueRepository(storage), {
      now: () => now,
      uuid: () => 'after-restart',
      leaseMs: 100,
    });
    await restarted.recover('conv:a');

    const resumed = await restarted.start('conv:a', 1);

    expect(resumed.status).toBe('running');
    expect(resumed.blockedReason).toBeUndefined();
    expect(resumed.items[0]).toMatchObject({ state: 'sending', content: 'one' });
    expect(resumed.runtime).toMatchObject({
      phase: 'sending',
      activeItemId: resumed.items[0]?.id,
      baselineAssistantCount: 4,
      baselineAssistantTurnKey: 'turn-before-send',
    });
    expect(await restarted.reserveNext('conv:a', 1, 4, 'turn-before-send')).toBeNull();
  });

  it('re-evaluates a resumed sending reservation without sending it again', async () => {
    const queue: ConversationQueue = {
      version: 1,
      id: 'q',
      conversationKey: 'conv:a',
      status: 'running',
      items: [{
        id: 'i',
        content: 'one',
        state: 'sending',
        dispatchToken: 'dispatch-1',
        sendAttemptedAt: 1000,
        createdAt: 900,
        updatedAt: 1000,
      }],
      runtime: {
        phase: 'sending',
        activeItemId: 'i',
        baselineAssistantCount: 4,
        baselineAssistantTurnKey: 'turn-before-send',
        generationObserved: false,
      },
      createdAt: 900,
      updatedAt: 1050,
    };
    const backend = new FakeBackend(queue);
    const adapter = new FakeAdapter(idleSnapshot);

    await new QueueRunner(adapter, backend).evaluate('conv:a', true);

    expect(backend.calls).toEqual(['block:send-not-confirmed']);
    expect(adapter.sent).toEqual([]);
  });
});
