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
owner: unassigned
---

# Prove The Paper Failure And Durable Recovery Matrix

## Outcome

The paper-intent slice handles the complete thirty-scenario L1 matrix and survives a process crash at every durable boundary without duplicate intents, plans, or simulated executions and without reporting a false-ready state.

## Success Criteria

- [ ] Exactly thirty named cases cover accept, reject, abstain, stale, partial and adversarial evidence, missing/reused/rejecting critic, malformed/ambiguous output, auth/rate-limit/timeout/process failure, candidate and intent mismatch, risk denial, partial simulated fill, corrections, restart, and duplicate-job suppression.
- [ ] A fixture-only SQLite-compatible authority store transactionally records operation/idempotency keys and append-only audit events; it rejects non-public data and is explicitly not represented as the future SQLCipher production store.
- [ ] Crash injection after every durable acceptance, gate, plan, fill, and audit boundary proves deterministic recovery, zero duplicate intent/plan/execution, tamper/gap detection, and no readiness before reconciliation completes.
- [ ] Every expected failure has a stable typed code, safe terminal state, and audit linkage; unexpected schema, state, or invariant differences fail fast rather than being retried or coerced.
- [ ] The deterministic gate benchmark runs 1,000 mixed fixtures on the reference host with p95 below 250 ms excluding process startup and broker I/O, and records the reproducible workload and distribution.
- [ ] Hosted checks are limited to behaviors that a fake server cannot prove; the normal thirty-case and recovery suites are deterministic and consume no hosted model capacity.

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

Not yet started; depends on WI-006 review.

## Blocked Or Deferred

Production encryption, backup/restore, broker reconciliation, and hostile descendant containment remain in their owning L2/L3 blocks.
