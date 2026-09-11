import type { ConversationQueue, QueueItem } from '../domain/types';

type MaybePromise = void | Promise<void>;

export interface QueuePanelActions {
  add?: (content: string) => MaybePromise;
  start?: () => MaybePromise;
  pause?: () => MaybePromise;
  resume?: () => MaybePromise;
  edit?: (itemId: string, content: string) => MaybePromise;
  remove?: (itemId: string) => MaybePromise;
  reorder?: (itemId: string, delta: number) => MaybePromise;
}

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

export class QueuePanel {
  private readonly root: ShadowRoot;

  constructor(private readonly host: HTMLElement, private readonly actions: QueuePanelActions) {
    this.root = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
  }

  render(queue: ConversationQueue, notice?: string): void {
    const pending = queue.items.filter((item) => item.state === 'queued').length;
    const control = queue.status === 'running'
      ? '<button data-action="pause">Pause</button>'
      : queue.status === 'paused' || queue.status === 'blocked'
        ? '<button data-action="resume">Resume</button>'
        : pending > 0
          ? '<button data-action="start">Start</button>'
          : '';

    const rows = queue.items.map((item) => {
      if (item.state === 'queued') {
        return `<li class="item queued">
          <span class="mark">${stateMark(item)}</span>
          <textarea data-item-id="${escapeHtml(item.id)}">${escapeHtml(item.content)}</textarea>
          <div class="row-actions">
            <button data-action="up" data-id="${escapeHtml(item.id)}" title="Move up">↑</button>
            <button data-action="down" data-id="${escapeHtml(item.id)}" title="Move down">↓</button>
            <button data-action="save" data-id="${escapeHtml(item.id)}">Save</button>
            <button data-action="delete" data-id="${escapeHtml(item.id)}">Delete</button>
          </div>
        </li>`;
      }
      return `<li class="item ${item.state}"><span class="mark">${stateMark(item)}</span><span>${escapeHtml(item.content)}</span><small>${escapeHtml(item.state)}</small></li>`;
    }).join('');

    const blocked = queue.blockedReason
      ? `<div class="blocked"><strong>Blocked:</strong> ${escapeHtml(queue.blockedReason)}</div>`
      : '';
    const localNotice = notice
      ? `<div class="blocked"><strong>Notice:</strong> ${escapeHtml(notice)}</div>`
      : '';

    this.root.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; }
        .wrap { position: fixed; right: 18px; bottom: 18px; z-index: 2147483647; width: min(380px, calc(100vw - 36px)); color: #ececec; font: 13px/1.35 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
        details { background: rgba(32,32,32,.98); border: 1px solid #4a4a4a; border-radius: 12px; box-shadow: 0 12px 38px rgba(0,0,0,.28); overflow: hidden; }
        summary { cursor: pointer; list-style: none; display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 12px; font-weight: 650; }
        summary::-webkit-details-marker { display: none; }
        .status { color: #b8b8b8; font-size: 12px; font-weight: 500; }
        .body { border-top: 1px solid #444; padding: 10px; max-height: 60vh; overflow: auto; }
        .controls, .add, .row-actions { display: flex; gap: 6px; }
        .controls { margin-bottom: 8px; }
        button { border: 1px solid #555; border-radius: 7px; background: #303030; color: #f4f4f4; padding: 5px 8px; cursor: pointer; }
        button:hover { background: #3a3a3a; }
        textarea { width: 100%; min-height: 50px; resize: vertical; border: 1px solid #555; border-radius: 7px; background: #242424; color: #f4f4f4; padding: 7px; font: inherit; }
        .add { align-items: flex-start; margin: 8px 0 10px; }
        .add textarea { min-height: 58px; }
        ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 7px; }
        .item { display: grid; grid-template-columns: 18px 1fr auto; align-items: start; gap: 7px; padding: 7px; border-radius: 8px; background: #282828; }
        .item.queued { grid-template-columns: 18px 1fr; }
        .item.queued .row-actions { grid-column: 2; flex-wrap: wrap; }
        .item small { color: #aaa; }
        .mark { color: #aaa; }
        .running .mark, .sending .mark { color: #fff; }
        .completed { opacity: .72; }
        .blocked { margin: 8px 0; padding: 7px; border-radius: 7px; background: #3b2727; color: #ffd7d7; overflow-wrap: anywhere; }
        .empty { color: #aaa; padding: 6px 0; }
      </style>
      <div class="wrap">
        <details open>
          <summary><span>Queue · ${pending}</span><span class="status">${statusLabel(queue.status)}</span></summary>
          <div class="body">
            <div class="controls">${control}</div>
            ${blocked}
            ${localNotice}
            <div class="add"><textarea data-role="new-message" placeholder="Add follow-up message"></textarea><button data-action="add">Add</button></div>
            ${rows ? `<ul>${rows}</ul>` : '<div class="empty">No queued messages.</div>'}
          </div>
        </details>
      </div>`;

    this.bind(queue);
  }

  private bind(queue: ConversationQueue): void {
    const invoke = (action: (() => MaybePromise) | undefined) => {
      if (action) void Promise.resolve(action()).catch(() => undefined);
    };

    this.root.querySelector<HTMLButtonElement>('[data-action="add"]')?.addEventListener('click', () => {
      const input = this.root.querySelector<HTMLTextAreaElement>('[data-role="new-message"]');
      const content = input?.value.trim() ?? '';
      if (content && this.actions.add) invoke(() => this.actions.add!(content));
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

    void queue;
  }
}
