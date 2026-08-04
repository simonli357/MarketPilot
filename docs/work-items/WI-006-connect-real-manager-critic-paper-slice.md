---
id: WI-006
title: Connect the real manager and critic to the paper authority
type: task
status: proposed
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

- [ ] App-owned closed output schemas request the block's exact manager and critic semantic-draft shapes rather than completed artifacts, and forbid model-supplied identity, linkage, timestamp, producer, or hash fields. The roles originate every decision-bearing field; the orchestrator may only validate the draft and losslessly bind those immutable envelope fields without altering semantics or supplying a precomputed conclusion, thesis, counterargument, verdict, reason, evidence selection, or hash.
- [ ] Manager and critic run in separate fresh ephemeral physical threads and app-server connections with verified `gpt-5.6-sol`/`ultra` settings and actual per-turn run identities. The manager runtime exposes exactly one paper-fixture read and no collaboration capability; the critic runtime exposes no MCP, discovery, collaboration, or other model-visible capability and receives only the rights-filtered event, candidate, and bound proposed intent with no manager transcript.
- [ ] The manager reads the canonical `ResearchEvent` from exactly one approved `PUBLIC_OFFICIAL` fixture MCP result rather than a separately supplied duplicate. Every draft and bound artifact is parsed and schema-validated locally, and any auth, entitlement, inventory/pagination, reroute, timeout, protocol, tool, schema, process, or cleanup failure returns a typed no-exposure result.
- [ ] An authenticated accepted walkthrough contains a manager-originated thesis and critic-originated counterargument and reaches exactly one Python-created plan and simulated execution. A deterministic rejected mandate is independently evaluated by both roles, records the observed critic/gate reasons, and creates neither. The two mandates may state objectives and constraints but never the expected disposition, verdict, reason, prose, or serialized answer; neither path may be a verbatim echo of an app-built answer.
- [ ] Deterministic fake-runtime integration tests cover orchestration without consuming hosted capacity; the opt-in hosted command reuses the qualified keyring namespace, validates exact role-specific inventories including pagination/resources/templates/auth state, and reports success only after every physical process and exclusive runtime lease is conclusively released.
- [x] No test or runtime path accepts licensed content, broker/account context, a real symbol decision, API token input, broker method, or automatic candidate promotion.

## Validation

- Automated: focused fake-runtime manager/critic integration tests, WI-005 paper-core suites, existing Codex regression and compatibility suites, and `npm run project:check`.
- Manual/hosted: one accepted and one rejected authenticated public-fixture walkthrough with redaction-safe artifact/audit inspection and complete process cleanup.
- Environment or fixture: Ubuntu reference host, existing qualified keyring-backed Codex runtime, fixture-only MCP, deterministic Python authority, and no broker/account access.

## Execution Contract

- Constraints: Preserve WI-001 qualification and DEC-001; criticism must be a distinct app-launched turn rather than Ultra delegation; Python remains the only acceptance and simulation authority. The model produces semantic drafts, while an app-owned lossless serializer binds only immutable envelope fields. Do not prompt either role with the desired prose, conclusion, full output object, or cryptographic hash.
- Boundaries: Add only the enabled manager skill, app-injected critic instructions with no critic skill, fixture orchestration, role-specific hosted/fake harnesses, focused tests, commands/guidance, and concise WI-006 evidence needed for the two-path slice. Do not implement the full failure matrix, durable recovery campaign, scheduler, soak, broker, or UI.
- Iteration policy: First prove role-specific zero-excess capability inventories and lossless draft binding with fake turns, including cleanup-failure tests. Then prove model-originated fake accepted/rejected paths, hosted manager, hosted critic, and the full hosted chain in that order; after a failure, fix the narrowest violated runtime or artifact contract and rerun that stage.
- Blocked stop condition: Stop for architecture review if the qualified stable app-server cannot provide two independent schema-valid turns without relaxing WI-001 containment or if hosted behavior cannot be made fail-closed at the Python boundary.

## Role Inventory Oracle

Inventory reads aggregate pages until a null cursor with a hard 16-page cap; a malformed/repeated cursor, an extra page/item, or any inventory error fails the role before its turn. The accepted manager inventory is exactly one enabled `marketpilot-paper-manager` skill at the hashed private role path, no skill errors, one `marketpilot_fixture` server, `authStatus = unsupported`, empty resources/templates, and the sole `research_read` tool constrained to `{ fixtureId: { const: "public-event-001" } }` with closed input and exact read-only/idempotent/non-destructive/closed-world annotations. The server returns the complete canonical `ResearchEvent`, not compatibility metadata.

The accepted critic inventory has zero enabled skills, zero skill errors, zero MCP servers/tools/resources/templates, and a null final cursor. Both roles require the same keyring-backed `account.type = chatgpt`, advertised `gpt-5.6-sol`/`ultra`, read-only/no-network thread policy, and role-unique process/connection/thread/run IDs. Both effective configs set `agents.enabled = false` and `features.multi_agent = false`; the critic additionally has an empty MCP config, and either role fails on any collaboration item or model-visible capability outside its row. Fake-runtime mutation tests add one extra skill/server/tool/resource/template/auth state/cursor/collaboration feature at a time and prove the exact typed fail-closed result.

## Evidence

- The 2026-08-04 WI-004 independent review rejected this completion. Both roles were instructed to echo complete app-built artifacts and prescribed conclusions, so the hosted run proved lifecycle and schema-constrained copying rather than manager analysis and independent criticism. The critic was still exposed to the manager's MCP and collaboration configuration; inventory validation did not reject extra servers, pagination, resources/templates, or unexpected auth state; and `paper-agent-hosted.mjs` printed success before cleanup, then swallowed `releaseRuntime()` failure. The corrective contract above selects model-originated semantic drafts with lossless app binding, role-specific runtimes, exact inventory checks, and cleanup-before-success.

- Automated fake-runtime and protocol validation (2026-08-03, Ubuntu reference host): `node --test test/paper/paper-agent-slice.test.mjs` (8/8); `node --test test/codex/structured-turn.test.mjs` (71/71, including the new `forbidDelegation` regression); `npm run check:paper-core`; `npm run audit:paper-core`; Python authority tests; `npm run test:codex`; `npm run project:check`; `npm audit --omit=dev` (0 findings); and `git diff --check` all passed.
- Initial hosted diagnostic (keyring namespace reused, no API token): `npm run paper:agent-hosted` exited 0 and returned the expected accepted/rejected authority summaries and hashes. Process observation indicated that run released its lease, but the command reported success before cleanup and swallowed a release exception, so the run cannot prove fail-closed cleanup and must be repeated after the corrective lifecycle gate.
- Earlier review fixed several selector, prompt, delegation, timeout, annotation, and model/catalog issues and observed distinct run/thread/connection IDs, rights-filtered critic input, no transcript transfer, and no API-token path. Its clean-teardown observation does not prove the missing cleanup-before-success gate.
- In an initial hosted diagnostic, the model attempted resource/template discovery and the turn failed closed with `MCP_TOOL_FORBIDDEN`; a prompt-only correction then passed. The corrective design removes discovery capability from the role inventory instead of relying on instructions alone.

## Blocked Or Deferred

The thirty-scenario matrix, durable restart behavior, material scheduler, and soak remain in WI-007 and WI-008.
