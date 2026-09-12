import { describe, expect, it } from 'vitest';
import type { AssistantArtifact } from '../../src/adapter/chatgpt-adapter';
import type { ConversationQueue, QueueItem } from '../../src/domain/types';
import { QueueBackedFlowRunHost } from '../../src/flowrun/content-host';

const item = (state: QueueItem['state']): QueueItem => ({
  id: 'flow-item',
  content: 'prompt',
  state,
  createdAt: 1,
  updatedAt: 1,
  ...(state === 'completed' ? { completedAt: 3 } : {}),
});

const queue = (state: QueueItem['state'], status: ConversationQueue['status']): ConversationQueue => ({
  version: 1,
  id: 'queue',
  conversationKey: 'conv:a',
  status,
  items: [item(state)],
  runtime: { phase: status === 'blocked' ? 'blocked' : status === 'running' ? 'generating' : 'idle' },
  ...(status === 'blocked' ? { blockedReason: 'network-error' } : {}),
  createdAt: 1,
  updatedAt: 1,
});

describe('QueueBackedFlowRunHost', () => {
  it('delegates queue reads, prompt insertion, start, conversation identity and assistant artifact', async () => {
    const calls: string[] = [];
    const artifact: AssistantArtifact = { turnKey: 'turn-1', text: 'answer' };
    const host = new QueueBackedFlowRunHost({
      conversationKey: () => 'conv:dynamic',
      getQueue: async () => { calls.push('get'); return queue('queued', 'idle'); },
      addPrompt: async (content) => { calls.push(`add:${content}`); return queue('queued', 'idle'); },
      startQueue: async () => { calls.push('start'); },
      latestAssistantArtifact: () => artifact,
      waitForSignal: async () => { calls.push('signal'); },
    });

    expect(host.conversationKey()).toBe('conv:dynamic');
    expect((await host.getQueue()).items[0]?.state).toBe('queued');
    expect((await host.addPrompt('hello')).items[0]?.content).toBe('prompt');
    await host.startQueue();
    expect(host.latestAssistantArtifact()).toEqual(artifact);
    expect(calls).toEqual(['get', 'add:hello', 'start']);
  });

  it('waits through nonterminal states and resolves when the exact item completes', async () => {
    const states = [queue('running', 'running'), queue('running', 'running'), queue('completed', 'completed')];
    let signalCount = 0;
    const host = new QueueBackedFlowRunHost({
      conversationKey: () => 'conv:a',
      getQueue: async () => structuredClone(states.shift() ?? queue('completed', 'completed')),
      addPrompt: async () => queue('queued', 'idle'),
      startQueue: async () => undefined,
      latestAssistantArtifact: () => null,
      waitForSignal: async () => { signalCount += 1; },
    });

    const terminal = await host.waitForItemTerminal('flow-item');

    expect(terminal.items[0]?.state).toBe('completed');
    expect(signalCount).toBe(2);
  });

  it('resolves immediately when the queue blocks and does not keep waiting', async () => {
    let signals = 0;
    const host = new QueueBackedFlowRunHost({
      conversationKey: () => 'conv:a',
      getQueue: async () => queue('running', 'blocked'),
      addPrompt: async () => queue('queued', 'idle'),
      startQueue: async () => undefined,
      latestAssistantArtifact: () => null,
      waitForSignal: async () => { signals += 1; },
    });

    const terminal = await host.waitForItemTerminal('flow-item');

    expect(terminal.status).toBe('blocked');
    expect(terminal.blockedReason).toBe('network-error');
    expect(signals).toBe(0);
  });

  it('fails closed if the tracked queue item disappears', async () => {
    const missing: ConversationQueue = {
      ...queue('running', 'running'),
      items: [],
    };
    const host = new QueueBackedFlowRunHost({
      conversationKey: () => 'conv:a',
      getQueue: async () => missing,
      addPrompt: async () => queue('queued', 'idle'),
      startQueue: async () => undefined,
      latestAssistantArtifact: () => null,
      waitForSignal: async () => undefined,
    });

    await expect(host.waitForItemTerminal('flow-item')).rejects.toThrow('flowrun-queue-item-missing');
  });
});
