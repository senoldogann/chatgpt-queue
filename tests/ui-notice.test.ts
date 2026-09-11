// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { QueuePanel } from '../src/ui/queue-panel';
import type { ConversationQueue } from '../src/domain/types';

it('shows a tab-local ownership conflict without mutating shared queue state', () => {
  const queue: ConversationQueue = {
    version: 1,
    id: 'q',
    conversationKey: 'conv:a',
    status: 'running',
    items: [],
    runtime: { phase: 'idle' },
    createdAt: 1,
    updatedAt: 1,
  };
  const host = document.createElement('div');
  const panel = new QueuePanel(host, {});
  panel.render(queue, 'Owned by another tab');
  expect(host.shadowRoot!.textContent).toContain('Owned by another tab');
});
