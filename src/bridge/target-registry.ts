import type { QueueStatus } from '../domain/types';
import type { BridgeTarget } from './protocol';

export interface BridgeTargetRegistration {
  conversationKey: string;
  queueStatus: QueueStatus;
  workflowStatus?: 'pending' | 'running' | 'blocked' | 'completed' | 'failed';
  busy: boolean;
}

export interface ResolvedBridgeTarget extends BridgeTarget {
  tabId: number;
  expiresAt: number;
}

interface TargetRegistryOptions {
  idFactory?: () => string;
  ttlMs?: number;
}

export class TargetRegistry {
  private readonly entries = new Map<number, ResolvedBridgeTarget>();
  private readonly idFactory: () => string;
  private readonly ttlMs: number;

  constructor(options: TargetRegistryOptions = {}) {
    this.idFactory = options.idFactory ?? (() => crypto.randomUUID());
    this.ttlMs = options.ttlMs ?? 30_000;
  }

  register(tabId: number, registration: BridgeTargetRegistration, now = Date.now()): BridgeTarget {
    const existing = this.entries.get(tabId);
    const targetId = existing?.conversationKey === registration.conversationKey
      ? existing.targetId
      : `target:${this.idFactory()}`;
    const entry: ResolvedBridgeTarget = {
      targetId,
      provider: 'chatgpt',
      conversationKey: registration.conversationKey,
      busy: registration.busy,
      tabId,
      expiresAt: now + this.ttlMs,
    };
    this.entries.set(tabId, entry);
    return this.publicTarget(entry);
  }

  list(now = Date.now()): BridgeTarget[] {
    this.prune(now);
    return [...this.entries.values()].map((entry) => this.publicTarget(entry));
  }

  resolve(targetId: string, now = Date.now()): ResolvedBridgeTarget | undefined {
    this.prune(now);
    for (const entry of this.entries.values()) {
      if (entry.targetId === targetId) return structuredClone(entry);
    }
    return undefined;
  }

  private prune(now: number): void {
    for (const [tabId, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(tabId);
    }
  }

  private publicTarget(entry: ResolvedBridgeTarget): BridgeTarget {
    return {
      targetId: entry.targetId,
      provider: 'chatgpt',
      conversationKey: entry.conversationKey,
      busy: entry.busy,
    };
  }
}
