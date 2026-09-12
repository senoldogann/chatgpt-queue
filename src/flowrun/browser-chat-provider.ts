import type { AssistantArtifact } from '../adapter/chatgpt-adapter';
import type { ConversationQueue, QueueItem } from '../domain/types';
import type { ChatExecutionRequest, ChatExecutionResult, ChatProvider, ProviderReceipt } from './provider';

const BUSY_ITEM_STATES = new Set<QueueItem['state']>(['queued', 'sending', 'running']);

export interface BrowserChatProviderHost {
  conversationKey(): string;
  getQueue(): Promise<ConversationQueue>;
  addPrompt(content: string): Promise<ConversationQueue>;
  startQueue(): Promise<void>;
  waitForItemTerminal(itemId: string): Promise<ConversationQueue>;
  latestAssistantArtifact(): AssistantArtifact | null;
}

const baseReceipt = (
  request: ChatExecutionRequest,
  conversationKey: string,
  item: QueueItem | undefined,
): ProviderReceipt => ({
  provider: 'chatgpt',
  dispatchToken: request.dispatchToken,
  ...(item?.startedAt === undefined ? {} : { startedAt: item.startedAt }),
  ...(item?.completedAt === undefined ? {} : { completedAt: item.completedAt }),
  conversationKey,
  metadata: item ? { queueItemId: item.id } : {},
});

export class BrowserChatProvider implements ChatProvider {
  readonly id = 'chatgpt';

  constructor(private readonly host: BrowserChatProviderHost) {}

  async execute(request: ChatExecutionRequest): Promise<ChatExecutionResult> {
    const before = await this.host.getQueue();
    if (before.items.some((item) => BUSY_ITEM_STATES.has(item.state))) {
      return { kind: 'blocked', reason: 'queue-busy' };
    }

    const baselineArtifact = this.host.latestAssistantArtifact();
    const existingIds = new Set(before.items.map((item) => item.id));
    const afterAdd = await this.host.addPrompt(request.prompt);
    const created = afterAdd.items.filter((item) => !existingIds.has(item.id));
    if (created.length !== 1) {
      return { kind: 'blocked', reason: 'queue-item-not-created' };
    }

    const queuedItem = created[0]!;
    await this.host.startQueue();
    const terminal = await this.host.waitForItemTerminal(queuedItem.id);
    const terminalItem = terminal.items.find((item) => item.id === queuedItem.id);
    const receipt = baseReceipt(request, this.host.conversationKey(), terminalItem ?? queuedItem);

    if (terminal.status === 'blocked') {
      return {
        kind: 'blocked',
        reason: terminal.blockedReason ?? 'queue-blocked',
        receipt,
      };
    }

    if (!terminalItem || terminalItem.state !== 'completed') {
      return { kind: 'blocked', reason: 'queue-item-not-completed', receipt };
    }

    const artifact = this.host.latestAssistantArtifact();
    if (!artifact) {
      return { kind: 'blocked', reason: 'assistant-output-unavailable', receipt };
    }

    const artifactReceipt: ProviderReceipt = {
      ...receipt,
      metadata: {
        ...(receipt.metadata ?? {}),
        assistantTurnKey: artifact.turnKey,
      },
    };

    if (baselineArtifact && baselineArtifact.turnKey === artifact.turnKey) {
      return { kind: 'blocked', reason: 'assistant-turn-not-advanced', receipt: artifactReceipt };
    }

    return {
      kind: 'completed',
      output: artifact.text,
      receipt: artifactReceipt,
    };
  }
}
