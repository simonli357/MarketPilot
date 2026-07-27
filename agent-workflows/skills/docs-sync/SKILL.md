---
name: docs-sync
description: Audit and repair real drift between implementation and canonical project documentation. Use when the human asks to sync docs, a command or setup path changed, a contract or decision changed, release truth changed, or code and docs demonstrably disagree. Do not use for routine task completion, validation reruns, successful pushes, or evidence that belongs only in a work item.
---

# Docs Sync

Repair the smallest canonical owner set; do not narrate the same change across the repository.

## Workflow

1. Identify the changed fact and its owner from `docs/README.md`.
2. Compare the owner with implementation, executable commands, runtime behavior, and canonical work-item or release state.
3. Update only owners whose facts changed.
4. Put detailed evidence in the owning work item or release evidence manifest.
5. Regenerate `docs/status.md` only when handoff truth changed.
6. Run `npm run project:check`.

## Reject

- Planning updates for implementation mistakes.
- Delivery-guide updates when setup or shipped behavior did not change.
- Status history, successful push records, copied test output, or duplicate task state.
- Aspirational commands presented as verified behavior.

If ownership is ambiguous, fix the ownership map before copying the fact into multiple files.
