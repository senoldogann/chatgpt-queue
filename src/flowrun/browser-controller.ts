import type { ConversationQueue, QueueItem } from '../domain/types';
import { BrowserChatProvider, type BrowserChatProviderHost } from './browser-chat-provider';
import { executeWorkflow } from './engine';
import type { WorkflowRun } from './events';
import type { ChatProvider } from './provider';
import type { WorkflowDefinition } from './schema';

const BUSY_ITEM_STATES = new Set<QueueItem['state']>(['queued', 'sending', 'running']);

export interface BrowserRunRepository {
  put(run: WorkflowRun): Promise<void>;
  latestForConversation(conversationKey: string): Promise<WorkflowRun | undefined>;
  blockInterruptedForConversation(
    conversationKey: string,
    helpers: { now(): number; idFactory(): string },
  ): Promise<WorkflowRun | undefined>;
}

export interface BrowserRunContext {
  bridgeJobId?: string;
}

export interface FlowRunBrowserControllerOptions {
  host: BrowserChatProviderHost;
  repository: BrowserRunRepository;
  provider?: ChatProvider;
  idFactory?: (prefix: string) => string;
  now?: () => number;
  onRunUpdated?: (run: WorkflowRun) => void;
}

const defaultIdFactory = (prefix: string): string => `${prefix}:${crypto.randomUUID()}`;
const defaultNow = (): number => Date.now();

const queueBusy = (queue: ConversationQueue): boolean =>
  queue.items.some((item) => BUSY_ITEM_STATES.has(item.state));

export class FlowRunBrowserController {
  private readonly provider: ChatProvider;
  private readonly idFactory: (prefix: string) => string;
  private readonly now: () => number;
  private current: WorkflowRun | undefined;
  private persistTail: Promise<void> = Promise.resolve();
  private runContext: BrowserRunContext = {};

  constructor(private readonly options: FlowRunBrowserControllerOptions) {
    this.provider = options.provider ?? new BrowserChatProvider(options.host);
    this.idFactory = options.idFactory ?? defaultIdFactory;
    this.now = options.now ?? defaultNow;
  }

  currentRun(): WorkflowRun | undefined {
    return this.current ? structuredClone(this.current) : undefined;
  }

  private browserMetadata(): NonNullable<WorkflowRun['browser']> {
    return {
      conversationKey: this.options.host.conversationKey(),
      ...(this.runContext.bridgeJobId === undefined ? {} : { bridgeJobId: this.runContext.bridgeJobId }),
    };
  }

  private capture(run: WorkflowRun): void {
    const snapshot: WorkflowRun = {
      ...structuredClone(run),
      browser: this.browserMetadata(),
    };
    this.current = snapshot;
    this.options.onRunUpdated?.(structuredClone(snapshot));
    this.persistTail = this.persistTail.then(() => this.options.repository.put(snapshot));
  }

  async run(
    workflow: WorkflowDefinition,
    inputs: Record<string, string>,
    context: BrowserRunContext = {},
  ): Promise<WorkflowRun> {
    const queue = await this.options.host.getQueue();
    if (queueBusy(queue)) throw new Error('queue-busy');

    this.current = undefined;
    this.persistTail = Promise.resolve();
    this.runContext = { ...context };

    const run = await executeWorkflow(workflow, inputs, { chatgpt: this.provider }, {
      idFactory: this.idFactory,
      now: this.now,
      onRunUpdated: (updated) => this.capture(updated),
    });
    await this.persistTail;

    const final = this.current ?? {
      ...structuredClone(run),
      browser: this.browserMetadata(),
    };
    this.current = structuredClone(final);
    return structuredClone(final);
  }

  async recoverInterrupted(conversationKey: string): Promise<WorkflowRun | undefined> {
    const recovered = await this.options.repository.blockInterruptedForConversation(conversationKey, {
      now: this.now,
      idFactory: () => this.idFactory('event'),
    });
    if (!recovered) return undefined;
    this.current = structuredClone(recovered);
    this.options.onRunUpdated?.(structuredClone(recovered));
    return structuredClone(recovered);
  }
}
