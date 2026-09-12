import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BridgeMailbox } from '../../src/bridge/mailbox';
import { NodeBridgeClient } from '../../src/cli/bridge-client';

const JOB_ID = '123e4567-e89b-42d3-a456-426614174000';

describe('NodeBridgeClient follow', () => {
  it('times out locally without cancelling or mutating the unattended job', async () => {
    const root = await mkdtemp(join(tmpdir(), 'flowrun-follow-'));
    const mailbox = new BridgeMailbox(root);
    let now = 0;
    const client = new NodeBridgeClient(
      mailbox,
      'a'.repeat(64),
      () => now,
      () => JOB_ID,
      async (ms) => { now += ms; },
    );

    await expect(client.follow(JOB_ID, 500)).rejects.toThrow('bridge-follow-timeout');
    expect(await mailbox.readResult(JOB_ID)).toBeUndefined();
    expect(await mailbox.readEvents(JOB_ID)).toEqual([]);
  });
});
