# Product And Releases

## Destination

MarketPilot is a private, single-user desktop market operating system for a Canadian investor. It combines licensed and official market intelligence, explainable Codex research, deterministic portfolio and risk controls, paper evidence, and auditable IBKR execution. The defining experience is an operations console where every position, proposal, rejection, incident, and lesson can be traced to the evidence and frozen configuration that produced it; autonomous trading is permitted only inside an explicitly armed and independently qualified envelope.

## Release Outcomes

| Release | User or operator outcome | Required capabilities | Explicitly later | Exit evidence |
| --- | --- | --- | --- | --- |
| V1 | On Ubuntu 24.04 x64, the owner can research and paper-test US equities across position, swing, and deterministic intraday cadences, then arm a qualified position strategy for bounded autonomous trading in one IBKR Canada FHSA. | Isolated Sol Ultra runtime; full licensed event intelligence; frozen candidates and forward qualification; deterministic risk/order core; IBKR paper/live reconciliation; encrypted operations console. | Windows; live options; TFSA/taxable activation; other assets; margin, shorts, and extended hours; unrestricted order ticket; automatic promotion. | Required blocks reach L3; clean Linux install and recovery pass; required data and broker contracts are proven; position paper gate passes; a user-authorized micro-live flow is reconciled and audited. |
| V2 | The owner can qualify additional account types and live strategy sleeves without weakening the V1 safety boundary. | Swing/intraday live qualification, additional registered-account validation, broader portfolio tooling. | Multi-user or commercial service, mobile clients, other brokers. | Named V2 blocks and release gates are approved when V2 is activated. |
| Later | MarketPilot becomes an adaptable personal market operating system across more assets, brokers, and platforms. | Evidence-driven expansion only. | No commitment until a later release is planned. | New release plan and human approval. |

## Users And Value

| User/operator | Problem | Desired outcome | Critical constraint |
| --- | --- | --- | --- |
| Canadian owner-investor | Market evidence, portfolio state, strategy behavior, and broker actions are fragmented and difficult to supervise continuously. | One explainable workspace that can research, simulate, qualify, and safely automate a small US-equity mandate. | The owner remains responsible for the account and tax treatment; the application must fail closed around money, data rights, and unknown broker state. |

## Journeys

| ID | Journey | Success | Failure or recovery |
| --- | --- | --- | --- |
| UJ-001 | Install, authenticate, and connect | The app starts on Ubuntu, uses keyring-backed ChatGPT authentication, connects to a user-authenticated IB Gateway, and reports an exact readiness state. | Missing credentials, unsupported runtime, or reconciliation failure leaves trading disarmed with a durable incident. |
| UJ-002 | Research and understand | The owner can inspect normalized events, evidence, theses, counterarguments, and portfolio relevance or ask questions in chat. | Stale, unlicensed, contradicted, or incomplete evidence is labeled and cannot create new exposure. |
| UJ-003 | Paper-test and qualify | Each strategy candidate accumulates forward paper and shadow-fill evidence against its cadence-specific gate. | Configuration drift, insufficient evidence, drawdown, or safety failure resets or fails that candidate visibly. |
| UJ-004 | Arm and supervise live position investing | The owner acknowledges FHSA risk, arms a qualified USD 900 sleeve, and can observe every intent, gate, order, fill, fee, thesis, and incident. | Kill cancels working orders, blocks exposure, preserves holdings, and provides guided price-collared reductions after reconciliation. |
| UJ-005 | Learn without self-modifying live behavior | Post-trade reflection proposes a new frozen candidate for review and paper qualification. | Reflection cannot alter or promote the armed candidate automatically. |

## Global Requirements

| ID | Category | Requirement | Priority | Block, spike, or deferral |
| --- | --- | --- | --- | --- |
| FR-001 | Functional | Run as a private single-user desktop application with tray/background operation, persistent incident attention, and explicit readiness and authorization states. | Must | BLK-operator-desktop, BLK-secure-runtime |
| FR-002 | Functional | Use an app-controlled Codex manager, bounded specialists, and an independent critic to produce typed research and trade intents; Python remains final authority. | Must | BLK-agent-runtime |
| FR-003 | Functional | Paper-test position, swing, and deterministic long intraday strategies independently, using immutable candidate versions and cadence-specific qualification. | Must | BLK-strategy-evaluation |
| FR-004 | Functional | Reconcile and trade through the official TWS API and a separately installed, user-authenticated IB Gateway, with paper before live. | Must | BLK-broker-execution |
| FR-005 | Functional | Provide an operations console, research drill-down, evidence-linked explanations, qualification views, and operator chat whose intent requests pass the same gate. | Must | BLK-operator-desktop |
| FR-006 | Functional | Record decision-time context and outcomes, then create reviewable candidate suggestions without live self-modification or automatic promotion. | Must | BLK-strategy-evaluation, BLK-agent-runtime |
| FR-007 | Functional | Paper-test long calls, long puts, covered calls, and protective puts, with no 0DTE and no V1 live eligibility. | Should | BLK-strategy-evaluation; live options deferred beyond V1 |
| IR-001 | Interface | Exchange versioned typed events, intents, critic verdicts, gate decisions, order plans, executions, candidate manifests, and qualification records across process boundaries. | Must | BLK-agent-runtime, BLK-broker-execution, BLK-market-intelligence |
| IR-002 | Interface | Support exactly one active broker account at a time and at most two isolated live sleeves with fixed allocations and no overlapping symbols. | Must | BLK-broker-execution, BLK-strategy-evaluation |
| DR-001 | Data | Ingest official filings and issuer sources plus licensed US breaking news, comprehensive global/geopolitical news, normalized macro/rate/corporate-action calendars, and analyst-level point-in-time estimates. | Must | BLK-market-intelligence; bounded vendor-rights spike WI-002 |
| DR-002 | Data | Enforce source- and field-level model, display, retention, correction, replay, and derived-data rights; never silently route restricted data to hosted Codex. | Must | BLK-market-intelligence, BLK-secure-runtime |
| DR-003 | Data | Maintain an encrypted, reconstructable audit ledger for configurations, evidence, intents, gates, orders, fills, fees, reconciliations, incidents, and learning artifacts. | Must | BLK-secure-runtime, BLK-broker-execution |
| PR-001 | Platform/environment | Support Ubuntu 24.04 x86_64 as the only V1 runtime target; validate GUI, keyring, process supervision, Gateway, packaging, update, and cleanup natively. | Must | BLK-secure-runtime |
| QR-001 | Quality | Require forward paper evidence, conservative costs and shadow fills, benchmark comparison, best-result removal, and immediate safety failure before live eligibility. | Must | BLK-strategy-evaluation |
| QR-002 | Quality | Expose typed, observable, tested failure for authentication, rate limits, stale data, vendor/broker outage, crash, restart, partial fills, corrections, and schema mismatch. | Must | All required blocks |
| SFR-001 | Safety/failure | Restrict V1 live trading to settled-cash, long positions in eligible USD US-primary-listed common stocks and plain unlevered ETFs during regular hours. | Must | BLK-broker-execution, BLK-strategy-evaluation |
| SFR-002 | Safety/failure | Cap live authorization at USD 1,000 with USD 100 reserve, no more than USD 900 across sleeves, five issuers, and 25% per issuer; default loss limits are USD 20 daily and USD 50 hard kill. | Must | BLK-broker-execution |
| SFR-003 | Safety/failure | Submit only SmartRouted price-collared limit and stop-limit orders; never silently use market orders, direct routing, leverage, shorts, or blind liquidation. | Must | BLK-broker-execution |
| SFR-004 | Safety/failure | Fail closed on unknown fill/order/position, account or candidate mismatch, invariant breach, unavailable decision data, or unqualified configuration. | Must | BLK-broker-execution, BLK-secure-runtime, BLK-agent-runtime |
| SFR-005 | Safety/failure | Require a live FHSA acknowledgement that MarketPilot gives no tax advice and creates no CRA safe harbour; professional sign-off is not a V1 prerequisite. | Must | BLK-operator-desktop, BLK-broker-execution |

## Open Human Choices

| Question | Recommended option | Why it matters | Blocking? |
| --- | --- | --- | --- |
| Which licensed vendors satisfy the full event contract and hosted-processing rights? | Select the lowest-cost passing set after the fixed 15-business-day rights, quote, and latency spike. | V1 cannot claim required event coverage or send licensed fields to Codex without written rights. | Blocks V1 data completion, not WI-001. |
| When will the IBKR FHSA, linked paper account, permissions, subscriptions, and Gateway be available? | Open and validate them before broker implementation leaves its spike. | Account-specific behavior cannot be proven from documentation alone. | Blocks broker/live work, not the first walking skeleton. |
