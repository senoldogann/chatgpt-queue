import { describe, expect, it } from 'vitest';
import type { AssistantArtifact } from '../../src/adapter/chatgpt-adapter';
import type { ConversationQueue, QueueItem } from '../../src/domain/types';
import { BrowserChatProvider, type BrowserChatProviderHost } from '../../src/flowrun/browser-chat-provider';

const item = (id: string, content: string, state: QueueItem['state']): QueueItem => ({
  id,
  content,
  state,
  createdAt: 1,
  updatedAt: 1,
  ...(state === 'completed' ? { startedAt: 2, completedAt: 3 } : {}),
});

const queue = (
  items: QueueItem[] = [],
  status: ConversationQueue['status'] = 'idle',
  blockedReason?: string,
): ConversationQueue => ({
  version: 1,
  id: 'queue-1',
  conversationKey: 'conv:a',
  status,
  items,
  runtime: { phase: status === 'running' ? 'generating' : status === 'blocked' ? 'blocked' : 'idle' },
  ...(blockedReason ? { blockedReason } : {}),
  createdAt: 1,
  updatedAt: 1,
});

class FakeHost implements BrowserChatProviderHost {
  calls: string[] = [];
  current = queue();
  terminal = queue([item('new-item', 'prompt', 'completed')], 'completed');
  artifact: AssistantArtifact | null = { turnKey: 'turn-new', text: 'assistant output' };
  baseline: AssistantArtifact | null = { turnKey: 'turn-old', text: 'old output' };

  conversationKey() { return 'conv:a'; }
  async getQueue() { this.calls.push('getQueue'); return structuredClone(this.current); }
  async addPrompt(content: string) {
    this.calls.push(`add:${content}`);
    this.current = queue([...this.current.items, item('new-item', content, 'queued')], 'idle');
    return structuredClone(this.current);
  }
  async startQueue() { this.calls.push('start'); }
  async waitForItemTerminal(itemId: string) { this.calls.push(`wait:${itemId}`); return structuredClone(this.terminal); }
  latestAssistantArtifact() {
    this.calls.push('artifact');
    if (this.calls.filter((call) => call === 'artifact').length === 1) return this.baseline;
    return this.artifact;
  }
}

const request = {
  runId: 'run-1',
  stepId: 'review',
  prompt: 'prompt',
  dispatchToken: 'flow-dispatch-1',
};

describe('BrowserChatProvider', () => {
  it('blocks before dispatch when the normal queue is busy', async () => {
    const host = new FakeHost();
    host.current = queue([item('existing', 'existing', 'queued')], 'idle');

    const result = await new BrowserChatProvider(host).execute(request);

    expect(result).toEqual({ kind: 'blocked', reason: 'queue-busy' });
    expect(host.calls).toEqual(['getQueue']);
  });

  it('dispatches exactly one prompt through the queue and captures the new assistant artifact', async () => {
    const host = new FakeHost();

    const result = await new BrowserChatProvider(host).execute(request);

    expect(host.calls).toEqual(['getQueue', 'artifact', 'add:prompt', 'start', 'wait:new-item', 'artifact']);
    expect(result).toEqual({
      kind: 'completed',
      output: 'assistant output',
      receipt: {
        provider: 'chatgpt',
        dispatchToken: 'flow-dispatch-1',
        startedAt: 2,
        completedAt: 3,
        conversationKey: 'conv:a',
        metadata: { queueItemId: 'new-item', assistantTurnKey: 'turn-new' },
      },
    });
  });

  it('blocks when the queue blocks and preserves the exact queue reason without retrying', async () => {
    const host = new FakeHost();
    host.terminal = queue([item('new-item', 'prompt', 'running')], 'blocked', 'message-delivery-timeout');

    const result = await new BrowserChatProvider(host).execute(request);

    expect(result).toEqual({
      kind: 'blocked',
      reason: 'message-delivery-timeout',
      receipt: {
        provider: 'chatgpt',
        dispatchToken: 'flow-dispatch-1',
        conversationKey: 'conv:a',
        metadata: { queueItemId: 'new-item' },
      },
    });
    expect(host.calls.filter((call) => call === 'start')).toHaveLength(1);
    expect(host.calls.filter((call) => call.startsWith('add:'))).toHaveLength(1);
  });

  it('blocks if no completed assistant artifact is available after queue completion', async () => {
    const host = new FakeHost();
    host.artifact = null;

    expect(await new BrowserChatProvider(host).execute(request)).toEqual({
      kind: 'blocked',
      reason: 'assistant-output-unavailable',
      receipt: {
        provider: 'chatgpt',
        dispatchToken: 'flow-dispatch-1',
        startedAt: 2,
        completedAt: 3,
        conversationKey: 'conv:a',
        metadata: { queueItemId: 'new-item' },
      },
    });
  });

  it('blocks if completion points at the same assistant turn that existed before dispatch', async () => {
    const host = new FakeHost();
    host.artifact = { turnKey: 'turn-old', text: 'old output' };

    expect(await new BrowserChatProvider(host).execute(request)).toEqual({
      kind: 'blocked',
      reason: 'assistant-turn-not-advanced',
      receipt: {
        provider: 'chatgpt',
        dispatchToken: 'flow-dispatch-1',
        startedAt: 2,
        completedAt: 3,
        conversationKey: 'conv:a',
        metadata: { queueItemId: 'new-item', assistantTurnKey: 'turn-old' },
      },
    });
  });
});
