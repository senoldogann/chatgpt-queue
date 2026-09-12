import { describe, expect, it, vi } from 'vitest';
import type { AssistantArtifact } from '../../src/adapter/chatgpt-adapter';
import type { ConversationQueue } from '../../src/domain/types';
import { FlowRunBrowserController, type BrowserRunRepository } from '../../src/flowrun/browser-controller';
import type { BrowserChatProviderHost } from '../../src/flowrun/browser-chat-provider';
import type { WorkflowRun } from '../../src/flowrun/events';
import type { ChatExecutionRequest, ChatProvider } from '../../src/flowrun/provider';
import { validateWorkflowDocument } from '../../src/flowrun/schema';

const workflow = () => {
  const result = validateWorkflowDocument({
    version: 1,
    name: 'browser-flow',
    inputs: { topic: { type: 'string', required: true } },
    steps: [
      { id: 'first', type: 'chat', provider: 'chatgpt', prompt: 'Analyze {{ inputs.topic }}' },
      { id: 'second', type: 'chat', provider: 'chatgpt', prompt: 'Continue with {{ steps.first.output }}' },
    ],
  });
  if (!result.ok) throw new Error('invalid fixture');
  return result.value;
};

const emptyQueue = (): ConversationQueue => ({
  version: 1,
  id: 'queue',
  conversationKey: 'conv:browser',
  status: 'idle',
  items: [],
  runtime: { phase: 'idle' },
  createdAt: 1,
  updatedAt: 1,
});

class FakeHost implements BrowserChatProviderHost {
  current = emptyQueue();
  conversationKey() { return 'conv:browser'; }
  async getQueue() { return structuredClone(this.current); }
  async addPrompt() { throw new Error('unused'); }
  async startQueue() { throw new Error('unused'); }
  async waitForItemTerminal() { throw new Error('unused'); }
  latestAssistantArtifact(): AssistantArtifact | null { return null; }
}

class RecordingRepository implements BrowserRunRepository {
  puts: WorkflowRun[] = [];
  latest?: WorkflowRun;
  interrupted?: WorkflowRun;
  async put(run: WorkflowRun) {
    this.puts.push(structuredClone(run));
    this.latest = structuredClone(run);
  }
  async latestForConversation() { return this.latest ? structuredClone(this.latest) : undefined; }
  async blockInterruptedForConversation() { return this.interrupted ? structuredClone(this.interrupted) : undefined; }
}

const ids = () => {
  let value = 0;
  return (prefix: string) => `${prefix}-${++value}`;
};

describe('FlowRunBrowserController', () => {
  it('refuses to start before engine execution when the normal queue is busy', async () => {
    const host = new FakeHost();
    host.current.items.push({ id: 'queued', content: 'normal queue', state: 'queued', createdAt: 1, updatedAt: 1 });
    const repository = new RecordingRepository();
    const provider: ChatProvider = { id: 'chatgpt', execute: vi.fn() };
    const controller = new FlowRunBrowserController({ host, repository, provider });

    await expect(controller.run(workflow(), { topic: 'queues' })).rejects.toThrow('queue-busy');
    expect(provider.execute).not.toHaveBeenCalled();
    expect(repository.puts).toEqual([]);
  });

  it('persists snapshots throughout a two-step run and preserves output chaining', async () => {
    const host = new FakeHost();
    const repository = new RecordingRepository();
    const calls: ChatExecutionRequest[] = [];
    const provider: ChatProvider = {
      id: 'chatgpt',
      execute: async (request) => {
        calls.push(request);
        return {
          kind: 'completed',
          output: request.stepId === 'first' ? 'architecture result' : 'tests done',
          receipt: { provider: 'chatgpt', dispatchToken: request.dispatchToken },
        };
      },
    };
    let now = 100;
    const controller = new FlowRunBrowserController({
      host,
      repository,
      provider,
      idFactory: ids(),
      now: () => ++now,
    });

    const run = await controller.run(workflow(), { topic: 'queues' });

    expect(run.status).toBe('completed');
    expect(run.browser).toEqual({ conversationKey: 'conv:browser' });
    expect(calls[0]?.prompt).toBe('Analyze queues');
    expect(calls[1]?.prompt).toBe('Continue with architecture result');
    expect(repository.puts.length).toBeGreaterThan(4);
    expect(repository.puts.some((snapshot) => snapshot.status === 'running')).toBe(true);
    expect(repository.puts.at(-1)?.status).toBe('completed');
    expect(repository.puts.at(-1)?.steps.map((step) => step.output)).toEqual(['architecture result', 'tests done']);
    expect(controller.currentRun()?.status).toBe('completed');
  });

  it('persists a provider block as the terminal current run', async () => {
    const repository = new RecordingRepository();
    const provider: ChatProvider = {
      id: 'chatgpt',
      execute: async () => ({ kind: 'blocked', reason: 'message-delivery-timeout' }),
    };
    const controller = new FlowRunBrowserController({
      host: new FakeHost(),
      repository,
      provider,
      idFactory: ids(),
    });

    const run = await controller.run(workflow(), { topic: 'queues' });

    expect(run.status).toBe('blocked');
    expect(run.steps[0]).toMatchObject({ status: 'blocked', error: 'message-delivery-timeout' });
    expect(repository.puts.at(-1)?.status).toBe('blocked');
    expect(repository.puts.at(-1)?.browser?.conversationKey).toBe('conv:browser');
  });

  it('recovers an interrupted persisted run without invoking a provider', async () => {
    const repository = new RecordingRepository();
    repository.interrupted = {
      id: 'run-old',
      workflowName: 'browser-flow',
      workflowVersion: 1,
      status: 'blocked',
      inputs: {},
      steps: [{ id: 'first', status: 'blocked', error: 'browser-session-interrupted' }],
      events: [{ id: 'event', runId: 'run-old', at: 1, kind: 'run.blocked', data: { reason: 'browser-session-interrupted' } }],
      browser: { conversationKey: 'conv:browser' },
      createdAt: 1,
      updatedAt: 2,
    };
    const provider: ChatProvider = { id: 'chatgpt', execute: vi.fn() };
    const controller = new FlowRunBrowserController({ host: new FakeHost(), repository, provider });

    const recovered = await controller.recoverInterrupted('conv:browser');

    expect(recovered?.status).toBe('blocked');
    expect(controller.currentRun()?.id).toBe('run-old');
    expect(provider.execute).not.toHaveBeenCalled();
  });
});
