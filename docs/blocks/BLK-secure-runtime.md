---
id: BLK-secure-runtime
title: Encrypted local runtime and operations
status: proposed
maturity: L0
release: V1
requirements: ["FR-001", "DR-002", "DR-003", "PR-001", "QR-002", "SFR-004"]
depends_on: []
ui: false
---

# Encrypted Local Runtime And Operations

## Outcome

MarketPilot installs and operates predictably on Ubuntu 24.04 x64 with encrypted durable application state, least-privilege local processes, exact readiness, safe restart/update, redacted diagnostics, and recoverable audit data.

## Requirements

| ID | Requirement | Priority | Important failure or edge | Work item, spike, or deferral | Verification |
| --- | --- | --- | --- | --- | --- |
| BLK-secure-runtime-R001 | Encrypt application data and exports with keys held by Secret Service; never use a plaintext credential or silent fallback. | Must | Missing keyring, partial backup, or plaintext sidecar can defeat encryption. | Future work item at block activation | Native keyring, at-rest inspection, backup/restore, and secret-scan tests. |
| BLK-secure-runtime-R002 | Supervise one Electron instance, Python core, and Codex process with private sockets/capabilities and exact readiness transitions. | Must | Split brain, stale process, or overprivileged renderer can bypass authority. | Future work item at block activation | Process crash/restart and IPC/socket permission tests. |
| BLK-secure-runtime-R003 | Provide transactional migration, integrity, backup/restore, retention/deletion, redacted diagnostics, and signed manual update/recovery. | Must | Corruption or decision-affecting update can invalidate authorization and audit. | Future work item at block activation | Clean-host migration/update/rollback and recovery matrix. |
| BLK-secure-runtime-R004 | Prove Ubuntu 24.04 x64 install, tray/autostart, keyring, app/Gateway process interaction, packaging, signing, uninstall, and cleanup. | Must | Container or developer-host success cannot prove native release behavior. | Future work item at block activation | Clean VM runtime and package evidence. |

## Boundary

- Owns: application database/key, migrations, backup/export/restore/delete, local process and socket lifecycle, readiness aggregation, leases, diagnostics, update/package identity, autostart, and cleanup.
- Does not own: Codex protocol semantics, data normalization, strategy logic, broker reconciliation rules, UI composition, or IB Gateway installation/login.
- Inputs and outputs: component health and durable events in; secure storage, readiness, lifecycle actions, diagnostics, and recovery outcomes out.
- Dependencies: Ubuntu native facilities including Secret Service; other blocks consume this boundary.

## Contracts And Failure

Startup moves monotonically through `BOOTING`, `CORE_READY`, `RECONCILING`, `SAFE`, and `AGENT_READY`; later component loss produces an explicit degraded/paused/killed state, never stale ready. Unix sockets are mode 0600 and capability scoped per launch. Keyring absence, database/schema mismatch, corruption, unsupported host, duplicate instance, or unverified update fails fast. Expected process/network failure is typed, observable, and bounded.

## Architecture

Electron main is the native supervisor and only renderer bridge. Python owns SQLCipher and durable job leases. Each process receives a minimal environment and only the local capability it needs. Application logs are structured and redacted; release evidence uses a size-budgeted manifest. Updates suspend active turns/new exposure, verify signature and component hashes, migrate, reconcile, and only then resume if the candidate is unchanged.

Codex-owned persistence is outside SQLCipher and must be resolved jointly with BLK-agent-runtime before it contains sensitive context. An encrypted filesystem boundary or ephemeral/reconstructed physical threads must be proven; private permissions alone are not accepted as encryption.

## Implementation Blueprint

Use the L1 headless process boundaries before adding the full desktop. Select maintained SQLCipher/keyring/package libraries only after license, security, maintenance, platform, and recovery review. Add crash-at-boundary tests and clean-host scripts as stable behavior appears. Defer signing and final packaging detail until L3, while preserving the update/requalification contract from the start.

## Maturity Criteria

### L1 Walking Skeleton

- [ ] A fresh local core starts, stores one encrypted audit event, recovers after process restart, and reports exact readiness through a private socket.
- [ ] Missing key or corrupt state fails visibly without fake recovery.

### L2 Functional

- [ ] Persistence, migrations, backup/export/restore/delete, process supervision, leases, readiness, diagnostics, tray/autostart, and update coordination are complete.
- [ ] Codex persistence has an approved and tested encryption boundary.

### L3 Hardened

- [ ] Clean Ubuntu install, keyring, package/signature, update/rollback, long soak, crash matrix, security/privacy review, resource budgets, uninstall, and retained-data policy pass.
- [ ] No plaintext secret or sensitive durable state, overbroad socket/IPC, false readiness, or unsupported fallback remains.

## Validation

| Outcome or risk | Method | Environment | Evidence |
| --- | --- | --- | --- |
| Data is encrypted and recoverable | At-rest inspection, secret scanning, backup/restore/delete and corruption scenarios | Native Ubuntu with Secret Service | Security and migration evidence |
| Lifecycle is exact | Crash each process at durable boundaries, duplicate-instance and stale-lease tests | Headless then Electron runtime | State transition/soak evidence |
| Native artifact is operable | Clean install, sign-in, autostart, update/recovery, uninstall | Clean Ubuntu 24.04 x64 VM | L3 package manifest |

## Known Gaps

- SQLCipher/keyring/package dependencies and the Codex-state encryption mechanism remain to be selected and proven in their owning work items.
- Windows is explicitly deferred; no platform abstraction may compromise the Ubuntu V1 proof.
