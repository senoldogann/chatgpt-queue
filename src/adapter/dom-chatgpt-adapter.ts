import type {
  AdapterInterfaceReport,
  AdapterSelectorProbe,
  AssistantArtifact,
  ChatGPTAdapter,
  ConversationTurnSample,
  SendResult,
} from './chatgpt-adapter';
import type { PageSnapshot } from '../domain/types';

const SEND_SELECTORS = [
  'button[data-testid="send-button"]',
  'button[aria-label="Send"]',
  'button[aria-label="Send message"]',
  'button[aria-label="Gönder"]',
  'button[aria-label="İleti gönder"]',
];

const STOP_SELECTORS = [
  'button[data-testid="stop-button"]',
  'button[aria-label="Stop"]',
  'button[aria-label="Stop generating"]',
  'button[aria-label="Durdur"]',
  'button[aria-label="Oluşturmayı durdur"]',
];

const COMPOSER_SELECTORS = [
  '#prompt-textarea',
  '[data-testid="prompt-textarea"]',
];

const TRANSCRIPT_SELECTORS = [
  'main',
  '[role="main"]',
  '#thread',
];

const USER_ROLE_SELECTORS = [
  '[data-message-author-role="user"]',
  '[data-role="user"]',
  '[data-message-author="user"]',
];

const ASSISTANT_ROLE_SELECTORS = [
  '[data-message-author-role="assistant"]',
  '[data-role="assistant"]',
  '[data-message-author="assistant"]',
];
const ASSISTANT_CANDIDATE_SELECTOR = [
  '[data-turn="assistant"]',
  '.agent-turn',
  ...ASSISTANT_ROLE_SELECTORS,
].join(', ');
const ASSISTANT_COMPLETION_SELECTORS = [
  'button[data-testid="copy-turn-action-button"]',
  'button[aria-label*="Copy response" i]',
  'button[aria-label*="Yanıtı kopyala" i]',
  'button[aria-label*="Yaniti kopyala" i]',
];

const USER_ROLE_SELECTOR = USER_ROLE_SELECTORS.join(', ');
const CONVERSATION_MESSAGE_SELECTOR = [...USER_ROLE_SELECTORS, ...ASSISTANT_CANDIDATE_SELECTOR.split(', ')].join(', ');
/** High enough for normal long chats while still bounding clone/clean work on pathological pages. */
const DEFAULT_CONVERSATION_TURN_LIMIT = 400;

const SEND_CONTROL_WAIT_MS = 1_500;

const first = <T extends Element>(document: Document, selectors: string[]): T | null => {
  for (const selector of selectors) {
    const element = document.querySelector<T>(selector);
    if (element) return element;
  }
  return null;
};

interface SelectorMatch {
  element: Element | null;
  selector: string | null;
}

const probe = (document: Document, selectors: string[]): SelectorMatch => {
  for (const selector of selectors) {
    const element = document.querySelector(selector);
    if (element) return { element, selector };
  }
  return { element: null, selector: null };
};

const selectorProbe = (match: SelectorMatch): AdapterSelectorProbe => ({
  status: match.element ? 'ok' : 'missing',
  matchedSelector: match.selector,
});

const firstWithin = <T extends Element>(root: Element, selectors: string[]): T | null => {
  for (const selector of selectors) {
    const element = root.querySelector<T>(selector);
    if (element) return element;
  }
  return null;
};

const isDisabled = (element: Element | null): boolean => {
  if (!element) return true;
  return element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true';
};

const composerReady = (element: Element | null): boolean => {
  if (!element || isDisabled(element)) return false;
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) return !element.disabled;
  return element.getAttribute('contenteditable') !== 'false';
};

const composerHasText = (element: Element | null): boolean => {
  if (!element) return false;
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) return element.value.trim().length > 0;
  return (element.textContent ?? '').trim().length > 0;
};

const waitForEnabledSend = (document: Document): Promise<HTMLButtonElement | null> => {
  const current = first<HTMLButtonElement>(document, SEND_SELECTORS);
  if (current && !isDisabled(current)) return Promise.resolve(current);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: HTMLButtonElement | null) => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      window.clearTimeout(timer);
      resolve(value);
    };
    const check = () => {
      const send = first<HTMLButtonElement>(document, SEND_SELECTORS);
      if (send && !isDisabled(send)) finish(send);
    };
    const observer = new MutationObserver(check);
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['disabled', 'aria-disabled', 'aria-label', 'data-testid'],
    });
    const timer = window.setTimeout(() => finish(null), SEND_CONTROL_WAIT_MS);
    queueMicrotask(check);
  });
};

const normalizedText = (element: Element | null): string => element?.textContent?.trim().toLowerCase() ?? '';

const describeDiagnosticElement = (element: Element | null): string => {
  if (!element) return 'missing';
  const id = element.id ? `#${element.id}` : '';
  const attributes = [
    ['data-testid', element.getAttribute('data-testid')],
    ['aria-label', element.getAttribute('aria-label')],
    ['role', element.getAttribute('role')],
    ['contenteditable', element.getAttribute('contenteditable')],
    ['aria-disabled', element.getAttribute('aria-disabled')],
    ['disabled', element.hasAttribute('disabled') ? 'true' : null],
  ].filter((entry): entry is [string, string] => entry[1] !== null);
  return `${element.tagName}${id}${attributes.map(([name, value]) => `[${name}=${value}]`).join('')}`;
};

const relevantDiagnosticButtons = (document: Document): Element[] =>
  [...document.querySelectorAll('button')].filter((button) => {
    const metadata = [
      button.getAttribute('data-testid'),
      button.getAttribute('aria-label'),
      button.getAttribute('title'),
    ].filter(Boolean).join(' ');
    return /send|submit|prompt|stop|voice|dictat|microphone|mic|gönder|durdur/i.test(metadata);
  }).slice(0, 8);

const detectBlockingReason = (document: Document): string | null => {
  const alerts = [...document.querySelectorAll<HTMLElement>('[role="alert"]')];
  const dedicatedErrors = [...document.querySelectorAll<HTMLElement>('[data-testid*="error" i], [data-testid="conversation-turn-error"]')];
  const text = [...alerts, ...dedicatedErrors].map(normalizedText).filter(Boolean).join(' ');
  if (!text) return null;
  if (/message delivery timed out|ileti.*zaman aşım|mesaj.*zaman aşım/.test(text)) return 'message-delivery-timeout';
  if (/too many requests|rate limit|rate-limit|çok fazla istek/.test(text)) return 'rate-limit';
  if (/network error|connection error|ağ hatası|bağlantı hatası/.test(text)) return 'network-error';
  if (/session expired|sign in|log in|oturum.*sona er/.test(text)) return 'session-expired';
  if (/something went wrong|try again|yeniden dene|bir şeyler ters gitti/.test(text)) return 'chatgpt-error';
  return dedicatedErrors.some((element) => Boolean(normalizedText(element))) ? 'blocking-error' : null;
};

const hasConfirmation = (document: Document): boolean => {
  const dialogs = [...document.querySelectorAll<HTMLElement>('[role="dialog"], [data-testid*="confirm" i], [data-testid*="approval" i]')];
  return dialogs.some((dialog) => {
    const buttons = [...dialog.querySelectorAll<HTMLButtonElement>('button')];
    return buttons.some((button) => /^(allow|confirm|approve|continue|run|izin ver|onayla|devam et|çalıştır)$/i.test(button.textContent?.trim() ?? ''));
  });
};

const assistantTurnRoot = (message: HTMLElement): HTMLElement =>
  message.closest<HTMLElement>('[data-turn="assistant"]')
  ?? message.closest<HTMLElement>('[data-testid^="conversation-turn-"]')
  ?? message.closest<HTMLElement>('[data-turn-id]')
  ?? message.closest<HTMLElement>('.agent-turn')
  ?? message;

interface AssistantEntry {
  turn: HTMLElement;
  message: HTMLElement;
}

const assistantEntries = (document: Document): AssistantEntry[] => {
  const candidates = [...document.querySelectorAll<HTMLElement>(ASSISTANT_CANDIDATE_SELECTOR)];
  const entries: AssistantEntry[] = [];
  const seenTurns = new Set<HTMLElement>();
  const roleSelector = ASSISTANT_ROLE_SELECTORS.join(', ');

  for (const candidate of candidates) {
    const turn = assistantTurnRoot(candidate);
    if (seenTurns.has(turn)) continue;
    const message = candidate.matches(roleSelector)
      ? candidate
      : firstWithin<HTMLElement>(turn, ASSISTANT_ROLE_SELECTORS) ?? candidate;
    seenTurns.add(turn);
    entries.push({ turn, message });
  }
  return entries;
};

const assistantState = (document: Document): { count: number; completionControlPresent: boolean; latestTurnKey?: string } => {
  const entries = assistantEntries(document);
  const latest = entries.at(-1);
  if (!latest) return { count: 0, completionControlPresent: false };
  const completionControl = firstWithin<HTMLButtonElement>(latest.turn, ASSISTANT_COMPLETION_SELECTORS);
  return {
    count: entries.length,
    completionControlPresent: Boolean(completionControl && !isDisabled(completionControl)),
    latestTurnKey: assistantObservationKey(latest.turn, latest.message, entries.length),
  };
};

const assistantStableTurnKey = (turn: HTMLElement, message: HTMLElement): string | undefined =>
  [
    turn.getAttribute('data-turn-id'),
    message.getAttribute('data-message-id'),
    turn.getAttribute('data-testid'),
    turn.id,
  ].find((value): value is string => Boolean(value?.trim()));

const assistantTurnKey = (turn: HTMLElement, message: HTMLElement, index: number): string =>
  assistantStableTurnKey(turn, message) ?? `assistant:${index}`;

const assistantObservationKey = (turn: HTMLElement, message: HTMLElement, index: number): string =>
  assistantStableTurnKey(turn, message) ?? `assistant:${index}:${assistantTextFingerprint(message)}`;

const cleanText = (element: HTMLElement): string => {
  const clone = element.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('button, script, style, [aria-hidden="true"], [data-testid*="copy" i]').forEach((node) => node.remove());
  return (clone.textContent ?? '').replace(/\s+/g, ' ').trim();
};

const assistantText = (message: HTMLElement): string => cleanText(message);

const assistantTextFingerprint = (message: HTMLElement): string => {
  const text = assistantText(message);
  const bounded = `${text.length}:${text.slice(0, 256)}:${text.slice(-256)}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < bounded.length; index += 1) {
    hash = Math.imul(hash ^ bounded.charCodeAt(index), 0x01000193);
  }
  return (hash >>> 0).toString(36);
};

export class DOMChatGPTAdapter implements ChatGPTAdapter {
  constructor(private readonly document: Document) {}

  getState(domStable: boolean): PageSnapshot {
    const composer = first<HTMLElement>(this.document, COMPOSER_SELECTORS);
    const send = first<HTMLButtonElement>(this.document, SEND_SELECTORS);
    const stop = first<HTMLButtonElement>(this.document, STOP_SELECTORS);
    const blockingReason = detectBlockingReason(this.document);
    const assistant = assistantState(this.document);

    return {
      domRecognized: Boolean(composer || stop),
      isGenerating: Boolean(stop && !isDisabled(stop)),
      composerReady: composerReady(composer),
      sendControlPresent: Boolean(send),
      assistantMessageCount: assistant.count,
      ...(assistant.latestTurnKey === undefined ? {} : { latestAssistantTurnKey: assistant.latestTurnKey }),
      assistantCompletionControlPresent: assistant.completionControlPresent,
      domStable,
      confirmationVisible: hasConfirmation(this.document),
      blockingReason,
    };
  }

  getLatestCompletedAssistantArtifact(): AssistantArtifact | null {
    const entries = assistantEntries(this.document);
    const latest = entries.at(-1);
    if (!latest) return null;
    const completionControl = firstWithin<HTMLButtonElement>(latest.turn, ASSISTANT_COMPLETION_SELECTORS);
    if (!completionControl || isDisabled(completionControl)) return null;
    const text = assistantText(latest.message);
    if (!text) return null;
    return {
      turnKey: assistantTurnKey(latest.turn, latest.message, entries.length),
      text,
    };
  }

  inspectInterface(): AdapterInterfaceReport {
    const composer = probe(this.document, COMPOSER_SELECTORS);
    const send = probe(this.document, SEND_SELECTORS);
    const stop = probe(this.document, STOP_SELECTORS);
    const transcript = probe(this.document, TRANSCRIPT_SELECTORS);
    const assistantTurn = probe(this.document, ASSISTANT_ROLE_SELECTORS);
    const isGeneratingControl = Boolean(stop.element && !isDisabled(stop.element));
    const recognized = Boolean(composer.element || stop.element);

    // Send controls are legitimately absent in two normal states: while ChatGPT is generating (the
    // composer swaps send for stop) and while the composer is empty (real ChatGPT only renders the
    // send control once there is something to send). So `degraded` means the page shows a composer
    // holding text with no way to send it and no generation running — the shape this build was
    // written against is gone, without the composer having vanished entirely.
    const health = !recognized
      ? 'unrecognized'
      : composer.element && (send.element || stop.element || !composerHasText(composer.element))
        ? 'ok'
        : 'degraded';

    return {
      health,
      recognized,
      composer: selectorProbe(composer),
      sendControl: selectorProbe(send),
      stopControl: selectorProbe(stop),
      transcript: selectorProbe(transcript),
      assistantTurn: selectorProbe(assistantTurn),
      isGenerating: isGeneratingControl,
      composerReady: composerReady(composer.element),
      sendControlPresent: Boolean(send.element),
      blockingReason: detectBlockingReason(this.document),
      confirmationVisible: hasConfirmation(this.document),
    };
  }

  getConversationTurns(limit: number = DEFAULT_CONVERSATION_TURN_LIMIT): ConversationTurnSample[] {
    const bounded = Math.max(0, limit);
    if (bounded === 0) return [];
    // Bound the scan before cloning: a long conversation can hold hundreds of nodes and this
    // runs on every panel refresh.
    const nodes = [...this.document.querySelectorAll<HTMLElement>(CONVERSATION_MESSAGE_SELECTOR)].slice(-(bounded * 3));
    const seenTurns = new Set<HTMLElement>();
    const turns: ConversationTurnSample[] = [];

    for (const node of nodes) {
      const root = assistantTurnRoot(node);
      if (seenTurns.has(root)) continue;
      seenTurns.add(root);
      const text = cleanText(node);
      if (!text) continue;
      turns.push({ role: node.matches(USER_ROLE_SELECTOR) ? 'user' : 'assistant', text });
    }

    return turns.slice(-bounded);
  }

  getDiagnosticSummary(): string {
    const composer = first<HTMLElement>(this.document, COMPOSER_SELECTORS);
    const buttons = relevantDiagnosticButtons(this.document).map(describeDiagnosticElement);
    return [
      `composer=${describeDiagnosticElement(composer)}`,
      `prompt-testid=${Boolean(this.document.querySelector('[data-testid="prompt-textarea"]'))}`,
      `send-testid=${Boolean(this.document.querySelector('button[data-testid="send-button"]'))}`,
      `send-aria-en=${Boolean(this.document.querySelector('button[aria-label="Send"]'))}`,
      `send-aria-tr=${Boolean(this.document.querySelector('button[aria-label="Gönder"]'))}`,
      `stop-testid=${Boolean(this.document.querySelector('button[data-testid="stop-button"]'))}`,
      `stop-aria-en=${Boolean(this.document.querySelector('button[aria-label="Stop"]'))}`,
      `stop-aria-tr=${Boolean(this.document.querySelector('button[aria-label="Durdur"]'))}`,
      `buttons=${buttons.length ? buttons.join(', ') : 'none'}`,
    ].join(' | ');
  }

  async sendMessage(content: string): Promise<SendResult> {
    const composer = first<HTMLElement>(this.document, COMPOSER_SELECTORS);
    if (!composer || !composerReady(composer)) {
      return { attempted: false, reason: 'composer-not-ready' };
    }

    if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
      composer.value = content;
    } else {
      composer.textContent = content;
    }
    composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: content }));

    const send = await waitForEnabledSend(this.document);
    if (!send) {
      return { attempted: false, reason: 'send-not-enabled-after-input' };
    }

    send.click();
    return { attempted: true };
  }
}
