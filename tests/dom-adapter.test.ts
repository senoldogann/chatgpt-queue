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

  it('ignores unknown accessibility alerts that are not recognized ChatGPT errors', () => {
    const adapter = render(`
      <main>
        <div id="prompt-textarea" contenteditable="true"></div>
        <button data-testid="send-button">Send</button>
        <div role="alert">Tool status updated successfully.</div>
      </main>`);

    expect(adapter.getState(false).blockingReason).toBeNull();
  });

  it('keeps dedicated ChatGPT error containers fail-closed when the error text is unknown', () => {
    const adapter = render(`
      <main>
        <div id="prompt-textarea" contenteditable="true"></div>
        <div data-testid="conversation-turn-error">Unexpected provider failure.</div>
      </main>`);

    expect(adapter.getState(false).blockingReason).toBe('blocking-error');
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

  it('recognizes agent-mode assistant turns even when no message-author-role node exists', () => {
    const adapter = render(`
      <main>
        <div id="prompt-textarea" contenteditable="true"></div>
        <section data-turn="assistant" data-turn-id="agent-turn-1">
          <div class="agent-output">Agent finished the task.</div>
          <button data-testid="copy-turn-action-button">Copy response</button>
        </section>
      </main>`);

    const state = adapter.getState(true);
    expect(state.assistantMessageCount).toBe(1);
    expect(state.latestAssistantTurnKey).toBe('agent-turn-1');
    expect(state.assistantCompletionControlPresent).toBe(true);
    expect(adapter.getLatestCompletedAssistantArtifact()).toEqual({
      turnKey: 'agent-turn-1',
      text: 'Agent finished the task.',
    });
  });

  it('recognizes standalone agent-turn fallback markup', () => {
    const adapter = render(`
      <main>
        <div id="prompt-textarea" contenteditable="true"></div>
        <div class="agent-turn" id="agent-fallback">
          <div>Fallback agent response.</div>
          <button data-testid="copy-turn-action-button">Copy response</button>
        </div>
      </main>`);

    const state = adapter.getState(true);
    expect(state.assistantMessageCount).toBe(1);
    expect(state.latestAssistantTurnKey).toBe('agent-fallback');
    expect(state.assistantCompletionControlPresent).toBe(true);
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

  it('returns the latest completed assistant artifact with a stable turn key and clean text', () => {
    const adapter = render(`
      <main>
        <div id="prompt-textarea" contenteditable="true"></div>
        <article data-testid="conversation-turn-2" data-turn="assistant" data-turn-id="turn-2">
          <div data-message-author-role="assistant" data-message-id="message-2">Architecture result<button>Nested action</button></div>
          <button data-testid="copy-turn-action-button">Copy response</button>
        </article>
      </main>`);

    expect(adapter.getLatestCompletedAssistantArtifact()).toEqual({
      turnKey: 'turn-2',
      text: 'Architecture result',
    });
  });

  it('uses a non-empty positional turn key when ChatGPT exposes no turn identifiers', () => {
    const adapter = render(`
      <main>
        <div id="prompt-textarea" contenteditable="true"></div>
        <article data-message-author-role="assistant">first<button data-testid="copy-turn-action-button">Copy</button></article>
      </main>`);

    expect(adapter.getLatestCompletedAssistantArtifact()?.turnKey).toBe('assistant:1');

    document.querySelector('main')!.insertAdjacentHTML('beforeend', `
      <article data-message-author-role="assistant">second<button data-testid="copy-turn-action-button">Copy</button></article>`);
    expect(adapter.getLatestCompletedAssistantArtifact()?.turnKey).toBe('assistant:2');
  });

  it('does not reuse an older completed assistant turn while the latest turn is incomplete', () => {
    const adapter = render(`
      <main>
        <div id="prompt-textarea" contenteditable="true"></div>
        <article data-testid="conversation-turn-2" data-turn="assistant" data-turn-id="turn-old">
          <div data-message-author-role="assistant">old answer</div>
          <button data-testid="copy-turn-action-button">Copy response</button>
        </article>
        <article data-testid="conversation-turn-4" data-turn="assistant" data-turn-id="turn-new">
          <div data-message-author-role="assistant">streaming answer</div>
        </article>
      </main>`);

    expect(adapter.getLatestCompletedAssistantArtifact()).toBeNull();
  });

  it('classifies ChatGPT message delivery timeout explicitly', () => {
    const adapter = render(`
      <main>
        <div id="prompt-textarea" contenteditable="true"></div>
        <div role="alert">Message delivery timed out. Please try again.</div>
      </main>`);

    expect(adapter.getState(true).blockingReason).toBe('message-delivery-timeout');
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
  it('reports an ok interface while the composer and a send control are both recognized', () => {
    const adapter = render(`
      <main>
        <div id="prompt-textarea" contenteditable="true"></div>
        <button data-testid="send-button">Send</button>
      </main>`);

    const report = adapter.inspectInterface();

    expect(report.health).toBe('ok');
    expect(report.recognized).toBe(true);
    expect(report.composer).toEqual({ status: 'ok', matchedSelector: '#prompt-textarea' });
    expect(report.sendControl).toEqual({ status: 'ok', matchedSelector: 'button[data-testid="send-button"]' });
    expect(report.stopControl).toEqual({ status: 'missing', matchedSelector: null });
    expect(report.transcript.status).toBe('ok');
    expect(report.sendControlPresent).toBe(true);
    expect(report.isGenerating).toBe(false);
  });

  it('stays ok while generating, when the send control is legitimately replaced by stop', () => {
    const adapter = render(`
      <main>
        <div id="prompt-textarea" contenteditable="true"></div>
        <button aria-label="Stop generating">Stop</button>
      </main>`);

    const report = adapter.inspectInterface();

    expect(report.health).toBe('ok');
    expect(report.isGenerating).toBe(true);
    expect(report.sendControlPresent).toBe(false);
    expect(report.stopControl.matchedSelector).toBe('button[aria-label="Stop generating"]');
  });

  it('treats an idle empty composer as healthy, matching how ChatGPT renders', () => {
    const report = render(`
      <main>
        <div id="prompt-textarea" contenteditable="true"></div>
        <button aria-label="Start dictation"></button>
      </main>`).inspectInterface();

    expect(report.health).toBe('ok');
    expect(report.recognized).toBe(true);
    expect(report.sendControl.status).toBe('missing');
  });

  it('distinguishes a degraded interface from an unrecognized one', () => {
    const degraded = render(`
      <main>
        <div id="prompt-textarea" contenteditable="true">unsendable draft</div>
        <button aria-label="New chat">New chat</button>
      </main>`).inspectInterface();
    expect(degraded.health).toBe('degraded');
    expect(degraded.recognized).toBe(true);
    expect(degraded.sendControl.status).toBe('missing');

    const unrecognized = render('<main><p>Some unrelated page.</p></main>').inspectInterface();
    expect(unrecognized.health).toBe('unrecognized');
    expect(unrecognized.recognized).toBe(false);
    expect(unrecognized.composer.status).toBe('missing');
  });

  it('samples visible conversation turns in order without reading the composer draft', () => {
    const adapter = render(`
      <main>
        <div id="prompt-textarea" contenteditable="true">draft that must not be counted</div>
        <article data-message-author-role="user">first question</article>
        <article data-testid="conversation-turn-2" data-turn="assistant" data-turn-id="turn-2">
          <div data-message-author-role="assistant">first answer<button data-testid="copy-turn-action-button">Copy</button></div>
        </article>
        <article data-message-author-role="user">second question</article>
        <article data-testid="conversation-turn-4" data-turn="assistant" data-turn-id="turn-4">
          <div data-message-author-role="assistant">second answer</div>
        </article>
      </main>`);

    expect(adapter.getConversationTurns()).toEqual([
      { role: 'user', text: 'first question' },
      { role: 'assistant', text: 'first answer' },
      { role: 'user', text: 'second question' },
      { role: 'assistant', text: 'second answer' },
    ]);
    expect(adapter.getConversationTurns(2)).toEqual([
      { role: 'user', text: 'second question' },
      { role: 'assistant', text: 'second answer' },
    ]);
    expect(adapter.getConversationTurns(0)).toEqual([]);
  });

  it('does not silently cut a long visible conversation down to 40 turns', () => {
    const transcript = Array.from({ length: 60 }, (_, index) =>
      `<article data-message-author-role="${index % 2 === 0 ? 'user' : 'assistant'}">turn ${index + 1}</article>`,
    ).join('');
    const adapter = render(`<main>${transcript}</main>`);

    expect(adapter.getConversationTurns()).toHaveLength(60);
    expect(adapter.getConversationTurns().at(0)?.text).toBe('turn 1');
    expect(adapter.getConversationTurns().at(-1)?.text).toBe('turn 60');
  });

  it('changes fallback assistant turn identity when virtualization replaces a turn without changing count', () => {
    const adapter = render(`
      <main>
        <div id="prompt-textarea" contenteditable="true"></div>
        <article data-message-author-role="assistant">old virtualized answer</article>
      </main>`);

    const before = adapter.getState(true);
    expect(before.assistantMessageCount).toBe(1);
    expect(before.latestAssistantTurnKey).toBeTruthy();

    document.querySelector('[data-message-author-role="assistant"]')!.remove();
    document.querySelector('main')!.insertAdjacentHTML('beforeend',
      '<article data-message-author-role="assistant">new answer after virtualization</article>');

    const after = adapter.getState(true);
    expect(after.assistantMessageCount).toBe(1);
    expect(after.latestAssistantTurnKey).toBeTruthy();
    expect(after.latestAssistantTurnKey).not.toBe(before.latestAssistantTurnKey);
  });

});
