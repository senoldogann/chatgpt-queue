declare const __FLOWRUN_E2E__: boolean;

import { DOMChatGPTAdapter } from './adapter/dom-chatgpt-adapter';
import { BridgeContentController, publishRecoveredBridgeRun } from './bridge/content-controller';
import { readRuntimeDeclaredCapacity, resolveContextCapacity } from './context/capacity';
import { HANDOFF_PROMPT, buildHandoffSeed, parseHandoffBrief } from './context/handoff';
import { HandoffRepository, type HandoffRecord } from './context/handoff-repository';
import { measureContextPressure, type ContextPressure } from './context/pressure';
import { ContextSettingsRepository } from './context/settings';
import type { ClaimResult } from './coordinator/queue-coordinator';
import { isQueueDriverStalled } from './domain/staleness';
import type { ConversationQueue } from './domain/types';
import { FlowRunBrowserController } from './flowrun/browser-controller';
import { QueueBackedFlowRunHost } from './flowrun/content-host';
import type { WorkflowRun } from './flowrun/events';
import { getWorkflowPreset } from './flowrun/presets';
import { chromeFlowRunStorageArea, FlowRunRunRepository } from './flowrun/run-repository';
import { validateWorkflowDocument, type WorkflowDefinition } from './flowrun/schema';
import { ChromeClient } from './runtime/chrome-client';
import { conversationKeyFromUrl, shouldMigrateConversationKey } from './runtime/identity';
import type { BridgeRunMessage } from './runtime/protocol';
import { QueueRunner } from './runtime/queue-runner';
import { chromeStorageArea } from './storage/queue-repository';
import { createTranslator, resolveLocale, type Locale, type LocalePreference, type Translator } from './ui/i18n';
import { QueuePanel, type QueuePanelContextView, type QueuePanelView } from './ui/queue-panel';
import { UiPreferencesRepository } from './ui/ui-preferences';

const TEMP_SESSION_KEY = 'chatgpt-queue:temporary-key';
const HANDOFF_IMPORT_SESSION_KEY = 'chatgpt-queue:handoff-imported';
const STABLE_WINDOW_MS = 900;
const HEARTBEAT_MS = 10_000;
/** How often the panel checks that the extension it belongs to is still reachable. */
const CONTEXT_WATCHDOG_MS = 3_000;
const FLOWRUN_RECONCILE_MS = 500;
/** The context estimate clones visible turns, so it refreshes on a budget rather than per render. */
const CONTEXT_REFRESH_MS = 1_500;
/** Bound DOM cloning while probing one extra turn so the UI can report a lower bound honestly. */
const CONTEXT_VISIBLE_TURN_LIMIT = 400;
/** A tab that does not own the queue still refreshes local panel state, but not per DOM mutation. */
const PASSIVE_RENDER_MIN_MS = 1_000;

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
let bridgeTargetId: string | undefined;
let bridgeState: 'disabled' | 'enabling' | 'disconnected' | 'connected' = 'disconnected';
let recoveringTransientBlock = false;
let contextCapacityOverride: number | undefined;
let handoffRecord: HandoffRecord | undefined;
let handoffCaptureInFlight = false;
let handoffPauseRequested = false;
let pressureCache: ContextPressure | undefined;
let pressureCacheAt = 0;
let lastPassiveRenderAt = 0;
/**
 * Set once the extension context behind this content script is gone (the extension was reloaded,
 * updated, or disabled). From that point on this script can neither read nor write the queue, so the
 * panel must stop presenting itself as a live driver.
 */
let extensionStale = false;
/**
 * The last queue and view the panel was painted with. A stale script cannot read storage any more,
 * but it can still repaint the DOM, which is what turns a frozen "Running" panel into an honest
 * one that tells the user to reload.
 */
let lastPaint: { queue: ConversationQueue; notice: string | undefined; view: QueuePanelView } | undefined;
const attemptedHandoffItems = new Set<string>();

const handoffRepository = new HandoffRepository(chromeStorageArea());
const contextSettings = new ContextSettingsRepository(chromeStorageArea());
const uiPreferences = new UiPreferencesRepository(chromeStorageArea());
let localePreference: LocalePreference = 'auto';
let locale: Locale = 'en';
let t: Translator = createTranslator('en');

const applyLocale = (preference: LocalePreference): void => {
  localePreference = preference;
  locale = resolveLocale(preference, navigator.language ?? '');
  t = createTranslator(locale);
};

const readImportedHandoffKey = (): string | undefined => {
  try {
    return sessionStorage.getItem(HANDOFF_IMPORT_SESSION_KEY) ?? undefined;
  } catch {
    return undefined;
  }
};

const writeImportedHandoffKey = (key: string): void => {
  try {
    sessionStorage.setItem(HANDOFF_IMPORT_SESSION_KEY, key);
  } catch {
    // Best-effort: the claim is single-use in the background, so a lost marker is not a data risk.
  }
};

let importedHandoffKey: string | undefined = readImportedHandoffKey();

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
    await pauseForHandoffOnceDispatched(queue);
    await maybeCaptureHandoff(queue);
    const notice = queue.blockedReason === 'dom-unrecognized'
      ? t('notice.domDiagnostics', { summary: adapter.getDiagnosticSummary() })
      : localNotice;
    const view: QueuePanelView = {
      ...(selectedWorkflow === undefined ? {} : { workflow: selectedWorkflow }),
      ...(workflowRun === undefined ? {} : { run: workflowRun }),
      ...(workflowError === undefined ? {} : { error: workflowError }),
      bridgeState,
      context: buildContextView(queue),
      locale,
      localePreference,
      ...(extensionStale ? { stale: true } : {}),
      ...(isQueueDriverStalled({ queue, now: Date.now() }) ? { driverStalled: true } : {}),
    };
    lastPaint = { queue, notice, view };
    panel.render(queue, notice, view);
  }
  return queue;
};

/**
 * Whether this content script can still talk to its extension. An orphaned script keeps running and
 * keeps painting, but `chrome.runtime.id` is undefined once the extension behind it is replaced, so
 * every read and write it attempts would fail.
 */
const extensionContextAlive = (): boolean => {
  try {
    return typeof chrome !== 'undefined' && Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
};

/**
 * Stops driving and repaints the last known queue with an explicit disconnected state.
 *
 * This is what prevents the failure mode where an orphaned panel keeps showing "Running" for a
 * conversation nothing is advancing any more: the queue contents stay visible because they are the
 * user's data, but the panel no longer pretends the extension can act on them.
 */
const detectLostExtensionContext = (): void => {
  if (extensionStale || extensionContextAlive()) return;
  extensionStale = true;
  window.clearInterval(heartbeatTimer);
  window.clearInterval(watchdogTimer);
  observer.disconnect();
  if (lastPaint && panel) {
    panel.render(lastPaint.queue, lastPaint.notice, { ...lastPaint.view, stale: true, driverStalled: false });
  }
};

const noteEvaluationFailure = (error: unknown): void => {
  const message = error instanceof Error ? error.message : String(error);
  if (/extension context invalidated|receiving end does not exist|message port closed/i.test(message)) {
    detectLostExtensionContext();
    return;
  }
  localNotice = t('notice.pausedLocally', { message });
};

const ensureCurrent = async (): Promise<ConversationQueue> =>
  client.request({ type: 'ensure', key: currentKey });

const currentContextPressure = (): ContextPressure => {
  const now = Date.now();
  if (pressureCache && now - pressureCacheAt < CONTEXT_REFRESH_MS) return pressureCache;
  const capacity = resolveContextCapacity({
    runtimeDeclaredTokens: readRuntimeDeclaredCapacity(document),
    configuredTokens: contextCapacityOverride,
  });
  const sampledTurns = adapter.getConversationTurns(CONTEXT_VISIBLE_TURN_LIMIT + 1);
  const sampleTruncated = sampledTurns.length > CONTEXT_VISIBLE_TURN_LIMIT;
  const measuredTurns = sampleTruncated ? sampledTurns.slice(-CONTEXT_VISIBLE_TURN_LIMIT) : sampledTurns;
  pressureCache = measureContextPressure(measuredTurns, capacity, { sampleTruncated });
  pressureCacheAt = now;
  return pressureCache;
};

const buildContextView = (queue: ConversationQueue): QueuePanelContextView => {
  const preparing = queue.items.some((item) => item.content === HANDOFF_PROMPT && item.state !== 'completed');
  return {
    pressure: currentContextPressure(),
    adapter: { report: adapter.inspectInterface(), diagnostics: adapter.getDiagnosticSummary() },
    ...(contextCapacityOverride === undefined ? {} : { capacityOverride: contextCapacityOverride }),
    handoff: handoffRecord && handoffRecord.sourceConversationKey === currentKey
      ? { status: 'ready', carriedItems: handoffRecord.carriedItems.length }
      : preparing
        ? { status: 'capturing', carriedItems: 0 }
        : { status: 'none', carriedItems: 0 },
  };
};

/**
 * Stops the source queue from dispatching anything after the handoff prompt.
 *
 * This has to happen while the prompt is still generating, not once its reply has been captured:
 * the runner keeps observing a paused queue's active item, so pausing here lets the brief finish
 * and guarantees the next queued follow-up is never sent, while pausing later leaves a window in
 * which it can already have been dispatched.
 */
const pauseForHandoffOnceDispatched = async (queue: ConversationQueue): Promise<void> => {
  if (handoffPauseRequested || !ownsCurrent) return;
  const dispatched = queue.items.some(
    (item) => item.content === HANDOFF_PROMPT && (item.state === 'sending' || item.state === 'running'),
  );
  if (!dispatched) return;
  handoffPauseRequested = true;
  await client.request({ type: 'pause', key: currentKey }).catch(() => undefined);
};

/**
 * Turns a completed handoff prompt into a durable brief.
 *
 * Fail-closed: an unrecognized or incomplete brief never becomes a handoff, and the source queue is
 * paused only after a validated brief exists. A failed compaction therefore leaves the queue exactly
 * as it was instead of losing the remaining follow-ups.
 */
const maybeCaptureHandoff = async (queue: ConversationQueue): Promise<void> => {
  if (!ownsCurrent || handoffCaptureInFlight || handoffRecord) return;
  const completed = [...queue.items].reverse().find(
    (item) => item.content === HANDOFF_PROMPT && typeof item.completedAt === 'number' && !attemptedHandoffItems.has(item.id),
  );
  if (!completed) return;
  const artifact = adapter.getLatestCompletedAssistantArtifact();
  if (!artifact) return;
  attemptedHandoffItems.add(completed.id);
  const parsed = parseHandoffBrief(artifact.text);
  if (!parsed.ok) {
    localNotice = t('notice.handoffRejected', { errors: parsed.errors.join(', ') });
    return;
  }

  handoffCaptureInFlight = true;
  try {
    const carriedItems = queue.items
      .filter((item) => item.state === 'queued' && item.content !== HANDOFF_PROMPT)
      .map((item) => item.content);
    const result = await handoffRepository.capture({
      itemId: completed.id,
      sourceConversationKey: currentKey,
      brief: parsed.brief,
      carriedItems,
      now: Date.now(),
      idFactory: () => `handoff:${crypto.randomUUID()}`,
    });
    if (!result.ok) return;
    handoffRecord = result.record;
    // Backstop for the earlier pause: the remaining follow-ups stay queued for the fresh
    // conversation rather than being spent on a conversation that has run out of headroom.
    if (ownsCurrent) await client.request({ type: 'pause', key: currentKey }).catch(() => undefined);
  } finally {
    handoffCaptureInFlight = false;
  }
};

const prepareHandoff = async (): Promise<void> => {
  const queue = await ensureCurrent();
  const report = adapter.inspectInterface();
  if (report.health !== 'ok') {
    localNotice = t('notice.handoffUnavailableAdapter', { health: report.health });
    await render();
    return;
  }
  if (queue.status === 'running' || queue.items.some((item) => ['sending', 'running'].includes(item.state))) {
    localNotice = t('notice.handoffUnavailableBusy');
    await render();
    return;
  }
  if (handoffRecord?.sourceConversationKey === currentKey) {
    localNotice = t('notice.handoffAlreadyReady');
    await render();
    return;
  }

  localNotice = undefined;
  handoffPauseRequested = false;
  try {
    const added = await client.request<ConversationQueue>({ type: 'add', key: currentKey, messages: [HANDOFF_PROMPT] });
    const handoffItem = [...added.items].reverse().find((item) => item.content === HANDOFF_PROMPT);
    if (handoffItem) {
      // The brief is produced first, so the remaining follow-ups are still queued when it is
      // captured and can be carried into the fresh conversation untouched.
      await client.request({ type: 'reorder', key: currentKey, itemId: handoffItem.id, queuedIndex: 0 });
    }
  } catch (error) {
    localNotice = t('notice.handoffPrepareFailed', { message: error instanceof Error ? error.message : String(error) });
    await render();
    return;
  }
  await render();
  await startOrResume();
};

const openHandoff = async (): Promise<void> => {
  const pending = handoffRecord ?? await handoffRepository.getPending();
  if (!pending) {
    localNotice = t('notice.noHandoff');
    await render();
    return;
  }
  try {
    const opened = await client.request<{ tabId: number }>({
      type: 'handoffOpen',
      url: new URL('/', location.origin).toString(),
    });
    localNotice = t('notice.handoffOpened', { tabId: opened.tabId });
  } catch (error) {
    localNotice = t('notice.handoffOpenFailed', { message: error instanceof Error ? error.message : String(error) });
  }
  await render();
};

const importHandoffIfClaimed = async (): Promise<void> => {
  if (importedHandoffKey === currentKey) return;
  const claim = await client.request<{ claimed: boolean }>({ type: 'handoffClaim' });
  if (!claim.claimed) return;
  const pending = await handoffRepository.getPending();
  if (!pending || pending.sourceConversationKey === currentKey) return;

  const seed = buildHandoffSeed(pending.brief, pending.carriedItems);
  try {
    await client.request({ type: 'add', key: currentKey, messages: seed });
    await handoffRepository.consume(pending.id, currentKey, Date.now());
    importedHandoffKey = currentKey;
    writeImportedHandoffKey(currentKey);
    localNotice = seed.length === 1
      ? t('notice.handoffImportedOne')
      : t('notice.handoffImported', { count: seed.length });
  } catch (error) {
    localNotice = t('notice.handoffImportFailed', { message: error instanceof Error ? error.message : String(error) });
  }
  await render();
};

const setContextCapacity = async (tokens: number | null): Promise<void> => {
  await contextSettings.setCapacityTokens(tokens);
  contextCapacityOverride = tokens ?? undefined;
  pressureCache = undefined;
  await render();
};

const registerBridgeTarget = async (): Promise<void> => {
  const previousState = bridgeState;
  const queue = (await client.get(currentKey)) ?? await ensureCurrent();
  const hasActiveItem = queue.items.some((item) => ['queued', 'sending', 'running'].includes(item.state));
  const busy = hasActiveItem
    || ['running', 'paused', 'blocked'].includes(queue.status)
    || workflowRun?.status === 'running'
    || workflowRun?.status === 'pending';
  const response = await client.request<{ target: { targetId: string }; state: 'disabled' | 'disconnected' | 'connected' }>({
    type: 'bridgeRegister',
    conversationKey: currentKey,
    queueStatus: queue.status,
    ...(workflowRun === undefined ? {} : { workflowStatus: workflowRun.status }),
    busy,
  });
  bridgeTargetId = response.target.targetId;
  bridgeState = response.state;
  if (__FLOWRUN_E2E__) host.dataset.flowrunBridgeTarget = bridgeTargetId;
  if (previousState !== bridgeState) await render();
};

const claimCurrent = async (): Promise<boolean> => {
  const claim = await client.request<ClaimResult>({ type: 'claim', key: currentKey });
  if (claim.kind === 'conflict') {
    ownsCurrent = false;
    localNotice = t('notice.ownedByOtherTab', { tabId: claim.ownerTabId });
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
      await registerBridgeTarget().catch(() => undefined);
      return;
    } catch (error) {
      localNotice = t('notice.migrationStopped', { message: error instanceof Error ? error.message : String(error) });
      await ensureCurrent();
    }
  } else {
    await ensureCurrent();
  }
  await attachExistingQueue();
  await registerBridgeTarget().catch(() => undefined);
};

const recoverTransientBlockIfSafe = async (queue?: ConversationQueue): Promise<boolean> => {
  const current = queue ?? await client.get(currentKey);
  if (!current || current.status !== 'blocked') return false;

  const snapshot = adapter.getState(false);
  if (current.blockedReason === 'dom-unrecognized') {
    if (!snapshot.domRecognized) return false;
  } else if (current.blockedReason === 'blocking-error') {
    const active = current.runtime.activeItemId
      ? current.items.find((item) => item.id === current.runtime.activeItemId)
      : undefined;
    if (snapshot.blockingReason !== null
      || active?.state !== 'running'
      || current.runtime.generationObserved !== true) return false;

    const baselineCount = current.runtime.baselineAssistantCount ?? 0;
    const assistantAdvanced = current.runtime.baselineAssistantTurnKey !== undefined
      ? snapshot.latestAssistantTurnKey !== undefined
        && snapshot.latestAssistantTurnKey !== current.runtime.baselineAssistantTurnKey
      : snapshot.assistantMessageCount > baselineCount;
    if (!assistantAdvanced) return false;
  } else {
    return false;
  }

  if (recoveringTransientBlock) return true;
  recoveringTransientBlock = true;
  try {
    if (!ownsCurrent && !await claimCurrent()) return false;
    await client.request({ type: 'start', key: currentKey });
    await render();
    scheduleEvaluation(false);
    return true;
  } finally {
    recoveringTransientBlock = false;
  }
};

const attachExistingQueue = async (): Promise<void> => {
  const queue = await ensureCurrent();
  if (queue.status === 'blocked') {
    if (await recoverTransientBlockIfSafe(queue)) return;
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

const bridgeContentController = new BridgeContentController({
  run: async (workflow, inputs, context) => {
    selectedWorkflow = workflow;
    workflowError = undefined;
    await render();
    return flowRunController.run(workflow, inputs, context);
  },
  publish: async (jobId, update) => {
    // Refresh the registration before reporting: a restarted service worker starts with an empty
    // target registry, and a job accepted before owner tabs were persisted can only be bound to
    // the tab that owns its target.
    await registerBridgeTarget().catch(() => undefined);
    await client.request({ type: 'bridgeJobUpdate', jobId, ...update });
  },
});

chrome.runtime.onMessage.addListener((message: BridgeRunMessage, _sender, sendResponse: (response: { ok: boolean; error?: string }) => void) => {
  if (!message || typeof message !== 'object' || message.type !== 'bridgeRun') return false;
  if (!bridgeTargetId || message.targetId !== bridgeTargetId) {
    sendResponse({ ok: false, error: 'bridge-target-mismatch' });
    return false;
  }
  const validated = validateWorkflowDocument(message.workflow);
  if (!validated.ok || !message.inputs || typeof message.inputs !== 'object' || Object.values(message.inputs).some((value) => typeof value !== 'string')) {
    sendResponse({ ok: false, error: 'bridge-invalid-run' });
    return false;
  }
  void bridgeContentController.accept({ jobId: message.jobId, workflow: validated.value, inputs: { ...message.inputs } })
    .catch(async (error: unknown) => {
      localNotice = t('notice.bridgeJobFailed', { message: error instanceof Error ? error.message : String(error) });
      await render().catch(() => undefined);
    });
  sendResponse({ ok: true });
  return false;
});

const loadWorkflowText = async (text: string): Promise<void> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    workflowError = t('notice.invalidWorkflowJson', { message: error instanceof Error ? error.message : String(error) });
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

const loadWorkflowPreset = async (presetId: string): Promise<void> => {
  const preset = getWorkflowPreset(presetId);
  if (!preset) {
    workflowError = t('notice.unknownWorkflowPreset', { presetId });
    await render();
    return;
  }

  selectedWorkflow = preset.workflow;
  workflowRun = undefined;
  workflowError = undefined;
  await render();
};

const runSelectedWorkflow = async (inputs: Record<string, string>): Promise<void> => {
  if (!selectedWorkflow) {
    workflowError = t('notice.noWorkflowLoaded');
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
  loadWorkflowPreset,
  runWorkflow: runSelectedWorkflow,
  clearWorkflow: clearSelectedWorkflow,
  prepareHandoff,
  openHandoff,
  setContextCapacity,
  setLocale: async (preference) => {
    applyLocale(preference);
    await uiPreferences.setLocale(preference).catch(() => undefined);
    await render();
  },
  enableBridge: async () => {
    bridgeState = 'enabling';
    await render();
    try {
      const response = await client.request<{ enabled: boolean; state: 'disabled' | 'disconnected' | 'connected' }>({ type: 'bridgeEnable' });
      bridgeState = response.state;
    } catch {
      bridgeState = 'disconnected';
    }
    await render();
  },
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
  if (extensionStale) return;
  evaluationTail = evaluationTail
    .then(async () => {
      await syncIdentity();
      if (!ownsCurrent) {
        // Panel state that is purely local — the adapter interface report and the context estimate —
        // must still follow the page on a tab that does not drive this conversation's queue. ChatGPT
        // mutates its DOM constantly, so this is deliberately budgeted instead of running per change.
        const now = Date.now();
        if (now - lastPassiveRenderAt >= PASSIVE_RENDER_MIN_MS) {
          lastPassiveRenderAt = now;
          await render();
        }
        return;
      }
      await runner.evaluate(currentKey, domStable);
      const queue = await render();
      if (shouldObserveLifecycle(queue) &&
        (queue?.runtime.phase === 'sending' || queue?.runtime.phase === 'waiting_stable_completion')) {
        armStableEvaluation();
      }
      if (queue?.status === 'running' && queue.runtime.phase === 'ready_to_send_next') scheduleEvaluation(false);
    })
    .catch(async (error: unknown) => {
      noteEvaluationFailure(error);
      await render().catch(() => undefined);
    });
}

const observer = new MutationObserver(() => {
  lastDomMutationAt = Date.now();
  if (extensionStale) return;
  void (async () => {
    await syncIdentity();
    if (await recoverTransientBlockIfSafe()) return;
    armStableEvaluation();
    scheduleEvaluation(false);
  })().catch(() => undefined);
});
observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });

chrome.storage.onChanged.addListener((_changes, areaName) => {
  if (areaName !== 'local' || extensionStale) return;
  void render().then((queue) => {
    if (ownsCurrent && shouldObserveLifecycle(queue)) scheduleEvaluation(false);
  }).catch(() => undefined);
});

const watchdogTimer = window.setInterval(detectLostExtensionContext, CONTEXT_WATCHDOG_MS);

const heartbeatTimer = window.setInterval(() => {
  if (extensionStale) return;
  void registerBridgeTarget().catch(() => undefined);
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

void (async () => {
  const preferences = await uiPreferences.get().catch(() => undefined);
  if (preferences) applyLocale(preferences.locale);
  contextCapacityOverride = await contextSettings.getCapacityTokens().catch(() => undefined);
  handoffRecord = await handoffRepository.getPending().catch(() => undefined);
  await importHandoffIfClaimed().catch(() => undefined);
})().then(async () => {
  await attachExistingQueue();
  const recoveredRun = await flowRunController.recoverInterrupted(currentKey);
  if (recoveredRun) {
    await publishRecoveredBridgeRun(recoveredRun, async (jobId, update) => {
      await client.request({ type: 'bridgeJobUpdate', jobId, ...update });
    });
  }
  await registerBridgeTarget().catch(() => undefined);
  armStableEvaluation();
}).catch(async (error: unknown) => {
  localNotice = error instanceof Error ? error.message : String(error);
  await render().catch(() => undefined);
});
