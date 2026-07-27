# Quality And Maturity

`project/profile.json` owns capability and risk activation. This document owns activation rationale, measurable budgets, maturity definitions, global validation strategy, and release policy. Blocks and work items own specific criteria and evidence.

## Maturity

| Level | Meaning | Required proof |
| --- | --- | --- |
| L0 | Risk or design unresolved | Bounded question, method, decision, evidence |
| L1 | End-to-end walking skeleton | One real primary flow manually exercised; limitations explicit |
| L2 | Functionally complete block | Required behavior, important states, focused tests and inspection |
| L3 | Production hardened block | Activated risk matrices, operations, clean setup, remaining gaps explicit |
| L4 | Release proven | Required blocks and release gates pass for the named target |

Do not apply L3 criteria to every L1 task. Do not call L2 or L3 complete from test counts alone.

## Activated Risks

Resolve every applicable `auto` value in `project/profile.json` before implementation. Record only rationale and measurable policy here.

| Risk/capability | Activation rationale or constraint | Budget or policy | Evidence owner |
| --- | --- | --- | --- |
| UI/accessibility |  |  |  |
| Network/service |  |  |  |
| Sensitive data/privacy |  |  |  |
| Persistence/migrations |  |  |  |
| Money/value |  |  |  |
| Realtime/performance |  |  |  |
| Native/platform |  |  |  |
| Hardware/safety |  |  |  |

## Validation Strategy

| Layer | Applies when | Purpose | Canonical command/evidence |
| --- | --- | --- | --- |
| Static/type/lint | Tooling supports it | Reject malformed or boundary-breaking code |  |
| Unit | Isolated logic exists | Prove local behavior and invariants |  |
| Integration/contract | Boundaries exist | Prove adapters and modules together |  |
| System/E2E | User/operator flow exists | Prove complete workflows |  |
| Manual/runtime | Automation is insufficient | Inspect actual behavior and failure paths |  |
| Visual/accessibility | UI active | Compare states and interaction against approved system |  |
| Performance/resource | Budget active | Measure latency, throughput, memory, FPS, load or soak |  |
| Security/privacy | Risk active | Test trust, authorization, secrets, redaction, retention |  |
| Packaging/platform | Distributed software | Prove clean install, run, update, rollback, cleanup |  |
| Simulation/HIL | Hardware or risky behavior | Prove safely before real-world acceptance |  |

## Performance And Scale

Do not promise scalability without a workload and budget.

| Measure | Workload/environment | Baseline | Required budget | Regression threshold |
| --- | --- | --- | --- | --- |
|  |  |  |  |  |

Profile before optimizing. Keep repeatable benchmarks in tests or CI, not one-off task scripts.

## Release Policy

`project/release.json` is the only mutable release-state owner. Required gates must name evidence, blockers, and approved deferrals. Stale evidence cannot close changed outcomes.
