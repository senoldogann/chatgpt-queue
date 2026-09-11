// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { QueuePanel } from '../src/ui/queue-panel';
import type { ConversationQueue } from '../src/domain/types';

const sampleQueue = (): ConversationQueue => ({
  version: 1,
  id: 'q',
  conversationKey: 'conv:a',
  status: 'running',
  items: [
    { id: 'done', content: 'Inspect project', state: 'completed', createdAt: 1, updatedAt: 2, completedAt: 2 },
    { id: 'active', content: 'Check backend', state: 'running', createdAt: 1, updatedAt: 2, dispatchToken: 'd' },
    { id: 'wait', content: 'Run tests', state: 'queued', createdAt: 1, updatedAt: 2 },
  ],
  runtime: { phase: 'generating', activeItemId: 'active', baselineAssistantCount: 1, generationObserved: true },
  createdAt: 1,
  updatedAt: 2,
});

describe('QueuePanel', () => {
  it('renders status, pending count, active and completed items', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const panel = new QueuePanel(host, {});
    panel.render(sampleQueue());
    const text = host.shadowRoot!.textContent!;
    expect(text).toContain('Queue · 1');
    expect(text).toContain('Running');
    expect(text).toContain('Inspect project');
    expect(text).toContain('Check backend');
    expect(text).toContain('Run tests');
  });

  it('adds a message and exposes pause plus queued edit/delete/reorder actions', async () => {
    const add = vi.fn();
    const pause = vi.fn();
    const edit = vi.fn();
    const remove = vi.fn();
    const reorder = vi.fn();
    const host = document.createElement('div');
    document.body.append(host);
    const panel = new QueuePanel(host, { add, pause, edit, remove, reorder });
    panel.render(sampleQueue());
    const root = host.shadowRoot!;

    const input = root.querySelector<HTMLTextAreaElement>('[data-role="new-message"]')!;
    input.value = 'next message';
    root.querySelector<HTMLButtonElement>('[data-action="add"]')!.click();
    root.querySelector<HTMLButtonElement>('[data-action="pause"]')!.click();

    const queuedInput = root.querySelector<HTMLTextAreaElement>('[data-item-id="wait"]')!;
    queuedInput.value = 'Run all tests';
    root.querySelector<HTMLButtonElement>('[data-action="save"][data-id="wait"]')!.click();
    root.querySelector<HTMLButtonElement>('[data-action="delete"][data-id="wait"]')!.click();
    root.querySelector<HTMLButtonElement>('[data-action="up"][data-id="wait"]')!.click();

    await Promise.resolve();
    expect(add).toHaveBeenCalledWith('next message');
    expect(pause).toHaveBeenCalled();
    expect(edit).toHaveBeenCalledWith('wait', 'Run all tests');
    expect(remove).toHaveBeenCalledWith('wait');
    expect(reorder).toHaveBeenCalledWith('wait', -1);
  });

  it('shows a blocked reason', () => {
    const host = document.createElement('div');
    const panel = new QueuePanel(host, {});
    panel.render({ ...sampleQueue(), status: 'blocked', blockedReason: 'confirmation-required' });
    expect(host.shadowRoot!.textContent).toContain('confirmation-required');
  });
});
