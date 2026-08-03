---
id: WI-008
title: Prove the materiality loop and L1 soak
type: task
status: proposed
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

- [ ] The Python scheduler owns a durable lease keyed by portfolio, job type, and scheduled time; a deterministic clock proves one decision job per cadence and explicit recovery of queued work.
- [ ] Material deltas arriving during an active manager turn coalesce into the next bounded turn without overlap, loss, starvation, or duplicate acceptance; nonmaterial deltas remain traceable without triggering a turn.
- [ ] Timeout, app-server crash, circuit-open state, and recovery visibly abstain, retain queued deltas, and cannot create new exposure or a false-ready state.
- [ ] A real two-hour run at the three-minute cadence on the Ubuntu reference host completes with zero overlapping manager turns, duplicate/missed scheduled jobs, lost material deltas, or unaudited incidents; hosted turns are triggered only by bounded public material fixtures.
- [ ] The soak records workload, turn/job counts, latency distribution, database growth, process resource use, and all threshold violations in a redaction-safe summary under ignored work evidence.
- [ ] A manual headless walkthrough traces one accepted and one rejected real public fixture through evidence, thesis, counterargument, critic, gate, simulated fill or no-fill result, and immutable audit identity.

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

Not yet started; the batch advances here after WI-007 reaches validated completion and is checkpoint-pushed.

## Blocked Or Deferred

Live vendor latency, production portfolio scheduling, desktop background operation, and release-scale operations remain in their owning blocks.
