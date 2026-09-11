import { QueueCoordinator } from './coordinator/queue-coordinator';
import type { ConversationQueue } from './domain/types';
import { handleBackgroundRequest } from './runtime/background-handler';
import type { BackgroundEnvelope, BackgroundRequest } from './runtime/protocol';
import { chromeStorageArea, QueueRepository } from './storage/queue-repository';

const coordinator = new QueueCoordinator(new QueueRepository(chromeStorageArea()));

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

chrome.runtime.onMessage.addListener((request: BackgroundRequest, sender, sendResponse: (response: BackgroundEnvelope) => void) => {
  const tabId = sender.tab?.id;
  if (tabId === undefined || !request || typeof request !== 'object' || typeof request.type !== 'string') {
    sendResponse({ ok: false, error: 'invalid-extension-request' });
    return false;
  }

  void handleBackgroundRequest(request, tabId, coordinator)
    .then(async (data) => {
      if (data && typeof data === 'object' && 'status' in data) await notify(data as ConversationQueue);
      sendResponse({ ok: true, data });
    })
    .catch((error: unknown) => {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    });
  return true;
});
