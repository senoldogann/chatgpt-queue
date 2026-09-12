import type { BridgeJobRecord } from './protocol';

export type BridgeJobOwnershipDecision =
  | { kind: 'authorized' }
  | { kind: 'bind-owner'; ownerTabId: number };

/**
 * Records persisted before jobs carried an owner tab cannot be authorized by identity, so the
 * sender has to prove it is still driving the job. Two proofs count: it holds the live queue
 * lease for the conversation, or it is the tab that registered the job's target. Requiring the
 * lease alone stalled every legacy job whose conversation was idle, because an idle tab never
 * claims ownership of a queue it is not draining.
 */
export const decideBridgeJobOwnership = (
  record: BridgeJobRecord,
  senderTabId: number,
  durableQueueOwnerTabId?: number,
  registeredTargetTabId?: number,
): BridgeJobOwnershipDecision => {
  if (record.ownerTabId !== undefined) {
    if (record.ownerTabId !== senderTabId) throw new Error('bridge-target-owner-mismatch');
    return { kind: 'authorized' };
  }
  const knownDrivers = [durableQueueOwnerTabId, registeredTargetTabId]
    .filter((tabId): tabId is number => tabId !== undefined);
  if (!knownDrivers.includes(senderTabId)) throw new Error('bridge-target-owner-mismatch');
  return { kind: 'bind-owner', ownerTabId: senderTabId };
};
