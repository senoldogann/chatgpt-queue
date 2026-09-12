import type { PageSnapshot, RuntimeDecision, RuntimePhase } from './types';

export interface RuntimeEvaluationInput {
  phase: RuntimePhase;
  snapshot: PageSnapshot;
  baselineAssistantCount: number;
  baselineAssistantTurnKey?: string;
  generationObserved: boolean;
  completionWaitMs?: number;
}

/**
 * Upper bound on how long a provable-but-unconfirmed completion may wait for a
 * quiescent DOM.
 *
 * ChatGPT pages keep mutating for reasons unrelated to the active response
 * (streaming marks, animations, background re-renders), and Chrome throttles
 * page timers in hidden tabs to roughly one wake-up per minute. The quiet
 * window can therefore stay unobserved forever while completion evidence is
 * already conclusive. Completion evidence stays the primary signal; the quiet
 * window is a secondary confirmation with a bounded wait.
 */
export const COMPLETION_QUIET_GRACE_MS = 5_000;

const blockReason = (snapshot: PageSnapshot): string | null => {
  if (!snapshot.domRecognized && snapshot.domStable) return 'dom-unrecognized';
  if (snapshot.confirmationVisible) return 'confirmation-required';
  return snapshot.blockingReason;
};

export function evaluateRuntime(input: RuntimeEvaluationInput): RuntimeDecision {
  const { phase, snapshot, baselineAssistantCount, baselineAssistantTurnKey, generationObserved, completionWaitMs } = input;
  const blocked = blockReason(snapshot);
  if (blocked) return { action: 'block', reason: blocked };

  const assistantIdentityAdvanced = Boolean(
    baselineAssistantTurnKey
    && snapshot.latestAssistantTurnKey
    && snapshot.latestAssistantTurnKey !== baselineAssistantTurnKey
  );
  const hasNewAssistant = snapshot.assistantMessageCount > baselineAssistantCount || assistantIdentityAdvanced;
  const pageReady = snapshot.composerReady && !snapshot.isGenerating;
  const completionEvidence = generationObserved || snapshot.assistantCompletionControlPresent;
  const legacyCompletionTarget = !baselineAssistantTurnKey
    && generationObserved
    && snapshot.assistantCompletionControlPresent
    && pageReady;
  const hasCompletionTarget = hasNewAssistant || legacyCompletionTarget;

  switch (phase) {
    case 'ready_to_send':
    case 'ready_to_send_next':
      return pageReady ? { action: 'send' } : { action: 'wait' };

    case 'sending':
      if (snapshot.isGenerating) return { action: 'generation_started', controlObserved: true };
      if (hasNewAssistant) return { action: 'generation_started', controlObserved: false };
      if (snapshot.domStable) return { action: 'block', reason: 'send-not-confirmed' };
      return { action: 'wait' };

    case 'waiting_generation_start':
      if (snapshot.isGenerating) return { action: 'generation_started', controlObserved: true };
      if (hasNewAssistant) return { action: 'generation_started', controlObserved: false };
      if (pageReady) return { action: 'block', reason: 'generation-start-not-observed' };
      return { action: 'wait' };

    case 'generating':
      if (snapshot.isGenerating && !generationObserved) return { action: 'generation_started', controlObserved: true };
      if (snapshot.isGenerating) return { action: 'wait' };
      if (completionEvidence && hasCompletionTarget && pageReady) return { action: 'wait_for_stability' };
      return { action: 'wait' };

    case 'waiting_stable_completion': {
      if (snapshot.isGenerating) return { action: 'generation_started', controlObserved: true };
      const quiet = snapshot.domStable || (completionWaitMs ?? 0) >= COMPLETION_QUIET_GRACE_MS;
      if (completionEvidence && hasCompletionTarget && pageReady && quiet) return { action: 'complete' };
      return { action: 'wait' };
    }

    default:
      return { action: 'wait' };
  }
}
