// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DOMChatGPTAdapter } from '../src/adapter/dom-chatgpt-adapter';

const render = (body: string) => {
  document.body.innerHTML = body;
  return new DOMChatGPTAdapter(document);
};

describe('DOMChatGPTAdapter', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('detects generating state from the stop control', () => {
    const adapter = render(`
      <main>
        <div id="prompt-textarea" contenteditable="true"></div>
        <button data-testid="stop-button">Stop</button>
        <article data-message-author-role="assistant">partial</article>
      </main>`);
    const state = adapter.getState(false);
    expect(state.domRecognized).toBe(true);
    expect(state.isGenerating).toBe(true);
    expect(state.sendControlPresent).toBe(false);
  });

  it('detects the current Turkish generating control', () => {
    const adapter = render(`
      <main>
        <div id="prompt-textarea" contenteditable="true"></div>
        <button aria-label="Oluşturmayı durdur"></button>
      </main>`);

    const state = adapter.getState(false);
    expect(state.domRecognized).toBe(true);
    expect(state.isGenerating).toBe(true);
    expect(state.sendControlPresent).toBe(false);
  });

  it('recognizes the authenticated composer before a send control exists', () => {
    const adapter = render(`
      <main>
        <div id="prompt-textarea" aria-label="Chat with ChatGPT" role="textbox" contenteditable="true"></div>
        <button aria-label="Start dictation"></button>
        <button aria-label="Start Voice"></button>
      </main>`);

    const state = adapter.getState(false);
    expect(state.domRecognized).toBe(true);
    expect(state.composerReady).toBe(true);
    expect(state.sendControlPresent).toBe(false);
    expect(state.isGenerating).toBe(false);
  });

  it('detects a usable send button and enabled composer', () => {
    const adapter = render(`
      <main>
        <div id="prompt-textarea" contenteditable="true"></div>
        <button data-testid="send-button">Send</button>
      </main>`);
    const state = adapter.getState(true);
    expect(state.composerReady).toBe(true);
    expect(state.sendControlPresent).toBe(true);
    expect(state.domStable).toBe(true);
  });

  it('detects disabled composer and send button', () => {
    const adapter = render(`
      <main>
        <div id="prompt-textarea" contenteditable="false" aria-disabled="true"></div>
        <button data-testid="send-button" disabled>Send</button>
      </main>`);
    const state = adapter.getState(false);
    expect(state.composerReady).toBe(false);
    expect(state.sendControlPresent).toBe(true);
  });

  it('detects blocking errors only from error/alert UI', () => {
    const adapter = render(`
      <main>
        <div id="prompt-textarea" contenteditable="true"></div>
        <button data-testid="send-button">Send</button>
        <div role="alert">Too many requests. Try again later.</div>
      </main>`);
    expect(adapter.getState(false).blockingReason).toBe('rate-limit');
  });

  it('detects confirmation UI as fail-closed', () => {
    const adapter = render(`
      <main>
        <div id="prompt-textarea" contenteditable="true"></div>
        <button data-testid="send-button">Send</button>
        <div role="dialog"><button>Allow</button></div>
      </main>`);
    expect(adapter.getState(false).confirmationVisible).toBe(true);
  });

  it('counts assistant responses for completion evidence', () => {
    const adapter = render(`
      <main>
        <div id="prompt-textarea" contenteditable="true"></div>
        <button data-testid="send-button">Send</button>
        <article data-message-author-role="assistant">one</article>
        <article data-message-author-role="assistant">two</article>
      </main>`);
    expect(adapter.getState(true).assistantMessageCount).toBe(2);
  });

  it('detects completion control only on the latest assistant turn', () => {
    const adapter = render(`
      <main>
        <div id="prompt-textarea" contenteditable="true"></div>
        <button data-testid="send-button">Send</button>
        <section data-testid="conversation-turn-old">
          <article data-message-author-role="assistant">old</article>
          <button data-testid="copy-turn-action-button">Copy</button>
        </section>
        <section data-testid="conversation-turn-new">
          <article data-message-author-role="assistant">new</article>
        </section>
      </main>`);

    expect(adapter.getState(true).assistantCompletionControlPresent).toBe(false);

    document.querySelector('[data-testid="conversation-turn-new"]')!.insertAdjacentHTML(
      'beforeend',
      '<button data-testid="copy-turn-action-button">Copy</button>',
    );
    expect(adapter.getState(true).assistantCompletionControlPresent).toBe(true);
  });

  it('writes the composer and clicks send exactly once', async () => {
    const adapter = render(`
      <main>
        <div id="prompt-textarea" contenteditable="true"></div>
        <button data-testid="send-button">Send</button>
      </main>`);
    const button = document.querySelector<HTMLButtonElement>('[data-testid="send-button"]')!;
    const click = vi.spyOn(button, 'click');

    const result = await adapter.sendMessage('hello');

    expect(document.querySelector('#prompt-textarea')?.textContent).toBe('hello');
    expect(click).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ attempted: true });
  });


  it('recognizes the current Turkish send control while it is disabled on an empty composer', () => {
    const adapter = render(`
      <main>
        <div id="prompt-textarea" contenteditable="true"></div>
        <button aria-label="İleti gönder" disabled></button>
      </main>`);

    const state = adapter.getState(false);
    expect(state.domRecognized).toBe(true);
    expect(state.composerReady).toBe(true);
    expect(state.sendControlPresent).toBe(true);
  });

  it('fills the authenticated composer before requiring a send control to exist', async () => {
    const adapter = render(`
      <main>
        <div id="prompt-textarea" aria-label="Chat with ChatGPT" role="textbox" contenteditable="true"></div>
        <button aria-label="Start dictation"></button>
        <button aria-label="Start Voice"></button>
      </main>`);
    const composer = document.querySelector<HTMLElement>('#prompt-textarea')!;
    let button: HTMLButtonElement | undefined;
    composer.addEventListener('input', () => {
      button = document.createElement('button');
      button.setAttribute('aria-label', 'Send message');
      document.querySelector('main')!.append(button);
    }, { once: true });

    const result = await adapter.sendMessage('hello');

    expect(composer.textContent).toBe('hello');
    expect(button).toBeDefined();
    expect(result).toEqual({ attempted: true });
  });

  it('fills the composer before requiring the send control to become enabled', async () => {
    const adapter = render(`
      <main>
        <div id="prompt-textarea" contenteditable="true"></div>
        <button aria-label="İleti gönder" disabled></button>
      </main>`);
    const composer = document.querySelector<HTMLElement>('#prompt-textarea')!;
    const button = document.querySelector<HTMLButtonElement>('button[aria-label="İleti gönder"]')!;
    composer.addEventListener('input', () => button.removeAttribute('disabled'), { once: true });
    const click = vi.spyOn(button, 'click');

    const result = await adapter.sendMessage('hello');

    expect(composer.textContent).toBe('hello');
    expect(click).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ attempted: true });
  });

  it('reports bounded DOM diagnostics without reading message text', () => {
    const adapter = render(`
      <main>
        <div id="prompt-textarea" contenteditable="true">private draft text</div>
        <button data-testid="composer-submit-button" aria-label="Submit prompt">ignored label text</button>
      </main>`);

    const diagnostics = adapter.getDiagnosticSummary();

    expect(diagnostics).toContain('composer=DIV#prompt-textarea');
    expect(diagnostics).toContain('contenteditable=true');
    expect(diagnostics).toContain('send-testid=false');
    expect(diagnostics).toContain('BUTTON[data-testid=composer-submit-button][aria-label=Submit prompt]');
    expect(diagnostics).not.toContain('private draft text');
    expect(diagnostics).not.toContain('ignored label text');
  });
});
