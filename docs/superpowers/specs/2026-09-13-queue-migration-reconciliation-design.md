# Queue Migration Reconciliation Design

## Goal

Make provisional/new-chat queue identity migration idempotent when the destination conversation queue already exists, without ever silently merging two meaningful queues.

## Safety rules

- A queue is a pristine placeholder only when it has no items, status `completed`, runtime phase `idle`, no owner, and no blocked reason.
- If the source is pristine and the target exists, discard only the source placeholder and keep the target unchanged.
- If the target is pristine and the source is meaningful, replace the target placeholder with the migrated source.
- If both source and target are meaningful, fail closed with `Target queue already exists for <key>`.
- If both are pristine, keep the already-established target and remove the source placeholder.
- No item-level merge, deduplication, owner transfer, or timestamp guessing is allowed.
