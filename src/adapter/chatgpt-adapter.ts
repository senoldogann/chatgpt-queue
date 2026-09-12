import type { PageSnapshot } from '../domain/types';

export type SendResult = { attempted: true } | { attempted: false; reason: string };

export interface AssistantArtifact {
  turnKey: string;
  text: string;
}

export interface ChatGPTAdapter {
  getState(domStable: boolean): PageSnapshot;
  getLatestCompletedAssistantArtifact(): AssistantArtifact | null;
  sendMessage(content: string): Promise<SendResult>;
}
