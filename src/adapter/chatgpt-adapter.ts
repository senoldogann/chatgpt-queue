import type { PageSnapshot } from '../domain/types';

export type SendResult = { attempted: true } | { attempted: false; reason: string };

export interface AssistantArtifact {
  turnKey: string;
  text: string;
}

export interface ConversationTurnSample {
  role: 'user' | 'assistant';
  text: string;
}

export type AdapterSelectorStatus = 'ok' | 'missing';

export interface AdapterSelectorProbe {
  status: AdapterSelectorStatus;
  /** The first selector that matched, or null when none did. Never includes page text. */
  matchedSelector: string | null;
}

export type AdapterHealth = 'ok' | 'degraded' | 'unrecognized';

/**
 * A read-only description of whether this build still recognizes the live ChatGPT DOM.
 *
 * It is produced without touching the composer, the send control, or any conversation state, so
 * it is safe to run at any time, including while a queue or workflow is running.
 */
export interface AdapterInterfaceReport {
  health: AdapterHealth;
  recognized: boolean;
  composer: AdapterSelectorProbe;
  sendControl: AdapterSelectorProbe;
  stopControl: AdapterSelectorProbe;
  transcript: AdapterSelectorProbe;
  assistantTurn: AdapterSelectorProbe;
  isGenerating: boolean;
  composerReady: boolean;
  sendControlPresent: boolean;
  blockingReason: string | null;
  confirmationVisible: boolean;
}

export interface ChatGPTAdapter {
  getState(domStable: boolean): PageSnapshot;
  getLatestCompletedAssistantArtifact(): AssistantArtifact | null;
  inspectInterface(): AdapterInterfaceReport;
  /** Ordered, bounded sample of visible conversation text used for local context estimates. */
  getConversationTurns(limit?: number): ConversationTurnSample[];
  getDiagnosticSummary(): string;
  sendMessage(content: string): Promise<SendResult>;
}
