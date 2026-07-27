---
name: production-hardening
description: Audit and raise one implemented capability block from functional maturity to explicit production quality. Use for an L3 hardening work item, a production-grade audit, or when surface-level behavior is suspected. Do not use for initial scaffolding, an L1 walking skeleton, speculative future blocks, or a clear local bug.
---

# Production Hardening

Define strict criteria before changing code, then attempt to disprove readiness.

## Read Set

Read only the active work item, its block, applicable sections of `docs/quality.md`, implementation, tests, and current evidence. Load `references/risk-gates.md` only for activated risks.

## Workflow

1. State the target maturity and current observed behavior.
2. Write observable success criteria in the owning work item before implementation.
3. Cover normal, boundary, invalid, repeated, concurrent, degraded, and recovery behavior only where the block risk requires it.
4. Inspect security, privacy, data integrity, destructive actions, resources, observability, setup, and compatibility according to the project profile.
5. Identify root causes. Reject broad conditional patches, silent fallbacks, fake defaults, swallowed errors, and tests that merely preserve broken behavior.
6. Implement the smallest coherent fixes.
7. Run focused automated checks and manually inspect runtime, visual, operational, or hardware behavior automation cannot prove.
8. Record concise evidence and remaining approved gaps in the work item. Update block maturity only when its criteria are met.
9. Run `npm run project:check`.

## Stop Conditions

Do not claim L3 when criteria are vague, only the happy path was inspected, required clean-environment behavior is unproven, or a fallback hides invalid state.
