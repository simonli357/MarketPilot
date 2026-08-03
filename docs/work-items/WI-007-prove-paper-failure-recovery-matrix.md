---
id: WI-007
title: Prove the paper failure and durable recovery matrix
type: task
status: done
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

- [x] Exactly thirty named cases cover accept, reject, abstain, stale, partial and adversarial evidence, missing/reused/rejecting critic, malformed/ambiguous output, auth/rate-limit/timeout/process failure, candidate and intent mismatch, risk denial, partial simulated fill, corrections, restart, and duplicate-job suppression.
- [x] A fixture-only SQLite-compatible authority store transactionally records operation/idempotency keys and append-only audit events; it rejects non-public data and is explicitly not represented as the future SQLCipher production store.
- [x] Crash injection after every durable acceptance, gate, plan, fill, and audit boundary proves deterministic recovery, zero duplicate intent/plan/execution, tamper/gap detection, and no readiness before reconciliation completes.
- [x] Every expected failure has a stable typed code, safe terminal state, and audit linkage; unexpected schema, state, or invariant differences fail fast rather than being retried or coerced.
- [x] The deterministic gate benchmark runs 1,000 mixed fixtures on the reference host with p95 below 250 ms excluding process startup and broker I/O, and records the reproducible workload and distribution.
- [x] Hosted checks are limited to behaviors that a fake server cannot prove; the normal thirty-case and recovery suites are deterministic and consume no hosted model capacity.

## Validation

- Automated: thirty-case system suite, parameterized crash-at-boundary recovery suite, audit-integrity tests, 1,000-fixture gate benchmark, WI-005/WI-006 regressions, Codex regressions, and `npm run project:check`.
- Manual: inspect one recovered accepted operation and one recovered rejected operation across a real process restart, including readiness and audit identity.
- Environment or fixture: Ubuntu reference host, deterministic public fixtures, fake app-server/market/broker, and temporary fixture-only persistence; no account or capital.

## Execution Contract

- Constraints: Preserve the cross-runtime contract and Python authority; recovery may replay observation but never acceptance or simulated submission; no automatic lease reclamation may weaken WI-001 process ownership.
- Boundaries: Add the fixture authority repository, migrations needed only for this public L1 store, crash hooks, scenario corpus, recovery harness, benchmark, focused commands/guidance, and concise WI-007 evidence. Do not add material scheduling, production SQLCipher/key management, real broker calls, or UI.
- Iteration policy: Add one durable boundary and its crash test at a time, then expand the failure matrix by category; rerun the narrow recovery case before the full thirty-case suite and benchmark.
- Blocked stop condition: Stop for architecture review if the Python authority cannot make acceptance and audit persistence atomic enough to prevent duplicates across application restart, or if recovery requires treating unknown state as safe.

## Evidence

- Exact corpus: `SCENARIO_NAMES` contains 30 unique names (`accepted_public_fixture`, `rejected_quantity_limit`, `manager_abstain`, `critic_abstain`, `evidence_stale`, `partial_evidence`, `adversarial_evidence`, `critic_missing`, `critic_reused`, `critic_rejects_policy`, `malformed_manager_output`, `ambiguous_critic_output`, `authority_auth_failure`, `authority_rate_limit_failure`, `authority_timeout`, `authority_process_failure`, `candidate_mismatch`, `intent_mismatch`, `risk_denial`, `partial_simulated_fill`, `correction_revision`, `restart_recovery`, `duplicate_job_suppression`, `candidate_stale`, `intent_stale`, `critic_stale`, `rights_not_public`, `licensed_evidence_rejected`, `time_order_invalid`, `candidate_inactive`). `npm run paper:recovery-matrix` passed with `scenarioCount=30`, `allNamed=true`, `allExpected=true`, `noUnexpectedExposure=true`; agent/transport/simulator cases are explicit typed no-exposure fixture harness cases.
- Durable store: `src/marketpilot/paper_fixture_store.py` uses stdlib SQLite with `fixtureOnly=1`, `productionState=0`, `encryption=none`, private operation/idempotency keys, canonical request/response bytes, append-only audit rows, unique per-operation sequence/hash constraints, exact public MPTEST/PAPER admission, and no broker/account/network/production state. Duplicate requests return the byte-stable stored response; a reused operation key with a different canonical request raises `IDEMPOTENCY_CONFLICT`.
- Recovery: `npm run paper:recovery-boundaries` launched a fresh child process for each of 14 boundaries (`after_operation_begin`, research/candidate/intent/critic/input-audit, gate, plan, fill, terminal, and idempotency commits), exited through the injected crash hook, closed/reopened SQLite, and recovered the same accepted response hash `15802bfdd218e381482049d01cfaa0e7a7d0e83521af20a5097e45862fc9fbeb` with seven audit events and zero duplicate events. Pending readiness stayed false until reconciliation; terminal-commit crashes were already fully reconciled. Tampered event JSON, SQL hash column, metadata/status/phase, and deleted sequence gaps fail closed as `RECOVERY_BLOCKED` and never auto-repair.
- Benchmark: `npm run paper:recovery-benchmark` used fixed seed `20260803`, 10 warmups, exactly 1,000 mixed in-process fixtures (800 accepted / 200 rejected), no startup or broker I/O; reference-host result was p95 `3.3258 ms`, median `2.5200 ms`, max `5.5531 ms`, `withinBudget=true`.
- Automated validation: `npm run test:paper-recovery` (8/8); `npm run check:paper-core`; `npm run test:paper-core` (20/20); `npm run audit:paper-core`; `npm run test:codex` (315/315); `npm run project:check`; `npm audit --omit=dev` (0 vulnerabilities); and `git diff --check` passed.
- Independent review initially identified audit-gap/hash-column repair, metadata reconciliation, permissive LIVE/non-MPTEST admission, in-process-only crash evidence, stale-code/report consistency, and synthetic-case labeling. Fixed by prefix/gap checks, stored-column/hash/status/phase/identity validation, strict fixture admission, child-process crash harness, explicit expected/idempotency codes, and documentation of fixture-only synthetic failure cases. The reviewer reran the focused matrix/recovery/benchmark suite after fixes (30 cases, 14 boundaries, 1,000 fixtures, p95 ~3.3 ms).

## Blocked Or Deferred

Production encryption, backup/restore, broker reconciliation, and hostile descendant containment remain in their owning L2/L3 blocks.
