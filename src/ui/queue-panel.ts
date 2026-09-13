import type { AdapterInterfaceReport } from '../adapter/chatgpt-adapter';
import type { ContextPressure } from '../context/pressure';
import type { ConversationQueue, QueueItem } from '../domain/types';
import type { WorkflowRun } from '../flowrun/events';
import { WORKFLOW_PRESETS, localizedPresetText } from '../flowrun/presets';
import type { WorkflowDefinition } from '../flowrun/schema';
import { GUIDE_STEP_COUNT, GUIDE_STEPS, clampGuideIndex } from './guide';
import { createTranslator, translate, type Locale, type LocalePreference, type MessageKey, type Translator } from './i18n';

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
  loadWorkflowPreset?: (presetId: string) => MaybePromise;
  runWorkflow?: (inputs: Record<string, string>) => MaybePromise;
  clearWorkflow?: () => MaybePromise;
  enableBridge?: () => MaybePromise;
  prepareHandoff?: () => MaybePromise;
  openHandoff?: () => MaybePromise;
  setContextCapacity?: (tokens: number | null) => MaybePromise;
  setLocale?: (preference: LocalePreference) => MaybePromise;
}

export interface QueuePanelContextView {
  pressure?: ContextPressure;
  capacityOverride?: number;
  handoff?: {
    status: 'none' | 'capturing' | 'ready';
    carriedItems: number;
  };
  adapter?: {
    report: AdapterInterfaceReport;
    diagnostics: string;
  };
}

export interface QueuePanelView {
  workflow?: WorkflowDefinition;
  run?: WorkflowRun;
  error?: string;
  bridgeState?: 'disabled' | 'enabling' | 'connected' | 'disconnected';
  context?: QueuePanelContextView;
  locale?: Locale;
  localePreference?: LocalePreference;
}

const PANEL_COLLAPSED_KEY = 'chatgpt-queue:panel-collapsed';
const LOCALE_PREFERENCE_VALUES: readonly LocalePreference[] = ['auto', 'en', 'tr'];

const escapeHtml = (value: string): string => value
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#039;');

const readSessionFlag = (key: string): boolean => {
  try {
    return sessionStorage.getItem(key) === '1';
  } catch {
    return false;
  }
};

const writeSessionFlag = (key: string, value: boolean): void => {
  try {
    sessionStorage.setItem(key, value ? '1' : '0');
  } catch {
    // Session storage is best-effort; panel behavior must not depend on it.
  }
};

export class QueuePanel {
  private readonly root: ShadowRoot;
  private lastConversationKey?: string;
  private lastVisualSignature?: string;
  private lastRenderArgs?: [ConversationQueue, string | undefined, QueuePanelView];
  private selectedPresetId = '';
  private adapterDetailsOpen = false;
  private guideIndex: number | null = null;
  private collapsed = readSessionFlag(PANEL_COLLAPSED_KEY);

  constructor(private readonly host: HTMLElement, private readonly actions: QueuePanelActions) {
    this.root = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
  }

  /** Re-renders the last view, used when panel-local state (the guide) changes. */
  private refresh(): void {
    if (!this.lastRenderArgs) return;
    this.render(...this.lastRenderArgs);
  }

  render(queue: ConversationQueue, notice?: string, view: QueuePanelView = {}): void {
    this.lastRenderArgs = [queue, notice, view];
    const locale: Locale = view.locale ?? 'en';
    const t = createTranslator(locale);
    const signature = visualSignature(queue, notice, view, this.guideIndex);
    if (signature === this.lastVisualSignature) return;

    const sameConversation = this.lastConversationKey === queue.conversationKey;
    const existingNewMessage = sameConversation
      ? this.root.querySelector<HTMLTextAreaElement>('[data-role="new-message"]')
      : null;
    const newMessageDraft = existingNewMessage?.value ?? '';
    const queuedDrafts = new Map<string, string>();
    const workflowDrafts = new Map<string, string>();
    let capacityDraft: string | undefined;
    if (sameConversation) {
      for (const input of this.root.querySelectorAll<HTMLTextAreaElement>('textarea[data-item-id]')) {
        if (input.dataset.itemId) queuedDrafts.set(input.dataset.itemId, input.value);
      }
      for (const input of this.root.querySelectorAll<HTMLInputElement>('input[data-workflow-input]')) {
        if (input.dataset.workflowInput) workflowDrafts.set(input.dataset.workflowInput, input.value);
      }
      capacityDraft = this.root.querySelector<HTMLInputElement>('input[data-role="context-capacity"]')?.value;
    }

    const livePreset = this.root.querySelector<HTMLSelectElement>('[data-role="workflow-preset"]');
    if (livePreset) this.selectedPresetId = livePreset.value;

    const active = sameConversation ? this.root.activeElement : null;
    const focusedNewMessage = active instanceof HTMLTextAreaElement && active.dataset.role === 'new-message';
    const focusedItemId = active instanceof HTMLTextAreaElement ? active.dataset.itemId : undefined;
    const focusedWorkflowInput = active instanceof HTMLInputElement ? active.dataset.workflowInput : undefined;
    const focusedCapacity = active instanceof HTMLInputElement && active.dataset.role === 'context-capacity';
    const editableActive = active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement ? active : null;
    const selectionStart = editableActive?.selectionStart ?? null;
    const selectionEnd = editableActive?.selectionEnd ?? null;

    const pending = queue.items.filter((item) => item.state === 'queued').length;
    const control = queue.status === 'running'
      ? `<button class="primary" data-action="pause">${escapeHtml(t('action.pause'))}</button>`
      : queue.status === 'paused' || queue.status === 'blocked'
        ? `<button class="primary" data-action="resume">${escapeHtml(t('action.resume'))}</button>`
        : pending > 0
          ? `<button class="primary" data-action="start">${escapeHtml(t('action.start'))}</button>`
          : '';

    const rows = queue.items.map((item) => {
      if (item.state === 'queued') {
        return `<li class="item queued">
          <div class="item-head">
            <span class="mark">${stateMark(item)}</span>
            <span class="item-state">${escapeHtml(t('item.queued'))}</span>
          </div>
          <textarea data-item-id="${escapeHtml(item.id)}" aria-label="${escapeHtml(t('item.draftLabel'))}">${escapeHtml(item.content)}</textarea>
          <div class="row-actions">
            <button class="icon" data-action="up" data-id="${escapeHtml(item.id)}" title="${escapeHtml(t('action.moveUp'))}" aria-label="${escapeHtml(t('action.moveUp'))}">↑</button>
            <button class="icon" data-action="down" data-id="${escapeHtml(item.id)}" title="${escapeHtml(t('action.moveDown'))}" aria-label="${escapeHtml(t('action.moveDown'))}">↓</button>
            <button data-action="save" data-id="${escapeHtml(item.id)}">${escapeHtml(t('action.save'))}</button>
            <button class="danger" data-action="delete" data-id="${escapeHtml(item.id)}">${escapeHtml(t('action.delete'))}</button>
          </div>
        </li>`;
      }
      return `<li class="item compact ${item.state}">
        <span class="mark">${stateMark(item)}</span>
        <span class="item-copy">${escapeHtml(item.content)}</span>
        <span class="item-state">${escapeHtml(t(itemStateKey(item.state)))}</span>
      </li>`;
    }).join('');

    // The raw code stays in the notice so a report or a log search still matches it; the human
    // sentence is added only when the code is known, so an unmapped code is never printed twice.
    const blockedReasonText = queue.blockedReason === undefined ? '' : describeReason(locale, queue.blockedReason);
    const blocked = queue.blockedReason
      ? `<div class="notice danger-notice"><strong>${escapeHtml(t('notice.blocked'))}:</strong> <code>${escapeHtml(queue.blockedReason)}</code>${blockedReasonText === queue.blockedReason ? '' : ` — ${escapeHtml(blockedReasonText)}`}</div>`
      : '';
    const localNotice = notice
      ? `<div class="notice"><strong>${escapeHtml(t('notice.notice'))}:</strong> ${escapeHtml(notice)}</div>`
      : '';

    const workflow = view.workflow;
    const flowRun = view.run;
    const queueBusy = queue.items.some((item) => ['queued', 'sending', 'running'].includes(item.state));
    const flowRunRunning = flowRun?.status === 'running';
    const isActive = queue.status === 'running' || flowRunRunning;
    const bridgeState = view.bridgeState ?? 'disabled';
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
            <strong>${escapeHtml(t(`status.${flowRun.status}` as MessageKey))}</strong>
            <span>${escapeHtml(t('workflow.progress', { done: completedSteps, total: flowRun.steps.length }))}</span>
            ${activeStep ? `<span>${escapeHtml(activeStep.id)}</span>` : ''}
          </div>
          ${activeStep?.error ? `<div class="workflow-error">${escapeHtml(activeStep.error)}</div>` : ''}
        </div>`
      : '';
    const workflowError = view.error
      ? `<div class="notice danger-notice"><strong>${escapeHtml(t('workflow.title'))}:</strong> ${escapeHtml(view.error)}</div>`
      : '';
    const selectedPreset = WORKFLOW_PRESETS.find((preset) => preset.id === this.selectedPresetId);
    const workflowPresetOptions = WORKFLOW_PRESETS.map((preset) => {
      const text = localizedPresetText(preset, locale);
      return `<option value="${escapeHtml(preset.id)}" data-description="${escapeHtml(text.description)}"${preset.id === selectedPreset?.id ? ' selected' : ''}>${escapeHtml(text.label)}</option>`;
    }).join('');
    const workflowPresetDescription = selectedPreset
      ? localizedPresetText(selectedPreset, locale).description
      : t('workflow.defaultDescription');
    const workflowSection = workflow
      ? `<section class="workflow-section">
          <div class="workflow-heading">
            <div><strong>${escapeHtml(t('workflow.title'))}</strong><span class="workflow-subtitle">${escapeHtml(t('workflow.subtitle'))}</span></div>
            <button class="ghost" data-action="clear-workflow">${escapeHtml(t('action.clear'))}</button>
          </div>
          <div class="workflow-meta"><strong>${escapeHtml(workflow.name)}</strong><span>${escapeHtml(t('workflow.stepsCount', { count: workflow.steps.length }))}</span></div>
          ${workflowInputs ? `<div class="workflow-inputs">${workflowInputs}</div>` : ''}
          ${workflowRunSummary}
          ${workflowError}
          ${queueBusy ? `<div class="workflow-hint">${escapeHtml(t('workflow.busyHint'))}</div>` : ''}
          <button class="primary workflow-run-button" data-action="run-workflow"${queueBusy || flowRunRunning ? ' disabled' : ''}>${escapeHtml(t('action.runWorkflow'))}</button>
        </section>`
      : `<section class="workflow-section">
          <div class="workflow-heading"><div><strong>${escapeHtml(t('workflow.title'))}</strong><span class="workflow-subtitle">${escapeHtml(t('workflow.subtitle'))}</span></div></div>
          ${workflowRunSummary}
          ${workflowError}
          <div class="workflow-preset-picker">
            <span class="workflow-preset-label">${escapeHtml(t('workflow.builtinLabel'))}</span>
            <div class="workflow-preset-row">
              <select data-role="workflow-preset" aria-label="${escapeHtml(t('workflow.builtinLabel'))}">
                <option value="">${escapeHtml(t('workflow.choosePlaceholder'))}</option>
                ${workflowPresetOptions}
              </select>
              <button class="ghost" data-action="load-workflow-preset"${selectedPreset ? '' : ' disabled'}>${escapeHtml(t('action.usePreset'))}</button>
            </div>
            <div class="workflow-preset-description" data-role="workflow-preset-description">${escapeHtml(workflowPresetDescription)}</div>
          </div>
          <div class="workflow-divider"><span>${escapeHtml(t('workflow.or'))}</span></div>
          <label class="workflow-file-button">${escapeHtml(t('workflow.loadCustom'))}<input data-role="workflow-file" type="file" accept=".json,.flowrun.json,application/json" /></label>
        </section>`;
    const bridgeStateLabel = bridgeState === 'connected'
      ? t('bridge.connected')
      : bridgeState === 'enabling'
        ? t('bridge.enabling')
        : bridgeState === 'disconnected'
          ? t('bridge.disconnected')
          : t('bridge.disabled');
    const bridgeControl = bridgeState === 'connected'
      ? `<div class="bridge-row"><span>${escapeHtml(t('bridge.label'))}</span><span class="bridge-state connected">${escapeHtml(bridgeStateLabel)}</span></div>`
      : `<div class="bridge-row"><span>${escapeHtml(t('bridge.label'))}</span><span class="bridge-state">${escapeHtml(bridgeStateLabel)}</span><button class="ghost" data-action="enable-bridge"${bridgeState === 'enabling' ? ' disabled' : ''}>${escapeHtml(bridgeState === 'disabled' ? t('action.enable') : t('action.reconnect'))}</button></div>`;

    const contextView = view.context ?? {};
    const pressure = contextView.pressure;
    const adapterView = contextView.adapter;
    const adapterHealth = adapterView?.report.health ?? 'unrecognized';
    const meterWidth = pressure ? Math.max(0, Math.min(100, Math.round(pressure.ratio * 100))) : 0;
    const pressureText = pressure
      ? t('context.pressure', {
          percent: Math.round(pressure.ratio * 100),
          capacity: pressure.capacity.usableTokens.toLocaleString('en-US'),
          estimated: pressure.estimatedTokens.toLocaleString('en-US'),
          turns: pressure.turnCount,
          source: pressure.capacity.label.toLowerCase(),
        })
      : '';
    const handoffStatus = contextView.handoff?.status ?? 'none';
    const handoffCarried = contextView.handoff?.carriedItems ?? 0;
    const queueActivelySending = queue.status === 'running' || queue.items.some((item) => item.state === 'sending' || item.state === 'running');
    const handoffBlocked = queueActivelySending || flowRunRunning || adapterHealth !== 'ok';
    const adapterChipLabel = adapterHealth === 'ok'
      ? t('adapter.ok')
      : adapterHealth === 'degraded'
        ? t('adapter.degraded')
        : t('adapter.unrecognized');
    const handoffControl = handoffStatus === 'capturing'
      ? `<span class="handoff-state">${escapeHtml(t('handoff.preparing'))}</span>`
      : handoffStatus === 'ready'
        ? `<span class="handoff-state ready">${escapeHtml(handoffCarried === 1 ? t('handoff.readyOne') : t('handoff.ready', { count: handoffCarried }))}</span>
           <button class="primary" data-action="open-handoff">${escapeHtml(t('handoff.open'))}</button>`
        : `<button data-action="prepare-handoff"${handoffBlocked ? ' disabled' : ''}>${escapeHtml(t('handoff.prepare'))}</button>
           <span class="handoff-hint">${escapeHtml(adapterHealth !== 'ok'
             ? t('handoff.hintAdapter')
             : handoffBlocked
               ? t('handoff.hintBusy')
               : t('handoff.hintReady'))}</span>`;
    const contextSection = `<section class="context-section">
      <div class="context-heading">
        <div><strong>${escapeHtml(t('context.title'))}</strong><span class="context-subtitle">${escapeHtml(t('context.subtitle'))}</span></div>
        <span class="adapter-chip adapter-${adapterHealth}" data-role="adapter-health">${escapeHtml(adapterChipLabel)}</span>
      </div>
      ${pressure
        ? `<div class="meter" aria-hidden="true"><div class="meter-fill level-${pressure.level}" style="width:${meterWidth}%"></div></div>
           <div class="meter-detail" data-role="context-detail">${escapeHtml(pressureText)}</div>`
        : `<div class="meter-detail">${escapeHtml(t('context.unavailable'))}</div>`}
      ${adapterView
        ? `<button class="ghost context-disclosure" data-action="toggle-adapter-detail">${escapeHtml(t('context.interfaceDetail'))}</button>
           <pre class="adapter-detail" data-role="adapter-detail"${this.adapterDetailsOpen ? '' : ' hidden'}>${escapeHtml(adapterView.diagnostics)}</pre>`
        : ''}
      <div class="handoff-row">${handoffControl}</div>
      <label class="capacity-row">
        <span>${escapeHtml(t('context.capacityLabel'))}</span>
        <input type="number" min="1000" step="1000" inputmode="numeric" data-role="context-capacity" placeholder="${escapeHtml(t('context.capacityPlaceholder'))}" value="${contextView.capacityOverride === undefined ? '' : String(contextView.capacityOverride)}" />
      </label>
    </section>`;

    const localePreference = view.localePreference ?? 'auto';
    const localeOptions = LOCALE_PREFERENCE_VALUES.map((value) => {
      const label = value === 'auto' ? t('locale.auto') : value.toUpperCase();
      return `<option value="${value}"${value === localePreference ? ' selected' : ''}>${escapeHtml(label)}</option>`;
    }).join('');
    const guideCard = this.renderGuide(t);

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
        .header-actions { display: flex; align-items: center; gap: 6px; }
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
        .status.activity::before { display: none; }
        .activity-spinner {
          display: inline-block;
          width: 12px;
          height: 12px;
          flex: 0 0 12px;
          border: 2px solid rgba(255,255,255,.25);
          border-top-color: #f2f2f2;
          border-radius: 999px;
          animation: queue-spin .75s linear infinite;
        }
        @keyframes queue-spin { to { transform: rotate(360deg); } }
        @media (prefers-reduced-motion: reduce) { .activity-spinner { animation: none; } }
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
        .locale-select {
          min-height: 28px;
          max-width: 78px;
          border: 1px solid rgba(255,255,255,.14);
          border-radius: 8px;
          outline: none;
          background: #232323;
          color: #e8e8e8;
          padding: 2px 4px;
          font: inherit;
          font-size: 11px;
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
        .workflow-preset-picker { display: grid; gap: 7px; }
        .workflow-preset-label { color: #aaa; font-size: 11px; }
        .workflow-preset-row { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 8px; align-items: stretch; }
        .workflow-preset-row select {
          min-width: 0;
          min-height: 38px;
          border: 1px solid rgba(255,255,255,.14);
          border-radius: 10px;
          outline: none;
          background: #232323;
          color: #f5f5f5;
          padding: 7px 9px;
          font: inherit;
        }
        .workflow-preset-row select:focus {
          border-color: rgba(255,255,255,.38);
          box-shadow: 0 0 0 3px rgba(255,255,255,.06);
        }
        .workflow-preset-description { color: #aaa; font-size: 11px; line-height: 1.4; }
        .workflow-divider { display: flex; align-items: center; gap: 8px; color: #777; font-size: 10px; text-transform: uppercase; letter-spacing: .08em; }
        .workflow-divider::before, .workflow-divider::after { content: ''; height: 1px; flex: 1; background: rgba(255,255,255,.08); }
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
        .bridge-row {
          margin-top: 12px;
          padding-top: 10px;
          border-top: 1px solid rgba(255,255,255,.08);
          display: flex;
          align-items: center;
          gap: 8px;
          color: #aaa;
          font-size: 11px;
        }
        .bridge-row > :first-child { color: #ddd; font-weight: 600; }
        .bridge-state { margin-left: auto; }
        .bridge-state.connected { color: #9fd3a9; }
        .context-section {
          margin-top: 12px;
          padding-top: 12px;
          border-top: 1px solid rgba(255,255,255,.1);
          display: grid;
          gap: 8px;
          border-radius: 12px;
        }
        .context-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
        .context-heading > div { display: flex; align-items: baseline; gap: 7px; }
        .context-subtitle { color: #888; font-size: 11px; }
        .adapter-chip {
          padding: 3px 7px;
          border: 1px solid rgba(255,255,255,.14);
          border-radius: 999px;
          color: #bbb;
          font-size: 10px;
          letter-spacing: .06em;
          text-transform: uppercase;
        }
        .adapter-chip.adapter-ok { color: #9fd3a9; border-color: rgba(159,211,169,.35); }
        .adapter-chip.adapter-degraded { color: #d7b987; border-color: rgba(215,185,135,.35); }
        .adapter-chip.adapter-unrecognized { color: #ffb4b4; border-color: rgba(255,140,140,.35); }
        .meter { height: 7px; border-radius: 999px; background: rgba(255,255,255,.09); overflow: hidden; }
        .meter-fill { height: 100%; border-radius: 999px; background: #8d8d8d; transition: width .2s ease; }
        .meter-fill.level-watch { background: #d7b987; }
        .meter-fill.level-compact { background: #e2a35f; }
        .meter-fill.level-critical { background: #ff8b8b; }
        .meter-detail { color: #aaa; font-size: 11px; line-height: 1.4; overflow-wrap: anywhere; }
        .context-disclosure { justify-self: start; min-height: 28px; padding: 3px 8px; font-size: 11px; }
        .adapter-detail {
          margin: 0;
          padding: 8px 9px;
          max-height: 160px;
          border: 1px solid rgba(255,255,255,.08);
          border-radius: 9px;
          background: rgba(0,0,0,.28);
          color: #cfcfcf;
          font: 11px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
          white-space: pre-wrap;
          overflow: auto;
          overflow-wrap: anywhere;
        }
        .handoff-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
        .handoff-state { color: #ddd; font-size: 12px; }
        .handoff-state.ready { color: #9fd3a9; }
        .handoff-hint { color: #999; font-size: 11px; line-height: 1.4; }
        .capacity-row {
          display: grid;
          grid-template-columns: minmax(0,1fr) 112px;
          align-items: center;
          gap: 8px;
          color: #aaa;
          font-size: 11px;
        }
        .capacity-row input {
          min-height: 32px;
          border: 1px solid rgba(255,255,255,.14);
          border-radius: 9px;
          outline: none;
          background: #232323;
          color: #f5f5f5;
          padding: 5px 8px;
          font: inherit;
        }
        .capacity-row input:focus {
          border-color: rgba(255,255,255,.38);
          box-shadow: 0 0 0 3px rgba(255,255,255,.06);
        }
        .guide-card {
          position: relative;
          margin-bottom: 10px;
          padding: 11px 12px 12px;
          border: 1px solid rgba(140,190,255,.32);
          border-radius: 12px;
          background: linear-gradient(180deg, rgba(52,72,104,.55), rgba(38,48,66,.55));
          box-shadow: 0 0 0 3px rgba(120,170,255,.07);
          outline: none;
        }
        .guide-head { display: flex; align-items: center; gap: 8px; }
        .guide-head strong { flex: 1; font-size: 12px; }
        .guide-progress-text { color: #b9cbe6; font-size: 11px; }
        .guide-dots { display: flex; gap: 5px; margin: 8px 0 10px; }
        .guide-dot {
          width: 100%;
          height: 4px;
          border-radius: 999px;
          background: rgba(255,255,255,.16);
          transition: background .18s ease;
        }
        .guide-dot.done { background: rgba(160,200,255,.5); }
        .guide-dot.active { background: #cfe2ff; }
        .guide-step-title { display: block; margin-bottom: 5px; font-size: 12.5px; }
        .guide-step-body { margin: 0; color: #dbe4f0; font-size: 12px; line-height: 1.5; }
        .guide-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; margin-top: 11px; }
        .guide-highlight {
          box-shadow: 0 0 0 2px rgba(150,195,255,.75), 0 0 0 6px rgba(150,195,255,.16);
          border-radius: 10px;
          transition: box-shadow .18s ease;
        }
        @media (max-width: 520px) {
          .dock { right: 8px; bottom: 8px; width: calc(100vw - 16px); }
          .body { max-height: 58vh; }
          .compact { grid-template-columns: 18px minmax(0,1fr); }
          .compact .item-state { grid-column: 2; }
        }
      </style>
      <div class="dock${this.collapsed ? ' collapsed' : ''}">
        <section class="panel" aria-label="${escapeHtml(t('app.title'))}">
          <header class="header">
            <div class="title-group">
              <span class="title">${escapeHtml(t('app.title'))}</span>
              <span class="count">${pending}</span>
            </div>
            <div class="header-actions">
              <span class="status status-${escapeHtml(queue.status)}${isActive ? ' activity' : ''}">${isActive ? `<span class="activity-spinner" data-role="activity-spinner" aria-label="${escapeHtml(t('status.running'))}"></span>` : ''}${escapeHtml(t(`status.${queue.status}` as MessageKey))}</span>
              <button class="ghost icon" data-action="open-guide" aria-label="${escapeHtml(t('guide.open'))}" title="${escapeHtml(t('guide.open'))}">?</button>
              <select class="locale-select" data-role="locale" aria-label="${escapeHtml(t('locale.label'))}" title="${escapeHtml(t('locale.label'))}">${localeOptions}</select>
              <button class="ghost icon" data-action="hide" aria-label="${escapeHtml(t('app.hide'))}" title="${escapeHtml(t('app.hide'))}">→</button>
            </div>
          </header>
          <div class="body">
            ${guideCard}
            <div class="toolbar">${control}<span class="spacer"></span></div>
            ${blocked}
            ${localNotice}
            <div class="composer">
              <textarea data-role="new-message" placeholder="${escapeHtml(t('item.newMessagePlaceholder'))}" aria-label="${escapeHtml(t('item.newMessageLabel'))}"></textarea>
              <button data-action="add">${escapeHtml(t('action.add'))}</button>
            </div>
            ${rows ? `<ul>${rows}</ul>` : `<div class="empty">${escapeHtml(t('list.empty'))}</div>`}
            ${contextSection}
            ${workflowSection}
            ${bridgeControl}
          </div>
        </section>
        <button class="peek" data-action="show" aria-label="${escapeHtml(t('app.show'))}">${isActive ? '<span class="activity-spinner" data-role="activity-spinner-collapsed" aria-hidden="true"></span>' : ''}<span>‹</span><strong>${escapeHtml(t('app.collapsedLabel', { count: pending }))}</strong></button>
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
      const capacityInput = this.root.querySelector<HTMLInputElement>('input[data-role="context-capacity"]');
      if (capacityInput && capacityDraft !== undefined) capacityInput.value = capacityDraft;
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
          : focusedCapacity
            ? this.root.querySelector<HTMLInputElement>('input[data-role="context-capacity"]')
            : null;
    if (focusTarget) {
      focusTarget.focus();
      if (selectionStart !== null && selectionEnd !== null) {
        focusTarget.setSelectionRange(selectionStart, selectionEnd);
      }
    }

    this.applyGuide();
  }

  private renderGuide(t: Translator): string {
    if (this.guideIndex === null) return '';
    const activeIndex = this.guideIndex;
    const step = GUIDE_STEPS[activeIndex];
    if (!step) return '';
    const dots = GUIDE_STEPS.map((_entry, index) =>
      `<span class="guide-dot${index === activeIndex ? ' active' : ''}${index < activeIndex ? ' done' : ''}"></span>`
    ).join('');
    const isLast = activeIndex === GUIDE_STEP_COUNT - 1;

    return `<section class="guide-card" data-role="guide-card" tabindex="-1" role="dialog" aria-label="${escapeHtml(t('guide.title'))}">
      <div class="guide-head">
        <strong>${escapeHtml(t('guide.title'))}</strong>
        <span class="guide-progress-text">${escapeHtml(t('guide.progress', { current: this.guideIndex + 1, total: GUIDE_STEP_COUNT }))}</span>
        <button class="ghost icon" data-action="close-guide" aria-label="${escapeHtml(t('action.close'))}" title="${escapeHtml(t('action.close'))}">✕</button>
      </div>
      <div class="guide-dots" aria-hidden="true">${dots}</div>
      <div class="guide-body">
        <strong class="guide-step-title">${escapeHtml(t(step.title))}</strong>
        <p class="guide-step-body">${escapeHtml(t(step.body))}</p>
      </div>
      <div class="guide-actions">
        <button class="ghost" data-action="guide-prev"${this.guideIndex === 0 ? ' disabled' : ''}>${escapeHtml(t('action.back'))}</button>
        <button class="primary" data-action="guide-next">${escapeHtml(isLast ? t('action.finish') : t('action.next'))}</button>
      </div>
    </section>`;
  }

  /** Highlights whatever the current guide step is talking about, without touching the guide card. */
  private applyGuide(): void {
    for (const node of this.root.querySelectorAll('.guide-highlight')) node.classList.remove('guide-highlight');
    if (this.guideIndex === null) return;
    const step = GUIDE_STEPS[this.guideIndex];
    if (!step) return;
    const selectors = [step.target, ...(step.fallbackTargets ?? [])];
    for (const selector of selectors) {
      const target = this.root.querySelector<HTMLElement>(selector);
      if (!target) continue;
      target.classList.add('guide-highlight');
      target.scrollIntoView?.({ block: 'nearest' });
      return;
    }
  }

  private setCollapsed(collapsed: boolean): void {
    this.collapsed = collapsed;
    writeSessionFlag(PANEL_COLLAPSED_KEY, collapsed);
    this.root.querySelector('.dock')?.classList.toggle('collapsed', collapsed);
  }

  private openGuide(): void {
    this.guideIndex = 0;
    this.refresh();
    this.root.querySelector<HTMLElement>('[data-role="guide-card"]')?.focus();
  }

  private closeGuide(): void {
    this.guideIndex = null;
    this.refresh();
  }

  private guideStep(delta: number): void {
    if (this.guideIndex === null) return;
    const next = this.guideIndex + delta;
    if (next >= GUIDE_STEP_COUNT) {
      this.closeGuide();
      return;
    }
    this.guideIndex = clampGuideIndex(next);
    this.refresh();
  }

  private bind(): void {
    const invoke = (action: (() => MaybePromise) | undefined) => {
      if (action) void Promise.resolve(action()).catch(() => undefined);
    };

    this.root.querySelector('[data-action="hide"]')?.addEventListener('click', () => this.setCollapsed(true));
    this.root.querySelector('[data-action="show"]')?.addEventListener('click', () => this.setCollapsed(false));

    this.root.querySelector('[data-action="open-guide"]')?.addEventListener('click', () => this.openGuide());
    this.root.querySelector('[data-action="close-guide"]')?.addEventListener('click', () => this.closeGuide());
    this.root.querySelector('[data-action="guide-prev"]')?.addEventListener('click', () => this.guideStep(-1));
    this.root.querySelector('[data-action="guide-next"]')?.addEventListener('click', () => this.guideStep(1));
    this.root.querySelector<HTMLElement>('[data-role="guide-card"]')?.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        this.closeGuide();
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        this.guideStep(1);
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        this.guideStep(-1);
      }
    });

    this.root.querySelector<HTMLSelectElement>('[data-role="locale"]')?.addEventListener('change', (event) => {
      const value = (event.currentTarget as HTMLSelectElement).value as LocalePreference;
      if (this.actions.setLocale) invoke(() => this.actions.setLocale!(value));
    });

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

    const workflowPreset = this.root.querySelector<HTMLSelectElement>('[data-role="workflow-preset"]');
    const workflowPresetDescription = this.root.querySelector<HTMLElement>('[data-role="workflow-preset-description"]');
    const workflowPresetButton = this.root.querySelector<HTMLButtonElement>('[data-action="load-workflow-preset"]');
    workflowPreset?.addEventListener('change', () => {
      const option = workflowPreset.selectedOptions[0];
      this.selectedPresetId = workflowPreset.value;
      if (workflowPresetDescription) {
        workflowPresetDescription.textContent = option?.dataset.description
          ?? translate(this.localeOfLastRender(), 'workflow.defaultDescription');
      }
      if (workflowPresetButton) workflowPresetButton.disabled = workflowPreset.value.length === 0;
    });
    workflowPresetButton?.addEventListener('click', () => {
      const presetId = workflowPreset?.value ?? '';
      if (!presetId || !this.actions.loadWorkflowPreset) return;
      invoke(() => this.actions.loadWorkflowPreset!(presetId));
    });

    this.root.querySelector('[data-action="toggle-adapter-detail"]')?.addEventListener('click', () => {
      this.adapterDetailsOpen = !this.adapterDetailsOpen;
      const detail = this.root.querySelector<HTMLElement>('[data-role="adapter-detail"]');
      if (detail) detail.hidden = !this.adapterDetailsOpen;
    });
    this.root.querySelector('[data-action="prepare-handoff"]')?.addEventListener('click', () => invoke(this.actions.prepareHandoff));
    this.root.querySelector('[data-action="open-handoff"]')?.addEventListener('click', () => invoke(this.actions.openHandoff));
    this.root.querySelector<HTMLInputElement>('input[data-role="context-capacity"]')?.addEventListener('change', () => {
      if (!this.actions.setContextCapacity) return;
      const input = this.root.querySelector<HTMLInputElement>('input[data-role="context-capacity"]');
      if (!input) return;
      const trimmed = input.value.trim();
      const parsed = trimmed === '' ? null : Number(trimmed);
      const next = parsed === null || !Number.isFinite(parsed) ? null : parsed;
      input.value = next === null ? '' : String(next);
      invoke(() => this.actions.setContextCapacity!(next));
    });

    this.root.querySelector('[data-action="clear-workflow"]')?.addEventListener('click', () => invoke(this.actions.clearWorkflow));
    this.root.querySelector('[data-action="enable-bridge"]')?.addEventListener('click', () => invoke(this.actions.enableBridge));
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

  private localeOfLastRender(): Locale {
    return this.lastRenderArgs?.[2]?.locale ?? 'en';
  }
}

const itemStateKey = (state: QueueItem['state']): MessageKey => `item.${state}` as MessageKey;

const stateMark = (item: QueueItem): string => {
  if (item.state === 'completed') return '✓';
  if (item.state === 'running' || item.state === 'sending') return '●';
  return '○';
};

/** Known fail-closed codes are explained in the panel language; unknown codes fall back to the code. */
const describeReason = (locale: Locale, code: string): string => {
  const key = `reason.${code}` as MessageKey;
  const translated = translate(locale, key);
  return translated === key ? code : translated;
};

const visualSignature = (
  queue: ConversationQueue,
  notice: string | undefined,
  view: QueuePanelView,
  guideIndex: number | null,
): string => JSON.stringify({
  conversationKey: queue.conversationKey,
  status: queue.status,
  blockedReason: queue.blockedReason ?? null,
  notice: notice ?? null,
  items: queue.items.map((item) => ({ id: item.id, content: item.content, state: item.state })),
  workflow: view.workflow ? {
    name: view.workflow.name,
    inputs: view.workflow.inputs,
    steps: view.workflow.steps.map((step) => step.id),
  } : null,
  run: view.run ? {
    id: view.run.id,
    status: view.run.status,
    steps: view.run.steps.map((step) => ({ id: step.id, status: step.status, error: step.error ?? null })),
  } : null,
  workflowError: view.error ?? null,
  bridgeState: view.bridgeState ?? 'disabled',
  locale: view.locale ?? 'en',
  localePreference: view.localePreference ?? 'auto',
  guideIndex,
  context: view.context ? {
    pressure: view.context.pressure
      ? {
          level: view.context.pressure.level,
          percent: Math.round(view.context.pressure.ratio * 100),
          estimatedTokens: view.context.pressure.estimatedTokens,
          capacityTokens: view.context.pressure.capacity.usableTokens,
        }
      : null,
    capacityOverride: view.context.capacityOverride ?? null,
    handoffStatus: view.context.handoff?.status ?? 'none',
    carriedItems: view.context.handoff?.carriedItems ?? 0,
    adapter: view.context.adapter
      ? {
          health: view.context.adapter.report.health,
          recognized: view.context.adapter.report.recognized,
          isGenerating: view.context.adapter.report.isGenerating,
          composerReady: view.context.adapter.report.composerReady,
          blockingReason: view.context.adapter.report.blockingReason,
          confirmationVisible: view.context.adapter.report.confirmationVisible,
          sendControl: view.context.adapter.report.sendControl.status,
          stopControl: view.context.adapter.report.stopControl.status,
          transcript: view.context.adapter.report.transcript.status,
          assistantTurn: view.context.adapter.report.assistantTurn.status,
        }
      : null,
  } : null,
});
