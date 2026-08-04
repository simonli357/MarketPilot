---
id: WI-007
title: Prove the paper failure and durable recovery matrix
type: task
status: proposed
block: BLK-agent-runtime
release: V1
maturity: L1
requirements: ["IR-001", "QR-002", "SFR-004", "BLK-agent-runtime-R005", "BLK-agent-runtime-R006"]
depends_on: ["WI-006"]
owner: implementation-agent
---

# Prove The Paper Failure And Durable Recovery Matrix

## Outcome

The paper-intent slice handles the complete thirty-scenario L1 matrix and survives a process crash at every durable boundary without duplicate intents, plans, or simulated executions and without reporting a false-ready state.

## Success Criteria

- [ ] The canonical thirty-row scenario manifest below is executable: each independently constructed stimulus enters its named owned agent, MCP, transport, authority, simulator, correction, persistence, or recovery API and proves that boundary ran. No scenario helper receives its expected code or copies it into the observed result. Together the rows cover accept, reject, abstain, stale, partial and adversarial evidence, missing/reused/rejecting critic, malformed/ambiguous output, auth/rate-limit/timeout/process failure, candidate and intent mismatch, risk denial, partial simulated fill, corrections, restart, and duplicate-job suppression.
- [ ] A fixture-only SQLite authority store implements the exact concurrent-claim semantics below, persists canonical append-only authority artifacts/audits and app incidents, rejects non-public data, and is explicitly not represented as the future SQLCipher production store. A barrier-synchronized eight-process campaign uses exactly 100 fresh same-request operation keys, followed by conflicting replays against all 100 terminal keys. Every caller returns a typed result; same-request callers converge on one byte-identical terminal result; every changed-request replay returns only `IDEMPOTENCY_CONFLICT`; final readiness is true; and there is exactly one final artifact/audit chain per operation with no raw SQLite error or blocked completed row.
- [ ] The exact durable state machine below atomically commits each artifact with its corresponding audit event and phase update. One post-commit crash hook exists per real commit and no two hooks alias the same fingerprint. Reopening the store follows the declared recovery result using persisted state only; duplicate/recovery calls never invoke evaluation, acceptance, planning, fill simulation, or simulated submission again. The campaign proves zero duplicate intent/plan/execution, rollback at interrupted transactions, tamper/gap detection, and no readiness before reconciliation completes.
- [ ] Every expected failure is caused through its real boundary and reaches a stable typed safe terminal state plus either an authority audit link or the block's append-only `AppIncidentEvent` identity when that failure outcome is outside the authority result. A side-ledger incident never replaces or mutates an existing authority result/audit. No expected case reports zero linkage or uses a synthetic expected-to-observed shortcut; unexpected schema, state, or invariant differences fail fast rather than being caught and relabeled as an expected failure.
- [ ] The deterministic gate benchmark runs 1,000 mixed fixtures on the reference host with p95 below 250 ms excluding process startup and broker I/O, records the reproducible workload and distribution, and can report success only when all 1,000 outcomes are expected and `ERROR` is exactly zero.
- [x] Hosted checks are limited to behaviors that a fake server cannot prove; the normal thirty-case and recovery suites are deterministic and consume no hosted model capacity.

## Validation

- Automated: thirty-case system suite; parameterized transaction/crash-state recovery suite; audit/incident-integrity tests; the exact eight-process 100-key same-request plus 100-key terminal-conflict campaign; deliberately held live-owner cases for both same-request `OPERATION_IN_PROGRESS` and changed-request `IDEMPOTENCY_CONFLICT`; 1,000-fixture gate benchmark; WI-005/WI-006 regressions; Codex regressions; and `npm run project:check`.
- Manual: inspect one recovered accepted operation and one recovered rejected operation across a real process restart, including readiness and audit identity.
- Environment or fixture: Ubuntu reference host, deterministic public fixtures, fake app-server/market/broker, and temporary fixture-only persistence; no account or capital.

## Execution Contract

- Constraints: Preserve the cross-runtime contract and Python authority. The normal owner may invoke the staged gate, planner, and simulator exactly once after winning an atomic claim; an idempotent duplicate or recovery path may inspect and serialize already-persisted observations but must never call request evaluation, acceptance, planning, fill simulation, or simulated submission. No automatic lease reclamation may weaken WI-001 process ownership.
- Boundaries: Add the fixture authority repository, fixture-only artifact/terminal/incident tables and migrations, staged authority entry points that preserve WI-005 output semantics, the explicit partial-fill fault seam and correction submission API named in the manifest, crash hooks, scenario corpus, recovery/concurrency harnesses, benchmark, focused commands/guidance, and concise WI-007 evidence. Do not add material scheduling, production SQLCipher/key management, real broker calls, or UI.
- Iteration policy: Implement the scenario manifest and append-only incident record without expected-result injection, then make operation claiming atomic and stress it concurrently. Add the state-machine transactions one at a time with their fingerprints, rollback checks, and crash hook; rerun the narrow state before the full thirty-case suite, concurrency campaign, and benchmark.
- Blocked stop condition: Stop for architecture review if the Python authority cannot make acceptance and audit persistence atomic enough to prevent duplicates across application restart, or if recovery requires treating unknown state as safe.

## Concurrent Claim Semantics

The operation key and canonical request hash are claimed together in one SQLite transaction before any evaluation. The winner owns the operation under the supervisor's exclusive live-owner token. A same-key/same-request caller waits within the fixed two-second authority deadline for that live owner and returns its exact stored terminal bytes; if the owner is still live and pending at the deadline, the caller appends an `OPERATION_IN_PROGRESS` incident without changing the operation. A same-key/different-request caller always appends and returns `IDEMPOTENCY_CONFLICT`, whether the operation is pending or terminal, and cannot mutate it. Ordinary callers never invoke recovery or mark a peer-owned row blocked.

Recovery requires the exclusive store recovery lease plus supervisor proof that no prior owner process remains. A completed or aborted operation is immutable and returns its stored terminal authority response or incident bytes. SQLite busy/unique conflicts are translated at the repository boundary into the semantics above; no raw database exception crosses it.

## Durable State Machine

The immutable operation fingerprint is `(phase, requestHash, ordered artifactType/artifactHash pairs, auditCount, auditHeadHash, terminalHash-or-null, terminalIncidentHash-or-null)`. Its separate append-only incident-ledger fingerprint is `(incidentCount, incidentHeadHash-or-null)`, so observer/conflict incidents do not mutate a peer operation while still leaving a unique durable trace. An artifact and its matching authority audit event, plus the phase update, share one transaction. Terminal bytes and the idempotency result index also share one transaction. The crash harness has one uniquely named hook immediately after each state-changing commit and after the first instance of each side-ledger behavior below; a separate mid-transaction kill proves rollback to the previous fingerprint and is not counted as another durable boundary.

| Phase after commit | Atomic transaction contents | Normal owner action | Restart/recovery result |
| --- | --- | --- | --- |
| `CLAIMED` | operation key, canonical request bytes/hash, live-owner token | validate/persist research; later invoke staged authority once | atomically append `RECOVERY_INCOMPLETE`, mark `ABORTED`, no exposure |
| `RESEARCH_RECORDED` | `ResearchEvent` + audit sequence 1 | persist candidate | same fail-closed abort |
| `CANDIDATE_RECORDED` | `CandidateManifest` + next audit | persist intent | same fail-closed abort |
| `INTENT_RECORDED` | `TradeIntent` + next audit | persist critic when present, otherwise invoke the gate | same fail-closed abort |
| `CRITIC_RECORDED` | `CriticVerdict` + next audit | invoke the gate | same fail-closed abort |
| `GATE_REJECTED` | rejected `GateDecision` + next audit | serialize the rejected authority response | serialize only these persisted artifacts, then atomically publish `TERMINAL` |
| `GATE_ACCEPTED` | accepted `GateDecision` + next audit | create/persist the plan once | append `RECOVERY_INCOMPLETE`, mark `ABORTED`; never plan during recovery |
| `PLAN_RECORDED` | `OrderPlan` + next audit | simulate once; a full observation persists `EXECUTION_RECORDED`, while a partial observation atomically appends `PARTIAL_FILL_UNSUPPORTED` and marks `ABORTED` | append `RECOVERY_INCOMPLETE`, mark `ABORTED`; never simulate during recovery |
| `EXECUTION_RECORDED` | `ExecutionEvent` + next audit | serialize the accepted authority response | serialize only these persisted artifacts, then atomically publish `TERMINAL` |
| `TERMINAL` | canonical authority response bytes/hash + result index | return stored bytes | return the same stored bytes |
| `ABORTED` | one append-only `AppIncidentEvent` + immutable aborted status | return stored incident bytes | return the same stored incident bytes |
| unchanged phase + observer incident | append `OPERATION_IN_PROGRESS` to the scope's incident chain only | return that incident; do not touch the live owner | operation fingerprint and owner remain unchanged after restart |
| unchanged phase + conflict incident | append `IDEMPOTENCY_CONFLICT` to the scope's incident chain only | return that incident; do not touch the claimed request/result | operation fingerprint remains unchanged after restart |

The accepted branch is `CLAIMED → RESEARCH_RECORDED → CANDIDATE_RECORDED → INTENT_RECORDED → CRITIC_RECORDED → GATE_ACCEPTED → PLAN_RECORDED → EXECUTION_RECORDED → TERMINAL`. A rejected branch ends at `GATE_REJECTED → TERMINAL`, with `CRITIC_RECORDED` omitted only when the request itself has a null critic. No alias hook is allowed for two names after one commit, and no phase-only commit is allowed.

## Scenario Manifest

Each runner constructs its stimulus independently, invokes the named production boundary or an explicit fault seam on that boundary, and captures an observed `entryPoint` plus a boundary-generated trace/record identity. The comparator owns expected codes separately; expected values are never arguments to the entry point. An authority row must return a verified response/audit head, and an app/store row must return a persisted `AppIncidentEvent.incidentHash`; an unexpected exception fails the matrix immediately.

| Scenario | Independently constructed stimulus and owned entry point | Required observed result and proof |
| --- | --- | --- |
| `accepted_public_fixture` | Canonical accepted request through `FixtureAuthorityStore.process` | `ACCEPTED`; verified gate/plan/execution and authority head |
| `rejected_quantity_limit` | Quantity `2.000000`, rehashed, through the store/authority | `QUANTITY_LIMIT_EXCEEDED` plus `NOTIONAL_LIMIT_EXCEEDED`; rejected head, no plan/execution |
| `manager_abstain` | Fake-runtime manager emits a schema-valid `ABSTAIN` semantic draft; real binder/store path | `INTENT_ABSTAINED`; rejected authority head |
| `critic_abstain` | Fake-runtime critic emits a schema-valid `ABSTAIN` draft; real binder/store path | `CRITIC_ABSTAINED`; rejected authority head |
| `evidence_stale` | Research observed one millisecond beyond the age limit, rehashed, through authority | `EVIDENCE_STALE`; rejected authority head |
| `partial_evidence` | Manager draft selects only the valid notice and reference-price fact IDs, omitting the valid ask-price ID; real binder/store path | `INTENT_EVIDENCE_MISMATCH`; rejected authority head |
| `adversarial_evidence` | Fixture MCP returns a fully rehashed event with an extra unreferenced `LOCAL` provenance row while claiming `PUBLIC_OFFICIAL`; real MCP-result validation | `MCP_CONTRACT_INVALID`; `MCP` incident and proof the validator consumed the tool result |
| `critic_missing` | Fake critic produces an explicit missing-terminal outcome; orchestrator passes null critic to authority | `CRITIC_MISSING`; rejected authority head |
| `critic_reused` | Valid artifacts reuse the manager run ID for the critic; store/authority path | `CRITIC_NOT_DISTINCT`; rejected authority head |
| `critic_rejects_policy` | Fake-runtime critic originates a valid rejecting semantic draft; binder/store path | `CRITIC_REJECTED`; rejected authority head |
| `malformed_manager_output` | Fake app-server emits malformed manager final JSON through structured-turn parsing | `MANAGER_OUTPUT_INVALID`; `MANAGER_OUTPUT` incident and parser trace |
| `ambiguous_critic_output` | Fake app-server emits multiple/ambiguous critic terminal messages through structured-turn parsing | `CRITIC_OUTPUT_INVALID`; `CRITIC_OUTPUT` incident and parser trace |
| `authority_auth_failure` | Fake role runtime returns the real app-server authentication failure at turn start | `AUTH_REQUIRED`; `AUTHENTICATION` incident and failed request identity |
| `authority_rate_limit_failure` | Fake role runtime returns the real rate-limit protocol failure at turn start | `RATE_LIMITED`; `HOSTED_SERVICE` incident and failed request identity |
| `authority_timeout` | Real Node authority adapter launches the explicit hanging-child fault fixture | `AUTHORITY_TIMEOUT`; process-group cleanup proof plus transport incident |
| `authority_process_failure` | Real Node authority adapter launches the explicit early-exit child fixture | `AUTHORITY_PROCESS_FAILED`; process cleanup proof plus transport incident |
| `candidate_mismatch` | Rehashed intent references another candidate; store/authority path | `INTENT_CANDIDATE_MISMATCH`; rejected authority head |
| `intent_mismatch` | Rehashed intent references another research event; store/authority path | `INTENT_EVIDENCE_MISMATCH`; rejected authority head |
| `risk_denial` | Candidate policy differs from the built-in fixture limit; store/authority path | `FIXTURE_POLICY_MISMATCH`; rejected authority head |
| `partial_simulated_fill` | Accepted gate/plan through the staged simulator's explicit partial-observation fault seam | `PARTIAL_FILL_UNSUPPORTED`; `SIMULATOR` incident, one simulator invocation, no persisted execution |
| `correction_revision` | Completed operation plus a valid superseding research revision submitted to `submit_correction` with the old operation key | `CORRECTION_REQUIRES_NEW_OPERATION`; `CORRECTION` incident and byte-unchanged original result |
| `restart_recovery` | Child crash once after `GATE_REJECTED` and once after `EXECUTION_RECORDED`, then controlled process restart | persisted rejected/accepted terminal responses respectively; recovery trace, same artifact hashes, ready after reconcile |
| `duplicate_job_suppression` | Barrier-synchronized same-key/same-request contenders through `process` | byte-identical terminal bytes, one operation/artifact/audit chain, ready true |
| `candidate_stale` | Candidate `validUntil` one millisecond before decision time | `CANDIDATE_INACTIVE`; rejected authority head |
| `intent_stale` | Intent expiry one millisecond before decision time | `INTENT_STALE`; rejected authority head |
| `critic_stale` | Critic expiry one millisecond before decision time | `CRITIC_STALE`; rejected authority head |
| `rights_not_public` | Event/fact rights set to `LOCAL_RESTRICTED` through store admission | `NON_PUBLIC_DATA_REJECTED`; `FIXTURE_STORE` incident, no operation claim |
| `licensed_evidence_rejected` | Provenance source set to `LICENSED_VENDOR` through store admission | `NON_PUBLIC_DATA_REJECTED`; `FIXTURE_STORE` incident, no operation claim |
| `time_order_invalid` | Rehashed intent timestamp precedes the observed event | `TIME_ORDER_INVALID`; rejected authority head |
| `candidate_inactive` | Candidate `validFrom` one millisecond after decision time | `CANDIDATE_INACTIVE`; rejected authority head |

## Evidence

The 2026-08-04 WI-004 independent review rejected this completion. Nine of the thirty scenarios returned a typed fixture assembled directly from the scenario's expected result rather than exercising an agent, transport, authority, simulator, or incident-audit path. The fourteen named crash hooks collapsed to nine logical database states, and recovery called `evaluate_request` again, replaying acceptance and simulated execution instead of observing persisted artifacts. A fresh eight-worker concurrency probe reproduced nine failures in twenty runs, including an untyped SQLite integrity error and `RECOVERY_BLOCKED` outcomes alongside successful calls for the same operation. The benchmark also treated a run as within budget without requiring `ERROR = 0`. The corrective criteria above require real failure paths, atomic claims, non-replaying recovery, materially distinct persisted boundaries, and a non-vacuous benchmark pass gate.

- Initial matrix diagnostic: the command listed the same 30 names and reported `allExpected=true`, but nine agent/transport/simulator rows copied their manifest expectation into a fabricated failure result and carried no audit/incident identity. It proves only that the candidate report enumerated the names.
- Initial store diagnostic: the fixture-only SQLite candidate persisted request/response bytes and audit rows and passed sequential replay/tamper checks. It did not atomically claim operations; multiprocess contention produced raw integrity errors, mixed outcomes, and blocked completed rows.
- Initial recovery diagnostic: the command reported fourteen named hooks and a recovered accepted hash, but hook pairs shared database states and `recover()` reran `evaluate_request`, including gate/plan/simulation. It is superseded by the exact state machine above.
- Initial benchmark diagnostic: seed `20260803`, 10 warmups, and 1,000 fixtures produced 800 accepted / 200 rejected / 0 errors with p95 about `3.3 ms`. The workload is useful, but the command's prior pass predicate ignored nonzero errors and is not acceptance evidence.
- Initial regression diagnostics passed 8 recovery tests, 20 paper-core tests, 315 Codex tests, project/dependency checks, and focused tamper cases. They did not cover the adversarial scenario, state-alias, non-replay, or atomic-concurrency findings and remain regression baselines only.

## Blocked Or Deferred

Production encryption, backup/restore, broker reconciliation, and hostile descendant containment remain in their owning L2/L3 blocks. This L1 chain detects local row/sequence/hash tampering but is not externally anchored; an attacker able to coherently rewrite the entire database remains an explicit deferred limitation rather than a claim this fixture store can prove.
