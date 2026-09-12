import { BridgeJobRepository, chromeBridgeStorageArea } from './bridge/job-repository';
import { NativeBridgeService, type NativePortLike } from './bridge/native-service';
import { TargetRegistry } from './bridge/target-registry';
import { QueueCoordinator } from './coordinator/queue-coordinator';
import type { ConversationQueue } from './domain/types';
import { handleBackgroundRequest } from './runtime/background-handler';
import type { BackgroundEnvelope, BackgroundRequest, BridgeControlRequest, ExtensionRequest } from './runtime/protocol';
import { chromeStorageArea, QueueRepository } from './storage/queue-repository';

const coordinator = new QueueCoordinator(new QueueRepository(chromeStorageArea()));
const bridgeRepository = new BridgeJobRepository(chromeBridgeStorageArea());
const targetRegistry = new TargetRegistry();
const nativeBridge = new NativeBridgeService({
  hasPermission: () => chrome.permissions.contains({ permissions: ['nativeMessaging'] }),
  requestPermission: () => chrome.permissions.request({ permissions: ['nativeMessaging'] }),
  connectNative: (name) => chrome.runtime.connectNative(name) as unknown as NativePortLike,
  repository: bridgeRepository,
  registry: targetRegistry,
  routeToTab: (tabId, message) => chrome.tabs.sendMessage(tabId, message),
});

const notify = async (queue: ConversationQueue): Promise<void> => {
  if (queue.status !== 'completed' && queue.status !== 'blocked') return;
  const completed = queue.status === 'completed';
  const id = `chatgpt-queue:${queue.id}:${completed ? 'completed' : 'blocked'}`;
  await chrome.notifications.create(id, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icon128.png'),
    title: completed ? 'ChatGPT Queue completed' : 'ChatGPT Queue paused',
    message: completed ? 'All queued follow-up messages finished.' : `Reason: ${queue.blockedReason ?? 'unknown'}`,
  });
};

const isBridgeRequest = (request: ExtensionRequest): request is BridgeControlRequest =>
  request.type === 'bridgeRegister'
  || request.type === 'bridgeState'
  || request.type === 'bridgeEnable'
  || request.type === 'bridgeJobUpdate';

const handleBridgeRequest = async (request: BridgeControlRequest, tabId: number): Promise<unknown> => {
  switch (request.type) {
    case 'bridgeRegister': {
      const target = targetRegistry.register(tabId, {
        conversationKey: request.conversationKey,
        queueStatus: request.queueStatus,
        ...(request.workflowStatus === undefined ? {} : { workflowStatus: request.workflowStatus }),
        busy: request.busy,
      });
      await nativeBridge.ensureConnected();
      return { target, state: nativeBridge.state() };
    }
    case 'bridgeState':
      await nativeBridge.ensureConnected();
      return { state: nativeBridge.state() };
    case 'bridgeEnable':
      return { enabled: await nativeBridge.enable(), state: nativeBridge.state() };
    case 'bridgeJobUpdate': {
      const record = await bridgeRepository.get(request.jobId);
      if (!record) throw new Error('bridge-job-not-found');
      const target = targetRegistry.resolve(record.targetId);
      if (!target || target.tabId !== tabId) throw new Error('bridge-target-owner-mismatch');
      return nativeBridge.publishJobUpdate(request.jobId, {
        status: request.status,
        ...(request.workflowRunId === undefined ? {} : { workflowRunId: request.workflowRunId }),
        ...(request.error === undefined ? {} : { error: request.error }),
      });
    }
  }
};

void nativeBridge.ensureConnected();

chrome.runtime.onMessage.addListener((rawRequest: ExtensionRequest, sender, sendResponse: (response: BackgroundEnvelope) => void) => {
  const tabId = sender.tab?.id;
  if (tabId === undefined || !rawRequest || typeof rawRequest !== 'object' || typeof rawRequest.type !== 'string') {
    sendResponse({ ok: false, error: 'invalid-extension-request' });
    return false;
  }

  if (isBridgeRequest(rawRequest)) {
    void handleBridgeRequest(rawRequest, tabId)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error: unknown) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  void handleBackgroundRequest(rawRequest as BackgroundRequest, tabId, coordinator)
    .then(async (data) => {
      if (data && typeof data === 'object' && 'status' in data) await notify(data as ConversationQueue);
      sendResponse({ ok: true, data });
    })
    .catch((error: unknown) => {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    });
  return true;
});
