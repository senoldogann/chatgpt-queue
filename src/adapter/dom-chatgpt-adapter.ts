import type { ChatGPTAdapter, SendResult } from './chatgpt-adapter';
import type { PageSnapshot } from '../domain/types';

const SEND_SELECTORS = [
  'button[data-testid="send-button"]',
  'button[aria-label="Send"]',
  'button[aria-label="Gönder"]',
];

const STOP_SELECTORS = [
  'button[data-testid="stop-button"]',
  'button[aria-label="Stop"]',
  'button[aria-label="Durdur"]',
];

const COMPOSER_SELECTORS = [
  '#prompt-textarea',
  '[data-testid="prompt-textarea"]',
];

const first = <T extends Element>(document: Document, selectors: string[]): T | null => {
  for (const selector of selectors) {
    const element = document.querySelector<T>(selector);
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
  const candidates = [...document.querySelectorAll<HTMLElement>('[role="alert"], [data-testid*="error" i], [data-testid="conversation-turn-error"]')];
  const text = candidates.map(normalizedText).join(' ');
  if (!text) return null;
  if (/too many requests|rate limit|rate-limit|çok fazla istek/.test(text)) return 'rate-limit';
  if (/network error|connection error|ağ hatası|bağlantı hatası/.test(text)) return 'network-error';
  if (/session expired|sign in|log in|oturum.*sona er/.test(text)) return 'session-expired';
  if (/something went wrong|try again|yeniden dene|bir şeyler ters gitti/.test(text)) return 'chatgpt-error';
  return 'blocking-error';
};

const hasConfirmation = (document: Document): boolean => {
  const dialogs = [...document.querySelectorAll<HTMLElement>('[role="dialog"], [data-testid*="confirm" i], [data-testid*="approval" i]')];
  return dialogs.some((dialog) => {
    const buttons = [...dialog.querySelectorAll<HTMLButtonElement>('button')];
    return buttons.some((button) => /^(allow|confirm|approve|continue|run|izin ver|onayla|devam et|çalıştır)$/i.test(button.textContent?.trim() ?? ''));
  });
};

export class DOMChatGPTAdapter implements ChatGPTAdapter {
  constructor(private readonly document: Document) {}

  getState(domStable: boolean): PageSnapshot {
    const composer = first<HTMLElement>(this.document, COMPOSER_SELECTORS);
    const send = first<HTMLButtonElement>(this.document, SEND_SELECTORS);
    const stop = first<HTMLButtonElement>(this.document, STOP_SELECTORS);
    const blockingReason = detectBlockingReason(this.document);

    return {
      domRecognized: Boolean(composer && (send || stop)),
      isGenerating: Boolean(stop && !isDisabled(stop)),
      composerReady: composerReady(composer),
      sendReady: Boolean(send && !isDisabled(send)),
      assistantMessageCount: this.document.querySelectorAll('[data-message-author-role="assistant"]').length,
      domStable,
      confirmationVisible: hasConfirmation(this.document),
      blockingReason,
    };
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
    const send = first<HTMLButtonElement>(this.document, SEND_SELECTORS);
    if (!composer || !send || isDisabled(send) || !composerReady(composer)) {
      return { attempted: false, reason: 'composer-or-send-not-ready' };
    }

    if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
      composer.value = content;
    } else {
      composer.textContent = content;
    }
    composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: content }));
    send.click();
    return { attempted: true };
  }
}
