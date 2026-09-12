import type { DispatchReservation } from '../coordinator/queue-coordinator';
import type { ConversationQueue } from '../domain/types';
import type { RunnerBackend } from './queue-runner';
import type { BackgroundEnvelope, ExtensionRequest } from './protocol';

export class ChromeClient implements RunnerBackend {
  async request<T>(request: ExtensionRequest): Promise<T> {
    const response = await chrome.runtime.sendMessage(request) as BackgroundEnvelope;
    if (!response?.ok) throw new Error(response?.error ?? 'extension-request-failed');
    return response.data as T;
  }

  get(key: string): Promise<ConversationQueue | undefined> {
    return this.request({ type: 'get', key });
  }

  reserve(key: string, baselineAssistantCount: number, baselineAssistantTurnKey?: string): Promise<DispatchReservation | null> {
    return this.request({
      type: 'reserve',
      key,
      baselineAssistantCount,
      ...(baselineAssistantTurnKey === undefined ? {} : { baselineAssistantTurnKey }),
    });
  }

  generationStarted(key: string, itemId: string, dispatchToken: string, controlObserved: boolean): Promise<ConversationQueue> {
    return this.request({ type: 'generationStarted', key, itemId, dispatchToken, controlObserved });
  }

  waitingStable(key: string, itemId: string, dispatchToken: string): Promise<ConversationQueue> {
    return this.request({ type: 'waitingStable', key, itemId, dispatchToken });
  }

  complete(key: string, itemId: string, dispatchToken: string): Promise<ConversationQueue> {
    return this.request({ type: 'complete', key, itemId, dispatchToken });
  }

  block(key: string, reason: string): Promise<ConversationQueue> {
    return this.request({ type: 'block', key, reason });
  }
}
