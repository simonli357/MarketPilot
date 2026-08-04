---
id: WI-008
title: Prove the materiality loop and L1 soak
type: task
status: done
block: BLK-agent-runtime
release: V1
maturity: L1
requirements: ["FR-002", "QR-002", "SFR-004", "BLK-agent-runtime-R005", "BLK-agent-runtime-R006"]
depends_on: ["WI-007"]
owner: implementation-agent
---

# Prove The Materiality Loop And L1 Soak

## Outcome

A three-minute fixture materiality loop coalesces changes while the manager is busy, never overlaps manager turns, retains every material event or typed incident, and completes a two-hour headless soak plus the accepted/rejected manual walkthrough needed for the WI-004 L1 gate.

## Success Criteria

- [x] The Python scheduler owns a durable lease keyed by portfolio, job type, and scheduled time; a deterministic clock proves one decision job per cadence and explicit recovery of queued work.
- [x] Material deltas arriving during an active manager turn coalesce into the next bounded turn without overlap, loss, starvation, or duplicate acceptance; nonmaterial deltas remain traceable without triggering a turn.
- [x] Timeout, app-server crash, circuit-open state, and recovery visibly abstain, retain queued deltas, and cannot create new exposure or a false-ready state.
- [x] A real two-hour run at the three-minute cadence on the Ubuntu reference host completes with zero overlapping manager turns, duplicate/missed scheduled jobs, lost material deltas, or unaudited incidents; hosted turns are triggered only by bounded public material fixtures.
- [x] The soak records workload, turn/job counts, latency distribution, database growth, process resource use, and all threshold violations in a redaction-safe summary under ignored work evidence.
- [x] A manual headless walkthrough traces one accepted and one rejected real public fixture through evidence, thesis, counterargument, critic, gate, simulated fill or no-fill result, and immutable audit identity.

## Validation

- Automated: deterministic scheduler/coalescing tests, timeout/crash/circuit recovery cases, the complete paper-intent regression suite, and `npm run project:check`.
- Runtime/manual: a wall-clock two-hour three-minute-cadence soak plus accepted and rejected hosted public-fixture artifact inspection.
- Environment or fixture: Ubuntu reference host, qualified Codex runtime, deterministic public fixture source, fake market/broker, and fixture-only authority store; no account or capital.

## Execution Contract

- Constraints: One manager operation at a time; preserve every material delta or typed incident; hosted unavailability abstains; no shortened run may be reported as the required two-hour soak.
- Boundaries: Add only the materiality scheduler/lease/coalescing behavior, soak harness, metrics, manual evidence flow, focused commands/guidance, and concise WI-008 evidence. Do not add production vendor feeds, portfolio scheduling, IBKR, UI, or L2 functionality.
- Iteration policy: Prove deterministic lease and coalescing transitions first, then a short diagnostic run, then the uninterrupted two-hour acceptance run; reset the acceptance run after any product-code or threshold-affecting change.
- Blocked stop condition: Stop for architecture review if the three-minute workload cannot avoid overlap or data loss within the approved one-operation supervisor model, or if hosted capacity makes the bounded real-fixture acceptance path unrepeatable.

## Evidence

- Scheduler and deterministic safety: `src/marketpilot/materiality_loop.py` owns the fixture-only SQLite cadence, portfolio/job/scheduled-time lease, one-manager fence, coalescing, exact captured input sets, Python fixture-authority replay, acceptance/result hashes, incidents, and uncertainty markers. Normal construction cannot accept a callback; `MaterialityScheduler.for_test` is the explicit fault-injection seam. `npm run test:materiality` passed 28/28, including durable timeout and typed-timeout reconciliation, `AUTHORITY_PROCESS_FAILED` crash uncertainty, circuit-open behavior, held-lease drain termination, transient overdue high-water metrics, live acceptance tamper blocking, and generated-delta retention checks.
- Failure/recovery validation: `npm run test:paper-recovery` passed 8/8; `npm run paper:recovery-matrix` passed exactly 30 named scenarios with `allExpected=true`, `allNamed=true`, and `noUnexpectedExposure=true`; `npm run paper:recovery-boundaries` passed all 14 durable crash boundaries with `allRecovered=true`; and `npm run paper:recovery-benchmark` used seed `20260803`, 1,000 fixtures (800 accepted / 200 rejected / 0 error), p95 `20.8193 ms`, `withinBudget=true` (startup and broker I/O excluded).
- Full regression/environment validation on the Ubuntu reference host: `npm run check:paper-core`, `npm run project:check` (0 warnings), Python compile, and `git diff --check` passed; the batch Codex suite passed 315/315 and `npm audit --omit=dev` reported 0 vulnerabilities. The independent contract and Python-authority reviews found and fixed the non-object acceptance tamper classification, held-lease empty-row spin, historical missed-cadence erasure, generated/persisted workload-count blind spot, raised and structured timeout operation widening, and app-server process-failure operation widening; both reviewers’ final read-only passes found no remaining WI-008 blocker.
- Required uninterrupted soak (fresh report generated 2026-08-04, ignored artifact `artifacts/work/wi-008-soak-report.json`, profile `marketpilot.materiality-soak.v1`): duration `7200.421 s` / required `7200 s`; cadence `180 s`; expected/scheduled/completed jobs `40/40/40`; manager turns `40` (`26` accepted, `14` rejected), abstained jobs `0`; generated/material/processed material deltas `1398/1398/1398`; generated/nonmaterial/traceable nonmaterial deltas `699/699/699`; latency count `40`, min `9.8576 ms`, median `31.6246 ms`, p95 `50.9613 ms`, max `245.1003 ms`; ephemeral database growth `499712 bytes`; max RSS `22820 KB`; user/system CPU `81.452/2.339 s`; incidents `0`; violations `[]`; final readiness `SCHEDULER_READY` with `queuedMaterial=0`; status `PASSED`. The soak intentionally reports `hostedTurns=0` and `hostedFixtureOnly=true`; each turn used the bounded public fixture through the Python authority.
- Fresh hosted manual walkthrough (`npm run paper:agent-hosted`, keyring-backed runtime, `smokeStatus=reused-keyring`, no API token) passed and released its runtime/process lease. Accepted: `ACCEPTED`, manager/critic `run_fixture_manager_v1`/`run_fixture_critic_v1`, primary `ACCEPTED`, plan `plan_6b4060f9d5e3036f1405629efea275da`, execution `exec_6c96c892df5616857af2fdcb736ea5b9`, 7 audit events, response hash `15802bfdd218e381482049d01cfaa0e7a7d0e83521af20a5097e45862fc9fbeb`. Rejected: `REJECTED`, same distinct role run IDs, primary `CRITIC_REJECTED`, reasons `CRITIC_REJECTED`, `QUANTITY_LIMIT_EXCEEDED`, `NOTIONAL_LIMIT_EXCEEDED`, no plan/execution, 5 audit events, response hash `81db23a511b9145e2f7d5ff843c1d7da41c1eaaa7524f3230464b2420d1220f6`. No account, capital, broker, licensed feed, or production state was used.

## Blocked Or Deferred

Production encryption, backup/restore, broker reconciliation, desktop background operation, live vendor latency, and hostile descendant containment remain in their owning L2/L3 blocks. WI-008’s scheduler store is deliberately fixture-only ephemeral SQLite; the full immutable paper authority audit remains owned by the WI-005/WI-007 Python boundary. WI-004 remains the proposed aggregate review gate.
