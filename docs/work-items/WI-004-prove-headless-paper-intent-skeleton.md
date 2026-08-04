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
owner: Codex
---

# Prove The Headless Paper-Intent Walking Skeleton

## Outcome

A rights-safe fixture/public event traverses the real qualified Sol Ultra manager, a separately orchestrated critic, a minimal deterministic Python gate, a broker-free simulator, and an immutable audit record, proving the end-to-end control boundary before broader data, strategy, broker, or UI implementation.

## Success Criteria

- [ ] Versioned fixture `ResearchEvent`, `TradeIntent`, `CriticVerdict`, `GateDecision`, `OrderPlan`, `ExecutionEvent`, and candidate/audit contracts are implemented with decimal-string and provenance rules.
- [ ] Thirty scenarios cover accept, reject, abstain, stale/partial/adversarial evidence, missing critic, malformed output, timeout, candidate mismatch, risk denial, partial simulated fill, restart, and duplicate-job suppression.
- [ ] Every terminal agent artifact is schema-valid and every new/increased exposure requires a distinct independent critic verdict that permits the proposal plus deterministic Python acceptance.
- [ ] Restart from each materially distinct committed state creates zero duplicate intent/plan/simulated execution, never reruns acceptance/planning/simulation, and never exposes a false-ready state.
- [ ] A two-hour three-minute local-authority materiality-loop soak coalesces deltas, avoids overlapping authority evaluations, consumes the durable WI-007 result boundary, and retains every material event or typed incident.
- [ ] A separate hosted manual headless walkthrough proves the real manager/critic path and explains the model-selected evidence, thesis, counterargument, gate result, simulated fill or no-fill, and immutable audit identity without broker/account access.

## Validation

- Automated: executable thirty-scenario contract/system suite, atomic-concurrency and crash-state idempotency tests, and the local-authority two-hour soak.
- Manual: one accepted and one rejected hosted fixture walkthrough with semantic artifact/audit inspection after complete runtime cleanup.
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
- WI-008 integrates materiality scheduling with WI-007's durable result boundary, runs the local-authority two-hour soak, and completes the separate hosted accepted/rejected walkthrough.
- The initial WI-005-through-WI-008 batch was implemented and independently rejected at this gate. The four reopened items form one corrective sequential batch on the same branch; the implementation agent validates, evidences, commits, and pushes each leaf checkpoint, promotes the next satisfied dependency without waiting for human review, and stops only at an explicit work-item blocker.
- WI-004 is the single post-batch independent review gate, not an additional implementation batch: it closes only when the four slices collectively satisfy every criterion above.

## Evidence

The initial implementation batch reached pushed checkpoints for WI-005 through WI-008. Independent review reran the focused paper-core, recovery, materiality, Codex, project, dependency, compatibility, fixture, and authenticated hosted commands; they passed, including 20 paper-core tests, 8 recovery tests, 28 materiality tests, 315 Codex tests, a 1,000-case benchmark with 800 accepted / 200 rejected / 0 errors and p95 `3.396 ms`, and real accepted/rejected keyring-backed hosted turns. The retained two-hour report also plausibly ran for `7200.421 s` at a 180-second cadence with 40 completed local-authority jobs and no reported incident.

Those checks were insufficient for acceptance. Adversarial review found non-executable/divergent schemas, incomplete provenance aggregation, forged Python producer acceptance, and a 16-versus-26 reason-code conflict in WI-005; prebuilt semantic answers, excess critic capabilities/inventory gaps, and cleanup-after-success in WI-006; nine synthetic scenario outcomes, replayed acceptance/simulation during recovery, collapsed crash boundaries, a benchmark false-pass condition, and non-atomic concurrent operation claims in WI-007; and live accepted-result tamper false-readiness, stale-history failure, restart-erased missed-cadence evidence, a vacuous soak pass gate, mislabeled local evaluations, and incomplete hosted semantic evidence in WI-008. Independent probes reproduced nine concurrent-claim failures in twenty runs and demonstrated that a rehashed `{}` accepted result still allowed a subsequent accepted scheduler cadence. WI-005 through WI-008 are therefore reopened under tightened criteria; none is accepted as done.

## Blocked Or Deferred

The gate remains proposed until the corrective WI-005-through-WI-008 batch is done and independently reviewed. Hosted-model availability remains an external readiness dependency and must fail closed; it was available during this review, so it is not the current blocker.
