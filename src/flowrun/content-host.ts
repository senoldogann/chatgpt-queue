import type { AssistantArtifact } from '../adapter/chatgpt-adapter';
import type { ConversationQueue } from '../domain/types';
import type { BrowserChatProviderHost } from './browser-chat-provider';

export interface QueueBackedFlowRunHostDependencies {
  conversationKey(): string;
  getQueue(): Promise<ConversationQueue>;
  addPrompt(content: string): Promise<ConversationQueue>;
  startQueue(): Promise<void>;
  latestAssistantArtifact(): AssistantArtifact | null;
  waitForSignal(): Promise<void>;
}

export class QueueBackedFlowRunHost implements BrowserChatProviderHost {
  constructor(private readonly dependencies: QueueBackedFlowRunHostDependencies) {}

  conversationKey(): string {
    return this.dependencies.conversationKey();
  }

  getQueue(): Promise<ConversationQueue> {
    return this.dependencies.getQueue();
  }

  addPrompt(content: string): Promise<ConversationQueue> {
    return this.dependencies.addPrompt(content);
  }

  startQueue(): Promise<void> {
    return this.dependencies.startQueue();
  }

  latestAssistantArtifact(): AssistantArtifact | null {
    return this.dependencies.latestAssistantArtifact();
  }

  async waitForItemTerminal(itemId: string): Promise<ConversationQueue> {
    while (true) {
      const queue = await this.dependencies.getQueue();
      if (queue.status === 'blocked') return queue;

      const item = queue.items.find((candidate) => candidate.id === itemId);
      if (!item) throw new Error('flowrun-queue-item-missing');
      if (['completed', 'failed', 'cancelled'].includes(item.state)) return queue;

      await this.dependencies.waitForSignal();
    }
  }
}
