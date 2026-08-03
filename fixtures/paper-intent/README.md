# WI-005 public fixtures

The committed, immutable fixture source is `src/paper-fixture/fixtures.mjs` (and the equivalent stdlib builder in `src/marketpilot/paper_fixtures.py`). It contains only the synthetic `PUBLIC_OFFICIAL` `MPTEST` event and deterministic manager/critic stand-ins. The accepted and quantity-two rejected requests are generated without network, account, broker, or production state; their artifact hashes are recomputed from the canonical contract before crossing the process boundary.

The headless command is:

```text
npm run paper:fixture -- --case accepted
npm run paper:fixture -- --case rejected
```
