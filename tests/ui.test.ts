// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { QueuePanel } from '../src/ui/queue-panel';
import type { ConversationQueue } from '../src/domain/types';
import type { WorkflowRun } from '../src/flowrun/events';
import type { WorkflowDefinition } from '../src/flowrun/schema';

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

  it('preserves a focused new-message draft across rerenders and clears it after a successful add', async () => {
    const add = vi.fn(async () => undefined);
    const host = document.createElement('div');
    document.body.append(host);
    const panel = new QueuePanel(host, { add });
    const completed: ConversationQueue = {
      ...sampleQueue(),
      status: 'completed',
      items: sampleQueue().items.map((item) => ({ ...item, state: 'completed' as const })),
      runtime: { phase: 'idle' },
    };

    panel.render(completed);
    const firstInput = host.shadowRoot!.querySelector<HTMLTextAreaElement>('[data-role="new-message"]')!;
    firstInput.value = 'follow-up after completion';
    firstInput.focus();
    firstInput.setSelectionRange(9, 9);

    panel.render(completed);

    const rerenderedInput = host.shadowRoot!.querySelector<HTMLTextAreaElement>('[data-role="new-message"]')!;
    expect(rerenderedInput).toBe(firstInput);
    expect(rerenderedInput.value).toBe('follow-up after completion');
    expect(host.shadowRoot!.activeElement).toBe(rerenderedInput);
    expect(rerenderedInput.selectionStart).toBe(9);

    host.shadowRoot!.querySelector<HTMLButtonElement>('[data-action="add"]')!.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(add).toHaveBeenCalledWith('follow-up after completion');
    expect(host.shadowRoot!.querySelector<HTMLTextAreaElement>('[data-role="new-message"]')!.value).toBe('');
  });

  it('keeps all interactive controls mounted when the visible queue state has not changed', async () => {
    const start = vi.fn();
    const edit = vi.fn();
    const remove = vi.fn();
    const reorder = vi.fn();
    const host = document.createElement('div');
    document.body.append(host);
    const panel = new QueuePanel(host, { start, edit, remove, reorder });
    const idle: ConversationQueue = {
      ...sampleQueue(),
      status: 'idle',
      items: sampleQueue().items.map((item, index) => index === 2 ? { ...item, state: 'queued' as const } : { ...item, state: 'completed' as const }),
      runtime: { phase: 'idle' },
    };

    panel.render(idle);
    const root = host.shadowRoot!;
    const controls = {
      start: root.querySelector<HTMLButtonElement>('[data-action="start"]')!,
      up: root.querySelector<HTMLButtonElement>('[data-action="up"]')!,
      down: root.querySelector<HTMLButtonElement>('[data-action="down"]')!,
      save: root.querySelector<HTMLButtonElement>('[data-action="save"]')!,
      delete: root.querySelector<HTMLButtonElement>('[data-action="delete"]')!,
    };
    root.querySelector<HTMLTextAreaElement>('[data-item-id="wait"]')!.value = 'Run stable tests';

    panel.render({ ...idle, owner: { tabId: 1, leaseId: 'lease', heartbeatAt: 10, expiresAt: 20 }, updatedAt: idle.updatedAt + 10 });

    expect(root.querySelector('[data-action="start"]')).toBe(controls.start);
    expect(root.querySelector('[data-action="up"]')).toBe(controls.up);
    expect(root.querySelector('[data-action="down"]')).toBe(controls.down);
    expect(root.querySelector('[data-action="save"]')).toBe(controls.save);
    expect(root.querySelector('[data-action="delete"]')).toBe(controls.delete);

    controls.start.click();
    controls.up.click();
    controls.down.click();
    controls.save.click();
    controls.delete.click();
    await Promise.resolve();

    expect(start).toHaveBeenCalledTimes(1);
    expect(reorder).toHaveBeenNthCalledWith(1, 'wait', -1);
    expect(reorder).toHaveBeenNthCalledWith(2, 'wait', 1);
    expect(edit).toHaveBeenCalledWith('wait', 'Run stable tests');
    expect(remove).toHaveBeenCalledWith('wait');
  });

  it('hides to a right-edge tab and restores without rebuilding the queue', () => {
    sessionStorage.removeItem('chatgpt-queue:panel-collapsed');
    const host = document.createElement('div');
    document.body.append(host);
    const panel = new QueuePanel(host, {});
    panel.render(sampleQueue());
    const root = host.shadowRoot!;
    const firstPanel = root.querySelector('.panel');

    root.querySelector<HTMLButtonElement>('[data-action="hide"]')!.click();
    expect(root.querySelector('.dock')?.classList.contains('collapsed')).toBe(true);
    expect(sessionStorage.getItem('chatgpt-queue:panel-collapsed')).toBe('1');
    expect(root.querySelector('.panel')).toBe(firstPanel);

    root.querySelector<HTMLButtonElement>('[data-action="show"]')!.click();
    expect(root.querySelector('.dock')?.classList.contains('collapsed')).toBe(false);
    expect(sessionStorage.getItem('chatgpt-queue:panel-collapsed')).toBe('0');
    expect(root.querySelector('.panel')).toBe(firstPanel);
  });


  it('renders a loaded workflow, preserves inputs, and runs only when the normal queue is free', async () => {
    const runWorkflow = vi.fn();
    const clearWorkflow = vi.fn();
    const host = document.createElement('div');
    document.body.append(host);
    const panel = new QueuePanel(host, { runWorkflow, clearWorkflow });
    const workflow: WorkflowDefinition = {
      version: 1,
      name: 'review-pr',
      inputs: {
        diff: { type: 'string', required: true },
        language: { type: 'string' },
      },
      steps: [
        { id: 'review', type: 'chat', provider: 'chatgpt', prompt: 'Review {{ inputs.diff }}' },
        { id: 'tests', type: 'chat', provider: 'chatgpt', prompt: 'Tests for {{ steps.review.output }}' },
      ],
    };

    panel.render(sampleQueue(), undefined, { workflow });
    let root = host.shadowRoot!;
    expect(root.textContent).toContain('Workflow');
    expect(root.textContent).toContain('review-pr');
    expect(root.textContent).toContain('2 steps');
    expect(root.textContent).toContain('Finish or clear the current queue before starting a workflow.');
    expect(root.querySelector<HTMLButtonElement>('[data-action="run-workflow"]')!.disabled).toBe(true);

    const idle: ConversationQueue = {
      ...sampleQueue(),
      status: 'completed',
      items: sampleQueue().items.map((item) => ({ ...item, state: 'completed' as const })),
      runtime: { phase: 'idle' },
    };
    panel.render(idle, undefined, { workflow });
    root = host.shadowRoot!;
    const diff = root.querySelector<HTMLInputElement>('[data-workflow-input="diff"]')!;
    const language = root.querySelector<HTMLInputElement>('[data-workflow-input="language"]')!;
    diff.value = 'diff content';
    language.value = 'tr';
    diff.focus();
    diff.setSelectionRange(4, 4);

    panel.render({ ...idle, updatedAt: 99 }, undefined, { workflow });
    root = host.shadowRoot!;
    expect(root.querySelector<HTMLInputElement>('[data-workflow-input="diff"]')!.value).toBe('diff content');
    expect(root.activeElement).toBe(root.querySelector('[data-workflow-input="diff"]'));

    root.querySelector<HTMLButtonElement>('[data-action="run-workflow"]')!.click();
    root.querySelector<HTMLButtonElement>('[data-action="clear-workflow"]')!.click();
    await Promise.resolve();

    expect(runWorkflow).toHaveBeenCalledWith({ diff: 'diff content', language: 'tr' });
    expect(clearWorkflow).toHaveBeenCalledTimes(1);
  });

  it('loads workflow text from a selected file and renders live run progress and block reason', async () => {
    const loadWorkflow = vi.fn();
    const host = document.createElement('div');
    document.body.append(host);
    const panel = new QueuePanel(host, { loadWorkflow });
    const idle: ConversationQueue = {
      ...sampleQueue(),
      status: 'completed',
      items: [],
      runtime: { phase: 'idle' },
    };

    panel.render(idle, undefined, {});
    const fileInput = host.shadowRoot!.querySelector<HTMLInputElement>('[data-role="workflow-file"]')!;
    const fakeFile = { text: vi.fn(async () => '{"version":1}') } as unknown as File;
    Object.defineProperty(fileInput, 'files', { value: [fakeFile] });
    fileInput.dispatchEvent(new Event('change'));
    await Promise.resolve();
    await Promise.resolve();
    expect(loadWorkflow).toHaveBeenCalledWith('{"version":1}');

    const workflow: WorkflowDefinition = {
      version: 1,
      name: 'live-flow',
      inputs: {},
      steps: [
        { id: 'first', type: 'chat', provider: 'chatgpt', prompt: 'one' },
        { id: 'second', type: 'chat', provider: 'chatgpt', prompt: 'two' },
      ],
    };
    const run: WorkflowRun = {
      id: 'run-1',
      workflowName: 'live-flow',
      workflowVersion: 1,
      status: 'blocked',
      inputs: {},
      steps: [
        { id: 'first', status: 'completed', output: 'done' },
        { id: 'second', status: 'blocked', error: 'message-delivery-timeout' },
      ],
      events: [],
      createdAt: 1,
      updatedAt: 2,
      browser: { conversationKey: 'conv:a' },
    };
    panel.render(idle, undefined, { workflow, run });
    const text = host.shadowRoot!.textContent!;
    expect(text).toContain('Blocked');
    expect(text).toContain('1 / 2');
    expect(text).toContain('second');
    expect(text).toContain('message-delivery-timeout');
  });

  it('shows a blocked reason', () => {
    const host = document.createElement('div');
    const panel = new QueuePanel(host, {});
    panel.render({ ...sampleQueue(), status: 'blocked', blockedReason: 'confirmation-required' });
    expect(host.shadowRoot!.textContent).toContain('confirmation-required');
  });
});
