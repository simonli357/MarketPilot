---
name: project-planning
description: Turn a rough idea or an approved capability block into a rolling-wave plan and evidence-backed execution goal. Use for initial planning, a new release or block, an architecture-changing discovery, or replanning after runtime review. Do not use for routine implementation or a local bug with clear expected behavior.
---

# Project Planning

Create enough durable direction to start the next evidence-producing slice without pretending the whole release is already understood.

## Workflow

1. Read the current prompt, `PROJECT.md`, `docs/idea.md`, and any intake file the human explicitly names. Never read `human.md`.
2. Summarize the idea plainly. Ask one to three high-impact questions at a time with a recommended option first. Suggest names and missing product, risk, environment, and delivery considerations.
3. Update only changed owners among `docs/product.md`, `docs/architecture.md`, `docs/quality.md`, and `docs/ui.md`.
4. Identify uncertainty that could invalidate architecture, deployment, security, data, hardware, or UI direction. Create bounded spike work items before dependent design.
5. Map every active-release requirement to a capability block, spike, or explicit deferral.
6. Detail only the current block and immediate horizon. Give that block local requirements, architecture, implementation blueprint, validation, and executable work items. Keep later blocks at outcome, risk, dependency, and acceptance level.
7. Draft the active execution goal using `references/goal-contract.md`.
8. Obtain human approval for product shape, active-release outcomes, major architecture, and the first execution goal before product implementation. Record genuine approval evidence in `project/release.json`; never infer it.
9. Run `npm run project:check` and regenerate `docs/status.md`.

## Planning Boundaries

- Require an L1 end-to-end walking skeleton before exhaustive L3 hardening.
- Do not create hundreds of speculative leaf tasks to prove completeness.
- Do not update stable planning owners for routine implementation evidence.
- Replan after runtime inspection, an architecture-changing discovery, or a block maturity transition.
- Leave genuinely unresolved human choices explicit; do not invent approval.

## Completion

Planning is ready when the current block has an approved goal, executable work items, known validation, and no hidden dependency on an unresolved choice.
