---
id: WI-005
title: Implement the paper-intent contract and authority seam
type: task
status: done
block: BLK-agent-runtime
release: V1
maturity: L1
requirements: ["IR-001", "QR-002", "SFR-004", "BLK-agent-runtime-R005"]
depends_on: ["WI-001"]
owner: implementation-agent
---

# Implement The Paper-Intent Contract And Authority Seam

## Outcome

On Ubuntu 24.04 x64, one committed `PUBLIC_OFFICIAL` paper-intent bundle crosses a versioned Node-to-Python process boundary and the Python 3.12 authority deterministically produces either an accepted gate decision, one broker-free order plan, one simulated execution, and a verifiable audit chain, or a typed rejection with no order or execution. This establishes the smallest executable state-and-money boundary needed by the real agent slice without claiming that WI-004 or block L1 is complete.

## Success Criteria

- [x] The block's complete `marketpilot.paper-intent-fixture.v1` profile is implemented as the one schema source under `contracts/paper-intent/fixture-l1/v1/`, including every named artifact and process envelope; no profile field, enum, lexical rule, authority assignment, or semantic invariant is widened or silently reinterpreted.
- [x] Both runtimes enforce the profile's closed Draft 2020-12 structural/lexical schemas, NFC/order rules, local-only registry, and input-versus-domain failure split. Node performs no authoritative input linkage, time, rights, critic, or policy decision; Python alone evaluates those domain rules, while Node independently rejects an invalid Python response as a whole.
- [x] The exact fixed-scale decimal grammars cross boundaries as strings and become Python `Decimal` values in a local precision-38 context. JSON financial numbers, exponent notation, non-finite values, invalid scale/sign/range, and forbidden zero/negative values are rejected rather than coerced; collar, exposure, fill, and reporting arithmetic matches the planning-owned rounding rules.
- [x] Node independently validates the untrusted committed manager/critic fixtures, then sends the unchanged bundle to a Python 3.12 entry point over bounded JSON stdio. Only Python creates `GateDecision`, `OrderPlan`, `ExecutionEvent`, and authoritative audit events; Node cannot manufacture or override an acceptance.
- [x] The accepted golden fixture satisfies the exact public-rights, time, hash/linkage, distinct-critic, fixture-policy, 50-bps collar, USD 100 notional, and marketable-ask rules; Python alone produces the expected accepted decision, one SMART simulation-only limit plan, and one full simulated fill.
- [x] The quantity-two golden fixture returns primary `QUANTITY_LIMIT_EXCEEDED` plus `NOTIONAL_LIMIT_EXCEEDED`, while each planned missing/rejecting critic, reused identity, linkage, time, rights, and policy case returns the profile's deterministic domain-code ordering. Domain rejection is audited with zero plan/execution; malformed/contract/hash input error returns only the fixed redacted protocol envelope and no domain artifact.
- [x] With the request clock and deterministic ID formula, identical canonical inputs produce byte-identical decisions and hashes; decision-relevant changes alter the appropriate hash, input bytes and objects are not mutated, response/audit verification passes, and modification, deletion, insertion, reordering, or artifact substitution is detected with the documented unanchored-audit limitation.
- [x] A headless accepted and rejected fixture command emits a redaction-safe summary that lets a reviewer trace evidence, intent, critic, gate, plan/fill presence, and audit identities without prompts, secrets, licensed data, account data, or broker access.
- [x] Any new Python or schema dependency is minimal, reproducibly pinned, and documented with its license, maintenance/security posture, Python 3.12 support, integration cost, and replacement boundary. Normal commands cover static checks, focused tests, existing Codex regressions, project validation, and dependency audit.

## Validation

- Automated: introduce and pass `npm run check:paper-core`, `npm run test:paper-core`, `npm run audit:paper-core`, `npm run test:codex`, `npm run project:check`, and `npm audit`; the focused suite includes cross-runtime golden-contract parity and parameterized accept/reject boundary cases, while the audit command covers the reproducibly locked Python dependency graph.
- Manual: run `npm run paper:fixture -- --case accepted` and `npm run paper:fixture -- --case rejected`, inspect the redaction-safe artifact linkage, and confirm the rejected report contains no plan or execution.
- Environment or fixture: native Ubuntu 24.04 x86_64, Node 22, Python 3.12, deterministic clocks/IDs, and committed `PUBLIC_OFFICIAL` fixtures only. Real Codex turns, SQLCipher production state, IBKR, account data, licensed data, and capital are excluded.

## Execution Contract

- Constraints: Preserve every WI-001 isolation and regression guarantee; implement the block's fixture profile exactly; keep Python the sole deterministic authority; use one canonical schema source; fail closed without coercion, silent fallback, hidden downgrade, fake success, or duplicated Node/Python business rules.
- Boundaries: Changes may add shared paper-intent schemas, the smallest Node validator/process adapter and fixture CLI, a cohesive Python 3.12 contract/gate/simulator/audit package, committed public fixtures, focused tests, reproducible dependency metadata, commands/developer guidance, and concise WI-005 evidence. Do not add real hosted turns, persistent production storage, a broker method, UI, scheduler, full portfolio policy, or later WI-006 through WI-008 behavior.
- Iteration policy: Start with one schema and the rejected path, make Node and Python agree on the same golden artifact, add the accepted deterministic path, then add one fail-closed invariant at a time; rerun the narrow case before the full paper-core and Codex suites.
- Blocked stop condition: Stop and request a planning review if one canonical schema and canonical decimal/hash semantics cannot be preserved across Node and Python without conflicting contract authorities, or if a required dependency/toolchain choice would change the approved Python-authority architecture; report the exact invariant and smallest decision needed.

## Evidence

Implemented the dependency-free Python 3.12 authority and local Draft 2020-12 registry, closed Node validator, bounded original-byte stdio adapter, deterministic fixtures, simulator, and tamper-evident in-memory audit. `npm run check:paper-core` passed registry/ref checks, Node/Python accepted and quantity-two parity, Python focused tests (13/13), and immutability. `npm run test:paper-core` passed 12/12, including non-public rights reaching Python, forged response-reference and nullable-critic-reference rejection, exact reason-code ordering, unresolved critic-evidence rejection, decimal/range/Unicode rejection, early-process exit, and audit tamper detection. `npm run audit:paper-core`, `npm run test:codex` (314/314), `npm audit --omit=dev` (0 vulnerabilities), `npm run project:check`, and `git diff --check` passed. Manual `npm run paper:fixture -- --case accepted` reported `ACCEPTED`, plan `99.4950`, fill `99.2500`, seven audit events; `--case rejected` reported `REJECTED`, primary `QUANTITY_LIMIT_EXCEEDED`, secondary `NOTIONAL_LIMIT_EXCEEDED`, and null plan/execution. Independent review found and fixed the Node rights-domain leak, forged rehashed input-reference substitution, nullable hash-pair gap, reason-code ambiguity, unresolved critic evidence, stdin EPIPE crash, deep-JSON traceback, Unicode length parity, ratio range parity, and identifier coercion; regressions have focused tests. No secrets, account/broker/licensed data, network, persistence, or live authority are used; Python dependency graph is empty and the registry is local-only.

## Blocked Or Deferred

Real manager/critic orchestration, durable restart recovery, the thirty-scenario matrix, partial fills, the three-minute scheduler, the two-hour soak, SQLCipher production storage, broker integration, and UI remain owned by WI-006 through WI-008 or their later blocks.
