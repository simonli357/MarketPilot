# Documentation And Workflow

## Ownership Rule

One mutable fact has one canonical owner. Secondary summaries are generated or link to that owner.

| Fact | Canonical owner |
| --- | --- |
| Rough human idea | `docs/idea.md`, a human-named file, or current prompt |
| Destination, users, releases, journeys, global requirements | `docs/product.md` |
| Cross-block architecture, dependencies, environment strategy | `docs/architecture.md` |
| Exact setup commands and host instructions | `docs/guides/developer.md` |
| Capability/risk activation | `project/profile.json` |
| Maturity model, risk rationale and budgets, global validation | `docs/quality.md` |
| Global UI interaction and state contract | `docs/ui.md` |
| UI direction, selection, exact references, surfaces, assets, and exceptions | `assets/ui-concepts/ui-manifest.json` |
| Local requirement, design, validation, acceptance | Owning file under `docs/blocks/` |
| Task, bug, feature, spike, or gate state | Owning file under `docs/work-items/` |
| Durable material decision | One file under `docs/decisions/` |
| Release gate state | `project/release.json` |
| Setup and environment | `docs/guides/developer.md` |
| Copy-paste commands | `docs/commands.md` |
| Current handoff | Generated `docs/status.md` |
| Disposable evidence | Ignored `artifacts/work/` |
| Retained release evidence | `artifacts/releases/<version>/manifest.json` |

## Read Sets

| Work | Read first | Add only when needed |
| --- | --- | --- |
| Intake/planning | `PROJECT.md`, idea or named input, product, architecture, quality | UI and existing blocks when active |
| Implementation | Active work item and block | Owners of facts that may change |
| Local bug | Report, affected code/tests, owning work item if one exists | Planning only when expected behavior was missing or wrong |
| Hardening | Active L3 item, block, activated quality risks | Relevant implementation and retained evidence |
| UI | Active item/block, UI manifest, selected system and references | Product/architecture only for changed contracts |
| Release | Release state, quality, required blocks, guides, release manifests | Product/architecture only for changed release facts |

## Rolling Workflow

1. Accept rough input without a form gate.
2. Define product destination, active-release outcomes, and highest-risk unknowns.
3. Run blocking spikes before dependent architecture or UI decisions.
4. Map all active requirements to capability blocks, spikes, or deferrals.
5. Detail only the current block and immediate horizon.
6. Approve a six-part execution goal.
7. Build and manually exercise an L1 end-to-end walking skeleton.
8. Replan from observed behavior; complete L2 function, then L3 hardening block by block.
9. Run L4 release readiness against canonical gate state.

## Documentation Impact

| Tier | Change | Required update |
| --- | --- | --- |
| D0 | Exploration with no durable decision | None |
| D1 | Routine implementation or immediate local bug | Owning work item when one exists; regression test and commit are enough for an untracked local bug |
| D2 | Product behavior, UI contract, setup, or validation strategy changes | Work item plus only the changed canonical owner |
| D3 | Architecture, durable dependency, release scope, security policy, or process changes | Changed owner, decision record when warranted, and release state when affected |
| D4 | Release or material handoff | Release gates, retained evidence manifest, required guides, and generated status |

Regenerate status whenever handoff truth changes. Do not escalate a tier merely because a change touched many files.

Never update planning merely to copy test output, task status, commit state, or successful push state.

## Bug Routing

- Fix a clear local bug directly and add focused regression evidence.
- Create a bug work item when unresolved, cross-block, recurring, security-sensitive, data-integrity-sensitive, or release-impacting.
- Create a spike when root cause or expected behavior is unclear.
- Update product, architecture, quality, or UI owners only when the bug proves their contract was missing or wrong.

## Generated Views

`docs/status.md` is generated from canonical work-item and release state. Do not append history to it. Traceability, queue, dependency, and maturity checks are computed by `npm run project:check` rather than copied into manual tables.
