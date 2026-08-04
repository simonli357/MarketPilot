---
id: WI-005
title: Implement the paper-intent contract and authority seam
type: task
status: ready
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

- [ ] The block's complete `marketpilot.paper-intent-fixture.v1` profile is implemented as the one executable schema source under `contracts/paper-intent/fixture-l1/v1/`, including every named artifact and process envelope; no profile field, enum, lexical rule, authority assignment, or semantic invariant is widened or silently reinterpreted.
- [ ] Both runtimes execute the profile's closed Draft 2020-12 structural/lexical schemas with format assertion, NFC/order rules, and local-only reference resolution before their separate semantic checks. Differential mutation tests prove that Node and Python agree on every schema boundary. Node performs no authoritative input linkage, time, rights, critic, or policy decision; Python alone evaluates those domain rules, while Node independently rejects an invalid Python response as a whole.
- [x] The exact fixed-scale decimal grammars cross boundaries as strings and become Python `Decimal` values in a local precision-38 context. JSON financial numbers, exponent notation, non-finite values, invalid scale/sign/range, and forbidden zero/negative values are rejected rather than coerced; collar, exposure, fill, and reporting arithmetic matches the planning-owned rounding rules.
- [ ] Node independently validates the untrusted committed manager/critic fixtures, then sends the unchanged bundle to a Python 3.12 entry point over bounded JSON stdio. Only Python creates `GateDecision`, `OrderPlan`, `ExecutionEvent`, and authoritative audit events. The first three artifact schemas require `producer.kind = PYTHON_AUTHORITY`; the producer-less audit shape is protected by its Python-only construction path plus Node's exact sequence/subject/hash/chain verification. Node rejects the response as a whole if explicit or implicit ownership is forged.
- [x] The accepted golden fixture satisfies the exact public-rights, time, hash/linkage, distinct-critic, fixture-policy, 50-bps collar, USD 100 notional, and marketable-ask rules; Python alone produces the expected accepted decision, one SMART simulation-only limit plan, and one full simulated fill.
- [ ] The quantity-two golden fixture returns primary `QUANTITY_LIMIT_EXCEEDED` plus `NOTIONAL_LIMIT_EXCEEDED`, while each planned missing/rejecting critic, reused identity, linkage, time, rights, and policy case returns the profile's deterministic domain-code ordering. The closed reason collection is capped at the exact 26 frozen domain codes. Every provenance entry is referenced and participates in strictest-rights inheritance. Domain rejection is audited with zero plan/execution; malformed/contract/hash input error returns only the fixed redacted protocol envelope and no domain artifact.
- [x] With the request clock and deterministic ID formula, identical canonical inputs produce byte-identical decisions and hashes; decision-relevant changes alter the appropriate hash, input bytes and objects are not mutated, response/audit verification passes, and modification, deletion, insertion, reordering, or artifact substitution is detected with the documented unanchored-audit limitation.
- [x] A headless accepted and rejected fixture command emits a redaction-safe summary that lets a reviewer trace evidence, intent, critic, gate, plan/fill presence, and audit identities without prompts, secrets, licensed data, account data, or broker access.
- [ ] Any new Python or schema dependency is minimal, reproducibly pinned, and documented with its license, maintenance/security posture, Python 3.12 support, integration cost, and replacement boundary. Normal commands cover static checks, focused tests, existing Codex regressions, project validation, and dependency audit.

## Validation

- Automated: introduce and pass `npm run check:paper-core`, `npm run test:paper-core`, `npm run audit:paper-core`, `npm run test:codex`, `npm run project:check`, and `npm audit`; the focused suite includes cross-runtime golden-contract parity and parameterized accept/reject boundary cases, while the audit command covers the reproducibly locked Python dependency graph.
- Manual: run `npm run paper:fixture -- --case accepted` and `npm run paper:fixture -- --case rejected`, inspect the redaction-safe artifact linkage, and confirm the rejected report contains no plan or execution.
- Environment or fixture: native Ubuntu 24.04 x86_64, Node 22, Python 3.12, deterministic clocks/IDs, and committed `PUBLIC_OFFICIAL` fixtures only. Real Codex turns, SQLCipher production state, IBKR, account data, licensed data, and capital are excluded.

## Execution Contract

- Constraints: Preserve every WI-001 isolation and regression guarantee; implement the block's fixture profile exactly; keep Python the sole deterministic authority; use the committed Draft schemas as the executable structural/lexical source in both runtimes; keep handwritten code to semantic invariants and safe transport only; fail closed without coercion, silent fallback, hidden downgrade, fake success, or duplicated Node/Python business rules. Input/audit collections remain capped at 16, while `reasonCodes` is capped at the exact 26-code frozen domain set.
- Boundaries: Changes may add shared paper-intent schemas, the smallest Node validator/process adapter and fixture CLI, a cohesive Python 3.12 contract/gate/simulator/audit package, committed public fixtures, focused tests, reproducible dependency metadata, commands/developer guidance, and concise WI-005 evidence. Do not add real hosted turns, persistent production storage, a broker method, UI, scheduler, full portfolio policy, or later WI-006 through WI-008 behavior.
- Iteration policy: First make every committed schema executable in both runtimes and run differential mutations for each field, enum, pattern, bound, conditional, producer, and local reference. Then repair rights aggregation and producer ownership, rerun the narrow case, and only then run golden parity plus the full paper-core and Codex suites.
- Blocked stop condition: Stop and request a planning review if one canonical schema and canonical decimal/hash semantics cannot be preserved across Node and Python without conflicting contract authorities, or if a required dependency/toolchain choice would change the approved Python-authority architecture; report the exact invariant and smallest decision needed.

## Evidence

The 2026-08-04 WI-004 independent review rejected this completion. The committed schemas were only metadata-loaded while handwritten validators diverged: Python accepted a lowercase `strategyKind` and a 129-character `sourceRevision`; an unreferenced `LOCAL` provenance entry was accepted; Node accepted a rehashed Python output whose execution producer was `MANAGER`; and the planned 16-item collection rule conflicted with 26 possible reason codes. The corrective contract above resolves the planning ambiguity at 26 reason codes and requires executable cross-runtime schemas, full provenance rights inheritance, exact output ownership, and new dependency review.

Initial candidate evidence: the dependency-free Python 3.12 authority, metadata-only local registry, handwritten Node validator, bounded original-byte stdio adapter, deterministic fixtures, simulator, and tamper-evident in-memory audit passed the then-current paper-core, Codex, project, dependency, fixture, and tamper checks. Those checks found several earlier bugs but did not execute the committed schemas or expose the cross-runtime, provenance, and forged-output-ownership defects recorded above. They remain useful regression evidence, not accepted completion evidence. No secrets, account/broker/licensed data, network, persistence, or live authority were used.

## Blocked Or Deferred

Real manager/critic orchestration, durable restart recovery, the thirty-scenario matrix, partial fills, the three-minute scheduler, the two-hour soak, SQLCipher production storage, broker integration, and UI remain owned by WI-006 through WI-008 or their later blocks.
