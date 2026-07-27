# Architecture And Environment

Owns cross-block system shape, interfaces, dependencies, environment, and durable technical policy. Block files own local design.

## System Context

| Actor/system | Interaction | Trust or failure boundary |
| --- | --- | --- |
|  |  |  |

## Boundaries

Choose boundaries from actual complexity; do not force layers or packages without benefit.

| Boundary/module | Responsibility | Depends on | Why separate |
| --- | --- | --- | --- |
|  |  |  |  |

## Cross-Block Contracts

| Producer block | Consumer block | Contract | Version/failure behavior |
| --- | --- | --- | --- |
|  |  |  |  |

## Development Environment

- Supported development hosts: Linux and Windows unless the project explicitly narrows them.
- Profile guidance: Use containers for shared services and reproducible CLI tooling; keep GUI runtime, OS integration, signing, installers, and hardware access native.
- Setup mode: native / container / devcontainer / hybrid
- Container responsibility and boundary:
- Native host responsibility and boundary:
- CI parity and platform matrix strategy:
- Environment constraints that shape architecture:

Containers should reduce shared-service drift, not hide platform behavior that requires native validation.

Exact runtimes, tools, commands, configuration, and troubleshooting belong only in `docs/guides/developer.md` and `docs/commands.md`.

## Dependencies And Reuse

| Capability | Candidates | Decision | Version/source | License/security/maintenance | Exit/update path |
| --- | --- | --- | --- | --- | --- |
|  |  |  |  |  |  |

Prefer package-managed dependencies. Record provenance and update strategy for vendored or forked code.

## Data, Security, And Operations

- Stored and sensitive data:
- Authentication and authorization:
- Secret boundaries:
- Migration, backup, restore, deletion:
- Health, logs, diagnostics, alerts:
- Deployment, rollback, cleanup:
- Unsupported states and startup failure policy:
