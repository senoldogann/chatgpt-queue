import type { PageSnapshot, RuntimeDecision, RuntimePhase } from './types';

export interface RuntimeEvaluationInput {
  phase: RuntimePhase;
  snapshot: PageSnapshot;
  baselineAssistantCount: number;
  generationObserved: boolean;
}

const blockReason = (snapshot: PageSnapshot): string | null => {
  if (!snapshot.domRecognized && snapshot.domStable) return 'dom-unrecognized';
  if (snapshot.confirmationVisible) return 'confirmation-required';
  return snapshot.blockingReason;
};

export function evaluateRuntime(input: RuntimeEvaluationInput): RuntimeDecision {
  const { phase, snapshot, baselineAssistantCount, generationObserved } = input;
  const blocked = blockReason(snapshot);
  if (blocked) return { action: 'block', reason: blocked };

  const hasNewAssistant = snapshot.assistantMessageCount > baselineAssistantCount;
  const pageReady = snapshot.composerReady && !snapshot.isGenerating;

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
      if (generationObserved && hasNewAssistant && pageReady) return { action: 'wait_for_stability' };
      return { action: 'wait' };

    case 'waiting_stable_completion':
      if (snapshot.isGenerating) return { action: 'generation_started', controlObserved: true };
      if (generationObserved && hasNewAssistant && pageReady && snapshot.domStable) return { action: 'complete' };
      return { action: 'wait' };

    default:
      return { action: 'wait' };
  }
}
