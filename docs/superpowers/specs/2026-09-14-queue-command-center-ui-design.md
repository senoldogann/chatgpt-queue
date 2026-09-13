# Queue Command Center UI Design

## Goal

Turn the ChatGPT Queue panel into a compact command center that keeps queue work primary, makes secondary systems discoverable without a long scroll, and improves dense follow-up management.

## Approved UX

### Persistent header

The header remains visible and shows:

- ChatGPT Queue title.
- Current queue status.
- Pending item count.
- Real-time total active duration.
- Help, locale, and panel hide controls.

Total active duration is the sum of completed item active intervals (`startedAt` to `completedAt`) plus the live interval of any currently active item. The display updates once per second without re-rendering the whole panel so textarea focus, unsaved drafts, and selection remain stable.

### Tabs

The body is split into three top-level tabs:

1. Queue / Sıra — composer, queue controls, queued/running/completed items.
2. Workflow / İş Akışı — built-in/custom workflow selection, workflow inputs, progress, and errors.
3. System / Sistem — context estimate, handoff, adapter diagnostics, capacity override, and bridge controls.

The active tab is panel-local UI state and must not alter queue/domain/runtime behavior.

### Queue collapse behavior

The queue toolbar exposes one aggregate collapse control:

- If any queued follow-up is expanded, clicking it collapses every queued follow-up.
- If every queued follow-up is collapsed, clicking it expands every queued follow-up.

Each queued item still supports individual expansion/collapse. Collapsed rows display a concise preview and queue position. The collapsed-row actions place Expand and Delete together. Delete remains available without expanding the row.

Unsaved textarea drafts must survive collapse/expand and normal panel re-renders for the same conversation. The preview should reflect the current unsaved draft when a row is collapsed.

### Visual hierarchy

Keep the existing dark ChatGPT-compatible surface, but improve hierarchy:

- Reduce unnecessary borders.
- Use consistent spacing and radii through local CSS variables/tokens.
- Make the active tab visually distinct.
- Treat status and counts as compact chips rather than large controls.
- Use icon-sized buttons for secondary actions, with text/aria labels available for accessibility.
- Make running/sending items visually distinct from passive queued items.
- Preserve `prefers-reduced-motion` behavior.
- Preserve narrow/mobile layout support.

### Localization and accessibility

All newly user-visible text must exist in English and Turkish, including:

- Queue / Workflow / System tabs.
- Active time label.
- Collapse all / Expand all behavior.
- Expand and Delete labels/tooltips/aria labels.
- Queue position wording where visible.

Technical workflow IDs remain untranslated.

Controls must remain keyboard-operable and use semantic buttons/tabs with `aria-selected`, `aria-controls`, `role="tablist"`, `role="tab"`, and `role="tabpanel"` where appropriate.

## Data and behavior constraints

No new backend persistence or queue schema is required for active duration: `QueueItem.startedAt` and `QueueItem.completedAt` already contain the necessary timestamps.

Collapse state and active-tab state are presentation-only state owned by `QueuePanel`. They must not mutate stored queue items or runtime phases.

The real-time clock must update only the timer node on its interval. A one-second timer must be cleared/replaced safely when the conversation/view changes so multiple intervals do not accumulate.

Deletion from a collapsed row uses the existing `actions.remove(itemId)` path and therefore preserves existing fail-closed/domain semantics.

## Testing

Unit/UI tests must cover:

- Aggregate Collapse collapses all queued follow-ups in one click and toggles to Expand when all are collapsed.
- Individual Expand remains available on collapsed items.
- Delete is available next to Expand on collapsed items and invokes the existing remove action.
- Unsaved drafts survive aggregate collapse/expand and re-render.
- Tab switching hides/shows the correct panels without mutating queue state or losing drafts.
- EN/TR tab, timer, collapse/expand, and delete accessibility text.
- Active duration formatting and deterministic duration calculation.
- Live timer node changes without a full panel re-render.

Browser-level coverage must exercise the primary Queue tab flow, aggregate collapse, collapsed-row deletion affordance, and tab switching.