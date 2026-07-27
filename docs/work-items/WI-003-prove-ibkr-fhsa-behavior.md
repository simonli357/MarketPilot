---
id: WI-003
title: Prove IBKR FHSA, paper, API, and order behavior
type: spike
status: blocked
block: BLK-broker-execution
release: V1
maturity: L0
requirements: ["FR-004", "IR-002", "SFR-001", "SFR-003", "SFR-004", "SFR-005", "BLK-broker-execution-R001"]
depends_on: []
owner: unassigned
---

# Prove IBKR FHSA, Paper, API, And Order Behavior

## Outcome

The actual IBKR Canada FHSA and linked paper environment prove account identity, USD cash-only behavior, API and market-data permissions, Gateway lifecycle, SMART whole/fractional price-collared orders, broker-resident protection, fills/corrections/commissions, and complete restart reconciliation before production broker design is frozen.

## Success Criteria

- [ ] The owner opens the FHSA and linked paper account, funds/converts settled USD as needed, accepts broker disclosures, enables approved permissions/subscriptions, and installs/authenticates IB Gateway manually.
- [ ] Read-only API discovery proves exact account type, permissions, market-data modes/lines, contracts, cash/settlement fields, open orders, positions, executions, corrections, commissions, and reconnect/replay behavior.
- [ ] Paper tests prove SMART limit and stop-limit behavior, partial fills, cancel/replace, regular-hours flags, restart reconciliation, and no duplicate submission.
- [ ] Account-level tests determine whether fractional permission, `CASHQTY`, entry, exact exit, protection, cancellation, TIF, and previewed commission are defensible; failure leaves fractional live trading disabled.
- [ ] The spike records unsupported states and exact adapter/order-policy decisions without transmitting unapproved live orders.

## Validation

- Automated: broker contract fixtures and reconciliation comparison around captured, redacted paper behavior.
- Manual: Client Portal permissions/subscriptions, Gateway session, paper orders, and any separately user-authorized minimal live probe.
- Environment or fixture: actual IBKR Canada FHSA, linked paper account, current IB Gateway and official TWS API on Ubuntu; no account credentials retained by MarketPilot.

## Execution Contract

- Constraints: No login automation, contribution/withdrawal/FX automation, live option, market order, direct route, margin, short, or unapproved live transmission.
- Boundaries: Read-only discovery and explicit paper behavior first; any minimal live probe needs separate user authorization and may use only the agreed value/order.
- Iteration policy: Reproduce each behavior in TWS/Client Portal where applicable, then through the smallest API probe; treat backend validation and account permissions as authoritative.
- Blocked stop condition: Stop if the actual account cannot expose required cash-only US-stock API behavior or safe reconciliation and request a broker/account/scope decision with the exact rejected capability.

## Evidence

Official documentation supports an IBKR Canada FHSA and fractional US equities, but account-specific behavior has not been observed.

## Blocked Or Deferred

Owner: human. Consequence: broker paper/live design and all live trading remain blocked. Unblock condition: opened IBKR Canada FHSA with linked paper account plus installed, user-authenticated IB Gateway and approved API/data permissions. Next action: the owner completes those external prerequisites, then assigns the spike.
