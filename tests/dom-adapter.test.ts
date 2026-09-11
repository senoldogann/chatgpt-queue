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
    expect(state.sendReady).toBe(false);
  });

  it('detects a usable send button and enabled composer', () => {
    const adapter = render(`
      <main>
        <div id="prompt-textarea" contenteditable="true"></div>
        <button data-testid="send-button">Send</button>
      </main>`);
    const state = adapter.getState(true);
    expect(state.composerReady).toBe(true);
    expect(state.sendReady).toBe(true);
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
    expect(state.sendReady).toBe(false);
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
});
