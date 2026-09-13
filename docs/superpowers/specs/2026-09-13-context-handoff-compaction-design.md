# Context Capacity, Pressure, and Handoff Compaction Design

## Goal

Make a ChatGPT Web conversation that is close to its context limit recoverable, and make the adapter's
ability to drive the live page observable, without adding any new permission, network call, or OpenAI
API usage.

## Why the capacity is resolved, not assumed

The extension cannot read server-side token accounting, and model windows change without any signal in
the page. A hardcoded limit would silently become wrong. So `src/context/capacity.ts` resolves a
`ContextCapacity` at runtime and every consumer takes that resolved value:

1. `runtime-declared` — a capacity the host page declares about itself via `data-context-window-tokens`.
2. `user-configured` — the **Capacity override (tokens)** field in the panel.
3. `capability-default` — a deliberately conservative fallback constant.

Only the third source is a constant, it is the last resort, and the panel always prints which source
won. Nothing in the pressure maths compares against a fixed model limit: `watch`, `compact`, and
`critical` are fractions of the resolved capacity, so a larger window moves the thresholds
automatically.

## Pressure estimate

`measureContextPressure` sums the visible conversation text plus a small per-turn overhead and divides
by the resolved capacity. It is labeled an estimate everywhere it is shown, because characters are not
tokens. The sample is bounded (40 turns) and refreshed on a budget (1.5 s) rather than per render,
because assistant text must be cloned out of the DOM to strip controls.

## Adapter interface health

`inspectInterface` produces a read-only report and never touches the composer or send control. Health
is a three-state signal:

- `unrecognized` — neither a composer nor a stop control is present; this build can no longer drive the page.
- `ok` — a composer is present together with a send control, a stop control, or an empty composer.
- `degraded` — a composer holding text, with no send control and no generation running.

The empty-composer case matters: real ChatGPT only renders the send control once there is something to
send, so demanding a send control on an idle conversation produces a false alarm. `degraded` therefore
means the shape this build was written against has changed without the composer disappearing entirely.

## Handoff protocol

1. `prepareHandoff` enqueues one deterministic prompt, moves it to the front of the queue, and starts it.
   It refuses while the queue is actively sending, while the adapter is not `ok`, or when a brief is
   already ready.
2. A completed item whose content is exactly the handoff prompt is read back with
   `getLatestCompletedAssistantArtifact` and validated by `parseHandoffBrief`.
3. On success the brief is stored as the single pending handoff and the source queue is **paused**, so
   the follow-ups still queued are not spent on a conversation at its limit.
4. `handoffOpen` asks the background script to open a new chat. The background only opens a
   same-origin `http(s)` URL and records the created tab id in `chrome.storage.session` with a
   10-minute expiry.
5. Only that tab may claim the import. It seeds its queue with the brief plus the carried follow-ups
   and consumes the record.

## Fail-closed rules

- The brief format uses plain uppercase labels (`STATE:`, `DECISIONS:`, `OPEN QUESTIONS:`,
  `NEXT STEPS:`, `CONSTRAINTS:`) instead of Markdown headings, because assistant text read back from
  the page is whitespace-collapsed and already rendered — `## State` arrives as a bare word.
- Missing, reordered, empty, or truncated sections reject the brief and change nothing. The queue keeps
  running exactly as before.
- One handoff is pending at a time; capturing a second replaces the first rather than growing state.
- Processing is keyed by the completed queue item, so a reload cannot re-arm an already-imported handoff.
- An import is claimed once and only by the tab the extension opened.
