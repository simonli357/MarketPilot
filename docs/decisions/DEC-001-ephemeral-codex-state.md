# DEC-001: Keep Sensitive Codex State Ephemeral

- Status: accepted
- Date: 2026-07-27
- Owners: MarketPilot owner
- Related blocks or work items: BLK-agent-runtime, BLK-secure-runtime, WI-001, WI-004

## Context

Codex app-server owns persistence that MarketPilot cannot redirect through SQLCipher. The pinned `0.145.0` compatibility probe created `goals_1.sqlite`, `logs_2.sqlite`, `memories_1.sqlite`, and `state_5.sqlite` even though it started only an ephemeral, unauthenticated metadata thread and disabled goals, logs, and memories. The files were plaintext mode 0644 inside a private mode-0700 home. A durable Codex thread can also create rollout transcripts.

Codex credentials are a separate concern. The [pinned authentication source](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/login/src/auth/storage.rs#L226-L245) derives the keyring account key from the canonical `CODEX_HOME` path, so a stable absolute path gives MarketPilot a dedicated repeatable keyring namespace without an `auth.json` file. The current reference host provides a private per-user tmpfs at `/run/user/$UID`, but its tmpfs can page to unencrypted swap; that host is therefore safe only for public qualification fixtures until its swap posture changes.

## Decision

MarketPilot will keep physical Codex conversation and database state ephemeral and keep durable logical agent memory in the encrypted Python-owned database.

- Production uses a stable, app-specific absolute runtime path below `XDG_RUNTIME_DIR` for `CODEX_HOME`, work files, SQLite state, and any qualification-only transcripts. Directories are non-symlink, owned by the current user, and mode 0700. The stable path preserves the path-derived keyring namespace even when its contents are recreated.
- Authentication is ChatGPT through `cli_auth_credentials_store = "keyring"`; `auth.json`, credential copying, API-key fallback, and `auto` credential fallback are forbidden.
- Sensitive product threads use `ephemeral: true`, history persistence is `none`, plaintext log output is not enabled, and the application never treats a physical Codex thread ID as durable state.
- The Python authority stores only the minimum versioned logical memory needed to reconstruct a manager, specialist, or critic in SQLCipher. After app-server or OS restart, MarketPilot creates a fresh physical thread and rehydrates it from that bounded memory.
- Before licensed research, account state, portfolio state, or live decisions can enter Codex, startup must prove that the runtime path is memory-backed and cannot page plaintext to unencrypted swap. An encrypted-swap host is acceptable; a non-swappable memory filesystem is also acceptable. An unknown or unencrypted posture fails closed.
- A durable thread may be used only in the public-fixture compatibility smoke to prove first-turn materialization and restart/resume behavior. Its runtime is deleted after the smoke and is not a product persistence path.

The compatibility probe may continue to use public, non-sensitive fixtures on a private disk-backed temporary directory because it never authenticates or starts a model turn. This exception does not weaken the sensitive-data gate.

## Consequences

The design removes Codex-owned plaintext files from durable product state and makes app-server replacement practical. Keyring login can survive application restarts because namespace identity comes from the stable runtime path, while conversation state does not survive an OS runtime-directory reset.

Rehydration adds tokens, latency, summary-versioning work, and fidelity tests. MarketPilot must bound and hash logical memory, distinguish public qualification from sensitive operation, validate runtime/swap posture, disable core dumps and unsafe diagnostics, and delete runtime state on logout/uninstall according to the secure-runtime policy. Direct `thread/resume` is not a recovery dependency.

## Alternatives Considered

- Persist Codex state on the normal application filesystem: rejected because SQLCipher cannot protect Codex-owned SQLite and rollout formats.
- Put `CODEX_HOME` on an encrypted FUSE filesystem: deferred because it adds mount/key/recovery complexity and still permits plaintext pages in unencrypted swap while mounted.
- Rely only on full-disk encryption: rejected as the application boundary because it does not provide selective deletion or protection from other same-user processes while the system is running.
- Use experimental app-server persistence controls or an unpinned SDK: rejected because V1 permits only the pinned stable protocol surface.
