import { DOMChatGPTAdapter } from './adapter/dom-chatgpt-adapter';
import type { ClaimResult } from './coordinator/queue-coordinator';
import type { ConversationQueue } from './domain/types';
import { FlowRunBrowserController } from './flowrun/browser-controller';
import { QueueBackedFlowRunHost } from './flowrun/content-host';
import type { WorkflowRun } from './flowrun/events';
import { chromeFlowRunStorageArea, FlowRunRunRepository } from './flowrun/run-repository';
import { validateWorkflowDocument, type WorkflowDefinition } from './flowrun/schema';
import { ChromeClient } from './runtime/chrome-client';
import { conversationKeyFromUrl, shouldMigrateConversationKey } from './runtime/identity';
import { QueueRunner } from './runtime/queue-runner';
import { QueuePanel } from './ui/queue-panel';

const TEMP_SESSION_KEY = 'chatgpt-queue:temporary-key';
const STABLE_WINDOW_MS = 900;
const HEARTBEAT_MS = 10_000;
const FLOWRUN_RECONCILE_MS = 500;

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
let lastDomMutationAt = Date.now();
let evaluationTail: Promise<void> = Promise.resolve();
let selectedWorkflow: WorkflowDefinition | undefined;
let workflowRun: WorkflowRun | undefined;
let workflowError: string | undefined;
let recoveringDomBlock = false;

const shouldObserveLifecycle = (queue: ConversationQueue | undefined): boolean => {
  if (!queue) return false;
  if (queue.status === 'running') return true;
  return queue.status === 'paused'
    && Boolean(queue.runtime.activeItemId)
    && ['sending', 'waiting_generation_start', 'generating', 'waiting_stable_completion'].includes(queue.runtime.phase);
};

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
    panel.render(queue, notice, {
      ...(selectedWorkflow === undefined ? {} : { workflow: selectedWorkflow }),
      ...(workflowRun === undefined ? {} : { run: workflowRun }),
      ...(workflowError === undefined ? {} : { error: workflowError }),
    });
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

const recoverDomUnrecognizedIfSafe = async (queue?: ConversationQueue): Promise<boolean> => {
  const current = queue ?? await client.get(currentKey);
  if (!current || current.status !== 'blocked' || current.blockedReason !== 'dom-unrecognized') return false;
  if (!adapter.getState(false).domRecognized) return false;
  if (recoveringDomBlock) return true;
  recoveringDomBlock = true;
  try {
    if (!ownsCurrent && !await claimCurrent()) return false;
    await client.request({ type: 'start', key: currentKey });
    await render();
    scheduleEvaluation(false);
    return true;
  } finally {
    recoveringDomBlock = false;
  }
};

const attachExistingQueue = async (): Promise<void> => {
  const queue = await ensureCurrent();
  if (queue.status === 'blocked' && queue.blockedReason === 'dom-unrecognized') {
    if (await recoverDomUnrecognizedIfSafe(queue)) return;
  }
  if (queue.status !== 'running' && queue.status !== 'paused') {
    await render();
    return;
  }
  if (!await claimCurrent()) return;
  const recovered = await client.request<ConversationQueue>({ type: 'recover', key: currentKey });
  if (shouldObserveLifecycle(recovered)) scheduleEvaluation(false);
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

const waitForQueueSignal = (): Promise<void> => new Promise((resolve) => {
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    window.clearTimeout(timer);
    chrome.storage.onChanged.removeListener(listener);
    resolve();
  };
  const listener = (_changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
    if (areaName === 'local') finish();
  };
  const timer = window.setTimeout(finish, FLOWRUN_RECONCILE_MS);
  chrome.storage.onChanged.addListener(listener);
});

const flowRunRepository = new FlowRunRunRepository(chromeFlowRunStorageArea());
const flowRunHost = new QueueBackedFlowRunHost({
  conversationKey: () => currentKey,
  getQueue: async () => (await client.get(currentKey)) ?? ensureCurrent(),
  addPrompt: async (content) => {
    const queue = await client.request<ConversationQueue>({ type: 'add', key: currentKey, messages: [content] });
    await render();
    return queue;
  },
  startQueue: startOrResume,
  latestAssistantArtifact: () => adapter.getLatestCompletedAssistantArtifact(),
  waitForSignal: waitForQueueSignal,
});
const flowRunController = new FlowRunBrowserController({
  host: flowRunHost,
  repository: flowRunRepository,
  onRunUpdated: (run) => {
    workflowRun = run;
    void render().catch(() => undefined);
  },
});

const loadWorkflowText = async (text: string): Promise<void> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    workflowError = `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`;
    await render();
    return;
  }

  const validated = validateWorkflowDocument(parsed);
  if (!validated.ok) {
    workflowError = validated.errors.map((error) => `${error.code} ${error.path}: ${error.message}`).join(' | ');
    await render();
    return;
  }

  selectedWorkflow = validated.value;
  workflowRun = undefined;
  workflowError = undefined;
  await render();
};

const runSelectedWorkflow = async (inputs: Record<string, string>): Promise<void> => {
  if (!selectedWorkflow) {
    workflowError = 'No workflow loaded.';
    await render();
    return;
  }
  workflowError = undefined;
  await render();
  try {
    workflowRun = await flowRunController.run(selectedWorkflow, inputs);
  } catch (error) {
    workflowError = error instanceof Error ? error.message : String(error);
  }
  await render();
};

const clearSelectedWorkflow = async (): Promise<void> => {
  selectedWorkflow = undefined;
  workflowRun = undefined;
  workflowError = undefined;
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
  loadWorkflow: loadWorkflowText,
  runWorkflow: runSelectedWorkflow,
  clearWorkflow: clearSelectedWorkflow,
});

const armStableEvaluation = (): void => {
  if (stableTimer !== undefined) window.clearTimeout(stableTimer);
  stableTimer = window.setTimeout(() => {
    stableTimer = undefined;
    scheduleEvaluation(true);
  }, STABLE_WINDOW_MS);
};

// Quiescence is measured rather than only inferred from a timer: a hidden tab's timers are
// throttled and page mutations can clear the stable window indefinitely.
const domQuietFor = (): number => Date.now() - lastDomMutationAt;

function scheduleEvaluation(domStable: boolean): void {
  evaluationTail = evaluationTail
    .then(async () => {
      await syncIdentity();
      if (!ownsCurrent) return;
      await runner.evaluate(currentKey, domStable);
      const queue = await render();
      if (shouldObserveLifecycle(queue) &&
        (queue?.runtime.phase === 'sending' || queue?.runtime.phase === 'waiting_stable_completion')) {
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
  lastDomMutationAt = Date.now();
  void (async () => {
    await syncIdentity();
    if (await recoverDomUnrecognizedIfSafe()) return;
    armStableEvaluation();
    scheduleEvaluation(false);
  })().catch(() => undefined);
});
observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });

chrome.storage.onChanged.addListener((_changes, areaName) => {
  if (areaName !== 'local') return;
  void render().then((queue) => {
    if (ownsCurrent && shouldObserveLifecycle(queue)) scheduleEvaluation(false);
  }).catch(() => undefined);
});

window.setInterval(() => {
  void (async () => {
    const queue = await client.get(currentKey);
    if (!queue || (queue.status !== 'running' && queue.status !== 'paused')) return;
    // A hidden tab can lapse its lease (Chrome throttles background timers to roughly one
    // wake-up per minute) or miss DOM signals entirely, and a single failed heartbeat used
    // to disable this tab permanently. Re-acquiring the lease and re-evaluating here keeps an
    // unattended queue moving; ownership stays exclusive, so a live lease held by another tab
    // still wins and this tab only reports the conflict.
    if (!ownsCurrent && !await claimCurrent()) return;
    await client.request({ type: 'heartbeat', key: currentKey });
    scheduleEvaluation(domQuietFor() >= STABLE_WINDOW_MS);
  })().catch(() => undefined);
}, HEARTBEAT_MS);

void attachExistingQueue().then(async () => {
  await flowRunController.recoverInterrupted(currentKey);
  armStableEvaluation();
}).catch(async (error: unknown) => {
  localNotice = error instanceof Error ? error.message : String(error);
  await render().catch(() => undefined);
});
