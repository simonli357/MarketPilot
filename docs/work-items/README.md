# Work Items

This directory is the only manual execution queue. A work item may be a task, bug, feature, spike, or gate. Its metadata is machine-checked and its body owns outcome, success criteria, validation, and concise evidence.

## Lifecycle

`proposed -> ready -> in_progress -> done`

Use `blocked` only with a concrete unblock condition. Use `deferred` only with an owning release or decision. An item is `ready` only when dependencies and external inputs are satisfied and its validation is known.

## Bugs

- Fix a clear, local bug immediately with a root-cause change and regression evidence; a permanent bug file is optional.
- Create a bug item when it is unresolved, cross-block, recurring, security-sensitive, data-integrity-sensitive, or release-impacting.
- Create a spike when the cause or correct behavior is unclear.
- Do not implement a fallback or broad conditional as a substitute for fixing the defect.

## Format

Copy `ITEM-template.md` to `WI-<number>-<slug>.md`. Keep frontmatter values on one line. Arrays use JSON syntax so the repository checker can parse them without a language-specific YAML dependency.

Generated queue, dependency, maturity, and handoff views come from `npm run project:status` and `npm run project:check`; do not reproduce them in Markdown tables.
