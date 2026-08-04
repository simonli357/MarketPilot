# Quality And Maturity

## Maturity

| Level | Meaning | Required proof |
| --- | --- | --- |
| L0 | Risk or design unresolved | Bounded question, method, decision, evidence |
| L1 | End-to-end walking skeleton | One real primary flow manually exercised; limitations explicit |
| L2 | Functionally complete block | Required behavior, important states, focused tests and inspection |
| L3 | Production hardened block | Activated risk matrices, operations, clean setup, remaining gaps explicit |
| L4 | Release proven | Required blocks and release gates pass for the named target |

V1 requires every required block at L3. L4 is a separate release decision using `$release-readiness`; automated checks alone cannot promote maturity.

## Activated Risks

| Risk/capability | Activation rationale or constraint | Budget or policy | Evidence owner |
| --- | --- | --- | --- |
| UI/accessibility | The desktop is the only operational and incident interface. | Keyboard-operable primary flows, visible focus, labeled controls/charts, non-color status cues, reduced motion, and approved state references before L2. | BLK-operator-desktop |
| Network/service | OpenAI, research vendors, and IBKR can be unavailable, slow, corrected, or rate-limited. | Typed timeouts/retries, freshness, reconnect/replay, circuit state, and no new exposure on missing decision dependencies. | BLK-agent-runtime, BLK-market-intelligence, BLK-broker-execution |
| Sensitive data/privacy | Credentials, FHSA/account state, decisions, licensed content, and exports are sensitive. | Keyring-only credentials, encrypted database/exports, least data, field rights, redacted diagnostics, tested deletion, and no plaintext fallback. | BLK-secure-runtime |
| Persistence/migrations | Audit, positions, orders, qualification, and authorization must survive restart exactly. | Transactional migration, integrity check, backup/restore, idempotent recovery, and reconciliation before safe state. | BLK-secure-runtime, BLK-broker-execution |
| Money/value | The product can place orders in a registered account. | Python-only authority, decimal arithmetic, fixed authorization, deterministic rules, idempotency, full broker reconciliation, and immutable audit. | BLK-broker-execution |
| Realtime/performance | A three-minute sensor loop and event-driven incidents must remain observable without overlapping decisions. | Coalesce while busy, no overlapping manager turns, p95 event delivery target at most 90 seconds, measured gate/scheduler budgets, and soak evidence. | BLK-market-intelligence, BLK-agent-runtime |
| Native/platform | Keyring, tray, processes, Unix sockets, IB Gateway, packaging, and signing are Linux-native. | Ubuntu 24.04 x64 clean-host setup, runtime, update/recovery, and cleanup evidence. | BLK-secure-runtime |
| Hardware/safety | No physical hardware is controlled. | Inactive for V1. | None |

## Validation Strategy

| Layer | Applies when | Purpose | Canonical command/evidence |
| --- | --- | --- | --- |
| Static/type/lint | From first product code | Reject malformed contracts, imports, configuration, and unsafe boundaries. | Package scripts introduced by the owning work item; always include `npm run project:check`. |
| Unit | Deterministic logic exists | Prove decimal sizing, rights, sessions, materiality, risk invariants, candidate hashes, and state transitions. | Normal test suite with deterministic clocks and fixtures. |
| Integration/contract | Process or external boundary exists | Prove app-server JSONL, MCP, RPC, SQLCipher, vendor, and IBKR adapters against versioned contracts. | Focused contract commands named by the active work item. |
| System/E2E | L1 onward | Prove fixture/public event through manager, critic, gate, simulator/order manager, audit, and operations state. | Headless harness first; native desktop E2E when UI is active. |
| Manual/runtime | Native or hosted behavior matters | Inspect ChatGPT/keyring auth, Codex subagents, tray, Gateway, account permissions, recovery, packaging, and live-state explanations. | Work-item checklist with environment and concise evidence. |
| Visual/accessibility | UI block active | Compare all required states and keyboard/screen-reader behavior to the approved coded system. | `$ui-design` then `$ui-fidelity`; captured state matrix. |
| Performance/resource | Workload exists | Measure event latency, decision backlog, gate time, database growth, memory, and soak behavior. | Repeatable benchmark/soak suite; distributions, not single samples. |
| Security/privacy | From WI-001 onward | Prove config isolation, tool denial, socket permissions, secret absence, rights/redaction, retention, and encrypted recovery. | Security contract tests plus native inspection. |
| Packaging/platform | L3 | Prove clean install, sign-in, run, update, rollback/recovery, uninstall, and retained-user-data policy. | Clean Ubuntu 24.04 x64 VM evidence. |
| Simulation/HIL | Before broker live use | Prove fills, corrections, partials, cancel/replace, gaps, halts, stale data, outage, and restart without capital. | Simulator, shadow ledger, IBKR paper, then minimal user-authorized live evidence. |

At L3, use `$production-hardening` and an independent adversarial review. Stable regression evidence graduates into normal commands; disposable logs remain under ignored `artifacts/work/`.

## Performance And Scale

| Measure | Workload/environment | Baseline | Required budget | Regression threshold |
| --- | --- | --- | --- | --- |
| Deterministic sensing | Up to 30 underlyings, 20 leased option contracts, 70 normal/100 hard data lines on Ubuntu reference host | Establish at L1 | Complete each scan inside the three-minute cadence without overlap or lost material delta. | p95 exceeds 150 seconds or any duplicate/missed scheduled job. |
| Licensed event arrival | Live vendor trial over at least three US trading days | Establish in WI-002 | Source-to-API p95 at most 60–90 seconds and enough remaining budget for a three-minute decision cycle. | p95 above 90 seconds or unobservable corrections/replay. |
| Deterministic gate | 1,000 mixed accept/reject fixtures on reference host | Establish at L1 | p95 below 250 ms excluding broker I/O. | More than 25% slower or any invariant difference. |
| Agent runtime | Material turns using pinned Sol Ultra and required MCP | Establish in WI-001/WI-004 | No overlap; bounded deadline; timeout visibly abstains and preserves queued deltas. | Any unauthorized tool, unbounded turn, lost delta, or silent model/effort downgrade. |
| Recovery | Parameterized real-process crash campaign at every durable state, plus a separate uninterrupted two-hour zero-incident soak | Establish at L1 | Crash cases produce zero duplicate intents/plans/executions and exact reconciliation before readiness; the soak completes every cadence without injected interruption. | Any duplicate, false-safe state, unreconciled gap, soak incident, or missed cadence. |

## Strategy Qualification Policy

| Cadence | Minimum forward paper evidence | Maximum window | Initial micro-live evidence |
| --- | --- | --- | --- |
| Position | 60 sessions; 6 flat-to-flat episodes; 5 symbols; 12 evidence-complete decisions | 252 sessions | 40 sessions; 3 episodes |
| Swing | 40 sessions; 12 episodes; 6 symbols; 20 evidence-complete decisions | 120 sessions | 20 sessions; 6 episodes |
| Intraday | 20 sessions; 15 active sessions; 100 round trips | 60 sessions | 20 sessions; 50 round trips |

Every gate requires positive net performance after conservative commissions, fees, spreads, slippage, partial/rejected-fill effects, and fractional costs; performance at least the defined SPY benchmark; a positive result after removing the best episode or intraday day; a separate shadow-fill ledger; and no safety, drawdown, evidence, or configuration failure. These gates demonstrate bounded operational and forward economic viability, not durable profitability.

## Release Policy

`project/release.json` is the only release-state owner. V1 remains no-go until all required blocks reach L3 and every required gate carries current evidence or a genuine human-approved deferral. Full event rights, actual-account IBKR behavior, FHSA acknowledgement, qualified position evidence, clean Linux setup, native runtime recovery, security/privacy, money integrity, and signed packaging are non-waivable without a new product and release approval.
