import { describe, expect, it, vi } from 'vitest';
import { BridgeContentController, publishRecoveredBridgeRun, type BridgeJobUpdate } from '../../src/bridge/content-controller';

const workflow = {
  version: 1 as const,
  name: 'bridge-job',
  inputs: {},
  steps: [{ id: 'one', type: 'chat' as const, provider: 'chatgpt', prompt: 'Continue' }],
};

const completedRun = {
  id: 'run-1', workflowName: 'bridge-job', workflowVersion: 1 as const, status: 'completed' as const,
  inputs: {}, steps: [{ id: 'one', status: 'completed' as const, output: 'done' }], events: [], createdAt: 1, updatedAt: 2,
};

const publishSpy = () => vi.fn(async (_jobId: string, _update: BridgeJobUpdate) => undefined);

describe('BridgeContentController', () => {
  it('starts an accepted job exactly once and publishes running then terminal state', async () => {
    const run = vi.fn(async (_workflow: typeof workflow, _inputs: Record<string, string>, _context: { bridgeJobId: string }) => completedRun);
    const publish = publishSpy();
    const controller = new BridgeContentController({ run, publish });
    const job = { jobId: 'job-1', workflow, inputs: {} };

    const first = controller.accept(job);
    const duplicate = controller.accept(job);
    expect(first).toBe(duplicate);
    await first;

    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[2]).toEqual({ bridgeJobId: 'job-1' });
    expect(publish.mock.calls[0]?.[1]).toMatchObject({ status: 'running' });
    expect(publish.mock.calls.at(-1)?.[1]).toMatchObject({ status: 'completed', workflowRunId: 'run-1' });
  });

  it('maps blocked/failed runs and execution errors without retrying', async () => {
    const publish = publishSpy();
    const blocked = new BridgeContentController({
      run: async () => ({ ...completedRun, status: 'blocked' as const, steps: [{ id: 'one', status: 'blocked' as const, error: 'dom-unrecognized' }] }),
      publish,
    });
    await blocked.accept({ jobId: 'job-b', workflow, inputs: {} });
    expect(publish.mock.calls.at(-1)?.[1]).toMatchObject({ status: 'blocked', error: 'dom-unrecognized' });

    const failedPublish = publishSpy();
    const failed = new BridgeContentController({ run: async () => { throw new Error('queue-busy'); }, publish: failedPublish });
    await failed.accept({ jobId: 'job-f', workflow, inputs: {} });
    expect(failedPublish.mock.calls.at(-1)?.[1]).toMatchObject({ status: 'failed', error: 'queue-busy' });
  });

  it('reconciles a recovered interrupted browser run back to its durable bridge job', async () => {
    const publish = publishSpy();
    const recovered = {
      ...completedRun,
      status: 'blocked' as const,
      steps: [{ id: 'one', status: 'blocked' as const, error: 'browser-session-interrupted' }],
      browser: { conversationKey: 'conv:a', bridgeJobId: 'job-bridge' },
    };

    expect(await publishRecoveredBridgeRun(recovered, publish)).toBe(true);
    expect(publish).toHaveBeenCalledWith('job-bridge', {
      status: 'blocked',
      workflowRunId: 'run-1',
      error: 'browser-session-interrupted',
    });
  });

  it('does not publish recovery for a manual browser run with no bridge job link', async () => {
    const publish = publishSpy();
    expect(await publishRecoveredBridgeRun({ ...completedRun, browser: { conversationKey: 'conv:a' } }, publish)).toBe(false);
    expect(publish).not.toHaveBeenCalled();
  });
});
