import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BridgeMailbox } from '../../src/bridge/mailbox';

const request = {
  version: 1 as const,
  jobId: '123e4567-e89b-42d3-a456-426614174000',
  secret: 's'.repeat(64),
  kind: 'targets' as const,
  createdAt: 1,
  expiresAt: 100,
  payload: {},
};

const jobId = (index: number): string => `123e4567-e89b-42d3-a456-${index.toString(16).padStart(12, '0')}`;

describe('BridgeMailbox', () => {
  it('submits requests atomically and reads them back', async () => {
    const root = await mkdtemp(join(tmpdir(), 'flowrun-mailbox-'));
    const box = new BridgeMailbox(root);
    await box.submit(request);

    expect(await box.readRequest(request.jobId)).toEqual(request);
    expect((await readdir(join(root, 'inbox'))).filter((name) => name.includes('.tmp'))).toEqual([]);
  });

  it('writes ordered events and one final result', async () => {
    const root = await mkdtemp(join(tmpdir(), 'flowrun-mailbox-'));
    const box = new BridgeMailbox(root);
    await box.writeEvent(request.jobId, 2, { status: 'running' });
    await box.writeEvent(request.jobId, 1, { status: 'accepted' });
    await box.writeResult(request.jobId, { status: 'completed' });

    expect(await box.readEvents(request.jobId)).toEqual([{ status: 'accepted' }, { status: 'running' }]);
    expect(await box.readResult(request.jobId)).toEqual({ status: 'completed' });
  });

  it('continues event sequence numbers after a native host restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'flowrun-mailbox-'));
    const firstHost = new BridgeMailbox(root);
    await firstHost.writeEvent(request.jobId, 1, { status: 'accepted' });
    await firstHost.writeEvent(request.jobId, 2, { status: 'running' });

    const restartedHost = new BridgeMailbox(root);
    const next = await restartedHost.nextEventSequence(request.jobId);
    expect(next).toBe(3);
    await restartedHost.writeEvent(request.jobId, next, { status: 'completed' });

    expect(await restartedHost.readEvents(request.jobId)).toEqual([
      { status: 'accepted' },
      { status: 'running' },
      { status: 'completed' },
    ]);
  });

  it('removes accepted inbox requests and bounds completed result/event history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'flowrun-mailbox-'));
    const box = new BridgeMailbox(root, 2);

    for (let index = 1; index <= 3; index += 1) {
      const id = jobId(index);
      await box.submit({ ...request, jobId: id });
      await box.writeEvent(id, 1, { status: 'accepted' });
      await box.writeResult(id, { status: 'completed' });
      await new Promise((resolve) => setTimeout(resolve, 2));
    }

    expect((await readdir(join(root, 'inbox'))).filter((name) => name.endsWith('.json'))).toEqual([]);
    expect((await readdir(join(root, 'results'))).filter((name) => name.endsWith('.json'))).toHaveLength(2);
    expect((await readdir(join(root, 'events'))).filter((name) => name.endsWith('.json'))).toHaveLength(2);
  });

  it('rejects unsafe job ids before touching paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'flowrun-mailbox-'));
    const box = new BridgeMailbox(root);
    await expect(box.readRequest('../escape')).rejects.toThrow('bridge.invalid-job-id');
    await expect(readFile(join(root, '..', 'escape.json'), 'utf8')).rejects.toBeTruthy();
  });
});
