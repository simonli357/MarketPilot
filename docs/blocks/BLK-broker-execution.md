---
id: BLK-broker-execution
title: IBKR execution and FHSA safety
status: proposed
maturity: L0
release: V1
requirements: ["FR-004", "IR-001", "IR-002", "DR-003", "QR-002", "SFR-001", "SFR-002", "SFR-003", "SFR-004", "SFR-005"]
depends_on: ["BLK-secure-runtime", "BLK-strategy-evaluation"]
ui: false
---

# IBKR Execution And FHSA Safety

## Outcome

MarketPilot can reconcile one IBKR Canada FHSA and linked paper account, turn qualified intents into deterministic price-collared orders, and supervise a USD 1,000 cash-only mandate without allowing Codex, the UI, a restart, or unknown broker state to bypass authorization and risk invariants.

## Requirements

| ID | Requirement | Priority | Important failure or edge | Work item, spike, or deferral | Verification |
| --- | --- | --- | --- | --- | --- |
| BLK-broker-execution-R001 | Prove the actual FHSA/paper account, permissions, market data, Gateway, TWS API, SMART cash-quantity fractions, order types, commissions, and reconciliation behavior. | Must | Published support does not prove account-specific permission or exit/protection behavior. | WI-003 | Paper and minimal user-authorized account-level probe. |
| BLK-broker-execution-R002 | Enforce capital, reserve, sleeve, issuer, settled-cash, instrument, session, loss, and qualification limits before every order and on every broker event. | Must | Partial fills, corrections, fees, corporate actions, or external orders can break assumptions. | Future work item at block activation | Rule/property tests and broker scenario matrix. |
| BLK-broker-execution-R003 | Use only Tiered SmartRouted price-collared limits and stop-limits, with explicit non-fill/gap behavior and no blind liquidation. | Must | Stops can gap; fractional cash orders cannot be modified; closing limits may not fill. | Future work item at block activation | Order contract tests, paper inspection, halt/gap scenarios. |
| BLK-broker-execution-R004 | Persist authorization but resume only after exact account/candidate/config/broker/ledger reconciliation. | Must | Restart, unknown fill, or account mismatch can otherwise create duplicate or unauthorized exposure. | Future work item at block activation | Crash-at-boundary and idempotency/reconciliation tests. |
| BLK-broker-execution-R005 | Require the FHSA tax-risk acknowledgement before live arming and retain turnover/holding evidence without presenting tax conclusions. | Must | Frequent trading may receive fact-specific CRA treatment. | Future work item at block activation | UI/core contract and audit inspection. |

## Boundary

- Owns: IBKR adapter, contract/permission discovery, account and market streams, portfolio ledger, sleeve allocations, deterministic gate, order plans, submission, fills/corrections/commissions, authorization, reconciliation, pause/kill, and guided reductions.
- Does not own: broker login, contributions/withdrawals, FX conversion, tax determination, research interpretation, strategy qualification decisions, or unrestricted manual trading.
- Inputs and outputs: qualified typed intents, critic verdicts, candidate/authorization, and local market/account state in; gate decisions, orders, executions, portfolio snapshots, and incidents out.
- Dependencies: secure runtime and qualified strategy candidates; actual account/Gateway for WI-003.

## Contracts And Failure

One active account is allowed. V1 live authorization is USD 1,000: USD 900 maximum investable, USD 100 reserve, at most two fixed sleeves, five issuers, and 25% per issuer. Defaults are USD 20 daily new-risk pause and USD 50 peak-to-trough kill; accepted configuration satisfies `0 < daily < kill <= 1000`. Tightening may apply immediately; loosening disarms and requalifies. Operational kill rules are not configurable.

Only eligible USD US-primary-listed common stocks and plain unlevered ETFs may be live, long, settled-cash, and regular-hours. Entries/reductions use SMART `LMT`; position/swing protection uses broker-resident `STP LMT` with `outsideRth=false`. Whole shares are preferred. Fractional `cashQty` is separately qualified, cancel/replaced rather than modified, and charged conservative published costs. Intraday starts exit before close; any position left at 15:55 ET enters kill and guided close without a market-order fallback.

Unknown order/fill/position, account mismatch, debit/unsettled cash, sequence gap, candidate mismatch, limit breach, or impossible ledger state enters kill. Kill cancels working orders, blocks exposure, preserves holdings, records the incident, and exposes guided price-collared reductions.

## Architecture

The Python core is the only TWS API client and money authority. An append-only broker-event inbox feeds transactional reconciliation and portfolio projections. Order submission uses a durable idempotency key and maps one accepted `OrderPlan` to broker identifiers and corrections. Startup recovers the local ledger, connects Gateway, requests open orders/executions/positions/cash, reconciles exact state, then exposes `SAFE`; Codex readiness is a later state and cannot make an unsafe core safe.

## Implementation Blueprint

Run WI-003 when the user provides the account and Gateway. Build a broker simulator and contract tests before IBKR paper, then prove discovery/reconciliation without transmission, price-collared paper orders, partials/corrections/cancel-replace/protection, restart, and only afterward a qualified position micro-live sleeve. No live work starts from documentation alone.

## Maturity Criteria

### L1 Walking Skeleton

- [ ] A qualified fixture intent passes the real deterministic gate and simulated order/fill/reconciliation/audit path without IBKR.
- [ ] An unknown fill and restart are detected without duplicate submission or false-safe state.

### L2 Functional

- [ ] IBKR paper account, permissions, subscriptions, contracts, account state, orders, fills, commissions, protection, cancellation, reconciliation, authorization, and kill behavior are complete.
- [ ] Whole and any enabled fractional paths have exact supported order behavior and conservative costs.

### L3 Hardened

- [ ] Gateway/network outage, reconnect/replay, corrections, corporate actions, settlement, clean setup, diagnostics, long soak, security, and money-integrity review pass.
- [ ] Qualified position micro-live evidence completes without unresolved discrepancy or safety failure.

## Validation

| Outcome or risk | Method | Environment | Evidence |
| --- | --- | --- | --- |
| Account/API assumptions are true | Bounded discovery and order-behavior spike | Actual IBKR FHSA and linked paper account | WI-003 report |
| Money invariants hold | Unit/property and crash-at-boundary integration tests | Simulator and IBKR paper | Normal regression suite |
| Live boundary is defensible | Reconciliation, paper soak, independent adversarial review, then minimal armed position sleeve | Ubuntu reference host and user account | L3 work-item and release evidence |

## Known Gaps

- The IBKR account is not open and IB Gateway is not installed/authenticated, so WI-003 cannot yet complete.
- Stop-limit and price-collared orders cannot guarantee execution through gaps, halts, or absent liquidity; the product must present this honestly.
- Automated FX, contributions, withdrawals, TFSA/taxable activation, and live options are deferred.
