// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { AdapterInterfaceReport } from '../src/adapter/chatgpt-adapter';
import { resolveContextCapacity } from '../src/context/capacity';
import { measureContextPressure } from '../src/context/pressure';
import { QueuePanel } from '../src/ui/queue-panel';
import type { ConversationQueue } from '../src/domain/types';
import type { WorkflowRun } from '../src/flowrun/events';
import type { WorkflowDefinition } from '../src/flowrun/schema';

const idleQueue = (): ConversationQueue => ({
  version: 1,
  id: 'q',
  conversationKey: 'conv:a',
  status: 'completed',
  items: [],
  runtime: { phase: 'idle' },
  createdAt: 1,
  updatedAt: 2,
});

const pressure = (capacityTokens: number, turns = 4, charsPerTurn = 1_000) => measureContextPressure(
  Array.from({ length: turns }, (_, index) => ({ role: index % 2 === 0 ? 'user' as const : 'assistant' as const, text: 'x'.repeat(charsPerTurn) })),
  resolveContextCapacity({ configuredTokens: capacityTokens }),
);

const adapterReport = (health: AdapterInterfaceReport['health']): AdapterInterfaceReport => ({
  health,
  recognized: health !== 'unrecognized',
  composer: { status: health === 'unrecognized' ? 'missing' : 'ok', matchedSelector: '#prompt-textarea' },
  sendControl: { status: health === 'ok' ? 'ok' : 'missing', matchedSelector: 'button[data-testid="send-button"]' },
  stopControl: { status: 'missing', matchedSelector: null },
  transcript: { status: 'ok', matchedSelector: 'main' },
  assistantTurn: { status: 'missing', matchedSelector: null },
  isGenerating: false,
  composerReady: health !== 'unrecognized',
  sendControlPresent: health === 'ok',
  blockingReason: null,
  confirmationVisible: false,
});

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

  it('renders professional workflow presets, previews the selection, and loads one only from an explicit action', async () => {
    const loadWorkflowPreset = vi.fn();
    const host = document.createElement('div');
    document.body.append(host);
    const panel = new QueuePanel(host, { loadWorkflowPreset });
    const idle: ConversationQueue = {
      ...sampleQueue(),
      status: 'completed',
      items: [],
      runtime: { phase: 'idle' },
    };

    panel.render(idle, undefined, {});
    const root = host.shadowRoot!;
    const select = root.querySelector<HTMLSelectElement>('[data-role="workflow-preset"]')!;
    expect(select).not.toBeNull();
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual([
      'Choose a built-in workflow',
      'Production Readiness',
      'Code Review',
      'Root Cause Debugging',
      'Release Gate',
      'Implementation Plan',
    ]);
    expect(root.querySelector('[data-role="workflow-preset-description"]')?.textContent).toContain('Choose a proven local workflow');
    expect(root.querySelector('[data-role="workflow-file"]')).not.toBeNull();

    select.value = 'root-cause-debugging';
    select.dispatchEvent(new Event('change'));
    expect(root.querySelector('[data-role="workflow-preset-description"]')?.textContent).toContain('Evidence-first diagnosis');
    expect(loadWorkflowPreset).not.toHaveBeenCalled();

    root.querySelector<HTMLButtonElement>('[data-action="load-workflow-preset"]')!.click();
    await Promise.resolve();
    expect(loadWorkflowPreset).toHaveBeenCalledWith('root-cause-debugging');
  });

  it('keeps a staged preset selection across panel re-renders so Use preset stays actionable', async () => {
    const loadWorkflowPreset = vi.fn();
    const host = document.createElement('div');
    document.body.append(host);
    const panel = new QueuePanel(host, { loadWorkflowPreset });
    const idle: ConversationQueue = {
      ...sampleQueue(),
      status: 'completed',
      items: [],
      runtime: { phase: 'idle' },
    };

    panel.render(idle, undefined, {});
    const root = host.shadowRoot!;
    const select = root.querySelector<HTMLSelectElement>('[data-role="workflow-preset"]')!;
    select.value = 'release-gate';
    select.dispatchEvent(new Event('change'));

    // Background queue/bridge updates re-render the panel and previously dropped the staged choice.
    panel.render({ ...idle, status: 'running', runtime: { phase: 'generating' } }, 'bridge-reconnected', {});

    const rerenderedSelect = root.querySelector<HTMLSelectElement>('[data-role="workflow-preset"]')!;
    expect(rerenderedSelect.value).toBe('release-gate');
    expect(root.querySelector('[data-role="workflow-preset-description"]')?.textContent).toContain('Evidence-based go/no-go');
    const button = root.querySelector<HTMLButtonElement>('[data-action="load-workflow-preset"]')!;
    expect(button.disabled).toBe(false);

    button.click();
    await Promise.resolve();
    expect(loadWorkflowPreset).toHaveBeenCalledWith('release-gate');
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
  it('shows a CSS-only activity spinner only while queue or FlowRun is running', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const panel = new QueuePanel(host, {});

    panel.render(sampleQueue(), undefined, { bridgeState: 'disabled' });
    let root = host.shadowRoot!;
    expect(root.querySelector('[data-role="activity-spinner"]')).not.toBeNull();
    expect(root.querySelector('[data-role="activity-spinner-collapsed"]')).not.toBeNull();
    expect(root.querySelector('style')?.textContent).toContain('@keyframes queue-spin');
    expect(root.querySelector('style')?.textContent).toContain('prefers-reduced-motion');

    const idle: ConversationQueue = { ...sampleQueue(), status: 'completed', items: [], runtime: { phase: 'idle' } };
    panel.render(idle, undefined, { bridgeState: 'disabled' });
    root = host.shadowRoot!;
    expect(root.querySelector('[data-role="activity-spinner"]')).toBeNull();

    const runningRun: WorkflowRun = {
      id: 'run-spinner', workflowName: 'flow', workflowVersion: 1, status: 'running', inputs: {},
      steps: [{ id: 'step', status: 'waiting' }], events: [], createdAt: 1, updatedAt: 2,
    };
    panel.render(idle, undefined, { run: runningRun, bridgeState: 'disabled' });
    expect(host.shadowRoot!.querySelector('[data-role="activity-spinner"]')).not.toBeNull();

    panel.render(idle, undefined, { run: { ...runningRun, status: 'blocked', steps: [{ id: 'step', status: 'blocked', error: 'x' }] }, bridgeState: 'disabled' });
    expect(host.shadowRoot!.querySelector('[data-role="activity-spinner"]')).toBeNull();
  });

  it('shows the adapter interface health, the context estimate, and a capacity override', async () => {
    const setContextCapacity = vi.fn();
    const host = document.createElement('div');
    document.body.append(host);
    const panel = new QueuePanel(host, { setContextCapacity });

    panel.render(idleQueue(), undefined, {
      context: {
        pressure: pressure(1_400, 4, 1_000),
        adapter: { report: adapterReport('ok'), diagnostics: 'composer=DIV#prompt-textarea | send-testid=true' },
      },
    });
    let root = host.shadowRoot!;
    expect(root.querySelector('[data-role="adapter-health"]')?.textContent).toBe('interface ok');
    expect(root.querySelector('[data-role="context-detail"]')?.textContent).toContain('(est.');
    expect(root.querySelector('.meter-fill')?.getAttribute('class')).toContain('level-compact');

    const detail = root.querySelector<HTMLElement>('[data-role="adapter-detail"]')!;
    expect(detail.hidden).toBe(true);
    root.querySelector<HTMLButtonElement>('[data-action="toggle-adapter-detail"]')!.click();
    expect(detail.hidden).toBe(false);
    expect(detail.textContent).toContain('composer=DIV#prompt-textarea');

    const capacity = root.querySelector<HTMLInputElement>('input[data-role="context-capacity"]')!;
    expect(capacity.value).toBe('');
    capacity.value = '1310000';
    capacity.dispatchEvent(new Event('change'));
    await Promise.resolve();
    expect(setContextCapacity).toHaveBeenCalledWith(1_310_000);

    // A later rerender keeps an unsaved edit instead of dropping the user's value.
    capacity.value = '250000';
    panel.render(idleQueue(), undefined, { context: { pressure: pressure(10_000), adapter: { report: adapterReport('degraded'), diagnostics: 'x' } } });
    root = host.shadowRoot!;
    expect(root.querySelector('[data-role="adapter-health"]')?.textContent).toBe('interface degraded');
    expect(root.querySelector<HTMLInputElement>('input[data-role="context-capacity"]')!.value).toBe('250000');
  });

  it('only offers a handoff when the adapter is recognized, and never opens one implicitly', async () => {
    const prepareHandoff = vi.fn();
    const openHandoff = vi.fn();
    const host = document.createElement('div');
    document.body.append(host);
    const panel = new QueuePanel(host, { prepareHandoff, openHandoff });
    const context = { pressure: pressure(1_310_000), adapter: { report: adapterReport('ok'), diagnostics: 'diag' } };

    panel.render(idleQueue(), undefined, { context });
    let root = host.shadowRoot!;
    const prepare = root.querySelector<HTMLButtonElement>('[data-action="prepare-handoff"]')!;
    expect(prepare.disabled).toBe(false);
    await Promise.resolve();
    expect(prepareHandoff).not.toHaveBeenCalled();

    prepare.click();
    await Promise.resolve();
    expect(prepareHandoff).toHaveBeenCalledTimes(1);

    panel.render(idleQueue(), undefined, { context: { ...context, handoff: { status: 'capturing', carriedItems: 0 } } });
    root = host.shadowRoot!;
    expect(root.textContent).toContain('Preparing handoff brief');
    expect(root.querySelector('[data-action="prepare-handoff"]')).toBeNull();

    panel.render(idleQueue(), undefined, { context: { ...context, handoff: { status: 'ready', carriedItems: 3 } } });
    root = host.shadowRoot!;
    expect(root.textContent).toContain('3 items carried');
    root.querySelector<HTMLButtonElement>('[data-action="open-handoff"]')!.click();
    await Promise.resolve();
    expect(openHandoff).toHaveBeenCalledTimes(1);
  });

  it('disables the handoff while the queue is busy or the interface is not recognized', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const panel = new QueuePanel(host, { prepareHandoff: vi.fn() });

    panel.render(sampleQueue(), undefined, {
      context: { pressure: pressure(1_310_000), adapter: { report: adapterReport('ok'), diagnostics: 'diag' } },
    });
    expect(host.shadowRoot!.querySelector<HTMLButtonElement>('[data-action="prepare-handoff"]')!.disabled).toBe(true);
    expect(host.shadowRoot!.textContent).toContain('Available once the queue');

    panel.render(idleQueue(), undefined, {
      context: { pressure: pressure(1_310_000), adapter: { report: adapterReport('unrecognized'), diagnostics: 'diag' } },
    });
    expect(host.shadowRoot!.querySelector<HTMLButtonElement>('[data-action="prepare-handoff"]')!.disabled).toBe(true);
    expect(host.shadowRoot!.textContent).toContain('The adapter must recognize this page');
  });

  it('renders CLI bridge state and requests enable only from an explicit click', async () => {
    const enableBridge = vi.fn();
    const host = document.createElement('div');
    document.body.append(host);
    const panel = new QueuePanel(host, { enableBridge });
    const idle: ConversationQueue = { ...sampleQueue(), status: 'completed', items: [], runtime: { phase: 'idle' } };

    panel.render(idle, undefined, { bridgeState: 'disabled' });
    expect(host.shadowRoot!.textContent).toContain('CLI bridge');
    expect(host.shadowRoot!.textContent).toContain('Disabled');
    host.shadowRoot!.querySelector<HTMLButtonElement>('[data-action="enable-bridge"]')!.click();
    await Promise.resolve();
    expect(enableBridge).toHaveBeenCalledTimes(1);

    panel.render(idle, undefined, { bridgeState: 'connected' });
    expect(host.shadowRoot!.textContent).toContain('Connected');
    expect(host.shadowRoot!.querySelector('[data-action="enable-bridge"]')).toBeNull();

    panel.render(idle, undefined, { bridgeState: 'disconnected' });
    expect(host.shadowRoot!.textContent).toContain('Disconnected');
    expect(host.shadowRoot!.querySelector<HTMLButtonElement>('[data-action="enable-bridge"]')?.textContent).toContain('Reconnect');
  });

});
