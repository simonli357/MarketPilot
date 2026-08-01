---
id: WI-001
title: Prove the isolated Sol Ultra app-server runtime
type: spike
status: done
block: BLK-agent-runtime
release: V1
maturity: L0
requirements: ["FR-002", "IR-001", "QR-002", "SFR-004", "BLK-agent-runtime-R001", "BLK-agent-runtime-R002", "BLK-agent-runtime-R003", "BLK-agent-runtime-R005", "BLK-agent-runtime-R007"]
depends_on: []
owner: Codex
---

# Prove The Isolated Sol Ultra App-Server Runtime

## Outcome

On Ubuntu 24.04 x64, a minimal MarketPilot supervisor launches the exact packaged Codex app-server `0.145.0` over stdio from a private application home, proves its stable protocol and effective Sol Ultra/read-only configuration, constrains skills and MCP to an exact fixture allowlist, and turns every unsupported, unauthorized, malformed, timed-out, or crashed state into a redacted fail-closed result. Authenticated evidence proves ChatGPT keyring isolation and the real structured-turn lifecycle.

## Success Criteria

- [x] `@openai/codex` is pinned exactly to `0.145.0`; the supervisor resolves its packaged binary rather than a system executable and reports reproducible binary/schema hashes.
- [x] The supervisor pre-creates non-symlink mode-0700 home/work directories under a restrictive umask, passes a minimal secret-free environment, uses strict config, stdio, and omits `experimentalApi`.
- [x] Startup permits only the required stable lifecycle methods, accepts safe additive response fields, and fails the current turn on unknown outbound fields, server requests, notification/item types, skills, MCP tools, or protocol violations.
- [x] Effective configuration proves model `gpt-5.6-sol`, effort `ultra`, approvals `never`, read-only/no-network sandbox, ChatGPT/keyring auth mode, no model-visible shell/web/apps/hooks/goals/memories/remote plugins, and at most two Sol Ultra subagents.
- [x] `model/list`, `skills/list`, and `mcpServerStatus/list` prove exact runtime inventories; bundled system skills are explicitly disabled and the fixture MCP exposes only its approved read tool.
- [x] A schema-constrained terminal result requires completed turn status, one unambiguous final agent message, independent JSON parsing/validation, matching thread/turn identity, and no reroute; malformed or ambiguous results fail closed.
- [x] Automated fake/real-process tests cover initialization order, duplicate IDs, limits, timeout, process exit, crash backoff/circuit, auth/rate-limit/reroute errors, forbidden approvals/tools, redaction, and restart without duplicate accepted artifacts.
- [x] Authenticated smoke proves browser ChatGPT login to the dedicated keyring namespace with no `auth.json`, actual Sol Ultra entitlement, a real typed turn, first-turn materialization, process restart/resume, interrupt, required read-only MCP use, and observable bounded delegation behavior.
- [x] The spike inventories all Codex transcript/database/log files and records an approved implementable boundary—encrypted filesystem or ephemeral physical threads rehydrated from encrypted MarketPilot memory—before real portfolio or licensed context is allowed.
- [x] `npm run project:check` and the focused Codex compatibility test command pass; concise evidence contains no credential, token, account identifier, or prompt content.

## Validation

- Automated: Node built-in unit/contract tests for the JSONL client, allowlists, runtime policy, fake server failures, and isolated real app-server metadata/config/model/skill/MCP checks; `npm run project:check`.
- Hosted/manual: opt-in browser login when the dedicated keyring session is absent; the authenticated command then automates entitlement, structured turn, resume/interrupt, delegation, MCP, file, and cleanup checks.
- Environment or fixture: Ubuntu 24.04 x86_64, Node 22, exact packaged Codex 0.145.0, fresh temporary application homes, fake app-server, and a fixture-only local MCP server; no market, broker, account, or capital access.

## Execution Contract

- Constraints: Use only app-server stable APIs over stdio; no experimental capability, system Codex binary, API-key auth, credential copying, inherited user configuration, silent fallback/reroute, product trading code, or sensitive fixture content.
- Boundaries: Changes may touch the Node package/lock, Codex supervisor/probe modules, fixture runtime policy/skill/MCP, focused tests, commands/developer guidance introduced by the spike, this work item/block, release validation, and ignored `artifacts/work/`; never read or modify `human.md` or the user's `docs/idea.md` change.
- Iteration policy: After each failure, classify protocol, policy, environment, packaging, authentication, or storage cause; make the smallest contract-level correction and rerun the narrow check before the full suite. Record additive runtime behavior but do not depend on undocumented fields.
- Blocked stop condition: Stop and request an architecture replan only after evidence shows the pinned stable app-server cannot provide ChatGPT keyring isolation, exact capability containment, Sol Ultra structured output, safe lifecycle recovery, or a defensible encrypted/ephemeral persistence boundary without experimental APIs; name the failed requirement and minimum external decision or OpenAI change needed.

## Evidence

The automated portion passes on Ubuntu 24.04 x64 with Node 22.22.2 and the packaged `0.145.0` app-server. It matches the pinned Linux binary and canonical stable-schema digests; verifies Sol Ultra, strict effective config, one enabled compatibility skill, the exact fixture MCP input schema and empty resource surface, ephemeral/read-only thread policy, notification and server-request policy, and absence of `auth.json`; and removes its private runtime before emitting its redacted report. The focused suite exercises transport bounds, qualification races, strict event ordering, required MCP evidence, bounded delegation, deadlines, redaction, keyring-route validation, runtime leasing, and crash-policy transitions. Accepted structured turns stop and retire their physical app-server connection before an artifact can be returned.

The focused suite now also proves process-owned recovery: a crashed generation is fully retired before a fresh client starts, controlled POSIX descendants are removed before close resolves, late generation results cannot cross acceptance, and an accepted or uncertain process-local idempotency key cannot be accepted again. Retry is limited to explicit process-unavailability codes; ownership, qualification, protocol, service, and unknown failures remain fail-closed. Durable idempotency across an application restart remains a Python-authority contract for WI-004 rather than an in-memory Node claim.

On 2026-08-01, `npm run codex:auth-smoke` reused the dedicated keyring session without opening a browser and returned a fully passing redacted report. The pinned authenticated runtime completed a non-rerouted Sol Ultra public-fixture turn with exactly one approved MCP read, resumed the accepted durable public thread from a fresh process with semantic continuity, observed exactly one completed `/root/auth_probe` V2 child and reconciled its persisted provenance, reached interrupted terminal state and recovered on the same ephemeral thread, created no `auth.json`, and retired every process and the exclusive runtime lease. `npm run test:codex` and `npm run codex:compatibility` also pass against the packaged `0.145.0` binary and stable-schema digests.

The isolated metadata run created four plaintext Codex databases—goals, logs, memories, and state—even with the corresponding product features disabled. DEC-001 therefore selects a stable path-derived keyring namespace plus ephemeral physical Codex state rehydrated from bounded SQLCipher-owned logical memory. The current host's per-user runtime directory is tmpfs but can page to unencrypted swap, so only public fixtures are permitted until the sensitive-runtime preflight and host posture pass.

## Blocked Or Deferred

The authenticated public-fixture boundary is proven. It intentionally remains fail-closed if the pinned runtime misses the delegated child's initial multiplexed lifecycle notification; a later run may be retried, but persisted child history alone cannot substitute for the required live observation.

Controlled crash recovery now owns one app-server generation at a time, permits only explicit one- and five-second automatic retries, opens the circuit on the third crash, and proves the old POSIX process group absent before replacement. This is live process-group ownership, not durable containment: deliberate `setsid()` escapes, a supervisor killed with `SIGKILL`, and application-restart idempotency remain outside the claim. A forced supervisor death can therefore leave the authenticated-smoke lease fail-closed; it must not be reclaimed automatically or unlinked while any descendant may remain. Sensitive runtime use also remains blocked until memory-backed storage and encrypted/non-swappable swap posture are implemented and proven.
