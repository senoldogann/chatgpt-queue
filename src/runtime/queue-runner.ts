import type { ChatGPTAdapter } from '../adapter/chatgpt-adapter';
import type { DispatchReservation } from '../coordinator/queue-coordinator';
import type { ConversationQueue } from '../domain/types';
import { evaluateRuntime } from '../domain/state-machine';

export const LEGACY_COMPLETION_RECOVERY_MS = 30_000;

export interface RunnerBackend {
  get(key: string): Promise<ConversationQueue | undefined>;
  reserve(key: string, baselineAssistantCount: number, baselineAssistantTurnKey?: string): Promise<DispatchReservation | null>;
  generationStarted(key: string, itemId: string, dispatchToken: string, controlObserved: boolean): Promise<unknown>;
  waitingStable(key: string, itemId: string, dispatchToken: string): Promise<unknown>;
  complete(key: string, itemId: string, dispatchToken: string): Promise<unknown>;
  block(key: string, reason: string): Promise<unknown>;
}

export interface QueueRunnerOptions {
  now?: () => number;
}

export class QueueRunner {
  private readonly now: () => number;

  constructor(
    private readonly adapter: ChatGPTAdapter,
    private readonly backend: RunnerBackend,
    options: QueueRunnerOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
  }

  async evaluate(key: string, domStable: boolean): Promise<void> {
    const queue = await this.backend.get(key);
    if (!queue) return;
    const observingPausedActive = queue.status === 'paused'
      && Boolean(queue.runtime.activeItemId)
      && ['sending', 'waiting_generation_start', 'generating', 'waiting_stable_completion'].includes(queue.runtime.phase);
    if (queue.status !== 'running' && !observingPausedActive) return;

    const snapshot = this.adapter.getState(domStable);
    const baselineAssistantCount = queue.runtime.baselineAssistantCount ?? snapshot.assistantMessageCount;
    const active = queue.runtime.activeItemId
      ? queue.items.find((item) => item.id === queue.runtime.activeItemId)
      : undefined;
    const generationObserved = queue.runtime.generationObserved ?? false;
    const legacyCompletionRecoveryEligible = queue.runtime.baselineAssistantTurnKey === undefined
      && generationObserved
      && active?.startedAt !== undefined
      && this.now() - active.startedAt >= LEGACY_COMPLETION_RECOVERY_MS
      && !snapshot.isGenerating
      && snapshot.composerReady
      && Boolean(snapshot.latestAssistantTurnKey);

    const decision = evaluateRuntime({
      phase: queue.runtime.phase,
      snapshot,
      baselineAssistantCount,
      ...(queue.runtime.baselineAssistantTurnKey === undefined
        ? {}
        : { baselineAssistantTurnKey: queue.runtime.baselineAssistantTurnKey }),
      generationObserved,
      ...(legacyCompletionRecoveryEligible ? { legacyCompletionRecoveryEligible: true } : {}),
    });

    if (decision.action === 'block') {
      await this.backend.block(key, decision.reason);
      return;
    }

    if (decision.action === 'send') {
      const reservation = await this.backend.reserve(key, snapshot.assistantMessageCount, snapshot.latestAssistantTurnKey);
      if (!reservation) return;
      const result = await this.adapter.sendMessage(reservation.content);
      if (!result.attempted) await this.backend.block(key, 'send-not-attempted');
      return;
    }

    if (decision.action === 'wait') return;

    if (!active?.dispatchToken) {
      await this.backend.block(key, 'active-item-missing');
      return;
    }

    if (decision.action === 'generation_started') {
      await this.backend.generationStarted(key, active.id, active.dispatchToken, decision.controlObserved);
      return;
    }
    if (decision.action === 'wait_for_stability') {
      await this.backend.waitingStable(key, active.id, active.dispatchToken);
      return;
    }
    if (decision.action === 'complete') {
      await this.backend.complete(key, active.id, active.dispatchToken);
    }
  }
}
