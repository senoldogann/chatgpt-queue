import type { BridgeJobRecord } from './protocol';

export type BridgeJobOwnershipDecision =
  | { kind: 'authorized' }
  | { kind: 'bind-owner'; ownerTabId: number };

export const decideBridgeJobOwnership = (
  record: BridgeJobRecord,
  senderTabId: number,
  durableQueueOwnerTabId?: number,
): BridgeJobOwnershipDecision => {
  if (record.ownerTabId !== undefined) {
    if (record.ownerTabId !== senderTabId) throw new Error('bridge-target-owner-mismatch');
    return { kind: 'authorized' };
  }
  if (durableQueueOwnerTabId !== senderTabId) throw new Error('bridge-target-owner-mismatch');
  return { kind: 'bind-owner', ownerTabId: senderTabId };
};
