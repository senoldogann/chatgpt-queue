import type { PageSnapshot } from '../domain/types';

export type SendResult = { attempted: true } | { attempted: false; reason: string };

export interface ChatGPTAdapter {
  getState(domStable: boolean): PageSnapshot;
  sendMessage(content: string): Promise<SendResult>;
}
