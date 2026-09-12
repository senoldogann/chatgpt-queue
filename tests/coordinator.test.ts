import { describe, expect, it } from 'vitest';
import { QueueCoordinator } from '../src/coordinator/queue-coordinator';
import { QueueRepository, type StorageAreaLike } from '../src/storage/queue-repository';

class MemoryStorage implements StorageAreaLike {
  data: Record<string, unknown> = {};
  async get(key: string) { return { [key]: this.data[key] }; }
  async set(values: Record<string, unknown>) { Object.assign(this.data, values); }
}

const setup = () => {
  let now = 1000;
  let seq = 0;
  const storage = new MemoryStorage();
  const repo = new QueueRepository(storage);
  const coordinator = new QueueCoordinator(repo, {
    now: () => now,
    uuid: () => `id-${++seq}`,
    leaseMs: 100,
  });
  return { storage, repo, coordinator, setNow: (value: number) => { now = value; } };
};

describe('queue coordinator', () => {
  it('allows only one owner per conversation and recovers a stale owner', async () => {
    const { coordinator, setNow } = setup();
    await coordinator.ensureQueue('conv:a');

    expect((await coordinator.claim('conv:a', 1)).kind).toBe('acquired');
    expect(await coordinator.claim('conv:a', 2)).toMatchObject({ kind: 'conflict', ownerTabId: 1 });

    setNow(1200);
    expect(await coordinator.claim('conv:a', 2)).toMatchObject({ kind: 'acquired' });
  });

  it('reserves a queued item exactly once before DOM send', async () => {
    const { coordinator } = setup();
    await coordinator.ensureQueue('conv:a');
    await coordinator.add('conv:a', ['one', 'two']);
    await coordinator.claim('conv:a', 1);
    await coordinator.start('conv:a', 1);

    const first = await coordinator.reserveNext('conv:a', 1, 4);
    const reservedQueue = await coordinator.get('conv:a');
    expect(reservedQueue?.runtime.baselineAssistantCount).toBe(4);
    expect(first).toMatchObject({ content: 'one' });
    expect(await coordinator.reserveNext('conv:a', 1, 4)).toBeNull();

    const queue = await coordinator.get('conv:a');
    expect(queue?.items[0]?.state).toBe('sending');
    expect(queue?.runtime.phase).toBe('sending');
  });

  it('blocks an unresolved sending item after worker restart instead of resending', async () => {
    const { storage, coordinator } = setup();
    await coordinator.ensureQueue('conv:a');
    await coordinator.add('conv:a', ['one']);
    await coordinator.claim('conv:a', 1);
    await coordinator.start('conv:a', 1);
    await coordinator.reserveNext('conv:a', 1, 4);

    const restarted = new QueueCoordinator(new QueueRepository(storage), {
      now: () => 1050,
      uuid: () => 'after-restart',
      leaseMs: 100,
    });
    const recovered = await restarted.recover('conv:a');
    expect(recovered.status).toBe('blocked');
    expect(recovered.blockedReason).toBe('uncertain-send');
    expect(recovered.items[0]?.state).toBe('sending');
  });

  it('keeps an acknowledged running item recoverable across refresh', async () => {
    const { storage, coordinator } = setup();
    await coordinator.ensureQueue('conv:a');
    await coordinator.add('conv:a', ['one']);
    await coordinator.claim('conv:a', 1);
    await coordinator.start('conv:a', 1);
    const reservation = await coordinator.reserveNext('conv:a', 1, 4);
    await coordinator.ackSent('conv:a', 1, reservation!.itemId, reservation!.dispatchToken);

    const restarted = new QueueCoordinator(new QueueRepository(storage), {
      now: () => 1050,
      uuid: () => 'after-restart',
      leaseMs: 100,
    });
    const recovered = await restarted.recover('conv:a');
    expect(recovered.status).toBe('running');
    expect(recovered.items[0]?.state).toBe('running');
    expect(recovered.runtime.phase).toBe('waiting_generation_start');
  });

  it('handles duplicate completion idempotently and exposes the next item once', async () => {
    const { coordinator } = setup();
    await coordinator.ensureQueue('conv:a');
    await coordinator.add('conv:a', ['one', 'two']);
    await coordinator.claim('conv:a', 1);
    await coordinator.start('conv:a', 1);
    const reservation = await coordinator.reserveNext('conv:a', 1, 1);
    await coordinator.ackSent('conv:a', 1, reservation!.itemId, reservation!.dispatchToken);
    await coordinator.markGenerationStarted('conv:a', 1, reservation!.itemId, reservation!.dispatchToken);

    await coordinator.completeCurrent('conv:a', 1, reservation!.itemId, reservation!.dispatchToken);
    await coordinator.completeCurrent('conv:a', 1, reservation!.itemId, reservation!.dispatchToken);

    const queue = await coordinator.get('conv:a');
    expect(queue?.items.filter((item) => item.state === 'completed')).toHaveLength(1);
    expect(queue?.items.filter((item) => item.state === 'queued')).toHaveLength(1);
    expect(queue?.runtime.phase).toBe('ready_to_send_next');
  });

  it('completes the active item while paused but keeps the next item queued until resume', async () => {
    const { coordinator } = setup();
    await coordinator.ensureQueue('conv:a');
    await coordinator.add('conv:a', ['one', 'two']);
    await coordinator.claim('conv:a', 1);
    await coordinator.start('conv:a', 1);
    const reservation = await coordinator.reserveNext('conv:a', 1, 1);
    await coordinator.ackSent('conv:a', 1, reservation!.itemId, reservation!.dispatchToken);
    await coordinator.markGenerationStarted('conv:a', 1, reservation!.itemId, reservation!.dispatchToken);
    await coordinator.pause('conv:a', 1);

    const completed = await coordinator.completeCurrent('conv:a', 1, reservation!.itemId, reservation!.dispatchToken);
    expect(completed.status).toBe('paused');
    expect(completed.items.map((item) => item.state)).toEqual(['completed', 'queued']);
    expect(await coordinator.reserveNext('conv:a', 1, 2)).toBeNull();

    await coordinator.start('conv:a', 1);
    const next = await coordinator.reserveNext('conv:a', 1, 2);
    expect(next?.content).toBe('two');
  });

  it('preserves the active lifecycle phase across a recoverable block and resume', async () => {
    const { coordinator } = setup();
    await coordinator.ensureQueue('conv:a');
    await coordinator.add('conv:a', ['one']);
    await coordinator.claim('conv:a', 1);
    await coordinator.start('conv:a', 1);
    const reservation = await coordinator.reserveNext('conv:a', 1, 1);
    await coordinator.ackSent('conv:a', 1, reservation!.itemId, reservation!.dispatchToken);
    await coordinator.markGenerationStarted('conv:a', 1, reservation!.itemId, reservation!.dispatchToken);

    const blocked = await coordinator.block('conv:a', 1, 'dom-unrecognized');
    expect(blocked.status).toBe('blocked');
    expect(blocked.runtime.phase).toBe('generating');

    const resumed = await coordinator.start('conv:a', 1);
    expect(resumed.status).toBe('running');
    expect(resumed.runtime.phase).toBe('generating');
    expect(resumed.blockedReason).toBeUndefined();
  });

  it('isolates conversation mutations', async () => {
    const { coordinator } = setup();
    await coordinator.ensureQueue('conv:a');
    await coordinator.ensureQueue('conv:b');
    await coordinator.add('conv:a', ['a1']);
    await coordinator.add('conv:b', ['b1']);
    await coordinator.claim('conv:a', 1);
    await coordinator.start('conv:a', 1);

    expect((await coordinator.get('conv:a'))?.status).toBe('running');
    expect((await coordinator.get('conv:b'))?.status).toBe('idle');
    expect((await coordinator.get('conv:b'))?.items[0]?.content).toBe('b1');
  });

  it('stores the baseline assistant turn key with the dispatch reservation', async () => {
    const { coordinator } = setup();
    await coordinator.add('conv:turn-key', ['one']);
    await coordinator.claim('conv:turn-key', 1);
    await coordinator.start('conv:turn-key', 1);
    await coordinator.reserveNext('conv:turn-key', 1, 7, 'turn-before-send');
    const current = await coordinator.get('conv:turn-key');
    expect(current?.runtime.baselineAssistantCount).toBe(7);
    expect(current?.runtime.baselineAssistantTurnKey).toBe('turn-before-send');
  });

});
