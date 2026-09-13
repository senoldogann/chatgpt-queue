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
  /**
   * The content script can no longer reach the extension (it was reloaded or updated). Nothing in
   * this panel can work until the page is reloaded, so it must not keep claiming the queue is live.
   */
  stale?: boolean;
  /** The queue's owner lease lapsed while work was in flight: nobody is driving this queue. */
  driverStalled?: boolean;
}

const PANEL_COLLAPSED_KEY = 'chatgpt-queue:panel-collapsed';
const LOCALE_PREFERENCE_VALUES: readonly LocalePreference[] = ['auto', 'en', 'tr'];

type PanelTab = 'queue' | 'workflow' | 'system';

export const totalActiveDurationMs = (queue: ConversationQueue, now = Date.now()): number => queue.items.reduce((total, item) => {
  if (item.startedAt === undefined) return total;
  const end = item.completedAt ?? ((item.state === 'sending' || item.state === 'running') ? now : undefined);
  if (end === undefined || end < item.startedAt) return total;
  return total + (end - item.startedAt);
}, 0);

export const formatActiveDuration = (milliseconds: number): string => {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':');
};

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
  private readonly collapsedQueueItemIds = new Set<string>();
  private activeTab: PanelTab = 'queue';
  private activeDurationTimer: ReturnType<typeof setInterval> | undefined;
  private activeDurationQueue?: ConversationQueue;
  private activeDurationLocale: Locale = 'en';

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
    // A stale panel is one whose content script has lost the extension. Every control it renders
    // is already non-functional, so it must say so instead of reporting a queue as running.
    const stale = view.stale === true;
    const signature = visualSignature(queue, notice, view, this.guideIndex);
    if (signature === this.lastVisualSignature) return;

    const sameConversation = this.lastConversationKey === queue.conversationKey;
    if (!sameConversation) {
      this.collapsedQueueItemIds.clear();
      this.activeTab = 'queue';
    }
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
      for (const input of this.root.querySelectorAll<HTMLTextAreaElement>('textarea[data-workflow-input]')) {
        if (input.dataset.workflowInput) workflowDrafts.set(input.dataset.workflowInput, input.value);
      }
      capacityDraft = this.root.querySelector<HTMLInputElement>('input[data-role="context-capacity"]')?.value;
    }

    const livePreset = this.root.querySelector<HTMLSelectElement>('[data-role="workflow-preset"]');
    if (livePreset) this.selectedPresetId = livePreset.value;

    const active = sameConversation ? this.root.activeElement : null;
    const focusedNewMessage = active instanceof HTMLTextAreaElement && active.dataset.role === 'new-message';
    const focusedItemId = active instanceof HTMLTextAreaElement ? active.dataset.itemId : undefined;
    const focusedWorkflowInput = active instanceof HTMLTextAreaElement ? active.dataset.workflowInput : undefined;
    const focusedCapacity = active instanceof HTMLInputElement && active.dataset.role === 'context-capacity';
    const editableActive = active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement ? active : null;
    const selectionStart = editableActive?.selectionStart ?? null;
    const selectionEnd = editableActive?.selectionEnd ?? null;

    const queuedItems = queue.items.filter((item) => item.state === 'queued');
    const queuedPositions = new Map(queuedItems.map((item, index) => [item.id, index + 1]));
    const queuedItemIds = new Set(queuedItems.map((item) => item.id));
    for (const itemId of this.collapsedQueueItemIds) {
      if (!queuedItemIds.has(itemId)) this.collapsedQueueItemIds.delete(itemId);
    }
    const pending = queuedItems.length;
    const allQueuedCollapsed = pending > 0 && queuedItems.every((item) => this.collapsedQueueItemIds.has(item.id));
    const collapseAllControl = pending > 0
      ? `<button class="ghost queue-collapse-toggle" data-action="toggle-all-items" aria-label="${escapeHtml(t(allQueuedCollapsed ? 'action.expand' : 'action.collapse'))}">${escapeHtml(t(allQueuedCollapsed ? 'action.expand' : 'action.collapse'))}</button>`
      : '';
    const control = queue.status === 'running'
      ? `<button class="primary" data-action="pause">${escapeHtml(t('action.pause'))}</button>`
      : queue.status === 'paused' || queue.status === 'blocked'
        ? `<button class="primary" data-action="resume">${escapeHtml(t('action.resume'))}</button>`
        : pending > 0
          ? `<button class="primary" data-action="start">${escapeHtml(t('action.start'))}</button>`
          : '';

    const rows = queue.items.map((item) => {
      if (item.state === 'queued') {
        const itemCollapsed = this.collapsedQueueItemIds.has(item.id);
        const position = queuedPositions.get(item.id) ?? 0;
        return `<li class="item queued${itemCollapsed ? ' item-collapsed' : ''}" data-queue-item-id="${escapeHtml(item.id)}">
          <div class="item-head">
            <span class="queue-position" data-role="queue-position">#${position}</span>
            <span class="item-state">${escapeHtml(t('item.queued'))}</span>
            <span class="queued-preview">${escapeHtml(item.content)}</span>
            <span class="spacer"></span>
            <div class="item-commands">
              <button class="ghost item-toggle" data-action="toggle-item" data-id="${escapeHtml(item.id)}" aria-expanded="${String(!itemCollapsed)}">${escapeHtml(t(itemCollapsed ? 'action.expand' : 'action.collapse'))}</button>
              <button class="ghost icon danger item-delete" data-action="delete" data-id="${escapeHtml(item.id)}" title="${escapeHtml(t('action.delete'))}" aria-label="${escapeHtml(t('action.delete'))}">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-2 6h10l-1 11H8L7 9Zm3 2v7h2v-7h-2Zm4 0v7h2v-7h-2Z" fill="currentColor"/></svg>
              </button>
            </div>
          </div>
          <div class="item-editor">
            <textarea data-item-id="${escapeHtml(item.id)}" aria-label="${escapeHtml(t('item.draftLabel'))}">${escapeHtml(item.content)}</textarea>
            <div class="row-actions">
              <button class="icon" data-action="up" data-id="${escapeHtml(item.id)}" title="${escapeHtml(t('action.moveUp'))}" aria-label="${escapeHtml(t('action.moveUp'))}">↑</button>
              <button class="icon" data-action="down" data-id="${escapeHtml(item.id)}" title="${escapeHtml(t('action.moveDown'))}" aria-label="${escapeHtml(t('action.moveDown'))}">↓</button>
              <button data-action="save" data-id="${escapeHtml(item.id)}">${escapeHtml(t('action.save'))}</button>
            </div>
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
    const staleBanner = stale
      ? `<div class="notice danger-notice" data-role="stale-banner"><strong>${escapeHtml(t('notice.staleTitle'))}:</strong> ${escapeHtml(t('notice.staleBody'))}</div>`
      : '';
    const stalledNotice = !stale && view.driverStalled === true
      ? `<div class="notice" data-role="driver-stalled">${escapeHtml(t('notice.driverStalled'))}</div>`
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
      ? Object.entries(workflow.inputs).map(([name, definition]) => {
          const presentation = workflowInputPresentation(name, t);
          return `<label class="workflow-input-label">
            <span class="workflow-input-title"><span>${escapeHtml(presentation.label)}</span><span class="workflow-requirement">${escapeHtml(t(definition.required ? 'workflow.required' : 'workflow.optional'))}</span></span>
            <textarea data-workflow-input="${escapeHtml(name)}" autocomplete="off" aria-label="${escapeHtml(presentation.label)}"${definition.required ? ' required aria-required="true"' : ''}></textarea>
            <span class="workflow-input-help">${escapeHtml(presentation.help)}</span>
          </label>`;
        }).join('')
      : '';
    const loadedPreset = workflow ? WORKFLOW_PRESETS.find((preset) => preset.workflow.name === workflow.name) : undefined;
    const workflowDisplayName = workflow
      ? loadedPreset ? localizedPresetText(loadedPreset, locale).label : workflow.name
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
          <div class="workflow-meta"><strong>${escapeHtml(workflowDisplayName)}</strong><span>${loadedPreset ? `${escapeHtml(workflow.name)} · ` : ''}${escapeHtml(t('workflow.stepsCount', { count: workflow.steps.length }))}</span></div>
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
      ? t(pressure.sampleTruncated ? 'context.pressureTruncated' : 'context.pressure', {
          percent: Math.round(pressure.ratio * 100),
          capacity: pressure.capacity.usableTokens.toLocaleString('en-US'),
          estimated: pressure.estimatedTokens.toLocaleString('en-US'),
          turns: pressure.turnCount,
          source: t(`context.source.${pressure.capacity.source}` as MessageKey),
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
           <div class="meter-detail" data-role="context-detail">${escapeHtml(pressureText)}</div>
           <div class="context-disclaimer">${escapeHtml(t('context.disclaimer'))}</div>`
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
          --cq-surface: rgba(28, 28, 28, .97);
          --cq-surface-raised: rgba(255,255,255,.045);
          --cq-border: rgba(255,255,255,.12);
          --cq-muted: #9a9a9a;
          --cq-radius: 12px;
          --cq-gap: 10px;
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
          flex-wrap: wrap;
          align-items: center;
          justify-content: space-between;
          gap: 8px 10px;
          padding: 11px 12px 10px;
          border-bottom: 1px solid var(--cq-border);
        }
        .title-group { display: flex; align-items: center; gap: 9px; min-width: 0; flex: 1 1 auto; }
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
        .header-actions {
          display: flex;
          flex: 1 1 100%;
          align-items: center;
          justify-content: flex-end;
          gap: 6px;
          min-width: 0;
        }
        .active-duration {
          display: inline-flex;
          align-items: center;
          min-height: 26px;
          padding: 3px 8px;
          border-radius: 999px;
          background: var(--cq-surface-raised);
          color: #d8d8d8;
          font: 600 10.5px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace;
          white-space: nowrap;
        }
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
        .body { padding: 10px 12px 12px; max-height: min(65vh, 640px); overflow: auto; }
        .tab-bar {
          position: sticky;
          top: -10px;
          z-index: 4;
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 4px;
          margin: 0 -2px 12px;
          padding: 4px;
          border: 1px solid rgba(255,255,255,.08);
          border-radius: 11px;
          background: rgba(24,24,24,.96);
          backdrop-filter: blur(14px);
        }
        button.tab {
          min-height: 32px;
          padding: 5px 8px;
          border-color: transparent;
          background: transparent;
          color: #9f9f9f;
          font-weight: 600;
        }
        button.tab:hover { background: rgba(255,255,255,.05); }
        button.tab.active {
          background: rgba(255,255,255,.11);
          border-color: rgba(255,255,255,.12);
          color: #fff;
          box-shadow: 0 1px 0 rgba(255,255,255,.04) inset;
        }
        .tab-panel[hidden] { display: none !important; }
        .tab-panel { min-width: 0; }
        .queue-panel { display: grid; gap: 10px; }
        .queue-panel .toolbar { margin-bottom: 0; }

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
        .item-head { display: flex; align-items: center; gap: 7px; margin-bottom: 8px; color: #aaa; font-size: 12px; min-width: 0; }
        .item.item-collapsed .item-head { margin-bottom: 0; }
        .item.item-collapsed .item-editor { display: none; }
        .queue-position {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-width: 28px;
          height: 22px;
          border-radius: 7px;
          background: rgba(255,255,255,.06);
          color: #bdbdbd;
          font: 600 10px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
        }
        .queued-preview { display: none; min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #d0d0d0; }
        .item.item-collapsed .queued-preview { display: block; }
        .item.item-collapsed .item-head > .spacer { display: none; }
        .item-commands { display: inline-flex; align-items: center; gap: 4px; flex: 0 0 auto; }
        .item-toggle { min-height: 26px; padding: 2px 7px; font-size: 11px; flex: 0 0 auto; }
        .item-commands .icon { min-width: 28px; min-height: 28px; padding: 5px; align-items: center; justify-content: center; }
        .item-commands svg { width: 14px; height: 14px; display: block; }
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
          margin-top: 0;
          padding-top: 0;
          border-top: 0;
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
        .workflow-inputs { display: grid; gap: 10px; }
        .workflow-input-label { display: grid; gap: 5px; color: #aaa; font-size: 11px; }
        .workflow-input-title { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: #ddd; }
        .workflow-requirement { color: #999; font-size: 10px; font-weight: 500; }
        .workflow-input-label textarea { min-height: 82px; resize: vertical; }
        .workflow-input-help { color: #888; font-size: 10.5px; line-height: 1.4; }
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
          margin-top: 0;
          padding-top: 0;
          border-top: 0;
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
        .context-disclaimer { color: #7f7f7f; font-size: 10px; line-height: 1.4; }
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
        /* A stale panel keeps its queue list readable but removes every control that could no
           longer work, so nothing invites a click that cannot do anything. */
        .dock.stale .toolbar,
        .dock.stale .composer,
        .dock.stale .row-actions,
        .dock.stale .item-commands,
        .dock.stale .workflow-section,
        .dock.stale .bridge-row,
        .dock.stale .handoff-row,
        .dock.stale .capacity-row { display: none; }

        @media (max-width: 520px) {
          .dock { right: 8px; bottom: 8px; width: calc(100vw - 16px); }
          .header { align-items: flex-start; }
          .header-actions { flex-wrap: wrap; justify-content: flex-start; }
          .body { max-height: 58vh; }
          .compact { grid-template-columns: 18px minmax(0,1fr); }
          .compact .item-state { grid-column: 2; }
          .item-head { flex-wrap: wrap; }
          .queued-preview { order: 3; flex-basis: 100%; }
        }
      </style>
      <div class="dock${this.collapsed ? ' collapsed' : ''}${stale ? ' stale' : ''}">
        <section class="panel" aria-label="${escapeHtml(t('app.title'))}">
          <header class="header">
            <div class="title-group">
              <span class="title">${escapeHtml(t('app.title'))}</span>
              <span class="count">${pending}</span>
            </div>
            <div class="header-actions">
              <span class="active-duration" data-role="active-duration">${escapeHtml(t('timer.active'))} ${escapeHtml(formatActiveDuration(totalActiveDurationMs(queue)))}</span>
              <span class="status status-${stale ? 'stale' : escapeHtml(queue.status)}${isActive && !stale ? ' activity' : ''}">${isActive && !stale ? `<span class="activity-spinner" data-role="activity-spinner" aria-label="${escapeHtml(t('status.running'))}"></span>` : ''}${escapeHtml(stale ? t('status.stale') : t(`status.${queue.status}` as MessageKey))}</span>
              <button class="ghost icon" data-action="open-guide" aria-label="${escapeHtml(t('guide.open'))}" title="${escapeHtml(t('guide.open'))}">?</button>
              <select class="locale-select" data-role="locale" aria-label="${escapeHtml(t('locale.label'))}" title="${escapeHtml(t('locale.label'))}">${localeOptions}</select>
              <button class="ghost icon" data-action="hide" aria-label="${escapeHtml(t('app.hide'))}" title="${escapeHtml(t('app.hide'))}">→</button>
            </div>
          </header>
          <div class="body">
            ${staleBanner}
            ${stalledNotice}
            ${guideCard}
            <nav class="tab-bar" data-role="tab-bar" role="tablist" aria-label="${escapeHtml(t('app.title'))}">
              <button class="tab${this.activeTab === 'queue' ? ' active' : ''}" role="tab" data-tab="queue" aria-selected="${String(this.activeTab === 'queue')}" aria-controls="queue-panel">${escapeHtml(t('tab.queue'))}</button>
              <button class="tab${this.activeTab === 'workflow' ? ' active' : ''}" role="tab" data-tab="workflow" aria-selected="${String(this.activeTab === 'workflow')}" aria-controls="workflow-panel">${escapeHtml(t('tab.workflow'))}</button>
              <button class="tab${this.activeTab === 'system' ? ' active' : ''}" role="tab" data-tab="system" aria-selected="${String(this.activeTab === 'system')}" aria-controls="system-panel">${escapeHtml(t('tab.system'))}</button>
            </nav>
            <section id="queue-panel" class="tab-panel queue-panel" role="tabpanel" data-panel="queue"${this.activeTab === 'queue' ? '' : ' hidden'}>
              <div class="toolbar">${control}<span class="spacer"></span>${collapseAllControl}</div>
              ${blocked}
              ${localNotice}
              <div class="composer">
                <textarea data-role="new-message" placeholder="${escapeHtml(t('item.newMessagePlaceholder'))}" aria-label="${escapeHtml(t('item.newMessageLabel'))}"></textarea>
                <button data-action="add">${escapeHtml(t('action.add'))}</button>
              </div>
              ${rows ? `<ul>${rows}</ul>` : `<div class="empty">${escapeHtml(t('list.empty'))}</div>`}
            </section>
            <section id="workflow-panel" class="tab-panel" role="tabpanel" data-panel="workflow"${this.activeTab === 'workflow' ? '' : ' hidden'}>
              ${workflowSection}
            </section>
            <section id="system-panel" class="tab-panel" role="tabpanel" data-panel="system"${this.activeTab === 'system' ? '' : ' hidden'}>
              ${contextSection}
              ${bridgeControl}
            </section>
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
      for (const input of this.root.querySelectorAll<HTMLTextAreaElement>('textarea[data-workflow-input]')) {
        const name = input.dataset.workflowInput;
        if (name && workflowDrafts.has(name)) input.value = workflowDrafts.get(name)!;
      }
      const capacityInput = this.root.querySelector<HTMLInputElement>('input[data-role="context-capacity"]');
      if (capacityInput && capacityDraft !== undefined) capacityInput.value = capacityDraft;
    }

    this.bind();
    this.syncActiveDurationTimer(queue, locale);
    this.lastConversationKey = queue.conversationKey;
    this.lastVisualSignature = signature;

    const focusTarget: HTMLTextAreaElement | HTMLInputElement | null = focusedNewMessage
      ? this.root.querySelector<HTMLTextAreaElement>('[data-role="new-message"]')
      : focusedItemId
        ? this.root.querySelector<HTMLTextAreaElement>(`textarea[data-item-id="${CSS.escape(focusedItemId)}"]`)
        : focusedWorkflowInput
          ? this.root.querySelector<HTMLTextAreaElement>(`textarea[data-workflow-input="${CSS.escape(focusedWorkflowInput)}"]`)
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

  private setActiveTab(tab: PanelTab): void {
    this.activeTab = tab;
    for (const button of this.root.querySelectorAll<HTMLButtonElement>('[data-tab]')) {
      const selected = button.dataset.tab === tab;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-selected', String(selected));
    }
    for (const panel of this.root.querySelectorAll<HTMLElement>('[data-panel]')) {
      panel.hidden = panel.dataset.panel !== tab;
    }
  }

  private syncActiveDurationTimer(queue: ConversationQueue, locale: Locale): void {
    this.activeDurationQueue = queue;
    this.activeDurationLocale = locale;
    this.updateActiveDurationNode();

    const needsLiveTimer = queue.items.some((item) =>
      item.startedAt !== undefined
      && item.completedAt === undefined
      && (item.state === 'sending' || item.state === 'running')
    );
    if (needsLiveTimer && this.activeDurationTimer === undefined) {
      this.activeDurationTimer = setInterval(() => this.updateActiveDurationNode(), 1_000);
    } else if (!needsLiveTimer && this.activeDurationTimer !== undefined) {
      clearInterval(this.activeDurationTimer);
      this.activeDurationTimer = undefined;
    }
  }

  private updateActiveDurationNode(): void {
    const queue = this.activeDurationQueue;
    const node = this.root.querySelector<HTMLElement>('[data-role="active-duration"]');
    if (!queue || !node) return;
    node.textContent = `${translate(this.activeDurationLocale, 'timer.active')} ${formatActiveDuration(totalActiveDurationMs(queue))}`;
  }

  private setQueueItemCollapsed(itemId: string, collapsed: boolean): void {
    if (collapsed) this.collapsedQueueItemIds.add(itemId);
    else this.collapsedQueueItemIds.delete(itemId);

    const row = this.root.querySelector<HTMLElement>(`[data-queue-item-id="${CSS.escape(itemId)}"]`);
    row?.classList.toggle('item-collapsed', collapsed);
    const toggle = row?.querySelector<HTMLButtonElement>('[data-action="toggle-item"]');
    if (toggle) {
      toggle.textContent = translate(this.localeOfLastRender(), collapsed ? 'action.expand' : 'action.collapse');
      toggle.setAttribute('aria-expanded', String(!collapsed));
    }
    if (collapsed && row) {
      const draft = row.querySelector<HTMLTextAreaElement>('textarea[data-item-id]')?.value;
      const preview = row.querySelector<HTMLElement>('.queued-preview');
      if (preview && draft !== undefined) preview.textContent = draft;
    }
    this.updateToggleAllControl();
  }

  private toggleAllQueuedItems(): void {
    const rows = [...this.root.querySelectorAll<HTMLElement>('.item.queued[data-queue-item-id]')];
    const itemIds = rows.map((row) => row.dataset.queueItemId).filter((id): id is string => Boolean(id));
    if (itemIds.length === 0) return;
    const collapse = itemIds.some((itemId) => !this.collapsedQueueItemIds.has(itemId));
    for (const itemId of itemIds) this.setQueueItemCollapsed(itemId, collapse);
  }

  private updateToggleAllControl(): void {
    const toggle = this.root.querySelector<HTMLButtonElement>('[data-action="toggle-all-items"]');
    if (!toggle) return;
    const itemIds = [...this.root.querySelectorAll<HTMLElement>('.item.queued[data-queue-item-id]')]
      .map((row) => row.dataset.queueItemId)
      .filter((id): id is string => Boolean(id));
    const allCollapsed = itemIds.length > 0 && itemIds.every((itemId) => this.collapsedQueueItemIds.has(itemId));
    const key = allCollapsed ? 'action.expand' : 'action.collapse';
    const label = translate(this.localeOfLastRender(), key);
    toggle.textContent = label;
    toggle.setAttribute('aria-label', label);
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
    for (const tab of this.root.querySelectorAll<HTMLButtonElement>('[data-tab]')) {
      tab.addEventListener('click', () => {
        const target = tab.dataset.tab;
        if (target === 'queue' || target === 'workflow' || target === 'system') this.setActiveTab(target);
      });
    }

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

    this.root.querySelector('[data-action="toggle-all-items"]')?.addEventListener('click', () => this.toggleAllQueuedItems());
    this.root.querySelector('[data-action="clear-workflow"]')?.addEventListener('click', () => invoke(this.actions.clearWorkflow));
    this.root.querySelector('[data-action="enable-bridge"]')?.addEventListener('click', () => invoke(this.actions.enableBridge));
    this.root.querySelector('[data-action="run-workflow"]')?.addEventListener('click', () => {
      if (!this.actions.runWorkflow) return;
      const inputs: Record<string, string> = {};
      for (const input of this.root.querySelectorAll<HTMLTextAreaElement>('textarea[data-workflow-input]')) {
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
        if (action === 'toggle-item') {
          this.setQueueItemCollapsed(itemId, !this.collapsedQueueItemIds.has(itemId));
        } else if (action === 'save' && this.actions.edit) {
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

const WORKFLOW_INPUT_PRESENTATION: Record<string, { label: MessageKey; help: MessageKey }> = {
  diff: { label: 'workflow.input.diff.label', help: 'workflow.input.diff.help' },
  context: { label: 'workflow.input.context.label', help: 'workflow.input.context.help' },
  change: { label: 'workflow.input.change.label', help: 'workflow.input.change.help' },
  requirements: { label: 'workflow.input.requirements.label', help: 'workflow.input.requirements.help' },
  symptom: { label: 'workflow.input.symptom.label', help: 'workflow.input.symptom.help' },
  evidence: { label: 'workflow.input.evidence.label', help: 'workflow.input.evidence.help' },
  release: { label: 'workflow.input.release.label', help: 'workflow.input.release.help' },
};

const workflowInputPresentation = (name: string, t: Translator): { label: string; help: string } => {
  const presentation = WORKFLOW_INPUT_PRESENTATION[name];
  return presentation
    ? { label: t(presentation.label), help: t(presentation.help) }
    : { label: name, help: t('workflow.input.generic.help', { name }) };
};

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
  items: queue.items.map((item) => ({ id: item.id, content: item.content, state: item.state, startedAt: item.startedAt ?? null, completedAt: item.completedAt ?? null })),
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
  stale: view.stale === true,
  driverStalled: view.driverStalled === true,
  guideIndex,
  context: view.context ? {
    pressure: view.context.pressure
      ? {
          level: view.context.pressure.level,
          percent: Math.round(view.context.pressure.ratio * 100),
          estimatedTokens: view.context.pressure.estimatedTokens,
          sampleTruncated: view.context.pressure.sampleTruncated,
          capacityTokens: view.context.pressure.capacity.usableTokens,
          capacitySource: view.context.pressure.capacity.source,
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
