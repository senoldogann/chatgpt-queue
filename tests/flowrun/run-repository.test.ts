import { describe, expect, it } from 'vitest';
import type { WorkflowRun } from '../../src/flowrun/events';
import { FlowRunRunRepository, MAX_FLOWRUN_HISTORY, type FlowRunStorageArea } from '../../src/flowrun/run-repository';

class MemoryStorage implements FlowRunStorageArea {
  values: Record<string, unknown> = {};
  async get(key: string) { return { [key]: this.values[key] }; }
  async set(values: Record<string, unknown>) { Object.assign(this.values, structuredClone(values)); }
}

const run = (id: string, conversationKey = 'conv:a', status: WorkflowRun['status'] = 'completed'): WorkflowRun => ({
  id,
  workflowName: 'test-flow',
  workflowVersion: 1,
  status,
  inputs: {},
  steps: [{ id: 'step', status: status === 'running' ? 'waiting' : status === 'blocked' ? 'blocked' : 'completed' }],
  events: [],
  createdAt: Number(id.replace(/\D/g, '')) || 1,
  updatedAt: Number(id.replace(/\D/g, '')) || 1,
  browser: { conversationKey },
});

describe('FlowRunRunRepository', () => {
  it('starts empty and returns cloned persisted runs', async () => {
    const storage = new MemoryStorage();
    const repo = new FlowRunRunRepository(storage);
    expect(await repo.list()).toEqual([]);

    const value = run('run-1');
    await repo.put(value);
    value.status = 'failed';

    expect((await repo.get('run-1'))?.status).toBe('completed');
    expect((await repo.list()).map((item) => item.id)).toEqual(['run-1']);
  });

  it('updates an existing run without duplicating it in order', async () => {
    const repo = new FlowRunRunRepository(new MemoryStorage());
    await repo.put(run('run-1'));
    await repo.put(run('run-2'));
    const updated = run('run-1');
    updated.status = 'failed';
    await repo.put(updated);

    expect((await repo.list()).map((item) => item.id)).toEqual(['run-2', 'run-1']);
    expect((await repo.get('run-1'))?.status).toBe('failed');
  });

  it('keeps only the most recent bounded history', async () => {
    const repo = new FlowRunRunRepository(new MemoryStorage());
    for (let index = 1; index <= MAX_FLOWRUN_HISTORY + 2; index += 1) {
      await repo.put(run(`run-${index}`));
    }

    const ids = (await repo.list()).map((item) => item.id);
    expect(ids).toHaveLength(MAX_FLOWRUN_HISTORY);
    expect(ids[0]).toBe('run-3');
    expect(ids.at(-1)).toBe(`run-${MAX_FLOWRUN_HISTORY + 2}`);
    expect(await repo.get('run-1')).toBeUndefined();
  });

  it('finds the latest run for one conversation', async () => {
    const repo = new FlowRunRunRepository(new MemoryStorage());
    await repo.put(run('run-1', 'conv:a'));
    await repo.put(run('run-2', 'conv:b'));
    await repo.put(run('run-3', 'conv:a'));

    expect((await repo.latestForConversation('conv:a'))?.id).toBe('run-3');
    expect((await repo.latestForConversation('conv:missing'))).toBeUndefined();
  });

  it('blocks an interrupted persisted run without creating another dispatch', async () => {
    const repo = new FlowRunRunRepository(new MemoryStorage());
    await repo.put(run('run-1', 'conv:a', 'running'));

    const recovered = await repo.blockInterruptedForConversation('conv:a', {
      now: () => 99,
      idFactory: () => 'event-recovery',
    });

    expect(recovered?.status).toBe('blocked');
    expect(recovered?.steps[0]).toMatchObject({ status: 'blocked', error: 'browser-session-interrupted' });
    expect(recovered?.events.at(-1)).toEqual({
      id: 'event-recovery',
      runId: 'run-1',
      at: 99,
      kind: 'run.blocked',
      data: { reason: 'browser-session-interrupted' },
    });
    expect((await repo.get('run-1'))?.status).toBe('blocked');
  });
});
