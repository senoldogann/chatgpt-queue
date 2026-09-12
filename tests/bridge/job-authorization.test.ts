import { describe, expect, it } from 'vitest';
import { decideBridgeJobOwnership } from '../../src/bridge/job-authorization';
import type { BridgeJobRecord } from '../../src/bridge/protocol';

const record = (ownerTabId?: number): BridgeJobRecord => ({
  version: 1,
  jobId: '123e4567-e89b-42d3-a456-426614174000',
  kind: 'run',
  targetId: 'target:opaque',
  conversationKey: 'conv:a',
  ...(ownerTabId === undefined ? {} : { ownerTabId }),
  status: 'running',
  createdAt: 1,
  updatedAt: 2,
});

describe('bridge job ownership', () => {
  it('authorizes updates from the persisted owner tab without consulting target registry state', () => {
    expect(decideBridgeJobOwnership(record(9), 9)).toEqual({ kind: 'authorized' });
  });

  it('rejects updates from a different persisted owner tab', () => {
    expect(() => decideBridgeJobOwnership(record(9), 10)).toThrow('bridge-target-owner-mismatch');
  });

  it('migrates a legacy record only when the durable queue owner matches the sender tab', () => {
    expect(decideBridgeJobOwnership(record(), 9, 9)).toEqual({ kind: 'bind-owner', ownerTabId: 9 });
  });

  it('rejects a legacy record when the durable queue owner is missing or belongs to another tab', () => {
    expect(() => decideBridgeJobOwnership(record(), 9)).toThrow('bridge-target-owner-mismatch');
    expect(() => decideBridgeJobOwnership(record(), 9, 10)).toThrow('bridge-target-owner-mismatch');
  });
});
