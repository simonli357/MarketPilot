---
id: BLK-market-intelligence
title: Rights-aware market intelligence
status: proposed
maturity: L0
release: V1
requirements: ["DR-001", "DR-002", "IR-001", "QR-002"]
depends_on: ["BLK-secure-runtime"]
ui: false
---

# Rights-Aware Market Intelligence

## Outcome

MarketPilot turns approved official and licensed sources into timely, normalized, provenance-rich US-equity and global market events that deterministic analytics, Codex, strategies, and the operator can use only within explicit field-level rights.

## Requirements

| ID | Requirement | Priority | Important failure or edge | Work item, spike, or deferral | Verification |
| --- | --- | --- | --- | --- | --- |
| BLK-market-intelligence-R001 | Obtain written rights, coverage, quotes, and measured latency for the complete V1 event contract. | Must | AI marketing, an MCP demo, or verbal assurance is not contractual permission. | WI-002 | Fixed rights matrix, signed terms/order forms, quotes, and live trial report. |
| BLK-market-intelligence-R002 | Normalize filings, issuer releases, breaking US/global news, macro/rates, corporate actions, and analyst-level point-in-time estimates. | Must | Duplicates, revisions, entity ambiguity, timestamp drift, and missing analyst history can change decisions. | Future work item at block activation | Contract fixtures and live correction/replay inspection. |
| BLK-market-intelligence-R003 | Enforce source/field model, display, cache, retention, replay, derivation, and termination rights. | Must | Derived records may reconstruct or inherit restricted data. | Future work item at block activation | Rights property tests and denied-path integration tests. |
| BLK-market-intelligence-R004 | Keep restricted IBKR market/account data local and respect bounded subscriptions and line budgets. | Must | Hosted transfer or broad chain streaming can violate contracts and resource limits. | Future work item at block activation | Payload inspection, subscription accounting, and hard-limit tests. |

## Boundary

- Owns: source adapters, provenance, rights metadata, entity resolution, event normalization, corrections, permitted cache/replay, deterministic derived facts, and freshness/coverage health.
- Does not own: model reasoning, strategy decisions, portfolio state, broker order authority, or final UI composition.
- Inputs and outputs: external source records and contracts in; versioned `ResearchEvent`, evidence retrieval, deterministic analytics, and rights/freshness state out.
- Dependencies: secure persistence; vendor access and written contracts for licensed coverage.

## Contracts And Failure

Every field names its source, publication/receipt/effective timestamps, rights class, permitted consumers, retention, and revision chain. Unknown source, ambiguous entity, unsupported schema, stale decision field, expired right, missing correction path, or vendor outage is explicit. Required coverage never silently falls back to a partial feed.

## Architecture

Adapters feed a Python normalization and rights pipeline. Public and licensed data remain separable; derived records inherit the strictest input. Codex-facing retrieval is built from allowed fields rather than redaction after assembly. Live IBKR data uses an independent local-only path and bounded lease manager.

## Implementation Blueprint

Run WI-002 first. Then implement canonical public adapters and a vendor-neutral normalized contract, add the approved vendor set, exercise corrections and latency, and only then enable Codex retrieval. Store raw content only for the contractually permitted period; retain source identifiers and non-reconstructive audit outputs where allowed.

## Maturity Criteria

### L1 Walking Skeleton

- [ ] One official public event is normalized, rights-checked, retrieved, corrected, and consumed by the headless product path.
- [ ] Missing, stale, revised, and forbidden fields are visibly rejected.

### L2 Functional

- [ ] All required V1 source classes, entity mapping, analytics, correction/replay, coverage, and field rights are complete.
- [ ] Licensed trials meet the event contract and model-processing policy.

### L3 Hardened

- [ ] Vendor outage/reconnect, quotas, retention/deletion, diagnostics, clean setup, latency budgets, and adversarial rights review pass.
- [ ] No required coverage, contract, or upstream-wire right remains unresolved.

## Validation

| Outcome or risk | Method | Environment | Evidence |
| --- | --- | --- | --- |
| Vendor set is legally and technically usable | 15-business-day rights/quote/latency spike | Vendor trial and written responses | WI-002 decision matrix |
| Normalized records are trustworthy | Golden contracts, property tests, correction/replay integration | Fixtures plus live public sources | Versioned regression suite |
| Hosted payloads obey rights | Denied-path and payload inspection tests | Local core and fixture Codex MCP | Rights audit evidence |

## Known Gaps

- No vendor contract or budget is approved. Full-events V1 remains no-go until WI-002 and user purchase approval complete.
- Research-grade historical backtesting and a permanent raw quote/options lake are explicitly outside V1.
