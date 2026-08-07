# Commands

Run commands from the repository root. The authenticated smoke is intentionally separate from normal validation.

## Project Workflow

```bash
npm run project:check
npm run project:status
npm run project:skills
npm run project:migrate
```

## Setup

```bash
npm ci
npm run paper:setup
npm run project:check
```

## Codex Runtime Validation

```bash
npm run test:codex
npm run codex:compatibility
npm audit
```

## Paper-Intent Authority Validation

```bash
npm run check:paper-core
npm run test:paper-core
npm run audit:paper-core
npm run test:paper-recovery
npm run paper:recovery-matrix
npm run paper:recovery-boundaries
npm run paper:recovery-benchmark
npm run test:materiality
npm run paper:fixture -- --case accepted
npm run paper:fixture -- --case rejected
npm run paper:agent-hosted -- --help
```

The fixture commands use only the committed synthetic `PUBLIC_OFFICIAL` MPTEST event. They do not contact a broker, read account or licensed-data state, or arm live trading.

`npm run paper:setup` creates the ignored private Python environment from `requirements/paper-core.lock`. `npm run audit:paper-core` verifies both locked validator graphs and may create a separate ignored audit-tool environment; its npm and Python vulnerability checks require package-registry access.

The WI-007 recovery commands use a temporary fixture-only SQLite-compatible store (`fixtureOnly=1`, `productionState=0`, no encryption). The current diagnostic matrix exposes thirty named cases, boundary validation closes and reopens the store after injected crash hooks, and the benchmark is fixed at 1,000 in-process Python authority fixtures excluding process startup and broker I/O. These commands exercise the candidate harness; only WI-007's canonical success criteria determine whether the paths, boundaries, concurrency behavior, and benchmark pass gate are accepted.

The WI-008 deterministic tests exercise the three-minute lease, coalescing, timeout/crash/circuit recovery, tamper handling, and readiness states. The current rejected candidate calls the Python fixture authority directly and stores summary hashes/IDs; injected callbacks are available only through the explicitly named test factory. Acceptance requires the normal scheduler to resolve each job through WI-007's durable operation/artifact/audit store. `npm run paper:soak` is fixed to an uninterrupted two-hour real-clock fixture soak, accepts no shortened duration flag, and writes its redaction-safe report to ignored `artifacts/work/wi-008-soak-report.json`. Passing the current tests or producing a report does not close WI-008 unless its canonical durable mapping, live validation, persistence, fixed workload, pass predicate, and separate manual walkthrough also hold.

The opt-in hosted paper-agent command runs the current candidate keyring-backed Sol Ultra manager/critic flow against the same fixture. It accepts only `--login` (for the existing browser/keyring flow) and prints redacted fixture output. WI-006 remains open until the command proves model-originated semantic drafts, exact role-specific capability inventories, typed auth/entitlement/reroute/tool/schema/process failures, and cleanup-before-success with propagated cleanup failure:

```bash
npm run paper:agent-hosted
npm run paper:agent-hosted -- --login
```

## Opt-In Authenticated Smoke

```bash
npm run codex:auth-smoke -- --help
npm run codex:auth-smoke
npm run codex:auth-smoke -- --login
```

The normal command reuses the dedicated keyring session. Add `--login` only when opting into the browser flow; both paths run the same fixed public-fixture Sol Ultra proof and never accept API tokens, prompts, or custom fixture content.

## Package And Release

No application packaging or release command exists at L0.
