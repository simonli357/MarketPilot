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
| BLK-agent-runtime-R004 | Explicitly orchestrate a manager and an independent critic for every new/increased exposure; Ultra delegation is optional support, never the safety mechanism. | Must | Ultra does not guarantee delegation and specialists may fail or time out. | WI-004 | Fixture path requires distinct typed manager and critic artifacts before acceptance. |
| BLK-agent-runtime-R005 | Constrain final messages with JSON Schema, parse and validate independently, enforce deadlines, coalesce material events, and expose typed auth/rate-limit/crash/schema failures. | Must | Final structured text may be missing, malformed, ambiguous, late, or associated with a failed turn. | WI-001, WI-004 | Fake-server failure suite and real L1 scenario matrix. |
| BLK-agent-runtime-R006 | Prove one public/fixture event through manager, critic, deterministic gate, simulated execution, and immutable audit before broader capability work. | Must | A successful chat response alone does not prove the product boundary. | WI-004 | Thirty-scenario L1 suite, manual walkthrough, restart/idempotency proof, and two-hour soak. |
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

## Architecture

Electron main launches the pinned native Codex binary with a pre-created non-symlink mode-0700 home and work directory, restrictive umask, a minimal secret-free environment, and JSONL stdio pipes. The client correlates request IDs, bounds lines/messages, validates responses, records redacted notifications, rejects server requests, and stops the process on protocol violation. Configuration disables built-in user-facing capabilities, explicitly disables bundled system skills, enables at most two Sol Ultra subagents per primary session, and registers only required app-owned MCP tools. Each accepted structured turn owns one physical app-server connection, which is stopped and retired before its artifact is returned; later logical continuity is reconstructed from Python-owned encrypted memory rather than by reusing that connection.

The process supervisor owns at most one app-server generation and one logical operation at a time. On POSIX, the direct child is retained as a detached session/process-group leader; controlled shutdown progresses from stdin EOF to group `SIGTERM` and bounded `SIGKILL`, and closure is conclusive only after the leader closes and a negative group probe reports `ESRCH`. A replacement uses a fresh client only after that closure. Only explicit process-unavailability codes are retryable, while a bounded in-memory acceptance fence prevents a late or repeated generation from accepting the same key twice. Durable cross-application idempotency remains with the Python authority.

One logical manager exists per active account/candidate, while operator chat is separate. Fresh research and critic contexts reduce contamination. Material sensing continues every three minutes in Python; if a manager is busy, deltas coalesce for the next turn rather than overlapping. The supervisor retries after one and five seconds; a third crash in ten minutes opens a latched circuit with a 30-second minimum operator-reset cooldown. A continuously live ten-minute generation clears earlier crash history.

Codex-owned persistence is treated as a separate security boundary. DEC-001 selects ephemeral physical threads rehydrated from encrypted MarketPilot memory. Production uses a stable path-derived keyring namespace but places physical Codex state below the per-user runtime directory; licensed or managed-sleeve context remains blocked until runtime and swap posture prove that plaintext cannot page to unencrypted storage. WI-001 may persist only public fixtures while proving the boundary.

## Implementation Blueprint

1. Implement WI-001 in Node 22 ESM with built-in `node:test`, pinning `@openai/codex` exactly to `0.145.0` and using its packaged binary rather than the system binary.
2. Add a small process/protocol client, hardened runtime-policy builder, fake app-server, fixture MCP, compatibility CLI, and redacted report. Generate/record the stable protocol schema and dependency hashes reproducibly.
3. Automate process, protocol, config, model, skill, MCP, isolation, output, timeout, crash, and storage-inventory checks; keep ChatGPT/keyring, entitlement, real turn/resume/interrupt, and Ultra activity as explicit opt-in manual smoke.
4. Enforce DEC-001's memory-backed runtime and encrypted-swap/non-swappable preflight before WI-004 handles anything beyond public fixtures; store only versioned bounded logical memory in SQLCipher.
5. Build WI-004 with app-owned manager/research/critic/reflection skills and a fixture-only MCP. Connect typed artifacts to a minimal deterministic gate and simulator without any broker method.
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
| ChatGPT and Sol Ultra work | User-driven keyring login, entitlement, structured turn, resume, interrupt, deliberate delegation smoke | Fresh dedicated app home | Manual WI-001 checklist |
| Failure is safe | Auth/rate-limit/reroute/timeout/crash/malformed/unknown-capability scenarios | Fake server plus opt-in real smoke | Typed outcomes and no-exposure assertions |
| L1 product boundary works | Thirty fixture cases, restart/idempotency suite, manual walkthrough, two-hour soak | Headless reference host | WI-004 evidence |

## Known Gaps

- Credential-free app-server compatibility is proven for the pinned Ubuntu 24.04 x64 package; authenticated account, live-turn, recovery, interrupt, and delegation behavior remain unproven until the owner completes WI-001's opt-in smoke.
- Controlled same-process restart, process-group cleanup, and process-local duplicate-acceptance fencing are implemented and tested. This does not provide durable containment for descendants that deliberately call `setsid()`, for a supervisor killed with `SIGKILL`, or for idempotency across an application restart.
- The authenticated-smoke runtime is exclusively leased, but an ungraceful supervisor death can leave a fail-closed stale lease. Safe automatic reclamation requires a stronger owner such as a surviving launcher or service/cgroup boundary; until then, recovery ends the user runtime/session or reboots rather than unlinking the lease.
- DEC-001 resolves the persistence design, but the current host has unencrypted swap and the runtime preflight is not implemented; no licensed, broker, account, or real portfolio context may enter Codex until both are corrected and verified.
- No trading or simulation capability exists yet; WI-004 owns the first L1 end-to-end path after WI-001.
