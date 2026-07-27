---
id: WI-002
title: Prove full-event vendor rights, cost, coverage, and latency
type: spike
status: proposed
block: BLK-market-intelligence
release: V1
maturity: L0
requirements: ["DR-001", "DR-002", "BLK-market-intelligence-R001"]
depends_on: []
owner: unassigned
---

# Prove Full-Event Vendor Rights, Cost, Coverage, And Latency

## Outcome

Within 15 business days, MarketPilot has a comparable written rights matrix, quote set, and measured trial for the minimum vendor combination that covers US breaking news, comprehensive global/geopolitical news, normalized events and macro/rates, corporate actions, and analyst-level point-in-time estimates with explicit named OpenAI/Codex processing rights.

## Success Criteria

- [ ] The same rights and dataset matrix is prepared for every shortlisted vendor, including processor, raw/structured/derived fields, caching, corrections, replay, retention/deletion, post-termination, citations, latency, rate, overage, and upstream-wire rights.
- [ ] The user approves each outbound vendor submission and any resulting purchase separately.
- [ ] Passing written terms cover a private Canadian own-account desktop application and the exact hosted-processing and local-retention behavior V1 needs.
- [ ] A three-trading-day trial measures publication-to-vendor and end-to-end p50/p95 latency, coverage, corrections, reconnect/replay, calendar revisions, FOMC/rate events, and genuine analyst-level point-in-time history.
- [ ] The selected set is the lowest-cost complete set; ties resolve by measured p95 latency, coverage, then contract simplicity. No partial-coverage fallback is labeled V1-ready.

## Validation

- Automated: schema/coverage matrix completeness checks and trial metric calculations once authorized data exists.
- Manual: written contract/order-form review and user approval of vendor selection and price.
- Environment or fixture: official vendor documents, sales responses, order forms, and time-limited live trials; no purchase without approval.

## Execution Contract

- Constraints: Treat marketing, tutorials, MCP availability, and verbal assurances as insufficient; do not send personal data or agree to terms without user approval.
- Boundaries: Prepare the fixed request and evaluate returned terms/trials; do not build production adapters or alter V1 requirements inside this spike.
- Iteration policy: Ask each vendor the same unresolved clause once in writing, update the matrix, and eliminate any candidate that misses a must-have right or measured coverage requirement.
- Blocked stop condition: If no candidate supplies explicit passing rights and coverage by the deadline, record full-events V1 as blocked and request a human scope or budget decision; do not extend research indefinitely.

## Evidence

Not yet started.

## Blocked Or Deferred

Outbound requests and purchases remain subject to explicit user approval. Sales waiting time does not block WI-001.
