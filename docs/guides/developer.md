# Developer Guide

The current L0 implementation is the isolated Codex app-server qualification harness. It contains no trading, broker, persistence-authority, or desktop UI implementation.

## Prerequisites

- Ubuntu 24.04 x86_64. Other operating systems and architectures are outside the V1 qualification target.
- Node.js 22; the reference validation host currently uses Node 22.22.2 and npm 10.9.7.
- A normal graphical user session with `XDG_RUNTIME_DIR`, Secret Service/keyring, and `/usr/bin/xdg-open` is required only for the opt-in authenticated smoke.
- No container is accepted as evidence for app-server, keyring, browser-login, filesystem-mode, or runtime-storage behavior.

## Clean Setup

```bash
npm ci
npm run project:check
npm run test:codex
npm run codex:compatibility
```

`npm ci` installs the exact `@openai/codex` version and integrity recorded in `package-lock.json`. The compatibility command uses the packaged native executable, creates a private temporary `CODEX_HOME`, performs no login or model turn, emits a redacted report, and removes that runtime before returning.

## Configuration And Secrets

The harness has no local configuration file and accepts no API credential. Codex authentication is ChatGPT browser login with keyring-only storage in the dedicated path-derived namespace. Do not add tokens to command arguments, committed files, fixtures, or evidence.

The authenticated smoke rejects common OpenAI/Codex token environment variables, accepts only its fixed public fixture, and emits no prompt, model response, login URL, account identifier, or credential. Run it only as an explicit manual action:

```bash
npm run codex:auth-smoke -- --login
```

This may open the browser, use ChatGPT capacity, and leave the dedicated keyring entry intact. It never receives licensed research, broker/account data, portfolio state, or live decisions. The current reference host has unencrypted swap, so public fixtures are the only permitted input even though its per-user runtime directory is memory-backed.

## Verification And Results

- `npm run test:codex` runs the fake-process contracts and the isolated real metadata probe.
- `npm run codex:compatibility` prints the standalone credential-free compatibility report and returns nonzero on any failed check.
- `npm run codex:auth-smoke -- --login` prints a redacted manual checklist. Exit code `0` means every implemented check passed, `1` means failure, and `2` means required manual recovery/delegation evidence remains incomplete.
- `npm run project:check` validates canonical planning owners, active work, profile, release state, skills, and links.
- `npm audit` checks the current npm dependency graph; evaluate and resolve findings rather than bypassing them.

No CI, application build, package, migration, shared service, or release artifact exists yet. Those commands are introduced by their owning work items rather than predeclared here.

## Troubleshooting

- A host, binary, package, or schema mismatch is a hard compatibility failure. Reinstall with `npm ci`; do not fall back to a system Codex executable.
- A skill or MCP inventory mismatch is a capability-containment failure. Inspect the redacted report and update the pinned compatibility policy; do not ignore the extra capability.
- A signed-out authenticated smoke remains incomplete until the owner explicitly reruns it with `--login` and completes the browser flow.
- Do not manually copy or create `auth.json`. Keyring unavailability is a fail-closed host problem.
- If an authenticated smoke is forcibly killed and a later run reports `RUNTIME_BUSY`, do not delete its lease file: the dead parent does not prove that every Codex or MCP descendant is gone. Close any known MarketPilot/Codex processes, fully end the graphical user session so its runtime directory is recreated, or reboot the host before retrying.
