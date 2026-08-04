# Developer Guide

The current L1 implementation is the isolated Codex app-server qualification harness plus a fixture-only paper authority/recovery proof. It contains no trading, broker, production SQLCipher store, or desktop UI implementation.

## Prerequisites

- Ubuntu 24.04 x86_64. Other operating systems and architectures are outside the V1 qualification target.
- Node.js 22; the reference validation host currently uses Node 22.22.2 and npm 10.9.7.
- Python 3.12; the paper authority is dependency-free stdlib code and is invoked as `python3.12 -m marketpilot.paper_fixture_authority` through the bounded Node adapter.
- A normal graphical user session with `XDG_RUNTIME_DIR`, Secret Service/keyring, and `/usr/bin/xdg-open` is required only for the opt-in authenticated smoke.
- No container is accepted as evidence for app-server, keyring, browser-login, filesystem-mode, or runtime-storage behavior.

## Clean Setup

```bash
npm ci
npm run project:check
npm run test:codex
npm run codex:compatibility
npm run check:paper-core
npm run test:paper-core
npm run audit:paper-core
npm run test:paper-recovery
npm run paper:recovery-matrix
npm run paper:recovery-boundaries
npm run paper:recovery-benchmark
npm run test:materiality
npm run paper:agent-hosted -- --help
```

`npm ci` installs the exact `@openai/codex` version and integrity recorded in `package-lock.json`. The compatibility command uses the packaged native executable, creates a private temporary `CODEX_HOME`, performs no login or model turn, emits a redacted report, and removes that runtime before returning.

## Configuration And Secrets

The harness has no local configuration file and accepts no API credential. Codex authentication is ChatGPT browser login with keyring-only storage in the dedicated path-derived namespace. Do not add tokens to command arguments, committed files, fixtures, or evidence.

The authenticated smoke rejects common OpenAI/Codex token environment variables, accepts only its fixed public fixture, and emits no prompt, model response, login URL, account identifier, or credential. Reuse an existing dedicated keyring session with:

```bash
npm run codex:auth-smoke
```

If that reports no keyring session, opt into the one-time browser flow with `npm run codex:auth-smoke -- --login`. The command uses ChatGPT capacity and leaves the dedicated keyring entry intact. It never receives licensed research, broker/account data, portfolio state, or live decisions. The current reference host has unencrypted swap, so public fixtures are the only permitted input even though its per-user runtime directory is memory-backed.

## Verification And Results

- `npm run test:codex` runs the fake-process contracts and the isolated real metadata probe.
- `npm run codex:compatibility` prints the standalone credential-free compatibility report and returns nonzero on any failed check.
- `npm run codex:auth-smoke` prints the redacted authenticated checklist and automates the real turn, fresh-process resume, interrupt/recovery, and bounded-delegation checks. Exit code `0` means every check passed, `1` means failure, and `2` means the dedicated keyring session is absent because browser login was not requested.
- `npm run project:check` validates canonical planning owners, active work, profile, release state, skills, and links.
- `npm audit` checks the current npm dependency graph; evaluate and resolve findings rather than bypassing them.
- `npm run check:paper-core` checks the local Draft 2020-12 registry, Node/Python golden parity, deterministic audit verification, and the focused Python suite.
- `npm run paper:fixture -- --case accepted` and `npm run paper:fixture -- --case rejected` emit redaction-safe summaries only; the Python boundary never reads network or product state.
- `npm run paper:recovery-matrix` executes exactly thirty deterministic named failure/recovery cases; `npm run paper:recovery-boundaries` injects a crash after every accepted durable boundary and reopens the fixture store; `npm run paper:recovery-benchmark` measures the reproducible 1,000-fixture Python gate with p95 under the 250 ms L1 budget.
- `npm run test:materiality` covers the three-minute lease/coalescing/circuit transitions and restart/tamper guards. Normal scheduler construction routes through the Python authority; the explicit callback factory is test-only. `npm run paper:soak` is the required uninterrupted two-hour real-clock fixture soak and has no shortened-run option; it reports workload, latency, ephemeral database growth, process resource use, authority audit identities, incidents, and threshold violations. The redaction-safe report is also written to ignored `artifacts/work/wi-008-soak-report.json`.

No CI, application build, package, migration, shared service, or release artifact exists yet. Those commands are introduced by their owning work items rather than predeclared here.

The hosted paper-agent command is opt-in and fixture-only. It launches two fresh ephemeral physical app-server sessions, verifies the ChatGPT/keyring Sol Ultra runtime, and reports only redacted artifact IDs/hashes. It must not be used with custom prompts, symbols, accounts, broker data, or API tokens.

## Troubleshooting

- A host, binary, package, or schema mismatch is a hard compatibility failure. Reinstall with `npm ci`; do not fall back to a system Codex executable.
- A skill or MCP inventory mismatch is a capability-containment failure. Inspect the redacted report and update the pinned compatibility policy; do not ignore the extra capability.
- A signed-out authenticated smoke remains incomplete until the owner explicitly reruns it with `--login` and completes the browser flow.
- Do not manually copy or create `auth.json`. Keyring unavailability is a fail-closed host problem.
- If an authenticated smoke is forcibly killed and a later run reports `RUNTIME_BUSY`, do not delete its lease file: the dead parent does not prove that every Codex or MCP descendant is gone. Close any known MarketPilot/Codex processes, fully end the graphical user session so its runtime directory is recreated, or reboot the host before retrying.
