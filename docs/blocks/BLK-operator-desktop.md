---
id: BLK-operator-desktop
title: Operator desktop and research workspace
status: proposed
maturity: L0
release: V1
requirements: ["FR-001", "FR-005", "SFR-005", "QR-002"]
depends_on: ["BLK-secure-runtime", "BLK-agent-runtime", "BLK-market-intelligence", "BLK-strategy-evaluation", "BLK-broker-execution"]
ui: true
---

# Operator Desktop And Research Workspace

## Outcome

The owner can understand portfolio and strategy state, inspect evidence and agent reasoning, acknowledge and control automation, and recover from incidents through one accessible desktop operations console without receiving an unrestricted broker order ticket.

## Requirements

| ID | Requirement | Priority | Important failure or edge | Work item, spike, or deferral | Verification |
| --- | --- | --- | --- | --- | --- |
| BLK-operator-desktop-R001 | Present readiness, authorization, incident, portfolio/sleeve, benchmark, costs, exposure, position/thesis, event, agent, and qualification state. | Must | Dense charts can obscure stale, degraded, killed, or unreconciled state. | Future work item after L1 headless proof | UI state matrix, accessibility, visual, and runtime inspection. |
| BLK-operator-desktop-R002 | Provide research and chat drill-down with evidence, counterarguments, corrections, rights, and intent-request status. | Must | Chat could be mistaken for direct discretionary execution. | Future work item at block activation | Contract and usability scenarios. |
| BLK-operator-desktop-R003 | Support explicit acknowledgement, configuration, arm, pause, kill, and guided-reduction flows without bypassing Python authority. | Must | Accidental or ambiguous controls can create financial harm. | Future work item at block activation | Keyboard/accessibility and money-boundary E2E tests. |
| BLK-operator-desktop-R004 | Operate in tray/background with persistent in-app incidents and no external notification channel. | Must | Closing the window must not hide supervision failure or imply the core stopped. | Future work item at block activation | Native tray/autostart/reopen/recovery inspection. |

## Boundary

- Owns: Electron lifecycle and renderer, operations navigation, charts/tables, research/chat views, configuration and control request UX, attention queue presentation, and accessibility.
- Does not own: durable financial truth, risk decisions, qualification, authentication secrets, direct broker/API access, external notifications, or order construction.
- Inputs and outputs: read-only snapshots/events in; validated operator requests and chat/intent requests out.
- Dependencies: all domain blocks; a thin L1 slice may use fixtures before they reach L2.

## Contracts And Failure

Renderer IPC is an exact preload allowlist. Every state names freshness and source; unavailable data does not render as zero or success. Arming displays exact account, candidate, strategy, capital, reserve, limits, and acknowledgement. Pause/kill results persist beyond window close. Chat requests create typed intents that re-enter the qualified manager/critic/gate path.

## Architecture

Electron main owns native process and tray behavior. A sandboxed, context-isolated React renderer consumes immutable view models and issues narrow commands through preload. Charts include accessible summaries. The operations console is home; research, strategy evidence, agent activity, settings, and incidents are first-class drill-downs.

## Implementation Blueprint

After the headless L1 flow, use `$ui-design` to create two complete directions, obtain human selection, and record the exact coded design system in the UI manifest. Build a thin state-complete console before visual depth, then use `$ui-fidelity` and manual native inspection for every required state. Use Apache ECharts only if the activation review passes.

## Maturity Criteria

### L1 Walking Skeleton

- [ ] A thin desktop view shows the real headless fixture flow, readiness, one accepted/rejected intent, simulated execution, and incident state.
- [ ] Arming and kill are visibly nonfunctional fixtures until the authority contract exists.

### L2 Functional

- [ ] Every surface/state in `docs/ui.md` is implemented against an approved exact design system.
- [ ] Keyboard, screen reader, charts, controls, tray, chat, acknowledgement, and incident flows are complete.

### L3 Hardened

- [ ] Visual fidelity, accessibility, native lifecycle, degraded/offline recovery, clean install/update, diagnostics, and user runtime inspection pass.
- [ ] No renderer path exposes a secret, broker method, unrestricted order ticket, or false-safe state.

## Validation

| Outcome or risk | Method | Environment | Evidence |
| --- | --- | --- | --- |
| Product states are understandable | State-fixture walkthrough and human UI direction approval | Ubuntu desktop | UI manifest and work-item evidence |
| UI cannot bypass authority | IPC contract and E2E denial tests | Electron test/runtime | Regression suite |
| Final interface is shippable | `$ui-fidelity`, accessibility review, native tray/autostart/update inspection | Reference viewport matrix and Ubuntu clean host | L3 fidelity/runtime evidence |

## Known Gaps

- UI direction is unresolved by design; no L2 UI item may start before `$ui-design` and human selection.
- No OS toast, email, SMS, mobile push, unrestricted order ticket, or Windows UI is included in V1.
