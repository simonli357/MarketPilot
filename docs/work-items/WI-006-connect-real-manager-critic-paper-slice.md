---
id: WI-006
title: Connect the real manager and critic to the paper authority
type: task
status: done
block: BLK-agent-runtime
release: V1
maturity: L1
requirements: ["FR-002", "IR-001", "QR-002", "SFR-004", "BLK-agent-runtime-R004", "BLK-agent-runtime-R005", "BLK-agent-runtime-R006"]
depends_on: ["WI-005"]
owner: implementation-agent
---

# Connect The Real Manager And Critic To The Paper Authority

## Outcome

A fixed rights-safe public event traverses the real WI-001-qualified Sol Ultra manager, a separately orchestrated critic, and the WI-005 Python authority seam, proving one accepted and one rejected broker-free paper path without granting Codex state, money, or broker authority.

## Success Criteria

- [x] App-owned manager and critic instructions produce only the canonical WI-005 artifacts and expose only the exact fixture MCP capability required by their roles.
- [x] Manager and critic run in separate fresh ephemeral physical threads and app-server connections with verified `gpt-5.6-sol`/`ultra` settings; the critic receives the rights-filtered event, candidate, and proposed intent but no manager transcript.
- [x] The manager reads exactly the approved `PUBLIC_OFFICIAL` fixture, every terminal artifact is parsed and schema-validated locally, and any auth, entitlement, reroute, timeout, protocol, tool, schema, or process failure returns a typed no-exposure result.
- [x] An authenticated accepted walkthrough reaches exactly one Python-created plan and simulated execution, while a deterministic rejected walkthrough records the critic/gate reason and creates neither.
- [x] Deterministic fake-runtime integration tests cover orchestration without consuming hosted capacity; the opt-in hosted command reuses the qualified keyring namespace and retains no sensitive physical thread state.
- [x] No test or runtime path accepts licensed content, broker/account context, a real symbol decision, API token input, broker method, or automatic candidate promotion.

## Validation

- Automated: focused fake-runtime manager/critic integration tests, WI-005 paper-core suites, existing Codex regression and compatibility suites, and `npm run project:check`.
- Manual/hosted: one accepted and one rejected authenticated public-fixture walkthrough with redaction-safe artifact/audit inspection and complete process cleanup.
- Environment or fixture: Ubuntu reference host, existing qualified keyring-backed Codex runtime, fixture-only MCP, deterministic Python authority, and no broker/account access.

## Execution Contract

- Constraints: Preserve WI-001 qualification and DEC-001; criticism must be a distinct app-launched turn rather than Ultra delegation; Python remains the only acceptance and simulation authority.
- Boundaries: Add only the manager/critic skills, fixture orchestration, hosted/fake harnesses, focused tests, commands/guidance, and concise WI-006 evidence needed for the two-path slice. Do not implement the full failure matrix, durable recovery campaign, scheduler, soak, broker, or UI.
- Iteration policy: Prove the fake accepted path, fake rejected path, hosted manager, hosted critic, and full hosted chain in that order; after a failure, fix the narrowest violated runtime or artifact contract and rerun that stage.
- Blocked stop condition: Stop for architecture review if the qualified stable app-server cannot provide two independent schema-valid turns without relaxing WI-001 containment or if hosted behavior cannot be made fail-closed at the Python boundary.

## Evidence

- Automated fake-runtime and protocol validation (2026-08-03, Ubuntu reference host): `node --test test/paper/paper-agent-slice.test.mjs` (8/8); `node --test test/codex/structured-turn.test.mjs` (71/71, including the new `forbidDelegation` regression); `npm run check:paper-core`; `npm run audit:paper-core`; Python authority tests; `npm run test:codex`; `npm run project:check`; `npm audit --omit=dev` (0 findings); and `git diff --check` all passed.
- Hosted validation (fresh run after explicit resource-discovery prohibition, keyring namespace reused, no API token): `npm run paper:agent-hosted` exited 0 and released its lease/process. Accepted report was `ACCEPTED`, primary `ACCEPTED`, one plan, one simulated execution, seven audit events, response hash `15802bfdd218e381482049d01cfaa0e7a7d0e83521af20a5097e45862fc9fbeb`; rejected report was `REJECTED`, primary `CRITIC_REJECTED`, reason codes `CRITIC_REJECTED`, `QUANTITY_LIMIT_EXCEEDED`, `NOTIONAL_LIMIT_EXCEEDED`, no plan/execution, five audit events, response hash `81db23a511b9145e2f7d5ff843c1d7da41c1eaaa7524f3230464b2420d1220f6`.
- Independent review found and fixed the permissive paper skill selector, manager resource-discovery prompt gap, Codex delegation-forbid coverage, authority adapter deadline, exact skill/MCP inventory annotations and skill-error checks, and model/catalog identity compatibility. Review also confirmed distinct run/thread/connection IDs, rights-filtered critic input, no transcript transfer, no API-token path, and clean runtime lease/process teardown.
- The hosted model initially attempted `list_mcp_resource_templates`/`list_mcp_resources` during the rejected walkthrough; the runtime correctly failed closed with `MCP_TOOL_FORBIDDEN`. The role skill and instructions were tightened to prohibit all discovery tools, and the fresh rerun passed. This is retained as a reproducible negative-path finding rather than hidden.

## Blocked Or Deferred

The thirty-scenario matrix, durable restart behavior, material scheduler, and soak remain in WI-007 and WI-008.
