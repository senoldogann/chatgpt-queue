import { describe, expect, it } from 'vitest';
import { TargetRegistry } from '../../src/bridge/target-registry';

describe('TargetRegistry', () => {
  it('uses the sender tab id internally while exposing an opaque target id', () => {
    const registry = new TargetRegistry({ idFactory: () => 'opaque-1', ttlMs: 30_000 });
    const target = registry.register(42, { conversationKey: 'conv:a', queueStatus: 'completed', busy: false }, 1_000);

    expect(target.targetId).toBe('target:opaque-1');
    expect(target).not.toHaveProperty('tabId');
    expect(registry.resolve(target.targetId, 2_000)?.tabId).toBe(42);
  });

  it('derives busy from queue and workflow state instead of trusting a stale false flag', () => {
    const registry = new TargetRegistry({ idFactory: () => 'opaque' });

    const queueRunning = registry.register(1, { conversationKey: 'conv:a', queueStatus: 'running', busy: false }, 1_000);
    expect(queueRunning.busy).toBe(true);

    const workflowRunning = registry.register(1, {
      conversationKey: 'conv:a',
      queueStatus: 'completed',
      workflowStatus: 'running',
      busy: false,
    }, 2_000);
    expect(workflowRunning.busy).toBe(true);

    const idle = registry.register(1, {
      conversationKey: 'conv:a',
      queueStatus: 'completed',
      workflowStatus: 'completed',
      busy: false,
    }, 3_000);
    expect(idle.busy).toBe(false);
  });

  it('keeps an id across heartbeats and rotates it when the conversation changes', () => {
    let seq = 0;
    const registry = new TargetRegistry({ idFactory: () => `id-${++seq}` });
    const first = registry.register(7, { conversationKey: 'conv:a', queueStatus: 'idle', busy: true }, 1_000);
    const again = registry.register(7, { conversationKey: 'conv:a', queueStatus: 'running', busy: true }, 2_000);
    const changed = registry.register(7, { conversationKey: 'conv:b', queueStatus: 'completed', busy: false }, 3_000);

    expect(again.targetId).toBe(first.targetId);
    expect(changed.targetId).not.toBe(first.targetId);
  });

  it('expires stale registrations after the ttl', () => {
    const registry = new TargetRegistry({ idFactory: () => 'opaque', ttlMs: 30_000 });
    const target = registry.register(1, { conversationKey: 'conv:a', queueStatus: 'completed', busy: false }, 1_000);
    expect(registry.list(30_999)).toHaveLength(1);
    expect(registry.list(31_001)).toEqual([]);
    expect(registry.resolve(target.targetId, 31_001)).toBeUndefined();
  });
});
