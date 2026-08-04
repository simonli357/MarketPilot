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

The WI-007 recovery commands use a temporary fixture-only SQLite-compatible store (`fixtureOnly=1`, `productionState=0`, no encryption). The matrix is exactly thirty deterministic named cases; boundary validation closes and reopens the store after each injected crash. The benchmark is fixed at 1,000 in-process Python authority fixtures and excludes process startup and broker I/O.

The WI-008 deterministic tests cover the three-minute lease, coalescing, timeout/crash/circuit recovery, tamper detection, and no-false-ready states. Normal scheduler construction always uses the Python fixture authority; injected callbacks are available only through the explicitly named test factory and cannot promote a production scheduler turn. The scheduler stores redacted authority hashes/IDs and result hashes; the full immutable response/audit remains owned and verified by the WI-005/WI-007 Python authority store. `npm run paper:soak` is intentionally fixed to the uninterrupted two-hour real-clock fixture soak; no shortened duration flag is accepted. It prints and writes the redaction-safe report to ignored `artifacts/work/wi-008-soak-report.json`.

The opt-in hosted paper-agent command runs the real keyring-backed Sol Ultra manager and independent critic against the same fixture. It accepts only `--login` (for the existing browser/keyring flow), prints redacted IDs/hashes, and fails closed on any auth, entitlement, reroute, tool, schema, process, or authority error:

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
