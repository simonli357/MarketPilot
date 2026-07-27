# Agent Guidance

## Start And Scope

- This repository plans and delivers a desktop application.
- Never read, summarize, edit, stage, commit, or use `human.md` as context.
- Start with `PROJECT.md` and `docs/status.md`.
- For implementation, read only the active work item, its block, and owners of facts that may change.
- Accept planning input from `docs/idea.md`, any file the human names, or the prompt itself.
- Use `$project-planning` for initial planning, new blocks, and architecture-changing replans.
- Do not write product code before the human approves product shape, major architecture, and the first execution goal.

## Delivery

- Map every V1 requirement to a block, spike, or deferral; detail leaf work only for the current block and immediate horizon.
- Produce an L1 end-to-end walking skeleton before exhaustive L3 hardening.
- Work from canonical files under `docs/work-items/`; do not maintain a second manual queue.
- Regenerate `docs/status.md` only when handoff truth changes.
- Use `$production-hardening` for explicit L3 work and `$release-readiness` for L4 or release decisions.
- For UI, use `$ui-design` before final implementation, `$ui-fidelity` during implementation, and `$visual-assets` for suitable shipping raster assets.

## Engineering

- Follow `docs/engineering.md` and activate only quality gates relevant to `project/profile.json`.
- Prefer mature maintained libraries for common capabilities after checking license, maintenance, security, platform support, and integration cost.
- Add abstractions only for demonstrated boundaries, reuse, volatility, or testability.
- Fix root causes. Reject broad conditional band-aids, fake success, swallowed errors, and hidden downgrade paths.
- Fail fast for invalid config, impossible state, schema mismatch, and unsupported platform assumptions.
- Treat expected external failure with explicit typed, observable, safe, documented, and tested behavior.
- Automated checks do not replace manual runtime, visual, operational, or hardware inspection when those matter.

## Git And Evidence

- Inspect worktree state, preserve user changes, and stage only intended files.
- Commit coherent validated units with `[type][WORK-ID]` when a work item exists.
- Push at coherent checkpoints when a remote exists; never edit docs solely to record a successful push.
- Keep disposable evidence under ignored `artifacts/work/`; retain release evidence only through a versioned manifest and size budget.

## Commands

- `npm run project:check`: validate owners, profile, blocks, work items, release state, skills, UI gate, and links.
- `npm run project:status`: regenerate the compact handoff.
- `npm run project:skills`: publish canonical repository skills to Codex and Claude discovery locations.
- `npm run project:migrate`: dry-run the v1-to-v2 migration inventory.

Work is complete only when behavior, focused validation, required manual inspection, canonical owners, and work-item evidence agree.
