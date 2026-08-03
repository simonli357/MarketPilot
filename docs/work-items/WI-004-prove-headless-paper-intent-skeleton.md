---
id: WI-004
title: Prove the headless paper-intent walking skeleton
type: gate
status: proposed
block: BLK-agent-runtime
release: V1
maturity: L1
requirements: ["FR-002", "FR-006", "IR-001", "QR-002", "SFR-004", "BLK-agent-runtime-R004", "BLK-agent-runtime-R005", "BLK-agent-runtime-R006"]
depends_on: ["WI-005", "WI-006", "WI-007", "WI-008"]
owner: unassigned
---

# Prove The Headless Paper-Intent Walking Skeleton

## Outcome

A rights-safe fixture/public event traverses the real qualified Sol Ultra manager, a separately orchestrated critic, a minimal deterministic Python gate, a broker-free simulator, and an immutable audit record, proving the end-to-end control boundary before broader data, strategy, broker, or UI implementation.

## Success Criteria

- [ ] Versioned fixture `ResearchEvent`, `TradeIntent`, `CriticVerdict`, `GateDecision`, `OrderPlan`, `ExecutionEvent`, and candidate/audit contracts are implemented with decimal-string and provenance rules.
- [ ] Thirty scenarios cover accept, reject, abstain, stale/partial/adversarial evidence, missing critic, malformed output, timeout, candidate mismatch, risk denial, partial simulated fill, restart, and duplicate-job suppression.
- [ ] Every terminal agent artifact is schema-valid and every new/increased exposure requires a distinct nonblocking critic verdict plus deterministic acceptance.
- [ ] Restart at each durable boundary creates zero duplicate intent or simulated order and never exposes a false-ready state.
- [ ] A two-hour three-minute materiality-loop soak coalesces deltas, avoids overlapping manager turns, and retains every material event or typed incident.
- [ ] A manual headless walkthrough explains the evidence, thesis, counterargument, gate result, simulated fill, and audit identity without broker/account access.

## Validation

- Automated: thirty-scenario contract/system suite, crash-at-boundary idempotency tests, and two-hour soak.
- Manual: one accepted and one rejected fixture walkthrough with artifact/audit inspection.
- Environment or fixture: Ubuntu reference host, qualified WI-001 runtime, public/fixture-only MCP, deterministic clock, fake market/broker; no real account or capital.

## Execution Contract

- Constraints: Preserve the WI-001 isolation boundary; no licensed/restricted data, IBKR connection, live order, final UI, historical profitability claim, or automatic candidate promotion.
- Boundaries: Agent-runtime contracts plus the smallest Python deterministic gate/simulator/audit seam needed to prove L1; other capability details stay in their future blocks.
- Iteration policy: Fix the smallest producer/consumer contract or state invariant exposed by a failing scenario, rerun that scenario, then the full matrix and soak.
- Blocked stop condition: Stop for replan if the qualified app-server cannot reliably produce terminal typed artifacts or the cross-language boundary cannot preserve idempotent fail-closed state without changing the approved authority model.

## Delivery Plan

- WI-005 implements the canonical contracts and deterministic fixture-only Node-to-Python authority seam.
- WI-006 connects the real qualified manager and independent critic to that seam for accepted and rejected public-fixture paths.
- WI-007 completes the thirty-scenario failure matrix and durable crash/restart idempotency proof.
- WI-008 implements materiality scheduling, runs the two-hour soak, and prepares the manual accepted/rejected walkthrough.
- WI-005 through WI-008 are delegated together as one sequential batch on one branch. The implementation agent validates, evidences, commits, and pushes each leaf checkpoint, promotes the next satisfied dependency without waiting for human review, and stops only at an explicit work-item blocker.
- WI-004 is the single post-batch independent review gate, not an additional implementation batch: it closes only when the four slices collectively satisfy every criterion above.

## Evidence

Not yet started. The implementation horizon is decomposed into one WI-005-through-WI-008 batch; this gate waits for its completed checkpoint evidence and then owns independent review.

## Blocked Or Deferred

The gate intentionally remains proposed until WI-005 through WI-008 are done. Hosted-model availability remains an external readiness dependency and must fail closed.
