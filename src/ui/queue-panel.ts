import type { ConversationQueue, QueueItem } from '../domain/types';
import type { WorkflowRun } from '../flowrun/events';
import type { WorkflowDefinition } from '../flowrun/schema';

type MaybePromise = void | Promise<void>;

export interface QueuePanelActions {
  add?: (content: string) => MaybePromise;
  start?: () => MaybePromise;
  pause?: () => MaybePromise;
  resume?: () => MaybePromise;
  edit?: (itemId: string, content: string) => MaybePromise;
  remove?: (itemId: string) => MaybePromise;
  reorder?: (itemId: string, delta: number) => MaybePromise;
  loadWorkflow?: (text: string) => MaybePromise;
  runWorkflow?: (inputs: Record<string, string>) => MaybePromise;
  clearWorkflow?: () => MaybePromise;
}

export interface QueuePanelWorkflowView {
  workflow?: WorkflowDefinition;
  run?: WorkflowRun;
  error?: string;
}

const PANEL_COLLAPSED_KEY = 'chatgpt-queue:panel-collapsed';

const escapeHtml = (value: string): string => value
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#039;');

const statusLabel = (status: ConversationQueue['status']) => `${status.charAt(0).toUpperCase()}${status.slice(1)}`;

const stateMark = (item: QueueItem): string => {
  if (item.state === 'completed') return '✓';
  if (item.state === 'running' || item.state === 'sending') return '●';
  return '○';
};

const readCollapsedPreference = (): boolean => {
  try {
    return sessionStorage.getItem(PANEL_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
};

const writeCollapsedPreference = (collapsed: boolean): void => {
  try {
    sessionStorage.setItem(PANEL_COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch {
    // Session storage is best-effort; panel behavior must not depend on it.
  }
};

const visualSignature = (queue: ConversationQueue, notice: string | undefined, workflowView: QueuePanelWorkflowView): string => JSON.stringify({
  conversationKey: queue.conversationKey,
  status: queue.status,
  blockedReason: queue.blockedReason ?? null,
  notice: notice ?? null,
  items: queue.items.map((item) => ({ id: item.id, content: item.content, state: item.state })),
  workflow: workflowView.workflow ? {
    name: workflowView.workflow.name,
    inputs: workflowView.workflow.inputs,
    steps: workflowView.workflow.steps.map((step) => step.id),
  } : null,
  run: workflowView.run ? {
    id: workflowView.run.id,
    status: workflowView.run.status,
    steps: workflowView.run.steps.map((step) => ({ id: step.id, status: step.status, error: step.error ?? null })),
  } : null,
  workflowError: workflowView.error ?? null,
});

export class QueuePanel {
  private readonly root: ShadowRoot;
  private lastConversationKey?: string;
  private lastVisualSignature?: string;
  private collapsed = readCollapsedPreference();

  constructor(private readonly host: HTMLElement, private readonly actions: QueuePanelActions) {
    this.root = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
  }

  render(queue: ConversationQueue, notice?: string, workflowView: QueuePanelWorkflowView = {}): void {
    const signature = visualSignature(queue, notice, workflowView);
    if (signature === this.lastVisualSignature) return;

    const sameConversation = this.lastConversationKey === queue.conversationKey;
    const existingNewMessage = sameConversation
      ? this.root.querySelector<HTMLTextAreaElement>('[data-role="new-message"]')
      : null;
    const newMessageDraft = existingNewMessage?.value ?? '';
    const queuedDrafts = new Map<string, string>();
    const workflowDrafts = new Map<string, string>();
    if (sameConversation) {
      for (const input of this.root.querySelectorAll<HTMLTextAreaElement>('textarea[data-item-id]')) {
        if (input.dataset.itemId) queuedDrafts.set(input.dataset.itemId, input.value);
      }
      for (const input of this.root.querySelectorAll<HTMLInputElement>('input[data-workflow-input]')) {
        if (input.dataset.workflowInput) workflowDrafts.set(input.dataset.workflowInput, input.value);
      }
    }

    const active = sameConversation ? this.root.activeElement : null;
    const focusedNewMessage = active instanceof HTMLTextAreaElement && active.dataset.role === 'new-message';
    const focusedItemId = active instanceof HTMLTextAreaElement ? active.dataset.itemId : undefined;
    const focusedWorkflowInput = active instanceof HTMLInputElement ? active.dataset.workflowInput : undefined;
    const editableActive = active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement ? active : null;
    const selectionStart = editableActive?.selectionStart ?? null;
    const selectionEnd = editableActive?.selectionEnd ?? null;

    const pending = queue.items.filter((item) => item.state === 'queued').length;
    const control = queue.status === 'running'
      ? '<button class="primary" data-action="pause">Pause</button>'
      : queue.status === 'paused' || queue.status === 'blocked'
        ? '<button class="primary" data-action="resume">Resume</button>'
        : pending > 0
          ? '<button class="primary" data-action="start">Start queue</button>'
          : '';

    const rows = queue.items.map((item) => {
      if (item.state === 'queued') {
        return `<li class="item queued">
          <div class="item-head">
            <span class="mark">${stateMark(item)}</span>
            <span class="item-state">Queued</span>
          </div>
          <textarea data-item-id="${escapeHtml(item.id)}" aria-label="Queued message">${escapeHtml(item.content)}</textarea>
          <div class="row-actions">
            <button class="icon" data-action="up" data-id="${escapeHtml(item.id)}" title="Move up" aria-label="Move up">↑</button>
            <button class="icon" data-action="down" data-id="${escapeHtml(item.id)}" title="Move down" aria-label="Move down">↓</button>
            <button data-action="save" data-id="${escapeHtml(item.id)}">Save</button>
            <button class="danger" data-action="delete" data-id="${escapeHtml(item.id)}">Delete</button>
          </div>
        </li>`;
      }
      return `<li class="item compact ${item.state}">
        <span class="mark">${stateMark(item)}</span>
        <span class="item-copy">${escapeHtml(item.content)}</span>
        <span class="item-state">${escapeHtml(item.state)}</span>
      </li>`;
    }).join('');

    const blocked = queue.blockedReason
      ? `<div class="notice danger-notice"><strong>Blocked:</strong> ${escapeHtml(queue.blockedReason)}</div>`
      : '';
    const localNotice = notice
      ? `<div class="notice"><strong>Notice:</strong> ${escapeHtml(notice)}</div>`
      : '';

    const workflow = workflowView.workflow;
    const flowRun = workflowView.run;
    const queueBusy = queue.items.some((item) => ['queued', 'sending', 'running'].includes(item.state));
    const flowRunRunning = flowRun?.status === 'running';
    const completedSteps = flowRun?.steps.filter((step) => step.status === 'completed').length ?? 0;
    const activeStep = flowRun?.steps.find((step) => ['ready', 'dispatching', 'waiting', 'blocked', 'failed'].includes(step.status))
      ?? flowRun?.steps.find((step) => step.status === 'pending');
    const workflowInputs = workflow
      ? Object.entries(workflow.inputs).map(([name, definition]) => `<label class="workflow-input-label">
          <span>${escapeHtml(name)}${definition.required ? ' *' : ''}</span>
          <input type="text" data-workflow-input="${escapeHtml(name)}" autocomplete="off" />
        </label>`).join('')
      : '';
    const workflowRunSummary = flowRun
      ? `<div class="workflow-run workflow-run-${escapeHtml(flowRun.status)}">
          <div class="workflow-run-line">
            <strong>${escapeHtml(statusLabel(flowRun.status as ConversationQueue['status']))}</strong>
            <span>${completedSteps} / ${flowRun.steps.length}</span>
            ${activeStep ? `<span>${escapeHtml(activeStep.id)}</span>` : ''}
          </div>
          ${activeStep?.error ? `<div class="workflow-error">${escapeHtml(activeStep.error)}</div>` : ''}
        </div>`
      : '';
    const workflowError = workflowView.error
      ? `<div class="notice danger-notice"><strong>Workflow:</strong> ${escapeHtml(workflowView.error)}</div>`
      : '';
    const workflowSection = workflow
      ? `<section class="workflow-section">
          <div class="workflow-heading">
            <div><strong>Workflow</strong><span class="workflow-subtitle">FlowRun</span></div>
            <button class="ghost" data-action="clear-workflow">Clear</button>
          </div>
          <div class="workflow-meta"><strong>${escapeHtml(workflow.name)}</strong><span>${workflow.steps.length} steps</span></div>
          ${workflowInputs ? `<div class="workflow-inputs">${workflowInputs}</div>` : ''}
          ${workflowRunSummary}
          ${workflowError}
          ${queueBusy ? '<div class="workflow-hint">Finish or clear the current queue before starting a workflow.</div>' : ''}
          <button class="primary workflow-run-button" data-action="run-workflow"${queueBusy || flowRunRunning ? ' disabled' : ''}>Run workflow</button>
        </section>`
      : `<section class="workflow-section">
          <div class="workflow-heading"><div><strong>Workflow</strong><span class="workflow-subtitle">FlowRun</span></div></div>
          ${workflowRunSummary}
          ${workflowError}
          <label class="workflow-file-button">Load workflow<input data-role="workflow-file" type="file" accept=".json,.flowrun.json,application/json" /></label>
        </section>`;

    this.root.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; }
        .dock {
          position: fixed;
          right: 16px;
          bottom: 16px;
          z-index: 2147483647;
          width: min(390px, calc(100vw - 32px));
          color: #f3f3f3;
          font: 13px/1.4 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          pointer-events: none;
        }
        .panel {
          pointer-events: auto;
          background: rgba(28, 28, 28, .97);
          border: 1px solid rgba(255,255,255,.14);
          border-radius: 16px;
          box-shadow: 0 18px 55px rgba(0,0,0,.38);
          overflow: hidden;
          transform: translateX(0);
          opacity: 1;
          transition: transform .2s ease, opacity .16s ease;
          backdrop-filter: blur(18px);
        }
        .dock.collapsed .panel {
          transform: translateX(calc(100% + 34px));
          opacity: 0;
          pointer-events: none;
        }
        .peek {
          position: fixed;
          right: 0;
          bottom: 86px;
          display: flex;
          align-items: center;
          gap: 7px;
          min-height: 42px;
          padding: 9px 12px 9px 10px;
          border: 1px solid rgba(255,255,255,.16);
          border-right: 0;
          border-radius: 12px 0 0 12px;
          background: rgba(28,28,28,.97);
          color: #f4f4f4;
          box-shadow: 0 12px 34px rgba(0,0,0,.32);
          cursor: pointer;
          opacity: 0;
          transform: translateX(105%);
          pointer-events: none;
          transition: transform .2s ease, opacity .16s ease;
          font: inherit;
        }
        .dock.collapsed .peek {
          opacity: 1;
          transform: translateX(0);
          pointer-events: auto;
        }
        .header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          padding: 12px 14px;
          border-bottom: 1px solid rgba(255,255,255,.1);
        }
        .title-group { display: flex; align-items: center; gap: 9px; min-width: 0; }
        .title { font-weight: 700; letter-spacing: .01em; }
        .count {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-width: 24px;
          height: 22px;
          padding: 0 7px;
          border-radius: 999px;
          background: rgba(255,255,255,.09);
          color: #ddd;
          font-size: 12px;
        }
        .header-actions { display: flex; align-items: center; gap: 8px; }
        .status {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          color: #c8c8c8;
          font-size: 12px;
        }
        .status::before {
          content: '';
          width: 7px;
          height: 7px;
          border-radius: 999px;
          background: #8d8d8d;
          box-shadow: 0 0 0 3px rgba(255,255,255,.04);
        }
        .status-running::before { background: #d7d7d7; }
        .status-blocked::before { background: #ff8b8b; }
        .status-completed::before { background: #9fd3a9; }
        .body { padding: 12px; max-height: min(65vh, 640px); overflow: auto; }
        .toolbar { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
        .spacer { flex: 1; }
        button {
          appearance: none;
          border: 1px solid rgba(255,255,255,.15);
          border-radius: 9px;
          background: #303030;
          color: #f4f4f4;
          min-height: 34px;
          padding: 6px 10px;
          cursor: pointer;
          font: inherit;
          transition: background .12s ease, border-color .12s ease, transform .08s ease;
        }
        button:hover { background: #3a3a3a; border-color: rgba(255,255,255,.24); }
        button:active { transform: translateY(1px); }
        button:disabled { opacity: .48; cursor: not-allowed; transform: none; }
        button.primary { background: #f0f0f0; color: #181818; border-color: #f0f0f0; font-weight: 650; }
        button.primary:hover { background: #fff; }
        button.ghost { background: transparent; }
        button.icon { min-width: 34px; padding: 5px 8px; }
        button.danger { color: #ffb4b4; }
        textarea, input[type="text"] {
          width: 100%;
          min-height: 58px;
          resize: vertical;
          border: 1px solid rgba(255,255,255,.14);
          border-radius: 10px;
          outline: none;
          background: #232323;
          color: #f5f5f5;
          padding: 9px 10px;
          font: inherit;
          transition: border-color .12s ease, box-shadow .12s ease;
        }
        textarea:focus, input[type="text"]:focus {
          border-color: rgba(255,255,255,.38);
          box-shadow: 0 0 0 3px rgba(255,255,255,.06);
        }
        .composer {
          display: grid;
          grid-template-columns: 1fr auto;
          gap: 8px;
          align-items: stretch;
          margin-bottom: 12px;
        }
        .composer button { height: 100%; min-width: 58px; }
        ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
        .item {
          border: 1px solid rgba(255,255,255,.08);
          border-radius: 12px;
          background: rgba(255,255,255,.035);
        }
        .item.queued { padding: 10px; }
        .item-head { display: flex; align-items: center; gap: 7px; margin-bottom: 8px; color: #aaa; font-size: 12px; }
        .row-actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
        .compact {
          display: grid;
          grid-template-columns: 18px minmax(0,1fr) auto;
          align-items: center;
          gap: 8px;
          padding: 9px 10px;
        }
        .item-copy { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .item-state { color: #999; font-size: 11px; text-transform: capitalize; }
        .mark { color: #aaa; }
        .running .mark, .sending .mark { color: #fff; }
        .completed { opacity: .68; }
        .notice {
          margin: 0 0 10px;
          padding: 9px 10px;
          border: 1px solid rgba(255,255,255,.08);
          border-radius: 10px;
          background: rgba(255,255,255,.05);
          color: #ddd;
          overflow-wrap: anywhere;
        }
        .danger-notice { background: rgba(120,45,45,.34); color: #ffd8d8; border-color: rgba(255,120,120,.15); }
        .empty { color: #aaa; padding: 8px 2px 2px; }
        .workflow-section {
          margin-top: 12px;
          padding-top: 12px;
          border-top: 1px solid rgba(255,255,255,.1);
          display: grid;
          gap: 10px;
        }
        .workflow-heading, .workflow-meta, .workflow-run-line {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
        }
        .workflow-heading > div { display: flex; align-items: baseline; gap: 7px; }
        .workflow-subtitle { color: #888; font-size: 11px; }
        .workflow-meta {
          padding: 9px 10px;
          border-radius: 10px;
          background: rgba(255,255,255,.04);
        }
        .workflow-meta span, .workflow-run-line span { color: #aaa; font-size: 11px; }
        .workflow-inputs { display: grid; gap: 8px; }
        .workflow-input-label { display: grid; gap: 5px; color: #aaa; font-size: 11px; }
        .workflow-input-label input { min-height: 38px; }
        .workflow-run {
          padding: 9px 10px;
          border: 1px solid rgba(255,255,255,.08);
          border-radius: 10px;
          background: rgba(255,255,255,.035);
        }
        .workflow-run-blocked, .workflow-run-failed { border-color: rgba(255,120,120,.18); }
        .workflow-error { margin-top: 6px; color: #ffb4b4; font-size: 12px; overflow-wrap: anywhere; }
        .workflow-hint { color: #d7b987; font-size: 12px; line-height: 1.35; }
        .workflow-run-button { width: 100%; }
        .workflow-file-button {
          display: flex;
          align-items: center;
          justify-content: center;
          min-height: 38px;
          border: 1px dashed rgba(255,255,255,.2);
          border-radius: 10px;
          background: rgba(255,255,255,.03);
          cursor: pointer;
          color: #ddd;
        }
        .workflow-file-button:hover { background: rgba(255,255,255,.06); }
        .workflow-file-button input { display: none; }
        @media (max-width: 520px) {
          .dock { right: 8px; bottom: 8px; width: calc(100vw - 16px); }
          .body { max-height: 58vh; }
          .compact { grid-template-columns: 18px minmax(0,1fr); }
          .compact .item-state { grid-column: 2; }
        }
      </style>
      <div class="dock${this.collapsed ? ' collapsed' : ''}">
        <section class="panel" aria-label="ChatGPT Queue">
          <header class="header">
            <div class="title-group">
              <span class="title">Queue</span>
              <span class="count">${pending}</span>
            </div>
            <div class="header-actions">
              <span class="status status-${escapeHtml(queue.status)}">${statusLabel(queue.status)}</span>
              <button class="ghost icon" data-action="hide" aria-label="Hide queue" title="Hide queue">→</button>
            </div>
          </header>
          <div class="body">
            <div class="toolbar">${control}<span class="spacer"></span></div>
            ${blocked}
            ${localNotice}
            <div class="composer">
              <textarea data-role="new-message" placeholder="Add follow-up message" aria-label="Add follow-up message"></textarea>
              <button data-action="add">Add</button>
            </div>
            ${rows ? `<ul>${rows}</ul>` : '<div class="empty">No queued messages.</div>'}
            ${workflowSection}
          </div>
        </section>
        <button class="peek" data-action="show" aria-label="Show queue"><span>‹</span><strong>Queue · ${pending}</strong></button>
      </div>`;

    if (sameConversation) {
      const newMessage = this.root.querySelector<HTMLTextAreaElement>('[data-role="new-message"]');
      if (newMessage) newMessage.value = newMessageDraft;
      for (const input of this.root.querySelectorAll<HTMLTextAreaElement>('textarea[data-item-id]')) {
        const itemId = input.dataset.itemId;
        if (itemId && queuedDrafts.has(itemId)) input.value = queuedDrafts.get(itemId)!;
      }
      for (const input of this.root.querySelectorAll<HTMLInputElement>('input[data-workflow-input]')) {
        const name = input.dataset.workflowInput;
        if (name && workflowDrafts.has(name)) input.value = workflowDrafts.get(name)!;
      }
    }

    this.bind();
    this.lastConversationKey = queue.conversationKey;
    this.lastVisualSignature = signature;

    const focusTarget: HTMLTextAreaElement | HTMLInputElement | null = focusedNewMessage
      ? this.root.querySelector<HTMLTextAreaElement>('[data-role="new-message"]')
      : focusedItemId
        ? this.root.querySelector<HTMLTextAreaElement>(`textarea[data-item-id="${CSS.escape(focusedItemId)}"]`)
        : focusedWorkflowInput
          ? this.root.querySelector<HTMLInputElement>(`input[data-workflow-input="${CSS.escape(focusedWorkflowInput)}"]`)
          : null;
    if (focusTarget) {
      focusTarget.focus();
      if (selectionStart !== null && selectionEnd !== null) {
        focusTarget.setSelectionRange(selectionStart, selectionEnd);
      }
    }
  }

  private setCollapsed(collapsed: boolean): void {
    this.collapsed = collapsed;
    writeCollapsedPreference(collapsed);
    this.root.querySelector('.dock')?.classList.toggle('collapsed', collapsed);
  }

  private bind(): void {
    const invoke = (action: (() => MaybePromise) | undefined) => {
      if (action) void Promise.resolve(action()).catch(() => undefined);
    };

    this.root.querySelector('[data-action="hide"]')?.addEventListener('click', () => this.setCollapsed(true));
    this.root.querySelector('[data-action="show"]')?.addEventListener('click', () => this.setCollapsed(false));

    this.root.querySelector<HTMLButtonElement>('[data-action="add"]')?.addEventListener('click', () => {
      const input = this.root.querySelector<HTMLTextAreaElement>('[data-role="new-message"]');
      const content = input?.value.trim() ?? '';
      if (!content || !this.actions.add || !input) return;
      const originalDraft = input.value;
      input.value = '';
      void Promise.resolve()
        .then(() => this.actions.add!(content))
        .catch(() => {
          const currentInput = this.root.querySelector<HTMLTextAreaElement>('[data-role="new-message"]');
          if (currentInput && !currentInput.value) currentInput.value = originalDraft;
        });
    });

    this.root.querySelector<HTMLInputElement>('[data-role="workflow-file"]')?.addEventListener('change', (event) => {
      const input = event.currentTarget as HTMLInputElement;
      const file = input.files?.[0];
      if (!file || !this.actions.loadWorkflow) return;
      void file.text().then((text) => this.actions.loadWorkflow!(text)).catch(() => undefined);
    });

    this.root.querySelector('[data-action="clear-workflow"]')?.addEventListener('click', () => invoke(this.actions.clearWorkflow));
    this.root.querySelector('[data-action="run-workflow"]')?.addEventListener('click', () => {
      if (!this.actions.runWorkflow) return;
      const inputs: Record<string, string> = {};
      for (const input of this.root.querySelectorAll<HTMLInputElement>('input[data-workflow-input]')) {
        const name = input.dataset.workflowInput;
        if (name) inputs[name] = input.value;
      }
      invoke(() => this.actions.runWorkflow!(inputs));
    });

    this.root.querySelector('[data-action="start"]')?.addEventListener('click', () => invoke(this.actions.start));
    this.root.querySelector('[data-action="pause"]')?.addEventListener('click', () => invoke(this.actions.pause));
    this.root.querySelector('[data-action="resume"]')?.addEventListener('click', () => invoke(this.actions.resume));

    for (const button of this.root.querySelectorAll<HTMLButtonElement>('button[data-id]')) {
      button.addEventListener('click', () => {
        const itemId = button.dataset.id!;
        const action = button.dataset.action;
        if (action === 'save' && this.actions.edit) {
          const input = this.root.querySelector<HTMLTextAreaElement>(`textarea[data-item-id="${CSS.escape(itemId)}"]`);
          const content = input?.value.trim() ?? '';
          if (content) invoke(() => this.actions.edit!(itemId, content));
        } else if (action === 'delete' && this.actions.remove) {
          invoke(() => this.actions.remove!(itemId));
        } else if ((action === 'up' || action === 'down') && this.actions.reorder) {
          invoke(() => this.actions.reorder!(itemId, action === 'up' ? -1 : 1));
        }
      });
    }
  }
}
