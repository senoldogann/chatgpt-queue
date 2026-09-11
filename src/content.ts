import { DOMChatGPTAdapter } from './adapter/dom-chatgpt-adapter';
import type { ClaimResult } from './coordinator/queue-coordinator';
import type { ConversationQueue } from './domain/types';
import { ChromeClient } from './runtime/chrome-client';
import { conversationKeyFromUrl, shouldMigrateConversationKey } from './runtime/identity';
import { QueueRunner } from './runtime/queue-runner';
import { QueuePanel } from './ui/queue-panel';

const TEMP_SESSION_KEY = 'chatgpt-queue:temporary-key';
const STABLE_WINDOW_MS = 900;
const HEARTBEAT_MS = 10_000;

const getTemporaryKey = (): string => {
  const existing = sessionStorage.getItem(TEMP_SESSION_KEY);
  if (existing) return existing;
  const created = `temp:${crypto.randomUUID()}`;
  sessionStorage.setItem(TEMP_SESSION_KEY, created);
  return created;
};

const temporaryKey = getTemporaryKey();
const client = new ChromeClient();
const adapter = new DOMChatGPTAdapter(document);
const runner = new QueueRunner(adapter, client);
let currentKey = conversationKeyFromUrl(location.href, temporaryKey);
let ownsCurrent = false;
let localNotice: string | undefined;
let stableTimer: number | undefined;
let evaluationTail: Promise<void> = Promise.resolve();

const host = document.createElement('div');
host.id = 'chatgpt-queue-extension-root';
(document.body ?? document.documentElement).append(host);

let panel: QueuePanel;

const render = async (): Promise<ConversationQueue | undefined> => {
  const queue = await client.get(currentKey);
  if (queue) {
    const notice = queue.blockedReason === 'dom-unrecognized'
      ? `DOM diagnostics: ${adapter.getDiagnosticSummary()}`
      : localNotice;
    panel.render(queue, notice);
  }
  return queue;
};

const ensureCurrent = async (): Promise<ConversationQueue> =>
  client.request({ type: 'ensure', key: currentKey });

const claimCurrent = async (): Promise<boolean> => {
  const claim = await client.request<ClaimResult>({ type: 'claim', key: currentKey });
  if (claim.kind === 'conflict') {
    ownsCurrent = false;
    localNotice = `Owned by another tab (${claim.ownerTabId})`;
    await render();
    return false;
  }
  ownsCurrent = true;
  localNotice = undefined;
  return true;
};

const syncIdentity = async (): Promise<void> => {
  const nextKey = conversationKeyFromUrl(location.href, temporaryKey);
  if (nextKey === currentKey) return;
  const previousKey = currentKey;
  currentKey = nextKey;
  ownsCurrent = false;
  localNotice = undefined;

  if (shouldMigrateConversationKey(previousKey, nextKey)) {
    try {
      const migrated = await client.request<ConversationQueue>({ type: 'migrate', fromKey: previousKey, toKey: nextKey });
      if (migrated.status === 'running' || migrated.status === 'paused') {
        if (!await claimCurrent()) return;
      }
      await render();
      return;
    } catch (error) {
      localNotice = `Queue migration stopped: ${error instanceof Error ? error.message : String(error)}`;
      await ensureCurrent();
    }
  } else {
    await ensureCurrent();
  }
  await attachExistingQueue();
};

const attachExistingQueue = async (): Promise<void> => {
  const queue = await ensureCurrent();
  if (queue.status !== 'running' && queue.status !== 'paused') {
    await render();
    return;
  }
  if (!await claimCurrent()) return;
  const recovered = await client.request<ConversationQueue>({ type: 'recover', key: currentKey });
  if (recovered.status === 'running') scheduleEvaluation(false);
  await render();
};

const startOrResume = async (): Promise<void> => {
  await ensureCurrent();
  if (!await claimCurrent()) return;
  await client.request({ type: 'start', key: currentKey });
  await render();
  scheduleEvaluation(false);
};

const mutateAndRender = async (request: Parameters<ChromeClient['request']>[0]): Promise<void> => {
  await client.request(request);
  await render();
};

panel = new QueuePanel(host, {
  add: async (content) => mutateAndRender({ type: 'add', key: currentKey, messages: [content] }),
  start: startOrResume,
  resume: startOrResume,
  pause: async () => {
    if (!ownsCurrent && !await claimCurrent()) return;
    await mutateAndRender({ type: 'pause', key: currentKey });
  },
  edit: async (itemId, content) => mutateAndRender({ type: 'edit', key: currentKey, itemId, content }),
  remove: async (itemId) => mutateAndRender({ type: 'delete', key: currentKey, itemId }),
  reorder: async (itemId, delta) => {
    const queue = await client.get(currentKey);
    if (!queue) return;
    const queued = queue.items.filter((item) => item.state === 'queued');
    const index = queued.findIndex((item) => item.id === itemId);
    if (index < 0) return;
    const target = Math.max(0, Math.min(queued.length - 1, index + delta));
    if (target === index) return;
    await mutateAndRender({ type: 'reorder', key: currentKey, itemId, queuedIndex: target });
  },
});

const armStableEvaluation = (): void => {
  if (stableTimer !== undefined) window.clearTimeout(stableTimer);
  stableTimer = window.setTimeout(() => {
    stableTimer = undefined;
    scheduleEvaluation(true);
  }, STABLE_WINDOW_MS);
};

function scheduleEvaluation(domStable: boolean): void {
  evaluationTail = evaluationTail
    .then(async () => {
      await syncIdentity();
      if (!ownsCurrent) return;
      await runner.evaluate(currentKey, domStable);
      const queue = await render();
      if (queue?.status === 'running' &&
        (queue.runtime.phase === 'sending' || queue.runtime.phase === 'waiting_stable_completion')) {
        armStableEvaluation();
      }
      if (queue?.status === 'running' && queue.runtime.phase === 'ready_to_send_next') scheduleEvaluation(false);
    })
    .catch(async (error: unknown) => {
      localNotice = `Queue paused locally: ${error instanceof Error ? error.message : String(error)}`;
      await render().catch(() => undefined);
    });
}

const observer = new MutationObserver(() => {
  void syncIdentity().catch(() => undefined);
  armStableEvaluation();
  scheduleEvaluation(false);
});
observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });

chrome.storage.onChanged.addListener((_changes, areaName) => {
  if (areaName !== 'local') return;
  void render().then((queue) => {
    if (ownsCurrent && queue?.status === 'running') scheduleEvaluation(false);
  }).catch(() => undefined);
});

window.setInterval(() => {
  if (!ownsCurrent) return;
  void client.get(currentKey).then((queue) => {
    if (queue?.status === 'running' || queue?.status === 'paused') {
      return client.request({ type: 'heartbeat', key: currentKey });
    }
    return undefined;
  }).catch(() => {
    ownsCurrent = false;
  });
}, HEARTBEAT_MS);

void attachExistingQueue().then(() => {
  armStableEvaluation();
}).catch(async (error: unknown) => {
  localNotice = error instanceof Error ? error.message : String(error);
  await render().catch(() => undefined);
});
