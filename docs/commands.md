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

## Opt-In Authenticated Smoke

```bash
npm run codex:auth-smoke -- --help
npm run codex:auth-smoke -- --login
```

The second command may open the system browser and run the fixed public-fixture Sol Ultra turn. It never accepts API tokens, prompts, or custom fixture content.

## Package And Release

No application packaging or release command exists at L0.
