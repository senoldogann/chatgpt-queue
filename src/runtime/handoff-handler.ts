import type { HandoffControlRequest } from './protocol';

export const HANDOFF_TARGET_TTL_MS = 10 * 60_000;

export interface HandoffTarget {
  tabId: number;
  handoffId: string;
  createdAt: number;
}

export interface HandoffTargetStore {
  get(): Promise<HandoffTarget | undefined>;
  set(target: HandoffTarget): Promise<void>;
  clear(): Promise<void>;
}

export interface HandoffHandlerDependencies {
  now(): number;
  createTab(url: string): Promise<{ id?: number | undefined }>;
  targets: HandoffTargetStore;
}

/**
 * Opens the fresh conversation that continues a prepared handoff brief.
 *
 * Two bounds keep this safe: only a same-origin `http(s)` URL can be opened, and only the tab the
 * extension created may claim the import. A stale claim expires instead of leaking to whichever
 * tab happens to ask next.
 */
export async function handleHandoffRequest(
  request: HandoffControlRequest,
  tabId: number,
  senderUrl: string | undefined,
  dependencies: HandoffHandlerDependencies,
): Promise<unknown> {
  switch (request.type) {
    case 'handoffOpen': {
      if (!senderUrl) throw new Error('handoff-sender-url-unavailable');
      const sender = new URL(senderUrl);
      const target = new URL(request.url);
      if (!/^https?:$/.test(target.protocol) || target.origin !== sender.origin) {
        throw new Error('handoff-url-not-allowed');
      }

      const tab = await dependencies.createTab(target.toString());
      if (tab.id === undefined) throw new Error('handoff-tab-create-failed');
      await dependencies.targets.set({ tabId: tab.id, handoffId: request.handoffId, createdAt: dependencies.now() });
      return { tabId: tab.id };
    }
    case 'handoffClaim': {
      const target = await dependencies.targets.get();
      if (!target || target.tabId !== tabId) return { claimed: false };
      if (dependencies.now() - target.createdAt > HANDOFF_TARGET_TTL_MS) {
        await dependencies.targets.clear();
        return { claimed: false };
      }
      await dependencies.targets.clear();
      return { claimed: true, handoffId: target.handoffId };
    }
  }
}
