# Architecture And Environment

## System Context

| Actor/system | Interaction | Trust or failure boundary |
| --- | --- | --- |
| Owner | Reviews research and evidence, configures candidates, arms/pauses/kills automation, and requests intents through the desktop UI. | Human actions are authenticated locally but still pass validation and deterministic trading rules. |
| Electron desktop | Presents the operations console and supervises local processes. | The sandboxed renderer has no secrets, broker socket, database, shell, or app-server transport. |
| Python core | Owns durable state, scheduling, data rights, analytics, portfolio accounting, qualification, simulation, reconciliation, risk, and orders. | Sole money/state authority; impossible or mismatched state fails fast. |
| Codex app-server | Runs the manager, specialists, critic, reflection, and chat using typed outputs. | Hosted reasoning is untrusted input to the deterministic gate and has no broker/database credentials or order method. |
| Research sources/vendors | Supply public or licensed facts, events, calendars, and estimates. | Every field carries provenance and enforceable usage/retention rights; external content is untrusted. |
| IB Gateway / IBKR | Supplies local account/market state and accepts authorized orders through the official TWS API. | Separately installed and user-authenticated; disconnects, corrections, and unknown state suspend exposure and force reconciliation. |

## Boundaries

| Boundary/module | Responsibility | Depends on | Why separate |
| --- | --- | --- | --- |
| Electron main | Single instance, tray/autostart, process supervision, update coordination, app-server stdio adapter, and narrow renderer IPC. | Python RPC, Codex app-server, OS keyring. | Owns native desktop lifecycle without giving the renderer authority. |
| React renderer | Read-only operations views plus explicit configuration, acknowledgement, arm/pause/kill, chat, and guided-reduction requests. | Electron preload contract only. | Treats all displayed data as snapshots and cannot bypass core rules. |
| Python application core | SQLCipher persistence, event scheduler, materiality detection, rights engine, analytics, simulator, portfolio/sleeves, candidate registry, risk gate, order manager, and reconciliation. | Vendor adapters, IBKR adapter, local RPC. | Creates a single deterministic state and money boundary. |
| Codex supervisor | Pinned binary/schema verification, dedicated home, authentication state, thread lifecycle, deadlines, typed output, subagent events, and crash circuit breaker. | Electron main, app-owned config/skills/MCP. | App-server is currently an evolving integration surface and must be qualified and replaceable. |
| Research MCP bridge | Read-only licensed research retrieval, redacted context, and immutable intent/candidate creation. | Python rights engine and append-only APIs. | Provides the model only exact capabilities whose output remains subject to local authority. |
| Broker adapter | Official TWS API connection, contract discovery, market/account streams, order mapping, fills/corrections, commissions, and reconciliation. | User-authenticated IB Gateway. | Contains volatile external protocol behavior without owning portfolio policy. |

## Cross-Block Contracts

| Producer block | Consumer block | Contract | Version/failure behavior |
| --- | --- | --- | --- |
| BLK-market-intelligence | BLK-agent-runtime, BLK-strategy-evaluation | `ResearchEvent` and evidence retrieval with source, timestamps, revision chain, facts, affected instruments, and field-level rights. | Schema-versioned; unknown schema or insufficient rights rejects the record rather than dropping fields silently. |
| BLK-agent-runtime | BLK-broker-execution | `TradeIntent` plus required `CriticVerdict`; neither is an order. | JSON Schema constrained; invalid, expired, mismatched, or incomplete artifacts are rejected and audited. |
| BLK-strategy-evaluation | BLK-agent-runtime, BLK-broker-execution | `CandidateManifest` and `QualificationRecord` containing exact hashes, scope, evidence window, metrics, and state. | Any decision-affecting hash change creates an unqualified candidate and disarms live use. |
| BLK-broker-execution | BLK-operator-desktop, BLK-strategy-evaluation | Portfolio/order/execution/reconciliation snapshots and immutable audit events. | Sequence and idempotency checked; gaps or contradictions enter reconciliation or kill state. |
| BLK-secure-runtime | All blocks | Health/readiness state, encrypted storage, key access, lifecycle leases, redacted diagnostics, and update identity. | Startup progresses `BOOTING -> CORE_READY -> RECONCILING -> SAFE -> AGENT_READY`; unsupported or partial state is explicit. |

All contracts include `schemaVersion`, stable identifiers, UTC timestamps, candidate hash where decision-relevant, and provenance. Money, price, and quantity values cross boundaries as decimal strings; Python converts them to `Decimal`. Exchange-session decisions use America/New_York.

## Development Environment

- Supported development and V1 runtime host: Ubuntu 24.04 x86_64.
- Setup mode: native application processes with package-managed developer tooling; containers are optional only for reproducible non-GUI utilities.
- Native host responsibility: Electron/Chromium, Secret Service/keyring, Codex process, Python/SQLCipher, Unix sockets, IB Gateway/TWS API, tray/autostart, packaging, signing, update, and runtime inspection.
- Container boundary: no GUI, keyring, broker, signing, or release-runtime proof may be accepted from a container.
- CI strategy: Linux static, unit, contract, and headless integration checks; manual native evidence for authentication, tray, Gateway, packaging, recovery, and UI.
- Environment constraints: one active application instance, one active broker account, regular US market hours, no broker-login automation, and no dependence on a system Codex configuration.

Exact setup and commands belong in `docs/guides/developer.md` and `docs/commands.md` when the relevant work item introduces them.

## Dependencies And Reuse

| Capability | Candidates | Decision | Version/source | License/security/maintenance | Exit/update path |
| --- | --- | --- | --- | --- | --- |
| Desktop shell | Electron + React + TypeScript | Use after the headless L1 contract exists. | Pin at BLK-operator-desktop activation. | Verify Electron security guidance and maintained React ecosystem before lock. | Renderer/preload contracts keep UI replaceable. |
| Deterministic core | Python 3.12 | Use Python as the only state, risk, and broker authority. | Ubuntu/package lock. | Standard ecosystem; dependency review at selection. | Typed local RPC decouples desktop and agent. |
| Encrypted persistence | SQLite-compatible SQLCipher | Use encrypted local relational storage with migrations and recovery. | Pin in BLK-secure-runtime. | Verify maintained bindings, license, backup, and corruption behavior. | Repository layer exists only at this demonstrated volatility boundary. |
| Agent integration | Codex CLI/app-server | Start with pinned `0.145.0`, stdio, stable API only, exact generated schema. | OpenAI npm distribution; SHA-256 recorded in candidate. | Apache-2.0 package; app-server remains compatibility-sensitive, with no experimental API or silent fallback. | Supervisor boundary permits an architecture replan without entering the money core. |
| Model profile | Codex model catalog | Default `gpt-5.6-sol` with effort `ultra` for manager and all subagents. | Validate via `model/list` at every startup. | User-selectable only from advertised combinations; usage and latency observed. | A change creates a new candidate and requalification. |
| Broker | Official IBKR TWS API through IB Gateway | Use the official Python API; Gateway remains user-installed and user-authenticated. | Pin after WI-003 account spike. | Account permissions and behavior proven in paper before live. | Broker contract isolates future adapters; no second broker in V1. |
| Charts | Apache ECharts candidate | Adopt only after license, security, maintenance, accessibility, and bundle review during UI design. | Pin in UI block. | Apache-2.0 candidate; runtime review required. | Chart view-model contract avoids domain coupling. |

No custom C++ is permitted in V1. A later pure numeric kernel requires profiling evidence and can never own broker, order, ledger, or financial state.

## Data, Security, And Operations

- Stored and sensitive data: encrypted candidates, research metadata, permitted source content, managed-sleeve state, orders/fills/fees, decisions, incidents, and audit records. Account identifiers, credentials, raw restricted data, and unrelated holdings are minimized and redacted.
- Authentication and authorization: ChatGPT login only for V1; `cli_auth_credentials_store = "keyring"`; IBKR login is performed by the user in IB Gateway; persistent live authorization is encrypted and scoped to exact account/candidate/capital hashes.
- Secret boundaries: Python retrieves the database key from Secret Service; Codex owns its credential entry through its dedicated home; no secret appears in source, CLI arguments, environment dumps, renderer state, logs, fixtures, or exports.
- Codex isolation: a stable app-specific `CODEX_HOME` path below `XDG_RUNTIME_DIR`, `--strict-config`, stable protocol, read-only sandbox, approval policy `never`, exact required MCP allowlist, no model-visible shell/web/filesystem/network tools, and OS-level restrictions that still permit the Codex process to reach required OpenAI endpoints. ChatGPT credentials live only in the path-derived keyring namespace; plaintext credential fallback is forbidden.
- Data rights: fields are tagged `PUBLIC_OFFICIAL`, `LICENSED_MODEL_OK`, or `LOCAL_RESTRICTED`; derivatives inherit the strictest input unless a contract explicitly permits otherwise. IBKR market/account data stays local until separate written processing rights and the user's redaction policy permit named fields.
- Persistence: transactional migrations, startup integrity check, encrypted backups/exports, tested restore, explicit retention/deletion, and no permanent raw quote/options lake without rights. Per DEC-001, sensitive Codex threads and SQLite state are physical-runtime-only; bounded logical agent memory is versioned in SQLCipher and rehydrated into a fresh ephemeral thread after restart. Sensitive startup fails closed unless the runtime is memory-backed and cannot page plaintext to unencrypted swap.
- Health and diagnostics: durable incident queue; structured redacted logs; readiness for core, data, broker, ledger, Codex, authorization, and candidate; in-app notification only.
- Concurrency: durable job lease keyed by `(portfolioId, jobType, scheduledAt)`; one active turn per thread; material deltas coalesce; order submission is idempotent across restart.
- Recovery: app-server crash backoff of 1/5/30 seconds with a circuit after three crashes in ten minutes; a recovered app-server receives a fresh physical thread rehydrated from encrypted logical memory rather than resuming Codex-owned sensitive persistence. WI-001 currently implements and tests the deterministic crash/circuit policy, while process-owned restart, orphan cleanup, and cross-restart idempotency remain open. Python or broker failure suspends exposure and reconciles; unknown fills/orders/positions and invariant breaches enter operational kill.
- Deployment: signed manual Linux update; stop active turns, suspend new exposure, update, verify hashes/schema/migrations, and reconcile before resume. Decision-affecting changes require requalification.
- Unsupported states: absent keyring, unrecognized schema, unexpected tool, account mismatch, debit/unsettled cash, unsupported instrument/order/platform, stale decision data, or unavailable required vendor causes visible fail-fast or fail-closed behavior.
