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

A three-minute fixture materiality loop coalesces changes while a local authority evaluation is active, never overlaps authority evaluations, retains every material event or typed incident, and completes a two-hour local-authority soak plus a separate accepted/rejected hosted manager/critic walkthrough needed for the WI-004 L1 gate.

## Success Criteria

- [ ] The Python scheduler owns a durable lease keyed by portfolio, job type, and scheduled time; a deterministic clock proves one decision job per cadence and explicit recovery of queued work, while persisted scheduled/completed high-water marks make duplicate or missed cadence history observable across restart. Each immutable job/delta capture atomically stores its canonical authority request bytes/hash and maps one-to-one to the stable WI-007 operation key defined below; restart reuses those exact bytes, and the job cannot complete without a verified durable terminal authority record.
- [ ] Material deltas arriving during an active authority evaluation coalesce into the next bounded job without overlap, loss, starvation, or duplicate acceptance; nonmaterial deltas remain traceable without triggering a job. This is revalidated through the WI-007 durable store rather than a direct authority callback.
- [ ] Timeout, app-server crash, circuit-open state, stale failure history, live result/reference tampering, missing or invalid WI-007 terminal state, and recovery visibly abstain, retain queued deltas, and cannot create new exposure or a false-ready state. Readiness and every tick verify every completed scheduler reference against the full durable operation/artifact/audit record, while expired failure history is pruned by an explicit deterministic rule.
- [ ] A real two-hour deterministic local-authority run at the three-minute cadence on the Ubuntu reference host completes with zero overlapping authority evaluations, duplicate/missed scheduled jobs, lost material deltas, unaudited incidents, or restart-erased violations. This soak is named and reported as local-authority evidence; a separate bounded hosted walkthrough proves the real manager/critic path without claiming forty hosted turns.
- [ ] In each 180-second interval, the deterministic soak generates the fixed deltas below, then runs the job at `+ 180 s`; odd intervals use the accepted request and even intervals use the quantity-two rejected request. It requires exactly 40 distinct jobs through `start + 7,200 s`, 40 completions, 40 WI-007 authority evaluations, 40 latency samples, 80 generated/processed material deltas, and 40 generated/traceable nonmaterial deltas. Accepted and rejected each equal 20; abstained, errors, incidents, overlap, duplicates, missed jobs, lost/queued material, and threshold violations equal zero. All 40 operation/response/head/gate identities are unique and verified; plan and execution identities each equal 20, appear only on accepted operations, and are unique. The harness continues ingestion, readiness, and incident monitoring through the full 7,200 seconds, including the final cadence interval, and records latency, database growth, process resources, and persisted historical high-water metrics in the ignored redaction-safe report.
- [ ] A manual headless walkthrough traces one accepted and one rejected real public fixture through the model-originated evidence selection, thesis, counterargument, critic, gate, simulated fill or no-fill result, and immutable audit identity; the report retains these validated semantic artifacts rather than only their hashes.

## Validation

- Automated: deterministic scheduler/coalescing tests, timeout/crash/circuit recovery cases, the complete paper-intent regression suite, and `npm run project:check`.
- Runtime/manual: a wall-clock two-hour three-minute-cadence soak plus accepted and rejected hosted public-fixture artifact inspection.
- Environment or fixture: Ubuntu reference host, qualified Codex runtime, deterministic public fixture source, fake market/broker, and fixture-only authority store; no account or capital.

## Execution Contract

- Constraints: One authority evaluation at a time; preserve every material delta or typed incident; hosted unavailability abstains. The normal scheduler must use the WI-007 durable repository and may not call `evaluate_request` or an injected callback directly; fault callbacks remain available only through an unmistakable test factory and cannot create a normal completed acceptance. Name local-authority and hosted evidence accurately, and never infer hosted model turns from a local callback or Python authority call. No shortened run may be reported as the required two-hour soak.
- Boundaries: Integrate only the materiality scheduler/lease/coalescing behavior with the WI-007 fixture store, soak harness, metrics, manual evidence flow, focused commands/guidance, and concise WI-008 evidence. Do not add production vendor feeds, portfolio scheduling, IBKR, UI, or L2 functionality.
- Iteration policy: First repair live acceptance verification, stale-history expiry, persisted high-water metrics, and the non-vacuous pass predicate; prove each with deterministic restart/tamper tests, then run a short diagnostic. After all WI-005-through-WI-008 product and threshold changes settle, reset and rerun the full uninterrupted two-hour acceptance run, followed by the separate hosted walkthrough.
- Blocked stop condition: Stop for architecture review if the three-minute workload cannot avoid overlap or data loss within the approved one-operation supervisor model, or if hosted capacity makes the bounded real-fixture acceptance path unrepeatable.

## Scheduler Authority Mapping

The canonical job source tuple is `(portfolioId = fixture_portfolio, jobType = PAPER_DECISION, scheduledAt)`, and `jobKey` is `job_sched_` plus the first 32 lowercase hex characters of `SHA-256(ASCII(portfolioId) || 0x00 || ASCII(jobType) || 0x00 || ASCII(scheduledAt))`. Once its lease captures a sorted set of material delta IDs, that set is immutable. Its operation ID is `op_sched_` plus the first 32 lowercase hex characters of `SHA-256(ASCII(profile) || 0x00 || ASCII(jobKey) || 0x00 || JCS(sortedDeltaIds))`. In the same transaction, the scheduler constructs and stores the complete canonical `FixtureAuthorityRequest` bytes and request hash, including all operation-linked artifact IDs/hashes. Restart loads those bytes rather than rebuilding the request; the same operation can therefore never drift into an idempotency conflict.

For interval `NN` from `01` through `40`, material IDs `delta_soak_NN_m1` and `delta_soak_NN_m2` arrive at `+ 30 s` and `+ 90 s` with payloads `{ fixtureId: "public-event-001", interval: "NN", ordinal: "1|2", material: true }`; nonmaterial ID `delta_soak_NN_n1` arrives at `+ 120 s` with ordinal `"1"` and `material: false`. The request selector is fixed: odd `NN` uses the accepted one-share fixture and even `NN` uses the rejected two-share fixture. No wall-clock loop speed, hash parity, random value, or hosted response chooses the workload or expected distribution.

The normal worker calls `FixtureAuthorityStore.process` for that operation and never invokes the authority function directly. A completed scheduler row stores only verified references—job key, operation ID, request hash, response hash, audit head, gate ID, and nullable plan/execution IDs—and must resolve to exactly one WI-007 `TERMINAL` record. Construction, `readiness()`, every `tick()`, metrics, and restart reconciliation all call the repository's full operation verifier before trusting any completed row. An absent, aborted, corrupt, mismatched, or incident-only operation marks the job abstained, persists/links the incident, retains its material deltas for the next cadence, and blocks readiness until reconciliation; it can never be promoted by replacing a local summary hash.

The two-hour run uses this local durable path with no model turns. The separate final hosted walkthrough sends WI-006's model-originated drafts through the same WI-007 repository and prints the validated fixture evidence IDs, thesis, counterargument, terminal authority result, and immutable operation/audit identity only after hosted runtime cleanup succeeds.

## Evidence

The 2026-08-04 WI-004 independent review rejected this completion. A stored accepted result could be replaced with `{}` and a matching hash while both `readiness()` and the next cadence still reported ready and accepted new exposure. Stale failure history older than ten minutes caused constructor failure instead of deterministic expiry; missed-cadence high-water evidence existed only in process memory and disappeared on restart. The soak's pass gate did not require the reported job/evaluation/latency counts or unique audit identities, and its local callback turns were mislabeled as manager turns while `hostedTurns` was hard-coded to zero. The hosted summary retained hashes and outcomes but omitted the evidence, thesis, and counterargument required for manual acceptance. The existing two-hour report remains useful diagnostic evidence, but product and threshold corrections require a fresh uninterrupted run before this item can close.

- Initial scheduler diagnostic: `npm run test:materiality` passed 28/28 against a summary-only SQLite scheduler and direct Python callback. Its tamper test called `metrics()` before `readiness()`, masking the reproduced path where a rehashed `{}` result remained ready and allowed another accepted cadence. The callback architecture and transient in-memory high-water metric are superseded by the WI-007 mapping above.
- Initial inherited recovery diagnostics reported 30 named scenarios, 14 crash hooks, and 1,000 fixtures (800 accepted / 200 rejected / 0 error). WI-007's review showed that the scenario and recovery reports were synthetic/replaying, so those results are regression baselines only and do not support WI-008 acceptance.
- Full candidate regression/environment validation on the Ubuntu reference host passed: `npm run check:paper-core`, `npm run project:check` (0 warnings), Python compile, `git diff --check`, the 315-test Codex suite, and `npm audit --omit=dev` (0 vulnerabilities). Those green checks did not cover the later adversarial acceptance-tamper, stale-history, persisted-high-water, evidence-retention, and soak-pass-gate findings recorded above.
- Initial uninterrupted diagnostic soak (report generated 2026-08-04, ignored artifact `artifacts/work/wi-008-soak-report.json`, profile `marketpilot.materiality-soak.v1`): duration `7200.421 s` / required `7200 s`; cadence `180 s`; expected/scheduled/completed jobs `40/40/40`; locally injected authority evaluations labeled as manager turns `40` (`26` accepted, `14` rejected), abstained jobs `0`; generated/material/processed material deltas `1398/1398/1398`; generated/nonmaterial/traceable nonmaterial deltas `699/699/699`; latency count `40`, p95 `50.9613 ms`; database growth `499712 bytes`; max RSS `22820 KB`; incidents `0`; violations `[]`; final readiness `SCHEDULER_READY`. Because the pass predicate and terminology were insufficient, this report does not satisfy the reopened acceptance criteria and must be replaced after corrections.
- Initial hosted lifecycle/protocol walkthrough (`npm run paper:agent-hosted`, keyring-backed runtime, no API token) returned accepted and rejected authority paths with distinct role IDs, the expected plan/execution presence, and stable audit/response hashes. It did not retain the model-originated evidence, thesis, or counterargument, and its cleanup happened after success reporting, so it is not accepted as the required manual walkthrough.

## Blocked Or Deferred

Production encryption, backup/restore, broker reconciliation, desktop background operation, live vendor latency, and hostile descendant containment remain in their owning L2/L3 blocks. WI-008’s scheduler store is deliberately fixture-only ephemeral SQLite; the full immutable paper authority audit remains owned by the WI-005/WI-007 Python boundary. WI-004 remains the proposed aggregate review gate.
