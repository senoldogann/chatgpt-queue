import { describe, expect, it } from 'vitest';
import { BridgeJobRepository, MAX_BRIDGE_JOB_HISTORY, type BridgeStorageArea } from '../../src/bridge/job-repository';
import type { BridgeJobRecord } from '../../src/bridge/protocol';

class MemoryStorage implements BridgeStorageArea {
  data: Record<string, unknown> = {};
  async get(key: string) { return { [key]: this.data[key] }; }
  async set(values: Record<string, unknown>) { Object.assign(this.data, structuredClone(values)); }
}

class YieldingStorage extends MemoryStorage {
  override async get(key: string) {
    const result = await super.get(key);
    await Promise.resolve();
    return result;
  }

  override async set(values: Record<string, unknown>) {
    await Promise.resolve();
    await super.set(values);
  }
}

const record = (jobId: string, updatedAt: number, conversationKey = 'conv:a'): BridgeJobRecord => ({
  version: 1,
  jobId,
  kind: 'run',
  targetId: 'target:1',
  conversationKey,
  ownerTabId: 1,
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

    expect(updated).toMatchObject({ jobId: 'job-1', conversationKey: 'conv:a', ownerTabId: 1, status: 'running', workflowRunId: 'run-1', updatedAt: 3 });
  });

  it('binds an owner to a legacy record once and never allows ownership to change', async () => {
    const storage = new MemoryStorage();
    const repo = new BridgeJobRepository(storage);
    const legacy = record('job-legacy', 1) as BridgeJobRecord & { ownerTabId?: number };
    delete legacy.ownerTabId;
    await repo.accept(legacy);

    const bound = await repo.bindOwner('job-legacy', 9);
    expect(bound.ownerTabId).toBe(9);
    expect((await repo.get('job-legacy'))?.ownerTabId).toBe(9);
    await expect(repo.bindOwner('job-legacy', 10)).rejects.toThrow('bridge-target-owner-mismatch');
  });

  it('serializes concurrent accepts so jobs for different conversations cannot overwrite each other', async () => {
    const repo = new BridgeJobRepository(new YieldingStorage());

    await Promise.all([
      repo.accept(record('job-a', 1, 'conv:a')),
      repo.accept(record('job-b', 2, 'conv:b')),
    ]);

    const list = await repo.list();
    expect(list.map((entry) => entry.jobId).sort()).toEqual(['job-a', 'job-b']);
  });

  it('enforces durable single-flight for one conversation even when accepts race', async () => {
    const repo = new BridgeJobRepository(new YieldingStorage());

    const results = await Promise.allSettled([
      repo.accept(record('job-a', 1, 'conv:a')),
      repo.accept(record('job-b', 2, 'conv:a')),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(String(rejected?.reason?.message ?? rejected?.reason)).toContain('bridge.target-busy');
    const list = await repo.list();
    expect(list).toHaveLength(1);
    expect(['job-a', 'job-b']).toContain(list[0]?.jobId);
  });

  it('allows a new job for the same conversation after the previous one is terminal', async () => {
    const repo = new BridgeJobRepository(new MemoryStorage());
    await repo.accept(record('job-a', 1, 'conv:a'));
    await repo.update('job-a', { status: 'completed', updatedAt: 2 });

    const next = await repo.accept(record('job-b', 3, 'conv:a'));
    expect(next.created).toBe(true);
    expect((await repo.get('job-b'))?.status).toBe('accepted');
  });

  it('bounds history to the newest records', async () => {
    const repo = new BridgeJobRepository(new MemoryStorage());
    for (let index = 0; index < MAX_BRIDGE_JOB_HISTORY + 3; index += 1) {
      const current = record(`job-${index}`, index, `conv:${index}`);
      await repo.accept(current);
    }

    const list = await repo.list();
    expect(list).toHaveLength(MAX_BRIDGE_JOB_HISTORY);
    expect(list[0]?.jobId).toBe('job-3');
    expect(list.at(-1)?.jobId).toBe(`job-${MAX_BRIDGE_JOB_HISTORY + 2}`);
    expect(await repo.get('job-0')).toBeUndefined();
  });
});
