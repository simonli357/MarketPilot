# UI Contract

## Headless First Gate

- Prove the typed event-to-intent-to-critic-to-gate-to-simulated-execution path before final visual implementation.
- Follow it with a thin operations slice early enough to validate states, explanations, incidents, and control placement.
- Use `$ui-design` to produce exactly two complete directions and an exact coded design system before L2 UI implementation; use `$ui-fidelity` during implementation.
- Use `$visual-assets` only for suitable shipping raster assets, never familiar controls or text-heavy operational elements.

## Product States

| Surface/flow | Required states | Data/permission source | Block |
| --- | --- | --- | --- |
| Application shell and readiness | Booting, core ready, reconciling, safe, agent ready, degraded, incident-blocked, update required | Electron supervisor and Python readiness aggregate | BLK-secure-runtime, BLK-operator-desktop |
| Portfolio operations console | Empty paper account, paper active, live disarmed, live armed, paused, killed, stale, broker offline, reconciliation required | Python portfolio, authorization, broker, ledger, and risk snapshots | BLK-operator-desktop, BLK-broker-execution |
| Positions and theses | No positions, ready, pending intent, working order, partial fill, protected, invalidated, guided close, unknown broker state | Python audit/portfolio core | BLK-operator-desktop |
| Research and event timeline | Loading, ready, revised/corrected, stale, partial coverage, restricted, source offline, error | Rights-filtered intelligence API | BLK-market-intelligence, BLK-operator-desktop |
| Strategies and qualification | Draft candidate, paper collecting, passed, failed, expired, superseded, micro-live, live-qualified | Candidate registry and qualification engine | BLK-strategy-evaluation, BLK-operator-desktop |
| Agent activity and chat | Signed out, ready, thinking, delegated, awaiting critic, typed result, abstained, timed out, rate-limited, schema error | Codex supervisor and immutable artifact ledger | BLK-agent-runtime, BLK-operator-desktop |
| Authorization and kill | Acknowledgement required, configuration changed, ready to arm, armed, pause pending, killed, reconciliation required, guided reductions | Python deterministic authority; UI submits explicit requests only | BLK-broker-execution, BLK-operator-desktop |
| Data/vendor settings | Not configured, trial, rights incomplete, ready, near limit, over limit, disconnected | Rights engine and adapter health | BLK-market-intelligence, BLK-operator-desktop |

## Operations Console Content

- Portfolio and sleeve equity curves against the appropriate SPY benchmark, drawdown, gross exposure, settled cash, USD 100 reserve, commissions, fees, and slippage.
- Strategy attribution and qualification progress, including evidence counts, window, benchmark, best-result removal, candidate hash, and failure reason.
- Positions, active theses, invalidators, expected horizon, working/protective orders, fills, and guided-close state.
- Normalized event timeline with sources, publication/receipt time, corrections, affected instruments, rights/coverage state, and links to evidence where licensed.
- Core, data, broker, ledger, Codex, authorization, and candidate readiness; persistent attention queue; prominent pause and kill controls.
- Research and chat drill-down. Chat may request an intent but cannot expose an unrestricted order ticket or bypass manager, critic, qualification, and gate rules.

The window may close to tray while the supervised core continues. No OS toast, email, SMS, or mobile push is permitted in V1; background incidents persist and must be conspicuous when the window reopens. The tray icon may communicate coarse state without a toast.

## Direction Gate

`assets/ui-concepts/ui-manifest.json` remains the sole direction-state owner. Direction is currently `unresolved`; no L2 UI item may start until two complete options are inspected and the human selects one with exact coded tokens, component gallery, surface inventory, viewports, and evidence.

## Interaction And Accessibility

- Keyboard and focus: every primary operation is keyboard reachable; focus order follows operational priority; modal focus is trapped and restored; pause and kill have unambiguous shortcuts that cannot trigger accidentally.
- Screen reader and labels: controls, status, tables, chart summaries, incidents, and changing readiness states have meaningful names and announcements.
- Contrast and non-color state cues: ready, stale, degraded, paused, killed, profit/loss, and qualification state use text/icon/shape in addition to color.
- Touch targets and compact layouts: desktop-first density with at least 44 CSS-pixel targets for destructive or permission-sensitive actions; compact data tables retain accessible alternatives.
- Motion and reduced motion: transitions never hide state changes; honor reduced motion; no decorative market-motion animation.
- Destructive and permission-sensitive actions: arming displays exact account/candidate/capital/limits; loosening risk disarms and requires requalification; kill is immediate but confirmed by persistent resulting state; guided close states explain price-collar and non-fill risk.

## Fidelity Policy

- Approved mockups define composition and visual intent; coded tokens and the component gallery define exact implementation values and states.
- Every active UI work item names its screen, state, modal, configuration, responsive reference, and data fixture before implementation.
- Capture matching viewports, compare all operational and failure states, fix drift, and record only human-approved exceptions.
- Every approved shipping asset is used or explicitly replaced/deferred with approval.
