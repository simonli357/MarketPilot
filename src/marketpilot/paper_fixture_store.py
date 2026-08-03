"""Fixture-only durable recovery store for the WI-007 L1 matrix.

This module is intentionally a small ``sqlite3`` repository, not the future
production SQLCipher store.  It persists only the committed public MPTEST
fixture and stores the authority's already-validated response/audit objects.
Every write is idempotent, every recovery path re-evaluates the original
request through the Python authority, and an incomplete or tampered operation
never reports readiness.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from .paper_fixture_authority import (
    InputContractError,
    canonical_json_bytes,
    compute_hash,
    evaluate_request,
    verify_response,
)


PROFILE = "marketpilot.paper-intent-fixture.v1"
FIXTURE_INSTRUMENT = "MPTEST"
STORE_SCHEMA_VERSION = 1

# These are public because the recovery harness and evidence report use the
# exact names.  The aliases make the durable boundary explicit even when a
# rejected operation has no plan/fill phase.
CRASH_BOUNDARIES = (
    "after_operation_begin",
    "after_research_persist",
    "after_candidate_persist",
    "after_intent_persist",
    "after_critic_persist",
    "after_input_audit_commit",
    "after_gate_commit",
    "after_gate_audit_commit",
    "after_plan_commit",
    "after_plan_audit_commit",
    "after_fill_commit",
    "after_fill_audit_commit",
    "after_terminal_commit",
    "after_idempotency_commit",
)

_CRASH_ALIASES = {
    "acceptance": "after_operation_begin",
    "audit:1": "after_research_persist",
    "audit:2": "after_candidate_persist",
    "audit:3": "after_intent_persist",
    "audit:4": "after_critic_persist",
    "gate": "after_gate_commit",
    "plan": "after_plan_commit",
    "fill": "after_fill_commit",
    "audit": "after_terminal_commit",
}


class StoreError(RuntimeError):
    """Base class for safe, typed repository failures."""


class CrashInjected(StoreError):
    """A test-only crash after a committed durable boundary."""

    def __init__(self, boundary: str, operation_id: str):
        super().__init__(f"crash injected after {boundary}")
        self.code = "CRASH_INJECTED"
        self.boundary = boundary
        self.operation_id = operation_id


class IdempotencyConflict(StoreError):
    """An operation key was reused for a different request."""

    def __init__(self, operation_id: str):
        super().__init__("operation idempotency key is bound to another request")
        self.code = "IDEMPOTENCY_CONFLICT"
        self.operation_id = operation_id


class RecoveryBlocked(StoreError):
    """Stored state is unknown, missing, or tampered and cannot be guessed."""

    def __init__(self, operation_id: str, reason: str = "durable state failed reconciliation"):
        super().__init__(reason)
        self.code = "RECOVERY_BLOCKED"
        self.operation_id = operation_id


class NonPublicFixture(StoreError):
    """The fixture-only repository was given non-public or non-fixture data."""

    def __init__(self, reason: str = "only the public MPTEST fixture is durable"):
        super().__init__(reason)
        self.code = "NON_PUBLIC_DATA_REJECTED"


@dataclass(frozen=True)
class OperationRecord:
    operation_id: str
    request_hash: str
    status: str
    phase: int
    ready: bool
    reconciled: bool
    event_count: int
    response: dict[str, Any] | None


class FixtureAuthorityStore:
    """A transactional, fixture-only repository with crash-safe replay."""

    def __init__(self, path: str | Path = ":memory:") -> None:
        self.path = str(path)
        self._connection = sqlite3.connect(self.path, isolation_level=None)
        self._connection.row_factory = sqlite3.Row
        self._connection.execute("PRAGMA foreign_keys = ON")
        self._connection.execute("PRAGMA busy_timeout = 5000")
        self._connection.execute(
            """
            CREATE TABLE IF NOT EXISTS store_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )
            """
        )
        self._connection.execute(
            """
            CREATE TABLE IF NOT EXISTS operations (
                operation_id TEXT PRIMARY KEY,
                request_hash TEXT NOT NULL UNIQUE,
                request_json TEXT NOT NULL,
                response_json TEXT,
                status TEXT NOT NULL CHECK (status IN ('PENDING', 'ACCEPTED', 'REJECTED', 'BLOCKED')),
                phase INTEGER NOT NULL CHECK (phase BETWEEN 0 AND 5),
                ready INTEGER NOT NULL CHECK (ready IN (0, 1)),
                reconciled INTEGER NOT NULL CHECK (reconciled IN (0, 1)),
                created_at TEXT NOT NULL
            )
            """
        )
        self._connection.execute(
            """
            CREATE TABLE IF NOT EXISTS audit_events (
                operation_id TEXT NOT NULL,
                sequence INTEGER NOT NULL CHECK (sequence >= 1),
                event_hash TEXT NOT NULL,
                event_json TEXT NOT NULL,
                PRIMARY KEY (operation_id, sequence),
                UNIQUE (operation_id, event_hash),
                FOREIGN KEY (operation_id) REFERENCES operations(operation_id) ON DELETE RESTRICT
            )
            """
        )
        for key, value in {
            "schemaVersion": str(STORE_SCHEMA_VERSION),
            "profile": PROFILE,
            "fixtureOnly": "1",
            "productionState": "0",
            "encryption": "none",
        }.items():
            self._connection.execute("INSERT OR IGNORE INTO store_meta(key, value) VALUES (?, ?)", (key, value))
        metadata = {row["key"]: row["value"] for row in self._connection.execute("SELECT key, value FROM store_meta").fetchall()}
        if metadata.get("schemaVersion") != str(STORE_SCHEMA_VERSION) or metadata.get("profile") != PROFILE or metadata.get("fixtureOnly") != "1" or metadata.get("productionState") != "0" or metadata.get("encryption") != "none":
            raise StoreError("fixture store schema version is unsupported")

    def close(self) -> None:
        self._connection.close()

    def __enter__(self) -> "FixtureAuthorityStore":
        return self

    def __exit__(self, _type: Any, _value: Any, _traceback: Any) -> None:
        self.close()

    def process(self, request: dict[str, Any], *, crash_at: str | None = None) -> dict[str, Any]:
        """Evaluate and durably materialize one request.

        ``crash_at`` is test-only.  The exception is raised *after* the
        boundary transaction commits, so a new process can call ``recover``.
        """

        if crash_at is not None and crash_at not in CRASH_BOUNDARIES and crash_at not in _CRASH_ALIASES:
            raise ValueError(f"unknown crash boundary: {crash_at}")
        self._assert_public_fixture(request)
        try:
            response = evaluate_request(request)
        except InputContractError:
            # Invalid input is not a durable operation.  The authority's typed
            # protocol error remains the caller's responsibility.
            raise
        operation_id = response["operationId"]
        request_hash = compute_hash(request, "request")
        if response["requestHash"] != request_hash:
            raise RecoveryBlocked(operation_id, "authority request hash differs from canonical request")
        existing = self._row(operation_id)
        if existing is not None:
            if existing["request_hash"] != request_hash:
                raise IdempotencyConflict(operation_id)
            if existing["ready"]:
                stored = self._decode_response(existing["response_json"], operation_id)
                self._verify_stored(operation_id, stored)
                return stored
            return self.recover(operation_id)

        request_json = _canonical_text(request)
        self._transaction(
            "INSERT INTO operations(operation_id, request_hash, request_json, response_json, status, phase, ready, reconciled, created_at) VALUES (?, ?, ?, NULL, 'PENDING', 0, 0, 0, ?)",
            (operation_id, request_hash, request_json, request["decisionAt"]),
        )
        self._maybe_crash(crash_at, "after_operation_begin", operation_id)
        self._maybe_crash(crash_at, "after_idempotency_commit", operation_id)
        self._materialize(operation_id, response, crash_at=crash_at)
        return self._finish(operation_id, response, crash_at=crash_at)

    def recover(self, operation_id: str) -> dict[str, Any]:
        """Reconcile one incomplete operation without guessing unknown state."""

        row = self._row(operation_id)
        if row is None:
            raise RecoveryBlocked(operation_id, "operation is not present")
        if row["ready"]:
            response = self._decode_response(row["response_json"], operation_id)
            self._verify_stored(operation_id, response)
            return response
        if row["status"] != "PENDING" or row["reconciled"] or row["phase"] not in range(0, 5):
            self._mark_blocked(operation_id)
            raise RecoveryBlocked(operation_id, "incomplete operation has an unknown durable state")
        try:
            request = json.loads(row["request_json"])
            response = evaluate_request(request)
        except Exception as exc:  # noqa: BLE001 - recovery must fail closed
            self._mark_blocked(operation_id)
            raise RecoveryBlocked(operation_id, "original request no longer reconciles") from exc
        if response["operationId"] != operation_id or response["requestHash"] != row["request_hash"]:
            self._mark_blocked(operation_id)
            raise RecoveryBlocked(operation_id, "replayed authority identity differs")
        try:
            self._materialize(operation_id, response, crash_at=None)
            return self._finish(operation_id, response, crash_at=None)
        except RecoveryBlocked:
            raise
        except Exception as exc:  # noqa: BLE001
            self._mark_blocked(operation_id)
            raise RecoveryBlocked(operation_id) from exc

    def get_operation(self, operation_id: str) -> OperationRecord | None:
        row = self._row(operation_id)
        if row is None:
            return None
        response = None if row["response_json"] is None else self._decode_response(row["response_json"], operation_id)
        count = self._connection.execute("SELECT COUNT(*) FROM audit_events WHERE operation_id = ?", (operation_id,)).fetchone()[0]
        return OperationRecord(
            operation_id=operation_id,
            request_hash=row["request_hash"],
            status=row["status"],
            phase=row["phase"],
            ready=bool(row["ready"]),
            reconciled=bool(row["reconciled"]),
            event_count=count,
            response=response,
        )

    def verify_operation(self, operation_id: str) -> bool:
        row = self._row(operation_id)
        if row is None or not row["ready"] or not row["reconciled"] or row["response_json"] is None:
            return False
        try:
            response = self._decode_response(row["response_json"], operation_id)
            self._verify_stored(operation_id, response)
            return True
        except (StoreError, KeyError, TypeError, ValueError, json.JSONDecodeError):
            return False

    def readiness(self) -> dict[str, Any]:
        """Return a safe readiness envelope; pending/unknown state is never ready."""

        rows = self._connection.execute("SELECT operation_id, ready, reconciled, status FROM operations ORDER BY operation_id").fetchall()
        if any(row["status"] == "BLOCKED" for row in rows):
            return {"ready": False, "reasonCode": "RECOVERY_BLOCKED", "pendingOperations": [row["operation_id"] for row in rows if row["status"] == "BLOCKED"]}
        pending = [row["operation_id"] for row in rows if not row["ready"] or not row["reconciled"]]
        if pending:
            return {"ready": False, "reasonCode": "RECONCILIATION_PENDING", "pendingOperations": pending}
        invalid = [row["operation_id"] for row in rows if not self.verify_operation(row["operation_id"])]
        if invalid:
            return {"ready": False, "reasonCode": "AUDIT_INTEGRITY_INVALID", "pendingOperations": invalid}
        return {"ready": True, "reasonCode": "READY", "pendingOperations": []}

    def audit_events(self, operation_id: str) -> list[dict[str, Any]]:
        rows = self._connection.execute("SELECT event_json FROM audit_events WHERE operation_id = ? ORDER BY sequence", (operation_id,)).fetchall()
        return [json.loads(row[0]) for row in rows]

    def _materialize(self, operation_id: str, response: dict[str, Any], *, crash_at: str | None) -> None:
        row = self._row(operation_id)
        if row is None or row["status"] != "PENDING" or row["ready"] or row["reconciled"]:
            self._mark_blocked(operation_id)
            raise RecoveryBlocked(operation_id, "durable operation is not a pending reconciliation")
        events = response["auditEvents"]
        existing_sequences = [row["sequence"] for row in self._connection.execute("SELECT sequence FROM audit_events WHERE operation_id = ? ORDER BY sequence", (operation_id,)).fetchall()]
        if existing_sequences != list(range(1, len(existing_sequences) + 1)) or any(sequence > len(events) for sequence in existing_sequences):
            self._mark_blocked(operation_id)
            raise RecoveryBlocked(operation_id, "durable audit sequence contains a gap or extra event")
        for index, event in enumerate(events, start=1):
            if self._event_exists(operation_id, index):
                self._assert_event(operation_id, index, event)
                continue
            self._append_event(operation_id, event, phase=_phase_for_event(index, len(events)))
            self._maybe_crash(crash_at, f"audit:{index}", operation_id)
            if index == 1:
                self._maybe_crash(crash_at, "after_research_persist", operation_id)
            elif index == 2:
                self._maybe_crash(crash_at, "after_candidate_persist", operation_id)
            elif index == 3:
                self._maybe_crash(crash_at, "after_intent_persist", operation_id)
            elif index == 4 and event["eventType"] == "INPUT_CRITIC_RECORDED":
                self._maybe_crash(crash_at, "after_critic_persist", operation_id)
                self._maybe_crash(crash_at, "after_input_audit_commit", operation_id)
            event_type = event["eventType"]
            if event_type == "GATE_DECIDED":
                self._maybe_crash(crash_at, "after_gate_commit", operation_id)
                self._maybe_crash(crash_at, "after_gate_audit_commit", operation_id)
            elif event_type == "ORDER_PLANNED":
                self._maybe_crash(crash_at, "after_plan_commit", operation_id)
                self._maybe_crash(crash_at, "after_plan_audit_commit", operation_id)
            elif event_type == "EXECUTION_SIMULATED":
                self._maybe_crash(crash_at, "after_fill_commit", operation_id)
                self._maybe_crash(crash_at, "after_fill_audit_commit", operation_id)

    def _finish(self, operation_id: str, response: dict[str, Any], *, crash_at: str | None) -> dict[str, Any]:
        events = self.audit_events(operation_id)
        if len(events) != len(response["auditEvents"]):
            raise RecoveryBlocked(operation_id, "audit sequence is incomplete")
        if not verify_response(response, self._request_for(operation_id)):
            raise RecoveryBlocked(operation_id, "authority response failed independent verification")
        self._transaction(
            "UPDATE operations SET response_json = ?, status = ?, phase = 5, ready = 1, reconciled = 1 WHERE operation_id = ? AND ready = 0",
            (_canonical_text(response), response["status"], operation_id),
        )
        self._maybe_crash(crash_at, "after_terminal_commit", operation_id)
        stored = self._decode_response(_canonical_text(response), operation_id)
        self._verify_stored(operation_id, stored)
        return stored

    def _append_event(self, operation_id: str, event: dict[str, Any], *, phase: int) -> None:
        sequence = int(event["sequence"])
        event_json = _canonical_text(event)
        event_hash = event["eventHash"]
        self._transaction(
            "INSERT INTO audit_events(operation_id, sequence, event_hash, event_json) VALUES (?, ?, ?, ?)",
            (operation_id, sequence, event_hash, event_json),
        )
        self._transaction("UPDATE operations SET phase = MAX(phase, ?) WHERE operation_id = ?", (phase, operation_id))

    def _assert_event(self, operation_id: str, sequence: int, expected: dict[str, Any]) -> None:
        row = self._connection.execute("SELECT event_hash, event_json FROM audit_events WHERE operation_id = ? AND sequence = ?", (operation_id, sequence)).fetchone()
        if row is None or row["event_hash"] != expected["eventHash"] or row["event_json"] != _canonical_text(expected):
            self._mark_blocked(operation_id)
            raise RecoveryBlocked(operation_id, "stored audit event differs from deterministic replay")

    def _verify_stored(self, operation_id: str, response: dict[str, Any]) -> None:
        request = self._request_for(operation_id)
        row = self._row(operation_id)
        audit_rows = self._audit_rows(operation_id)
        events = [json.loads(item["event_json"]) for item in audit_rows]
        if (
            row is None
            or row["operation_id"] != response.get("operationId")
            or row["status"] != response.get("status")
            or row["phase"] != 5
            or not row["ready"]
            or not row["reconciled"]
            or events != response["auditEvents"]
            or any(item["event_hash"] != event.get("eventHash") for item, event in zip(audit_rows, events))
            or [item["sequence"] for item in audit_rows] != list(range(1, len(audit_rows) + 1))
            or not verify_response(response, request)
        ):
            self._mark_blocked(operation_id)
            raise RecoveryBlocked(operation_id, "stored response or audit chain failed verification")
        if row["request_hash"] != response["requestHash"]:
            self._mark_blocked(operation_id)
            raise RecoveryBlocked(operation_id, "stored request identity failed verification")

    def _request_for(self, operation_id: str) -> dict[str, Any]:
        row = self._row(operation_id)
        if row is None:
            raise RecoveryBlocked(operation_id, "operation disappeared")
        try:
            return json.loads(row["request_json"])
        except (TypeError, ValueError, json.JSONDecodeError) as exc:
            raise RecoveryBlocked(operation_id, "stored request is not JSON") from exc

    def _decode_response(self, raw: str | None, operation_id: str) -> dict[str, Any]:
        if raw is None:
            raise RecoveryBlocked(operation_id, "response has not been durably reconciled")
        value = json.loads(raw)
        if not isinstance(value, dict):
            raise RecoveryBlocked(operation_id, "stored response is not an object")
        return value

    def _row(self, operation_id: str) -> sqlite3.Row | None:
        return self._connection.execute("SELECT * FROM operations WHERE operation_id = ?", (operation_id,)).fetchone()

    def _event_exists(self, operation_id: str, sequence: int) -> bool:
        return self._connection.execute("SELECT 1 FROM audit_events WHERE operation_id = ? AND sequence = ?", (operation_id, sequence)).fetchone() is not None

    def _audit_rows(self, operation_id: str) -> list[sqlite3.Row]:
        return self._connection.execute("SELECT sequence, event_hash, event_json FROM audit_events WHERE operation_id = ? ORDER BY sequence", (operation_id,)).fetchall()

    def _transaction(self, sql: str, params: Iterable[Any]) -> None:
        self._connection.execute("BEGIN IMMEDIATE")
        try:
            self._connection.execute(sql, tuple(params))
            self._connection.execute("COMMIT")
        except Exception:
            self._connection.execute("ROLLBACK")
            raise

    def _mark_blocked(self, operation_id: str) -> None:
        self._transaction("UPDATE operations SET status = 'BLOCKED', ready = 0, reconciled = 0 WHERE operation_id = ?", (operation_id,))

    @staticmethod
    def _maybe_crash(crash_at: str | None, boundary: str, operation_id: str) -> None:
        requested = _CRASH_ALIASES.get(crash_at, crash_at)
        if requested == boundary:
            raise CrashInjected(boundary, operation_id)

    @staticmethod
    def _assert_public_fixture(request: dict[str, Any]) -> None:
        try:
            if request.get("profile") != PROFILE or request.get("policyId") != "FIXTURE_LONG_US_EQUITY_100_V1" or request.get("messageType") != "EVALUATE_FIXTURE_PAPER_INTENT":
                raise NonPublicFixture("only the committed fixture contract may be persisted")
            bundle = request["bundle"]
            research = bundle["researchEvent"]
            candidate = bundle["candidateManifest"]
            intent = bundle["tradeIntent"]
            if research["instrumentId"] != FIXTURE_INSTRUMENT or candidate["instrumentId"] != FIXTURE_INSTRUMENT:
                raise NonPublicFixture("only the MPTEST fixture may be persisted")
            if candidate["mode"] != "PAPER" or candidate["liveEligible"] is not False or candidate["policy"]["policyId"] != "FIXTURE_LONG_US_EQUITY_100_V1":
                raise NonPublicFixture("live or non-fixture candidate state cannot be persisted")
            if intent.get("proposal") is not None and intent["proposal"].get("instrumentId") != FIXTURE_INSTRUMENT:
                raise NonPublicFixture("only the MPTEST intent may be persisted")
            if research["rightsClass"] != "PUBLIC_OFFICIAL" or any(fact["rightsClass"] != "PUBLIC_OFFICIAL" for fact in research["facts"]):
                raise NonPublicFixture()
            if any(source["sourceClass"] != "PUBLIC_OFFICIAL" for source in research["provenance"]):
                raise NonPublicFixture()
        except KeyError as exc:
            raise NonPublicFixture("fixture identity is incomplete") from exc


def _canonical_text(value: Any) -> str:
    return canonical_json_bytes(value).decode("utf-8")


def _phase_for_event(sequence: int, total: int) -> int:
    if sequence <= min(4, total):
        return 1
    if sequence == 5:
        return 2
    if sequence == 6:
        return 3
    if sequence == 7:
        return 4
    return 4


def request_digest(request: dict[str, Any]) -> str:
    """Return the stable local digest used by recovery diagnostics."""

    return hashlib.sha256((PROFILE + "/request\0").encode("ascii") + canonical_json_bytes(request)).hexdigest()


__all__ = [
    "CRASH_BOUNDARIES",
    "CrashInjected",
    "FixtureAuthorityStore",
    "FIXTURE_INSTRUMENT",
    "IdempotencyConflict",
    "NonPublicFixture",
    "OperationRecord",
    "RecoveryBlocked",
    "StoreError",
    "request_digest",
]
