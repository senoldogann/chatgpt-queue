import { describe, expect, it } from 'vitest';
import { executeWorkflow } from '../../src/flowrun/engine';
import type { ChatExecutionRequest, ChatProvider } from '../../src/flowrun/provider';
import { validateWorkflowDocument } from '../../src/flowrun/schema';

const workflow = (assertions = true) => {
  const result = validateWorkflowDocument({
    version: 1,
    name: 'engine-test',
    inputs: { topic: { type: 'string', required: true } },
    steps: [
      { id: 'first', type: 'chat', provider: 'chatgpt', prompt: 'Analyze {{ inputs.topic }}' },
      {
        id: 'second',
        type: 'chat',
        provider: 'chatgpt',
        prompt: 'Follow up on {{ steps.first.output }}',
        ...(assertions ? { assert: [{ type: 'output_contains', value: 'done' }] } : {}),
      },
    ],
  });
  if (!result.ok) throw new Error('fixture invalid');
  return result.value;
};

const options = (sequence: string[]) => {
  let id = 0;
  let now = 1000;
  return {
    idFactory: (prefix: string) => `${prefix}-${++id}`,
    now: () => ++now,
    onEvent: (event: { kind: string }) => sequence.push(`event:${event.kind}`),
  };
};

describe('FlowRun deterministic engine', () => {
  it('executes sequentially, reserves before provider invocation, and renders previous outputs', async () => {
    const calls: ChatExecutionRequest[] = [];
    const sequence: string[] = [];
    const provider: ChatProvider = {
      id: 'chatgpt',
      execute: async (request) => {
        sequence.push('provider');
        calls.push(request);
        return {
          kind: 'completed',
          output: request.stepId === 'first' ? 'first done' : 'second done',
          receipt: { provider: 'chatgpt', dispatchToken: request.dispatchToken },
        };
      },
    };

    const run = await executeWorkflow(workflow(), { topic: 'queues' }, { chatgpt: provider }, options(sequence));

    expect(run.status).toBe('completed');
    expect(calls.map((call) => call.stepId)).toEqual(['first', 'second']);
    expect(calls[0]?.prompt).toBe('Analyze queues');
    expect(calls[1]?.prompt).toBe('Follow up on first done');
    expect(sequence.indexOf('event:step.dispatch_reserved')).toBeLessThan(sequence.indexOf('provider'));
    expect(run.steps.map((step) => step.status)).toEqual(['completed', 'completed']);
    expect(run.events.at(-1)?.kind).toBe('run.completed');
  });

  it('blocks fail-closed and never dispatches later steps when the provider blocks', async () => {
    const calls: ChatExecutionRequest[] = [];
    const provider: ChatProvider = {
      id: 'chatgpt',
      execute: async (request) => {
        calls.push(request);
        return { kind: 'blocked', reason: 'confirmation-required' };
      },
    };

    const run = await executeWorkflow(workflow(false), { topic: 'queues' }, { chatgpt: provider }, options([]));

    expect(run.status).toBe('blocked');
    expect(calls).toHaveLength(1);
    expect(run.steps[0]?.status).toBe('blocked');
    expect(run.steps[1]?.status).toBe('pending');
    expect(run.events.filter((event) => event.kind === 'step.dispatch_reserved')).toHaveLength(1);
    expect(run.events.at(-1)).toMatchObject({ kind: 'run.blocked', stepId: 'first' });
  });

  it('fails the run on assertion failure without dispatching another step', async () => {
    const calls: ChatExecutionRequest[] = [];
    const provider: ChatProvider = {
      id: 'chatgpt',
      execute: async (request) => {
        calls.push(request);
        return {
          kind: 'completed',
          output: request.stepId === 'first' ? 'first result' : 'missing keyword',
          receipt: { provider: 'chatgpt', dispatchToken: request.dispatchToken },
        };
      },
    };

    const run = await executeWorkflow(workflow(), { topic: 'queues' }, { chatgpt: provider }, options([]));

    expect(calls).toHaveLength(2);
    expect(run.status).toBe('failed');
    expect(run.steps[1]?.status).toBe('failed');
    expect(run.events.some((event) => event.kind === 'step.assertion_failed')).toBe(true);
    expect(run.events.at(-1)?.kind).toBe('run.failed');
  });

  it('fails before dispatch when a provider is unavailable', async () => {
    const run = await executeWorkflow(workflow(false), { topic: 'queues' }, {}, options([]));
    expect(run.status).toBe('failed');
    expect(run.steps[0]?.status).toBe('failed');
    expect(run.events.at(-1)).toMatchObject({ kind: 'run.failed', stepId: 'first' });
  });
});
