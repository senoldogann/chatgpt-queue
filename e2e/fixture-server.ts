import { createServer, type Server } from 'node:http';

export interface FixtureServer {
  origin: string;
  close(): Promise<void>;
}

const pageHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>ChatGPT Queue E2E Fixture</title>
  <style>
    body { font-family: sans-serif; margin: 24px; }
    #fixture-controls { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 16px; }
    #chat { display: grid; gap: 10px; max-width: 680px; }
    #prompt-textarea { min-height: 80px; }
  </style>
</head>
<body>
  <div id="fixture-controls">
    <button id="fixture-complete" type="button">Complete generation</button>
    <button id="fixture-duplicate" type="button">Duplicate completion mutation</button>
    <button id="fixture-error" type="button">Show network error</button>
    <button id="fixture-confirmation" type="button">Show confirmation</button>
    <button id="fixture-uncertain" type="button">Next send uncertain</button>
  </div>
  <main id="chat">
    <div id="messages"></div>
    <textarea id="prompt-textarea"></textarea>
    <button data-testid="send-button" type="button">Send</button>
  </main>
  <script>
    (() => {
      const conversationId = location.pathname.match(/(?:^|\\/)c\\/([^/]+)/)?.[1] ?? 'temporary';
      const params = new URLSearchParams(location.search);
      const tabName = params.get('tab') ?? 'default';
      const authenticatedMode = params.get('authenticated') === '1';
      const transientGapMode = params.get('transient-gap') === '1';
      const routeOnSend = params.get('route-on-send');
      const routeChainFinal = params.get('route-chain-final');
      const delayedStopMs = Number(params.get('delayed-stop-ms') ?? '0');
      const omitStop = params.get('omit-stop') === '1';
      const autoCompleteMs = Number(params.get('auto-complete-ms') ?? '0');
      const storageKey = 'fixture-sends:' + conversationId;
      const composer = document.getElementById('prompt-textarea');
      let send = document.querySelector('[data-testid="send-button"]');
      const messages = document.getElementById('messages');
      let nextSendUncertain = false;
      let responseCount = 0;

      const readEvents = () => JSON.parse(localStorage.getItem(storageKey) ?? '[]');
      const recordSend = (content) => {
        const events = readEvents();
        events.push({ content, tab: tabName, at: Date.now() });
        localStorage.setItem(storageKey, JSON.stringify(events));
      };

      const removeSendControl = () => {
        send?.remove();
        send = null;
      };

      const beginGeneration = () => {
        if (!delayedStopMs) composer.disabled = true;
        if (authenticatedMode) removeSendControl();
        else if (send) send.disabled = true;

        const response = document.createElement('article');
        response.dataset.messageAuthorRole = 'assistant';
        response.textContent = 'assistant streaming';
        messages.append(response);

        const appendStop = () => {
          const stop = document.createElement('button');
          stop.type = 'button';
          if (authenticatedMode) stop.setAttribute('aria-label', 'Stop generating');
          else stop.dataset.testid = 'stop-button';
          stop.textContent = 'Stop';
          document.getElementById('chat').append(stop);
        };
        if (!omitStop) {
          if (delayedStopMs) window.setTimeout(appendStop, delayedStopMs);
          else appendStop();
        }
      };

      const completeGeneration = () => {
        document.querySelector('[data-testid="stop-button"], button[aria-label="Stop generating"]')?.remove();
        responseCount += 1;
        const existingResponse = messages.querySelector('[data-message-author-role="assistant"]:last-child');
        let completedResponse;
        if (existingResponse) {
          existingResponse.textContent = 'assistant response ' + responseCount;
          completedResponse = existingResponse;
        } else {
          const response = document.createElement('article');
          response.dataset.messageAuthorRole = 'assistant';
          response.textContent = 'assistant response ' + responseCount;
          messages.append(response);
          completedResponse = response;
        }
        const copy = document.createElement('button');
        copy.type = 'button';
        copy.dataset.testid = 'copy-turn-action-button';
        copy.textContent = 'Copy';
        completedResponse.append(copy);

        const restoreComposer = () => {
          composer.disabled = false;
          composer.value = '';
          if (authenticatedMode) removeSendControl();
          else if (send) send.disabled = false;
          if (!composer.isConnected) document.getElementById('chat').append(composer);
        };

        if (transientGapMode) {
          composer.remove();
          window.setTimeout(restoreComposer, 100);
        } else {
          restoreComposer();
        }
      };

      const handleSend = () => {
        const content = composer.value;
        recordSend(content);
        if (nextSendUncertain) {
          nextSendUncertain = false;
          composer.disabled = true;
          if (authenticatedMode) removeSendControl();
          else if (send) send.disabled = true;
          return;
        }
        beginGeneration();
        if (autoCompleteMs > 0) window.setTimeout(completeGeneration, autoCompleteMs);
        if (routeOnSend && location.pathname === '/new') {
          history.pushState({}, '', '/c/' + routeOnSend);
          if (routeChainFinal) {
            window.setTimeout(() => {
              history.pushState({}, '', '/c/' + routeChainFinal);
              document.body.append(document.createElement('span'));
            }, 100);
          }
        }
      };

      const bindSend = (button) => button.addEventListener('click', handleSend);
      const createAuthenticatedSendControl = () => {
        if (send) return send;
        const button = document.createElement('button');
        button.type = 'button';
        button.setAttribute('aria-label', 'Send message');
        button.textContent = 'Send';
        document.getElementById('chat').append(button);
        send = button;
        bindSend(button);
        return button;
      };

      if (send) bindSend(send);
      if (authenticatedMode) {
        removeSendControl();
        composer.setAttribute('aria-label', 'Chat with ChatGPT');
        composer.setAttribute('role', 'textbox');
        composer.addEventListener('input', () => {
          if (!composer.disabled && composer.value) createAuthenticatedSendControl();
          else if (!composer.value) removeSendControl();
        });
      }

      document.getElementById('fixture-complete').addEventListener('click', completeGeneration);

      document.getElementById('fixture-duplicate').addEventListener('click', () => {
        const marker = document.createElement('span');
        marker.textContent = 'duplicate mutation ' + Date.now();
        messages.append(marker);
      });

      document.getElementById('fixture-error').addEventListener('click', () => {
        const alert = document.createElement('div');
        alert.setAttribute('role', 'alert');
        alert.textContent = 'Network error';
        document.body.append(alert);
      });

      document.getElementById('fixture-confirmation').addEventListener('click', () => {
        const dialog = document.createElement('div');
        dialog.setAttribute('role', 'dialog');
        const allow = document.createElement('button');
        allow.type = 'button';
        allow.textContent = 'Allow';
        dialog.append(allow);
        document.body.append(dialog);
      });

      document.getElementById('fixture-uncertain').addEventListener('click', () => {
        nextSendUncertain = true;
      });
    })();
  </script>
</body>
</html>`;

export async function createFixtureServer(): Promise<FixtureServer> {
  const server: Server = createServer((_request, response) => {
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(pageHtml);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture-server-address-unavailable');

  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}
