---
id: BLK-agent-runtime
title: Isolated Codex reasoning runtime
status: in_progress
maturity: L0
release: V1
requirements: ["FR-002", "FR-006", "IR-001", "QR-002", "SFR-004"]
depends_on: []
ui: false
---

# Isolated Codex Reasoning Runtime

## Outcome

MarketPilot can run a pinned, isolated, ChatGPT-authenticated Sol Ultra manager and bounded specialists that consume rights-filtered context and emit schema-valid research, criticism, reflection, and immutable trade intents. Every output remains untrusted until the Python authority accepts it, and agent failure cannot create new exposure.

## Requirements

| ID | Requirement | Priority | Important failure or edge | Work item, spike, or deferral | Verification |
| --- | --- | --- | --- | --- | --- |
| BLK-agent-runtime-R001 | Launch the exact pinned Codex app-server over stdio with stable APIs, strict config, and verified schema/binary identity. | Must | The app-server command is compatibility-sensitive and may add fields or change behavior. | WI-001 | Compatibility probe checks version, hashes, handshake, stable methods, and additive-field policy. |
| BLK-agent-runtime-R002 | Use a private app-owned home, keyring-only ChatGPT auth, minimal environment, read-only sandbox, approvals never, exact skills/MCP, and no model-visible shell/web/mutation tools. | Must | A fresh home still includes bundled skills; the stable protocol exposes dangerous methods and server requests. | WI-001 | Inventory/allowlist tests plus authenticated keyring and runtime inspection. |
| BLK-agent-runtime-R003 | Require `gpt-5.6-sol` with effort `ultra` by default and fail readiness on absence, reroute, or silent downgrade. | Must | Catalog presence without authentication does not prove account entitlement. | WI-001 | Startup `model/list`, effective thread settings, authenticated turn, and reroute rejection. |
| BLK-agent-runtime-R004 | Explicitly orchestrate a manager and an independent critic for every new/increased exposure; Ultra delegation is optional support, never the safety mechanism. | Must | Ultra does not guarantee delegation and specialists may fail or time out. | WI-006, WI-004 | Fixture path requires distinct typed manager and critic artifacts before acceptance. |
| BLK-agent-runtime-R005 | Constrain final messages with JSON Schema, parse and validate independently, enforce deadlines, coalesce material events, and expose typed auth/rate-limit/crash/schema failures. | Must | Final structured text may be missing, malformed, ambiguous, late, or associated with a failed turn. | WI-001, WI-005, WI-006, WI-007, WI-008, WI-004 | Shared cross-runtime contracts, fake-server failure coverage, and the real L1 scenario matrix. |
| BLK-agent-runtime-R006 | Prove one public/fixture event through manager, critic, deterministic gate, simulated execution, and immutable audit before broader capability work. | Must | A successful chat response alone does not prove the product boundary. | WI-006, WI-007, WI-008, WI-004 | Real fixture slice, thirty-scenario suite, restart/idempotency proof, two-hour soak, and manual acceptance gate. |
| BLK-agent-runtime-R007 | Resolve protection for app-server transcript and SQLite state before real portfolio or licensed context enters durable threads. | Must | Codex persists plaintext rollout and SQLite files that SQLCipher does not protect. | WI-001 | Storage inventory and an evidence-backed decision: encrypted filesystem or ephemeral rehydrated threads. |

## Boundary

- Owns: pinned app-server process, configuration, authentication state, protocol client, model/effort verification, skills and agent definitions, MCP registration, thread/turn lifecycle, output validation, deadlines, subagent telemetry, and agent readiness.
- Does not own: market/broker data acquisition, portfolio state, qualification truth, risk decisions, order construction/submission, credentials outside Codex, or live authorization.
- Inputs and outputs: rights-filtered evidence/context and typed user requests in; versioned `TradeIntent`, `CriticVerdict`, research, reflection, and observable runtime events out.
- Dependencies: OpenAI/ChatGPT service and app-owned MCP; the L0 spike uses fixtures and no broker dependency.

## Contracts And Failure

- Initialize once per process connection, then use only app-allowlisted stable methods. Outbound methods/fields, server-initiated requests, notifications, item types, enabled skills, and MCP tools are exact allowlists; unexpected capability fails the current turn closed.
- Accept additive response fields only when known required fields and types remain valid; never consume undocumented fields for safety or control.
- A manager thread becomes durable only after its first successful terminal bootstrap turn. A crash before materialization starts fresh rather than attempting an invalid resume.
- `turn/start.outputSchema` constrains the final assistant text; MarketPilot still requires terminal `turn/completed`, one unambiguous final agent message, JSON parsing, local schema validation, candidate match, and deadline validity.
- `model/rerouted`, missing Sol Ultra entitlement, authentication expiry, rate limit, malformed output, forbidden request, unexpected tool/item, timeout, process exit, or schema mismatch yields no new exposure and a typed incident.
- Mandatory criticism is a separate app-launched thread/turn with no manager transcript and a typed verdict. A manager may use bounded Ultra workers for research, but their existence does not satisfy the critic requirement.

## L1 Fixture Contract Profile

WI-005 implements the closed `marketpilot.paper-intent-fixture.v1` profile and `FIXTURE_LONG_US_EQUITY_100_V1` policy below. They are deterministic L1 test oracles, not production market-data, portfolio, risk, execution, or audit contracts: they accept only synthetic `MPTEST` paper input, cannot arm live trading, and must not be imported as a production policy. Later cross-block contracts extend or replace this profile under a new version after their owning blocks are active.

### Schema And Ownership

- The only schema source is `contracts/paper-intent/fixture-l1/v1/`, using JSON Schema Draft 2020-12. Every schema has a stable `urn:marketpilot:paper-intent-fixture:v1:<name>` `$id`, `schemaVersion: { "const": 1 }`, and `profile: { "const": "marketpilot.paper-intent-fixture.v1" }`.
- Every object is closed with `additionalProperties: false`; conditional branches also use `unevaluatedProperties: false`. Validators enable format assertion, resolve only the committed local registry, and reject unknown references. Adding a field or enum, relaxing a constraint, or changing semantics requires a new schema/profile rather than widening V1.
- Strings are valid Unicode NFC and are rejected rather than normalized. Opaque IDs, enums, hashes, keys, and reason codes are ASCII. Text is 1–1,024 characters without control characters. Collections contain at most 16 entries; identifier-keyed collections are unique and already sorted lexicographically. Validators reject unsorted input rather than silently rewriting it.
- The opaque fields `requestId`, `operationId`, every artifact/fact/provenance/revision/audit ID, and `producer.runId` match `^[a-z][a-z0-9_]{2,63}$` and use the prefixes `req_`, `op_`, `re_`, `rev_`, `fact_`, `prov_`, `cand_`, `ti_`, `cv_`, `gd_`, `plan_`, `exec_`, `audit_`, `ae_`, or `run_` according to type. Symbolic fields are separate: `instrumentId` matches `^[A-Z][A-Z0-9.]{0,9}$`, currency matches `^[A-Z]{3}$`, `sourceId` matches `^[a-z][a-z0-9.-]{2,63}$`, and profile/policy/artifact/enum values use their exact declared constants. Hashes are 64 lowercase hexadecimal characters.
- A `producer` is the closed object `{ kind, runId }`. Producer kinds are `FIXTURE_SOURCE`, `FIXTURE_REGISTRY`, `MANAGER`, `CRITIC`, and `PYTHON_AUTHORITY`; manager and critic `runId` values must differ.

| Artifact | Producer | Authority in this profile |
| --- | --- | --- |
| `ResearchEvent` | committed `FIXTURE_SOURCE` | Rights-safe input only |
| `CandidateManifest` | committed `FIXTURE_REGISTRY` | Frozen input only |
| `TradeIntent` | committed stand-in for `MANAGER` in WI-005; real manager in WI-006 | Untrusted input |
| `CriticVerdict` | committed stand-in for `CRITIC` in WI-005; real critic in WI-006 | Untrusted input |
| `GateDecision`, `OrderPlan`, `ExecutionEvent`, `AuditEvent` | `PYTHON_AUTHORITY` | Python creates; Node may validate but never create, amend, or repair |

### Lexical And Hash Rules

Only `schemaVersion` and audit `sequence` are JSON numbers. Decision-affecting financial values are strings parsed with Python `Decimal` in a local precision-38 context; no binary float, coercion, global decimal-context change, whitespace, sign where forbidden, exponent, omitted part, leading zero, `NaN`, or infinity is accepted.

| Primitive | Canonical grammar | Range |
| --- | --- | --- |
| `UtcTimestamp` | `YYYY-MM-DDTHH:MM:SS.mmmZ` exactly | Valid UTC date; no offset or leap second |
| `UsdPrice` | `^(0|[1-9][0-9]*)\.[0-9]{4}$` | `0.0001` through `999999.9999` |
| `ShareQuantity` | `^(0|[1-9][0-9]*)\.[0-9]{6}$` | `0.000001` through `1000000.000000` |
| `UnsignedUsdAmount` | `^(0|[1-9][0-9]*)\.[0-9]{2}$` | `0.00` through `999999999.99` |
| `Ratio` | `^(0|1)\.[0-9]{6}$` | `0.000000` through `1.000000` |

Artifacts and envelopes use RFC 8785 JSON Canonicalization Scheme bytes and this exact formula: `lowercase_hex(SHA-256(ASCII(domain) || 0x00 || JCS(hashView)))`. The hash view is the complete object with only its own hash field removed; nulls, timestamps, provenance, policy, IDs, and array order remain. A supplied hash is always recomputed.

| Object | Own hash field | Domain suffix after `marketpilot.paper-intent-fixture.v1/` |
| --- | --- | --- |
| `FixtureAuthorityRequest` | derived `requestHash` in the response | `request` |
| `ResearchEvent` | `eventHash` | `research-event` |
| `CandidateManifest` | `candidateHash` | `candidate` |
| `TradeIntent` | `intentHash` | `trade-intent` |
| `CriticVerdict` | `verdictHash` | `critic-verdict` |
| `GateDecision` | `decisionHash` | `gate-decision` |
| `OrderPlan` | `planHash` | `order-plan` |
| `ExecutionEvent` | `executionHash` | `execution-event` |
| `AuditEvent` | `eventHash` | `audit-event` |
| `FixtureAuthorityResponse` or protocol error | `responseHash` | `response` |

Python output IDs are deterministic: `<type-prefix><first-32-hex(SHA-256(ASCII(profile) || 0x00 || ASCII(operationId) || 0x00 || ASCII(artifactType) [|| 0x00 || ASCII(auditSequence)]))>`. No clock read, randomness, process ID, filesystem path, locale, or environment value may influence output. Every Python-created timestamp equals the request's `decisionAt`.

### Exact Artifact Shapes

All fields named below are required; nested objects are closed. A nullable field is present with JSON `null` rather than omitted.

| Artifact | Required fields and exact branches |
| --- | --- |
| `ResearchEvent` | `schemaVersion`, `profile`, `artifactType = ResearchEvent`, `eventId`, `eventHash`, `producer`, `instrumentId`, `assetClass`, `currency`, `eventKind`, `revisionId`, nullable `supersedesEventId`, `rightsClass`, `publishedAt`, `observedAt`, `facts`, `provenance`. `eventKind = FIXTURE_ISSUER_NOTICE`; `rightsClass` and each field/source right use `PUBLIC_OFFICIAL`, `LICENSED_MODEL_OK`, or `LOCAL_RESTRICTED`, ordered from least to most restrictive exactly as `PUBLIC_OFFICIAL < LICENSED_MODEL_OK < LOCAL_RESTRICTED`. `facts` contains one each of `NOTICE_TEXT`, `REFERENCE_PRICE_USD`, and `ASK_PRICE_USD`, with `factId`, `kind`, typed `value`, `rightsClass`, and `provenanceId`. Each provenance entry has `provenanceId`, `sourceId`, `sourceClass`, `sourceRef`, `sourceRevision`, `publishedAt`, `retrievedAt`, and `contentHash`; every reference resolves and event rights equal the strictest source/fact right. |
| `CandidateManifest` | `schemaVersion`, `profile`, `artifactType = CandidateManifest`, `candidateId`, `candidateHash`, `producer`, `createdAt`, `validFrom`, `validUntil`, `mode`, `liveEligible`, `strategyKind`, `instrumentId`, `assetClass`, `currency`, `policy`. `policy` has `policyId`, `allowedAction`, `side`, `session`, `maxQuantity`, `maxGrossNotionalUsd`, and `buyCollarRatio`. |
| `TradeIntent` | `schemaVersion`, `profile`, `artifactType = TradeIntent`, `intentId`, `intentHash`, `producer`, `operationId`, `createdAt`, `expiresAt`, `candidateId`, `candidateHash`, `disposition`, `proposal`, `abstainReasonCode`, `thesis`, `evidenceRefs`. `PROPOSE` requires a proposal and null abstain reason; `ABSTAIN` requires null proposal and `INSUFFICIENT_EVIDENCE`, `NO_SUPPORTED_ACTION`, or `UNSAFE_CONTEXT`. A proposal has `action`, `instrumentId`, `assetClass`, `currency`, `side`, `session`, `quantity`, and `maximumEntryPrice`. Each evidence reference has `eventId`, `eventHash`, and sorted `factIds`. The intent contains no order type, route, time-in-force, or execution field. |
| `CriticVerdict` | `schemaVersion`, `profile`, `artifactType = CriticVerdict`, `verdictId`, `verdictHash`, `producer`, `operationId`, `createdAt`, `expiresAt`, `candidateId`, `candidateHash`, `intentId`, `intentHash`, `eventId`, `eventHash`, `verdict`, `reasonCode`, `counterargument`, `evidenceFactIds`. `APPROVE` requires `NO_BLOCKING_ISSUE`; `REJECT` uses `EVIDENCE_GAP`, `THESIS_CONTRADICTION`, or `FIXTURE_POLICY_CONCERN`; `ABSTAIN` uses `INSUFFICIENT_EVIDENCE`. The counterargument is always nonempty. |
| `GateDecision` | `schemaVersion`, `profile`, `policyId`, `artifactType = GateDecision`, `decisionId`, `decisionHash`, `producer`, `operationId`, `requestHash`, `decidedAt`, `decision`, `primaryReasonCode`, `reasonCodes`, `inputRefs`. `inputRefs` contains `eventId`, `eventHash`, `candidateId`, `candidateHash`, `intentId`, `intentHash`, and nullable `verdictId`/`verdictHash`. `ACCEPT` uses only `ACCEPTED`; `REJECT` uses the ordered domain codes below. |
| `OrderPlan` | `schemaVersion`, `profile`, `policyId`, `artifactType = OrderPlan`, `planId`, `planHash`, `producer`, `operationId`, `decisionId`, `decisionHash`, `candidateId`, `candidateHash`, `intentId`, `intentHash`, `createdAt`, `instrumentId`, `assetClass`, `currency`, `side`, `quantity`, `orderType`, `limitPrice`, `routing`, `timeInForce`, `session`, `simulationOnly`, `priceCollar`. Constants are `BUY`, `LIMIT`, `SMART`, `DAY`, `REGULAR`, and `simulationOnly = true`; `priceCollar` contains `referencePrice`, `maximumLimitPrice`, and `ratio`. The plan may equal or tighten an intent but never enlarge it. |
| `ExecutionEvent` | `schemaVersion`, `profile`, `policyId`, `artifactType = ExecutionEvent`, `executionId`, `executionHash`, `producer`, `operationId`, `planId`, `planHash`, `occurredAt`, `status`, `instrumentId`, `assetClass`, `currency`, `side`, `quantity`, `fillPrice`, `fillNotionalUsd`, `commissionUsd`, `simulationOnly`. Constants are `FILLED`, `BUY`, `simulationOnly = true`; the full quantity fills once at the fixture ask with `commissionUsd = 0.00`. |
| `AuditEvent` | `schemaVersion`, `profile`, `policyId`, `artifactType = AuditEvent`, `auditId`, `auditEventId`, `sequence`, `occurredAt`, `eventType`, `subjectType`, `subjectId`, `subjectHash`, `previousEventHash`, `eventHash`. `eventType` is `INPUT_RESEARCH_RECORDED`, `INPUT_CANDIDATE_RECORDED`, `INPUT_INTENT_RECORDED`, `INPUT_CRITIC_RECORDED`, `GATE_DECIDED`, `ORDER_PLANNED`, or `EXECUTION_SIMULATED`; `subjectType` is the corresponding request/artifact type. Sequence starts at 1 and is contiguous; subject references resolve. |

Structural enums deliberately admit safe negative cases so Python can issue domain rejections: known rights classes; `PAPER | LIVE`; `US_PRIMARY_LISTED_COMMON_STOCK | PLAIN_UNLEVERED_ETF`; three-letter currencies; `OPEN_LONG | CLOSE_LONG | HOLD`; `BUY | SELL`; and `REGULAR | EXTENDED`. The fixture policy below is the accepting subset.

### Deterministic Gate And Simulator

The built-in fixture policy—not values supplied by the candidate—permits only `PAPER`, `liveEligible = false`, `MPTEST`, `US_PRIMARY_LISTED_COMMON_STOCK`, `USD`, `OPEN_LONG`, `BUY`, `REGULAR`, zero starting exposure, `maxQuantity = 1.000000`, `maxGrossNotionalUsd = 100.00`, `buyCollarRatio = 0.005000`, public-only provenance, and one full simulated fill. The candidate policy must exactly mirror these constants or the gate rejects it.

The request supplies `decisionAt`; no component reads the system clock. Required ordering is `candidate.createdAt <= research.publishedAt <= research.observedAt <= intent.createdAt <= critic.createdAt <= decisionAt`. Candidate validity contains `decisionAt`, and `decisionAt` does not exceed the intent or critic `expiresAt`. Inclusive maximum ages are 180 seconds for observed research, 60 seconds for the intent, and 30 seconds for the critic; one millisecond beyond fails. A missing critic skips critic time checks and rejects as `CRITIC_MISSING`.

Python computes the BUY collar as `referencePrice * (1 + buyCollarRatio)`, quantized down to four places with `ROUND_DOWN`. The plan limit is the lesser of that collar and the intent's maximum entry price. Risk uses the exact unrounded `quantity * collar`, not reported notional, and rejects values above USD 100.00. The gate also requires `askPrice <= plan limit`; an accepted request then creates one plan and fills the full quantity once at `askPrice`. `fillNotionalUsd` is reported to two places with `ROUND_HALF_EVEN`; risk never uses the rounded report. An impossible post-accept simulator condition is an internal invariant failure, never a fabricated fill or second decision.

Artifact hash mismatch is the input-contract error `INPUT_ARTIFACT_HASH_INVALID`: it produces no gate or audit and never reaches domain evaluation. For structurally and cryptographically valid input, Python alone evaluates cross-artifact linkage, producer identity, time, rights, intent/critic state, and fixture policy. It collects every safely evaluable domain failure, skips checks whose prerequisite is absent, deduplicates, and emits codes in this exact precedence; `primaryReasonCode` is the first:

```text
INTENT_CANDIDATE_MISMATCH
INTENT_EVIDENCE_MISMATCH
CRITIC_INTENT_MISMATCH
CRITIC_CANDIDATE_MISMATCH
CRITIC_NOT_DISTINCT
TIME_ORDER_INVALID
CANDIDATE_INACTIVE
RIGHTS_NOT_PUBLIC
EVIDENCE_STALE
INTENT_STALE
CRITIC_STALE
INTENT_ABSTAINED
CRITIC_MISSING
CRITIC_REJECTED
CRITIC_ABSTAINED
FIXTURE_POLICY_MISMATCH
CANDIDATE_NOT_PAPER
CANDIDATE_LIVE_ELIGIBLE
INSTRUMENT_NOT_ALLOWED
CURRENCY_NOT_USD
ACTION_NOT_ALLOWED
SIDE_NOT_ALLOWED
SESSION_NOT_REGULAR
QUANTITY_LIMIT_EXCEEDED
NOTIONAL_LIMIT_EXCEEDED
PRICE_NOT_MARKETABLE
```

A domain rejection is a successfully processed response with a rejected `GateDecision` and audit chain but null plan/execution. `ACCEPTED` is the sole accepted reason. Raw malformed JSON, duplicate keys, invalid UTF-8/framing, unsupported profile/schema, or an artifact contract violation is instead an input error with no gate, audit, plan, or execution.

### Audit And Process Envelopes

WI-005 returns a tamper-evident in-memory bundle, not durable, cryptographically anchored, or production-encrypted audit. The genesis hash is `SHA-256(ASCII("marketpilot.paper-intent-fixture.v1/audit-genesis") || 0x00 || ASCII(requestHash))`. Every audit event uses `decisionAt`, points to the genesis or prior event hash, and is hashed with the normal audit domain. Event order is `INPUT_RESEARCH_RECORDED`, `INPUT_CANDIDATE_RECORDED`, `INPUT_INTENT_RECORDED`, optional `INPUT_CRITIC_RECORDED`, `GATE_DECIDED`, then accepted-only `ORDER_PLANNED` and `EXECUTION_SIMULATED`. Response `headHash` equals the last event hash. Verification recomputes artifact hashes, membership, order, contiguous sequence, subject links, chain links, event hashes, and head; modification, deletion, insertion, reordering, or substitution must fail. An attacker able to rewrite the entire unanchored bundle can recompute it; WI-007 owns durable storage/recovery.

`FixtureAuthorityRequest` is a closed object containing `schemaVersion`, `profile`, `policyId`, `messageType = EVALUATE_FIXTURE_PAPER_INTENT`, `requestId`, `operationId`, `decisionAt`, and a closed `bundle` with `researchEvent`, `candidateManifest`, `tradeIntent`, and nullable `criticVerdict`. `FixtureAuthorityResponse` contains `schemaVersion`, `profile`, `policyId`, `messageType = FIXTURE_PAPER_INTENT_RESULT`, `requestId`, `operationId`, `requestHash`, `status = ACCEPTED | REJECTED`, `primaryReasonCode`, `reasonCodes`, non-null `gateDecision`, nullable `orderPlan`, nullable `executionEvent`, `auditEvents`, `headHash`, and `responseHash`. Accepted responses require an accepted gate, non-null plan/execution, and the full audit sequence; domain-rejected responses require a rejected gate, null plan/execution, and the matching shorter sequence.

The process command is `python -m marketpilot.paper_fixture_authority`. Input is exactly one LF-terminated UTF-8 JSON object followed by EOF, at most 131,072 bytes including LF; reject BOM, CR, NUL, invalid UTF-8, missing LF, duplicate keys, blank/trailing/second-line content, nonstandard constants, or extra bytes. Stdout is exactly one canonical JSON envelope plus LF within the same limit and contains no commentary; stderr is empty for expected outcomes. Exit 0 means domain accepted/rejected. Exit 2 returns only a closed redacted envelope containing `schemaVersion = 1`, the supported `profile` and `policyId`, `messageType = FIXTURE_AUTHORITY_PROTOCOL_ERROR`, validated-or-null `requestId`, `status = ERROR`, `errorCode`, and `responseHash`; `errorCode` is `INPUT_LIMIT_EXCEEDED`, `INPUT_ENCODING_INVALID`, `INPUT_FRAMING_INVALID`, `INPUT_JSON_INVALID`, `INPUT_DUPLICATE_KEY`, `PROFILE_UNSUPPORTED`, `SCHEMA_UNSUPPORTED`, `INPUT_SCHEMA_INVALID`, or `INPUT_ARTIFACT_HASH_INVALID`. Exit 1 uses the same shape with `messageType = FIXTURE_AUTHORITY_INTERNAL_ERROR` and only `INTERNAL_ERROR`. Neither error form contains operation/domain artifacts, input excerpts, paths, stacks, or attacker-controlled text. If `requestId` is unsafe, it is null.

The Node launcher enforces transport/shallow-envelope safety, performs non-authoritative deep schema/hash validation for parity, and passes every bounded syntactically valid request to Python as the exact original bytes without repairing artifacts. Node does not evaluate input linkage, time, rights, critic, or policy rules. It independently validates response schema, hashes, conditional shape, and references only to decide whether Python's entire response can be accepted as an authority result. The launcher accepts one request per process, enforces a two-second absolute deadline and the same output bound, and uses exactly `AUTHORITY_INPUT_ERROR`, `AUTHORITY_TIMEOUT`, `AUTHORITY_PROCESS_FAILED`, `AUTHORITY_OUTPUT_INVALID`, or `AUTHORITY_RESPONSE_MISMATCH` as redacted no-exposure adapter codes. Timeout, signal, nonzero exit, extra/malformed output, request-ID/reference mismatch, or response/hash/schema failure discards every returned domain artifact. The Python process performs no network access and reads or writes no product state.

### Golden Oracles And Deferrals

Both committed cases use `decisionAt = 2026-08-03T14:30:00.000Z`, candidate validity spanning that time, public research observed at `14:27:30.000Z`, an intent created at `14:29:15.000Z`, and a critic created at `14:29:45.000Z`. Reference price is `99.0000`, ask is `99.2500`, and maximum entry is `99.4950`. The accepted case proposes `1.000000` share with a distinct approving critic and must fill once at `99.2500`. The rejected case differs only by proposing `2.000000` shares; it must return primary `QUANTITY_LIMIT_EXCEEDED`, also report `NOTIONAL_LIMIT_EXCEEDED`, and produce no plan or execution.

WI-005 does not claim real Codex output, persistence/restart safety, partial fills, full risk policy, broker semantics, or block L1. WI-006 replaces committed manager/critic artifacts with real qualified turns; WI-007 owns durable audit/idempotency and the thirty-case matrix; WI-008 owns scheduling and soak. Production schemas must preserve the global architecture invariants but are not frozen by this fixture profile.

## Architecture

Electron main launches the pinned native Codex binary with a pre-created non-symlink mode-0700 home and work directory, restrictive umask, a minimal secret-free environment, and JSONL stdio pipes. The client correlates request IDs, bounds lines/messages, validates responses, records redacted notifications, rejects server requests, and stops the process on protocol violation. Configuration disables built-in user-facing capabilities, explicitly disables bundled system skills, enables at most two Sol Ultra subagents per primary session, and registers only required app-owned MCP tools. Each accepted structured turn owns one physical app-server connection, which is stopped and retired before its artifact is returned; later logical continuity is reconstructed from Python-owned encrypted memory rather than by reusing that connection.

The process supervisor owns at most one app-server generation and one logical operation at a time. On POSIX, the direct child is retained as a detached session/process-group leader; controlled shutdown progresses from stdin EOF to group `SIGTERM` and bounded `SIGKILL`, and closure is conclusive only after the leader closes and a negative group probe reports `ESRCH`. A replacement uses a fresh client only after that closure. Only explicit process-unavailability codes are retryable, while a bounded in-memory acceptance fence prevents a late or repeated generation from accepting the same key twice. Durable cross-application idempotency remains with the Python authority.

One logical manager exists per active account/candidate, while operator chat is separate. Fresh research and critic contexts reduce contamination. Material sensing continues every three minutes in Python; if a manager is busy, deltas coalesce for the next turn rather than overlapping. The supervisor retries after one and five seconds; a third crash in ten minutes opens a latched circuit with a 30-second minimum operator-reset cooldown. A continuously live ten-minute generation clears earlier crash history.

Codex-owned persistence is treated as a separate security boundary. DEC-001 selects ephemeral physical threads rehydrated from encrypted MarketPilot memory. Production uses a stable path-derived keyring namespace but places physical Codex state below the per-user runtime directory; licensed or managed-sleeve context remains blocked until runtime and swap posture prove that plaintext cannot page to unencrypted storage. WI-001 may persist only public fixtures while proving the boundary.

## Implementation Blueprint

1. Implement WI-001 in Node 22 ESM with built-in `node:test`, pinning `@openai/codex` exactly to `0.145.0` and using its packaged binary rather than the system binary.
2. Add a small process/protocol client, hardened runtime-policy builder, fake app-server, fixture MCP, compatibility CLI, and redacted report. Generate/record the stable protocol schema and dependency hashes reproducibly.
3. Automate process, protocol, config, model, skill, MCP, isolation, output, timeout, crash, storage inventory, authenticated turn/resume/interrupt, and bounded Ultra activity checks; keep only initial browser/keyring login as an explicit operator action.
4. Enforce DEC-001's memory-backed runtime and encrypted-swap/non-swappable preflight before WI-004 handles anything beyond public fixtures; store only versioned bounded logical memory in SQLCipher.
5. Deliver the WI-004 L1 goal as four reviewable slices: WI-005 establishes canonical contracts and the deterministic Node-to-Python authority seam; WI-006 connects the real manager and independent critic; WI-007 proves the failure matrix and durable restart idempotency; WI-008 proves material scheduling and the two-hour soak. Close WI-004 only after the combined manual acceptance gate passes.
6. After L1 proof, graduate stable checks into normal validation and keep the app-server adapter replaceable. Any failure of stable isolation/auth/structured-output requirements triggers architecture replanning rather than experimental or SDK fallback.

## Maturity Criteria

### L1 Walking Skeleton

- [ ] One rights-safe fixture/public event crosses the real pinned app-server manager and separate critic, a deterministic gate, simulator, and immutable audit.
- [ ] Thirty scenarios have 100% schema-valid terminal artifacts and correct accept/reject/abstain behavior.
- [ ] Restart and a two-hour materiality-loop soak create no duplicate intent or simulated order.
- [ ] Known limitations, including hosted availability and Codex persistence, are explicit and safe.

### L2 Functional

- [ ] Manager, specialist, critic, reflection, chat, model selection, candidate versioning, material scheduling, and important failure states are complete.
- [ ] Required public/licensed MCP context is enforced field by field and no forbidden tool or data path is reachable.

### L3 Hardened

- [ ] Clean Ubuntu setup, keyring lifecycle, encrypted/private state decision, update/schema compatibility, diagnostics, resource budgets, recovery, and adversarial security review pass.
- [ ] No silent reroute, fallback, inherited configuration, unexpected capability, plaintext credential, or unresolved critical app-server risk remains.

## Validation

| Outcome or risk | Method | Environment | Evidence |
| --- | --- | --- | --- |
| Pinned stable protocol is usable | Fake and real process contract tests; generated-schema/hash check | Ubuntu 24.04 x64, Codex 0.145.0 | WI-001 concise report and normal test results |
| Isolation and least privilege | Config/skill/MCP/env inventories, forbidden-request tests, file-mode inspection | Fresh temporary app homes | WI-001 security output with secrets redacted |
| ChatGPT and Sol Ultra work | User-driven keyring login followed by automated entitlement, structured turn, fresh-process resume, interrupt/recovery, and bounded delegation proof | Stable dedicated app home with public fixtures only | Redacted WI-001 authenticated report |
| Failure is safe | Auth/rate-limit/reroute/timeout/crash/malformed/unknown-capability scenarios | Fake server plus opt-in real smoke | Typed outcomes and no-exposure assertions |
| L1 product boundary works | Thirty fixture cases, restart/idempotency suite, manual walkthrough, two-hour soak | Headless reference host | WI-004 evidence |

## Known Gaps

- The pinned Ubuntu 24.04 x64 package has passed credential-free compatibility and authenticated public-fixture turn, recovery, interrupt, and bounded-delegation proof. Keyring availability and hosted-model capacity remain external readiness dependencies and must fail closed when absent.
- Controlled same-process restart, process-group cleanup, and process-local duplicate-acceptance fencing are implemented and tested. This does not provide durable containment for descendants that deliberately call `setsid()`, for a supervisor killed with `SIGKILL`, or for idempotency across an application restart.
- The authenticated-smoke runtime is exclusively leased, but an ungraceful supervisor death can leave a fail-closed stale lease. Safe automatic reclamation requires a stronger owner such as a surviving launcher or service/cgroup boundary; until then, recovery ends the user runtime/session or reboots rather than unlinking the lease.
- DEC-001 resolves the persistence design, but the current host has unencrypted swap and the runtime preflight is not implemented; no licensed, broker, account, or real portfolio context may enter Codex until both are corrected and verified.
- No trading or simulation capability exists yet. WI-005 is the ready first implementation slice; WI-004 remains the final L1 acceptance gate after WI-005 through WI-008.
