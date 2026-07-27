# AI-Assisted Desktop App Template

Use this repository to turn a rough idea into a maintainable, evidence-backed desktop application with an AI coding agent.

## Start

1. Write anything useful in `docs/idea.md`, another file you name, or the planning prompt itself. One paragraph is enough.
2. Enter plan mode and invoke `$project-planning`.
3. Review the proposed product shape, risks, capability blocks, and first execution goal.
4. Approve the first goal before product implementation starts.
5. Build one end-to-end walking skeleton, inspect it, then detail and harden one block at a time.

## Commands

```bash
npm run project:check
npm run project:status
npm run project:skills
npm run project:migrate
```

Product tooling may use any language or framework. Node 22 is required only for the dependency-free template validation scripts.

## Map

- `PROJECT.md`: compact entry point and current target.
- `docs/product.md`: destination, releases, users, journeys, global requirements.
- `docs/architecture.md`: cross-block architecture and environment.
- `docs/quality.md`: risk profile, maturity, validation, and release policy.
- `docs/ui.md` and `assets/ui-concepts/`: activated when the project has a visual interface.
- `docs/blocks/`: capability-local requirements, design, and acceptance.
- `docs/work-items/`: canonical tasks, bugs, features, spikes, and gates.
- `project/release.json`: canonical release truth.
- `docs/status.md`: generated handoff, never a historical log.
- `human.md`: human-only notes that agents must ignore.

See `docs/README.md` for ownership and workflow rules.
