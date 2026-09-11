import { QueueCoordinator } from '../coordinator/queue-coordinator';
import type { BackgroundRequest } from './protocol';

export async function handleBackgroundRequest(request: BackgroundRequest, tabId: number, coordinator: QueueCoordinator): Promise<any> {
  switch (request.type) {
    case 'ensure':
      return coordinator.ensureQueue(request.key);
    case 'get':
      return coordinator.get(request.key);
    case 'add':
      return coordinator.add(request.key, request.messages);
    case 'edit':
      return coordinator.edit(request.key, request.itemId, request.content);
    case 'delete':
      return coordinator.remove(request.key, request.itemId);
    case 'reorder':
      return coordinator.reorder(request.key, request.itemId, request.queuedIndex);
    case 'claim':
      return coordinator.claim(request.key, tabId);
    case 'heartbeat':
      return coordinator.heartbeat(request.key, tabId);
    case 'start':
      return coordinator.start(request.key, tabId);
    case 'pause':
      return coordinator.pause(request.key, tabId);
    case 'recover':
      return coordinator.recover(request.key);
    case 'reserve':
      return coordinator.reserveNext(request.key, tabId, request.baselineAssistantCount);
    case 'generationStarted':
      return coordinator.confirmGenerationStarted(request.key, tabId, request.itemId, request.dispatchToken, request.controlObserved);
    case 'waitingStable':
      return coordinator.markWaitingForStability(request.key, tabId, request.itemId, request.dispatchToken);
    case 'complete':
      return coordinator.completeCurrent(request.key, tabId, request.itemId, request.dispatchToken);
    case 'block':
      return coordinator.block(request.key, tabId, request.reason);
    case 'migrate':
      return coordinator.migrateKey(request.fromKey, request.toKey);
  }
}
