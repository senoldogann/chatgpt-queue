import { describe, expect, it } from 'vitest';
import { BridgeJobRepository, MAX_BRIDGE_JOB_HISTORY, type BridgeStorageArea } from '../../src/bridge/job-repository';
import type { BridgeJobRecord } from '../../src/bridge/protocol';

class MemoryStorage implements BridgeStorageArea {
  data: Record<string, unknown> = {};
  async get(key: string) { return { [key]: this.data[key] }; }
  async set(values: Record<string, unknown>) { Object.assign(this.data, structuredClone(values)); }
}

const record = (jobId: string, updatedAt: number): BridgeJobRecord => ({
  version: 1,
  jobId,
  kind: 'run',
  targetId: 'target:1',
  conversationKey: 'conv:a',
  status: 'accepted',
  createdAt: updatedAt,
  updatedAt,
});

describe('BridgeJobRepository', () => {
  it('accepts a job idempotently and keeps the original record', async () => {
    const repo = new BridgeJobRepository(new MemoryStorage());
    const first = await repo.accept(record('job-1', 1));
    const duplicate = await repo.accept({ ...record('job-1', 2), conversationKey: 'conv:b' });

    expect(first.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(duplicate.record.conversationKey).toBe('conv:a');
  });

  it('updates mutable state without changing identity', async () => {
    const repo = new BridgeJobRepository(new MemoryStorage());
    await repo.accept(record('job-1', 1));
    const updated = await repo.update('job-1', { status: 'running', workflowRunId: 'run-1', updatedAt: 3 });

    expect(updated).toMatchObject({ jobId: 'job-1', conversationKey: 'conv:a', status: 'running', workflowRunId: 'run-1', updatedAt: 3 });
  });

  it('bounds history to the newest records', async () => {
    const repo = new BridgeJobRepository(new MemoryStorage());
    for (let index = 0; index < MAX_BRIDGE_JOB_HISTORY + 3; index += 1) {
      await repo.accept(record(`job-${index}`, index));
    }

    const list = await repo.list();
    expect(list).toHaveLength(MAX_BRIDGE_JOB_HISTORY);
    expect(list[0]?.jobId).toBe('job-3');
    expect(list.at(-1)?.jobId).toBe(`job-${MAX_BRIDGE_JOB_HISTORY + 2}`);
    expect(await repo.get('job-0')).toBeUndefined();
  });
});
