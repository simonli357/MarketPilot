# Risk Gates

Load only categories activated in `project/profile.json` or the active block.

| Risk | Required hardening questions |
| --- | --- |
| Network/service | Timeouts, retries, idempotency, partial outcomes, backpressure, health, shutdown |
| Sensitive data | Authorization, secret handling, redaction, retention, deletion, audit, threat model |
| Money/value | Idempotency, reconciliation, immutable audit, provider failure, legal/support gates |
| Realtime | Latency distribution, throughput, memory, dropped work, overload, soak, recovery |
| Persistence | Migration, corruption, concurrency, backup, restore, rollback, compatibility |
| Native/platform | Permissions, unsupported OS, packaging, signing, update, clean installation |
| Hardware | Simulation, HIL, timeout, safe stop, stale input, disconnect, recovery |
| UI | All states, accessibility, responsive behavior, asset use, screenshot drift, real interaction |

Give every activated quantitative risk a budget and a repeatable measurement. Do not add inactive gates as compliance theater.
