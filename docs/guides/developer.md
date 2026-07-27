# Developer Guide

Complete this guide before product implementation. Commands must work from a clean supported Linux and Windows environment.

## Prerequisites

- Supported operating systems and versions:
- Pinned runtime and package-manager versions:
- Container runtime when used:
- Native SDKs, compilers, emulators, drivers, or hardware:

## Setup

1. Clone the repository.
2. Install or activate the pinned toolchain.
3. Create local configuration from a committed safe example; never commit secrets.
4. Start shared services.
5. Install dependencies reproducibly.
6. Run the setup verification command.

Exact commands belong in `docs/commands.md`.

## Environment Strategy

Use containers for shared services and reproducible CLI tooling; keep GUI runtime, OS integration, signing, installers, and hardware access native.

Record explicitly:

- What runs in containers and why.
- What must run natively on Linux and Windows.
- Filesystem, path, line-ending, networking, permission, and shell differences.
- How local setup matches CI and where it intentionally differs.

Do not force GUI runtimes, hardware access, signing, or unstable native SDK workflows into Docker merely for uniformity. Do not leave databases, queues, or shared service versions unpinned when containers can remove drift.

## Configuration And Secrets

List required variables, safe local defaults, source of secrets, validation behavior, and rotation expectations. The application must fail clearly when required configuration is absent or invalid.

## Verification

Define one fast command that proves toolchain, dependencies, services, configuration shape, and a minimal real execution path. Also document clean reset, data migration, and troubleshooting steps that solve root causes rather than bypass checks.

## CI And Release Parity

State which setup, test, build, packaging, migration, and release commands CI executes. Validate release artifacts from a clean environment on every target platform that has native behavior.
