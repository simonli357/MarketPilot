"""Fixture-only three-minute materiality scheduler and L1 soak harness.

The scheduler owns cadence, leases, coalescing, recovery, and metrics.  It
does not own acceptance or execution authority: the callback receives a
bounded list of public fixture delta IDs and returns a typed result.  The
production portfolio/SQLCipher scheduler is deliberately out of scope.
"""

from __future__ import annotations

import json
import hashlib
import argparse
import math
import os
import resource
import re
import secrets
import sqlite3
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable


CADENCE_SECONDS = 180
LEASE_SECONDS = 30
CIRCUIT_WINDOW_SECONDS = 600
CIRCUIT_COOLDOWN_SECONDS = 30
SOAK_SECONDS = 2 * 60 * 60
SOAK_PROFILE = "marketpilot.materiality-soak.v1"
_OPERATION_ID_RE = re.compile(r"^op_[a-z0-9_]{2,63}$")
_GATE_ID_RE = re.compile(r"^gd_[a-z0-9_]{2,63}$")
_PLAN_ID_RE = re.compile(r"^plan_[a-z0-9_]{2,63}$")
_EXECUTION_ID_RE = re.compile(r"^exec_[a-z0-9_]{2,63}$")
_RESPONSE_HASH_RE = re.compile(r"^[0-9a-f]{64}$")
_ALLOWED_DELTA_PAYLOAD_KEYS = {"fixture", "ordinal", "material"}
_RESULT_KEYS = {"status", "reasonCode", "operationId", "responseHash", "auditEventCount", "auditHeadHash", "gateDecisionId", "orderPlanId", "executionId"}
_REJECT_REASON_CODES = {
    "QUANTITY_LIMIT_EXCEEDED", "NOTIONAL_LIMIT_EXCEEDED", "CRITIC_REJECTED", "CRITIC_ABSTAINED", "CRITIC_MISSING",
    "CRITIC_INTENT_MISMATCH", "CRITIC_CANDIDATE_MISMATCH", "INTENT_ABSTAINED", "EVIDENCE_STALE", "INTENT_EVIDENCE_MISMATCH", "INTENT_CANDIDATE_MISMATCH", "FIXTURE_POLICY_MISMATCH",
    "CANDIDATE_INACTIVE", "CANDIDATE_NOT_PAPER", "CANDIDATE_LIVE_ELIGIBLE", "INTENT_STALE", "CRITIC_STALE", "TIME_ORDER_INVALID", "RIGHTS_NOT_PUBLIC", "CURRENCY_NOT_USD",
    "INSTRUMENT_NOT_ALLOWED", "ACTION_NOT_ALLOWED", "SIDE_NOT_ALLOWED", "SESSION_NOT_REGULAR", "PRICE_NOT_MARKETABLE",
    "CRITIC_NOT_DISTINCT", "FIXTURE_TEST",
}
_FAILURE_CODES = {
    "MANAGER_PROCESS_FAILED",
    "MANAGER_RESULT_INVALID",
    "DUPLICATE_ACCEPTANCE",
    "SCHEDULER_ACCEPTANCE_INVALID",
    "AUTH_REQUIRED",
    "RATE_LIMITED",
    "TURN_TIMEOUT",
    "AUTHORITY_TIMEOUT",
    "AUTHORITY_PROCESS_FAILED",
    "AUTHORITY_INPUT_ERROR",
    "AUTHORITY_OUTPUT_INVALID",
    "AUTHORITY_RESPONSE_MISMATCH",
}
_UNCERTAIN_OPERATION_CODES = {"TURN_TIMEOUT", "AUTHORITY_TIMEOUT", "AUTHORITY_PROCESS_FAILED"}
_ABSTAIN_CODES = _FAILURE_CODES | {
    "MANAGER_ABSTAINED", "SCHEDULER_CIRCUIT_OPEN", "SCHEDULER_RECOVERY_ABSTAINED", "SCHEDULER_OPERATION_UNCERTAIN",
}


class SchedulerError(RuntimeError):
    """Typed scheduler failure; no exposure is implied by any exception."""

    def __init__(self, code: str, message: str = "materiality scheduler failed closed") -> None:
        super().__init__(message)
        self.code = code


class SchedulerFailure(SchedulerError):
    pass


def _safe_delta_id(value: Any) -> bool:
    return isinstance(value, str) and bool(value) and len(value) <= 128 and all(0x21 <= ord(char) <= 0x7E for char in value)


def _decode_delta_ids(raw: Any) -> tuple[str, ...]:
    if raw is None:
        return ()
    if not isinstance(raw, str):
        raise ValueError("delta input set must be JSON text")
    decoded = json.loads(raw)
    if not isinstance(decoded, list) or not decoded or any(not _safe_delta_id(delta_id) for delta_id in decoded) or len(decoded) != len(set(decoded)):
        raise ValueError("delta input set is invalid")
    return tuple(decoded)


@dataclass
class DeterministicClock:
    """A monotonic deterministic clock for scheduler transition tests."""

    value: float = 0.0

    def now(self) -> float:
        return self.value

    def advance(self, seconds: float) -> None:
        if seconds < 0:
            raise ValueError("clock cannot move backwards")
        self.value += seconds


@dataclass(frozen=True)
class SchedulerMetrics:
    scheduled_jobs: int
    completed_jobs: int
    abstained_jobs: int
    manager_turns: int
    material_deltas: int
    nonmaterial_deltas: int
    processed_material_deltas: int
    traceable_nonmaterial_deltas: int
    incidents: int
    overlap_violations: int
    missed_job_violations: int
    lost_delta_violations: int
    unaudited_incident_violations: int
    duplicate_acceptance_violations: int
    latency_ms: tuple[float, ...]


class MaterialityScheduler:
    """A durable one-manager-at-a-time materiality loop."""

    def __init__(
        self,
        path: str | Path = ":memory:",
        *,
        portfolio_id: str = "portfolio_fixture",
        job_type: str = "materiality_decision",
        cadence_seconds: int = CADENCE_SECONDS,
        lease_seconds: int = LEASE_SECONDS,
        clock: DeterministicClock | Callable[[], float] | None = None,
        manager_callback: Callable[[tuple[str, ...], str], dict[str, Any]] | None = None,
        _allow_test_callback: bool = False,
    ) -> None:
        if cadence_seconds != CADENCE_SECONDS:
            raise ValueError("WI-008 cadence is fixed at three minutes")
        if lease_seconds < 1 or lease_seconds > cadence_seconds:
            raise ValueError("lease duration is outside the scheduler bound")
        if manager_callback is not None and not _allow_test_callback:
            raise SchedulerError("SCHEDULER_AUTHORITY_CALLBACK_FORBIDDEN")
        self.path = str(path)
        self.portfolio_id = portfolio_id
        self.job_type = job_type
        self.cadence_seconds = cadence_seconds
        self.lease_seconds = lease_seconds
        self._clock = clock or time.time
        self._test_callback = manager_callback is not None
        self._manager_callback = manager_callback or _fixture_manager_callback
        self._manager_busy = False
        self._connection = sqlite3.connect(self.path, isolation_level=None)
        self._connection.row_factory = sqlite3.Row
        self._connection.execute("PRAGMA foreign_keys = ON")
        self._connection.execute("PRAGMA busy_timeout = 5000")
        self._connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS scheduler_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS scheduler_jobs (
                job_key TEXT PRIMARY KEY,
                scheduled_at REAL NOT NULL,
                state TEXT NOT NULL CHECK (state IN ('QUEUED','RUNNING','COMPLETED','ABSTAINED')),
                lease_id TEXT,
                input_delta_ids_json TEXT,
                attempts INTEGER NOT NULL DEFAULT 0,
                started_at REAL,
                completed_at REAL,
                error_code TEXT
            );
            CREATE TABLE IF NOT EXISTS material_deltas (
                delta_id TEXT PRIMARY KEY,
                observed_at REAL NOT NULL,
                material INTEGER NOT NULL CHECK (material IN (0,1)),
                payload_json TEXT NOT NULL,
                state TEXT NOT NULL CHECK (state IN ('QUEUED','PROCESSED','TRACEABLE')),
                processed_job_key TEXT
            );
            CREATE TABLE IF NOT EXISTS scheduler_incidents (
                incident_id INTEGER PRIMARY KEY AUTOINCREMENT,
                occurred_at REAL NOT NULL,
                code TEXT NOT NULL,
                job_key TEXT,
                detail_json TEXT NOT NULL,
                FOREIGN KEY (job_key) REFERENCES scheduler_jobs(job_key)
            );
            CREATE TABLE IF NOT EXISTS scheduler_leases (
                job_key TEXT PRIMARY KEY,
                lease_id TEXT NOT NULL,
                acquired_at REAL NOT NULL,
                expires_at REAL NOT NULL,
                released_at REAL,
                FOREIGN KEY (job_key) REFERENCES scheduler_jobs(job_key)
            );
            CREATE TABLE IF NOT EXISTS scheduler_manager_leases (
                lease_key TEXT PRIMARY KEY,
                job_key TEXT NOT NULL,
                lease_id TEXT NOT NULL,
                acquired_at REAL NOT NULL,
                expires_at REAL NOT NULL,
                released_at REAL,
                FOREIGN KEY (job_key) REFERENCES scheduler_jobs(job_key)
            );
            CREATE TABLE IF NOT EXISTS scheduler_acceptances (
                acceptance_key TEXT PRIMARY KEY,
                job_key TEXT NOT NULL,
                result_json TEXT NOT NULL,
                result_hash TEXT NOT NULL,
                FOREIGN KEY (job_key) REFERENCES scheduler_jobs(job_key)
            );
            CREATE TABLE IF NOT EXISTS scheduler_uncertain_deltas (
                delta_id TEXT PRIMARY KEY,
                job_key TEXT NOT NULL,
                marked_at REAL NOT NULL,
                resolved_at REAL,
                resolution_operation_id TEXT,
                FOREIGN KEY (delta_id) REFERENCES material_deltas(delta_id),
                FOREIGN KEY (job_key) REFERENCES scheduler_jobs(job_key)
            );
            """
        )
        try:
            self._connection.execute("SELECT resolved_at FROM scheduler_uncertain_deltas LIMIT 1")
        except sqlite3.OperationalError:
            self._connection.execute("ALTER TABLE scheduler_uncertain_deltas ADD COLUMN resolved_at REAL")
        for table, column, declaration in (
            ("scheduler_jobs", "input_delta_ids_json", "TEXT"),
            ("scheduler_acceptances", "result_hash", "TEXT"),
            ("scheduler_uncertain_deltas", "resolution_operation_id", "TEXT"),
        ):
            try:
                self._connection.execute(f"SELECT {column} FROM {table} LIMIT 1")
            except sqlite3.OperationalError:
                self._connection.execute(f"ALTER TABLE {table} ADD COLUMN {column} {declaration}")
        metadata = {
            "schemaVersion": "1",
            "profile": SOAK_PROFILE,
            "fixtureOnly": "1",
            "productionState": "0",
            "encryption": "none",
            "portfolioId": portfolio_id,
            "jobType": job_type,
        }
        for key, value in metadata.items():
            self._connection.execute("INSERT OR IGNORE INTO scheduler_meta(key,value) VALUES(?,?)", (key, value))
        current = {row["key"]: row["value"] for row in self._connection.execute("SELECT key,value FROM scheduler_meta")}
        if any(current.get(key) != value for key, value in metadata.items()):
            raise SchedulerError("SCHEDULER_METADATA_INVALID")
        self._crash_failures: list[float] = []
        try:
            raw_failures = json.loads(current.get("failureTimes", "[]"))
            if not isinstance(raw_failures, list) or len(raw_failures) > 128 or any(type(value) not in {int, float} for value in raw_failures):
                raise ValueError("failure history shape is invalid")
            self._crash_failures = [float(value) for value in raw_failures]
        except (TypeError, ValueError, json.JSONDecodeError):
            raise SchedulerError("SCHEDULER_FAILURE_HISTORY_INVALID")
        current_time = self._now()
        if any(not math.isfinite(value) or value > current_time or value < current_time - CIRCUIT_WINDOW_SECONDS for value in self._crash_failures) or self._crash_failures != sorted(self._crash_failures):
            raise SchedulerError("SCHEDULER_FAILURE_HISTORY_INVALID")
        self._live_since: float | None = None
        self._latencies: list[float] = []
        self._violations = {"overlap": 0, "missed": 0, "lost": 0, "unaudited": 0, "duplicate": 0}
        self._startup_halted = False
        self._startup_reconciling = self._has_unreconciled_state()

    @classmethod
    def for_test(
        cls,
        *args: Any,
        manager_callback: Callable[[tuple[str, ...], str], dict[str, Any]],
        **kwargs: Any,
    ) -> "MaterialityScheduler":
        """Construct a scheduler with an injected callback for fault tests only.

        Normal construction always routes through the fixture Python authority;
        this explicit factory keeps deterministic failure injection out of the
        acceptance path and makes the boundary auditable in call sites.
        """

        return cls(*args, manager_callback=manager_callback, _allow_test_callback=True, **kwargs)

    def close(self) -> None:
        self._connection.close()

    def __enter__(self) -> "MaterialityScheduler":
        return self

    def __exit__(self, _type: Any, _value: Any, _traceback: Any) -> None:
        self.close()

    @property
    def manager_busy(self) -> bool:
        return self._manager_busy

    def ingest_delta(self, delta_id: str, *, material: bool, payload: dict[str, Any] | None = None, observed_at: float | None = None) -> str:
        """Persist one delta; duplicate IDs are a no-op, never a duplicate turn."""

        if not isinstance(delta_id, str) or not delta_id or len(delta_id) > 128 or any(ord(char) < 0x21 or ord(char) > 0x7E for char in delta_id):
            raise ValueError("delta_id is not safe")
        if not isinstance(material, bool):
            raise TypeError("material must be boolean")
        if payload is None:
            payload = {"fixture": "public-event-001"}
        if not isinstance(payload, dict) or set(payload) - _ALLOWED_DELTA_PAYLOAD_KEYS or payload.get("fixture") != "public-event-001":
            raise SchedulerError("NON_PUBLIC_DELTA")
        if "ordinal" in payload and (type(payload["ordinal"]) is not int or not 0 <= payload["ordinal"] <= 1_000_000_000):
            raise SchedulerError("NON_PUBLIC_DELTA")
        if "material" in payload and (type(payload["material"]) is not bool or payload["material"] != material):
            raise SchedulerError("NON_PUBLIC_DELTA")
        if isinstance(observed_at, bool):
            raise SchedulerError("DELTA_TIMESTAMP_INVALID")
        try:
            now = self._now() if observed_at is None else float(observed_at)
        except (TypeError, ValueError, OverflowError) as error:
            raise SchedulerError("DELTA_TIMESTAMP_INVALID") from error
        if not math.isfinite(now):
            raise SchedulerError("DELTA_TIMESTAMP_INVALID")
        state = "QUEUED" if material else "TRACEABLE"
        try:
            payload_json = _canonical_json(payload)
        except (TypeError, ValueError, OverflowError) as error:
            raise SchedulerError("NON_PUBLIC_DELTA") from error
        if len(payload_json.encode("utf-8")) > 2048:
            raise SchedulerError("NON_PUBLIC_DELTA")
        existing = self._connection.execute("SELECT observed_at,material,payload_json,state FROM material_deltas WHERE delta_id=?", (delta_id,)).fetchone()
        if existing is not None:
            if existing["observed_at"] != now or bool(existing["material"]) != material or existing["payload_json"] != payload_json:
                raise SchedulerError("DELTA_IDEMPOTENCY_CONFLICT")
            return existing["state"]
        try:
            self._transaction(
                "INSERT INTO material_deltas(delta_id,observed_at,material,payload_json,state) VALUES(?,?,?,?,?)",
                (delta_id, now, int(material), payload_json, state),
            )
        except sqlite3.IntegrityError:
            raced = self._connection.execute("SELECT observed_at,material,payload_json,state FROM material_deltas WHERE delta_id=?", (delta_id,)).fetchone()
            if raced is None or raced["observed_at"] != now or bool(raced["material"]) != material or raced["payload_json"] != payload_json:
                raise SchedulerError("DELTA_IDEMPOTENCY_CONFLICT")
            return raced["state"]
        return state

    def tick(self) -> list[dict[str, Any]]:
        """Enqueue every elapsed cadence and attempt only one non-overlapping job."""

        if not self._validate_runtime_metadata() or not self._validate_delta_rows():
            self._startup_halted = True
            return [{"status": "ABSTAINED", "reasonCode": "SCHEDULER_RECOVERY_BLOCKED"}]
        if self._startup_halted:
            return [{"status": "ABSTAINED", "reasonCode": "SCHEDULER_RECOVERY_BLOCKED"}]
        if self._startup_reconciling:
            return [{"status": "ABSTAINED", "reasonCode": "SCHEDULER_RECONCILIATION_PENDING"}]
        if self._connection.execute("SELECT COUNT(*) FROM scheduler_uncertain_deltas WHERE resolved_at IS NULL").fetchone()[0]:
            return [{"status": "ABSTAINED", "reasonCode": "SCHEDULER_OPERATION_UNCERTAIN"}]
        now = self._now()
        next_due = self._meta_float("nextDue")
        if next_due is None:
            next_due = now
        jobs: list[dict[str, Any]] = []
        while now >= next_due:
            job_key = self._job_key(next_due)
            self._transaction(
                "INSERT OR IGNORE INTO scheduler_jobs(job_key,scheduled_at,state) VALUES(?,?, 'QUEUED')",
                (job_key, next_due),
            )
            next_due += self.cadence_seconds
        # Advance the cadence cursor before external manager work.  If the
        # process dies during the callback, restart recovery must not recreate
        # the already-enqueued boundary and accidentally run two turns.
        self._set_meta("nextDue", str(next_due))
        # Capture a historical high-water mark before attempting work.  A
        # transiently overdue row may be completed later in this tick, so a
        # final snapshot of currently queued rows alone would erase evidence
        # that a cadence was missed while the manager was busy.
        overdue = self._connection.execute(
            "SELECT COUNT(*) FROM scheduler_jobs WHERE state='QUEUED' AND scheduled_at + ? <= ?",
            (self.cadence_seconds, now),
        ).fetchone()[0]
        self._violations["missed"] = max(self._violations["missed"], overdue)
        # Attempt only the oldest due boundary.  A retry and a newly-created
        # cadence row must never execute in the same tick; newer work remains
        # queued for the next three-minute boundary.
        queued = self._connection.execute("SELECT job_key FROM scheduler_jobs WHERE state='QUEUED' AND scheduled_at <= ? ORDER BY scheduled_at", (now,)).fetchall()
        if queued:
            jobs.append(self._attempt_job(queued[0]["job_key"]))
        # Empty cadence rows are bookkeeping only.  Once the manager has
        # finished and no material work remains, close any additional due
        # rows without a manager turn so readiness does not report phantom
        # queued work.  Material work always stops this drain and waits for
        # the next cadence.
        while not self._manager_busy and not self._connection.execute("SELECT 1 FROM material_deltas WHERE state='QUEUED' LIMIT 1").fetchone() and not self._connection.execute("SELECT 1 FROM scheduler_uncertain_deltas WHERE resolved_at IS NOT NULL LIMIT 1").fetchone():
            empty_row = self._connection.execute("SELECT job_key FROM scheduler_jobs WHERE state='QUEUED' AND scheduled_at <= ? ORDER BY scheduled_at LIMIT 1", (now,)).fetchone()
            if empty_row is None:
                break
            empty_result = self._attempt_job(empty_row["job_key"])
            jobs.append(empty_result)
            # A concurrent scheduler may own the durable manager/job lease.
            # Do not spin on the same still-queued empty row; the next tick
            # will retry after the owner releases or recovery reconciles it.
            if empty_result.get("status") == "QUEUED":
                break
        return jobs

    def recover(self) -> dict[str, Any]:
        """Reconcile an abandoned RUNNING job; never reclaim it as accepted."""

        if self._startup_halted:
            return {"recoveredJobs": [], "ready": False, "reasonCode": "SCHEDULER_RECOVERY_BLOCKED"}
        rows = self._connection.execute("SELECT job_key,input_delta_ids_json FROM scheduler_jobs WHERE state = 'RUNNING' ORDER BY scheduled_at").fetchall()
        recovered: list[str] = []
        for row in rows:
            job_key = row["job_key"]
            now = self._now()
            try:
                captured = json.loads(row["input_delta_ids_json"] or "")
                if not isinstance(captured, list) or not captured or any(not isinstance(delta_id, str) or not delta_id or len(delta_id) > 128 or any(ord(char) < 0x21 or ord(char) > 0x7E for char in delta_id) for delta_id in captured) or len(captured) != len(set(captured)):
                    raise ValueError("running job input set is invalid")
            except (TypeError, ValueError, json.JSONDecodeError):
                self._startup_halted = True
                return {"recoveredJobs": recovered, "ready": False, "reasonCode": "SCHEDULER_RECOVERY_BLOCKED"}
            queued_deltas = [item["delta_id"] for item in self._connection.execute(
                f"SELECT delta_id FROM material_deltas WHERE state='QUEUED' AND delta_id IN ({','.join('?' for _ in captured)}) ORDER BY observed_at, delta_id",
                captured,
            )]
            if set(queued_deltas) != set(captured):
                self._startup_halted = True
                return {"recoveredJobs": recovered, "ready": False, "reasonCode": "SCHEDULER_RECOVERY_BLOCKED"}
            uncertain_statements = [
                ("INSERT OR IGNORE INTO scheduler_uncertain_deltas(delta_id,job_key,marked_at) VALUES(?,?,?)", (delta_id, job_key, now))
                for delta_id in queued_deltas
            ]
            # Recovery is one durable boundary: a restarted process may not
            # leave an abstained job, an open lease, and its incident split
            # across commits.
            self._transaction_batch([
                ("UPDATE scheduler_jobs SET state='ABSTAINED', error_code='SCHEDULER_RECOVERY_ABSTAINED', completed_at=? WHERE job_key=?", (now, job_key)),
                ("UPDATE scheduler_leases SET released_at=? WHERE job_key=? AND released_at IS NULL", (now, job_key)),
                ("UPDATE scheduler_manager_leases SET released_at=? WHERE job_key=? AND released_at IS NULL", (now, job_key)),
                ("INSERT INTO scheduler_incidents(occurred_at,code,job_key,detail_json) VALUES(?,?,?,?)", (now, "SCHEDULER_RECOVERY_ABSTAINED", job_key, _canonical_json({"exposure": False, "deltaIds": list(captured)}))),
                *uncertain_statements,
            ])
            recovered.append(job_key)
        uncertain_leases = self._connection.execute(
            "SELECT j.job_key FROM scheduler_jobs j JOIN scheduler_leases l ON l.job_key=j.job_key WHERE j.state='QUEUED' AND l.released_at IS NULL"
        ).fetchall()
        for row in uncertain_leases:
            job_key = row["job_key"]
            self._abstain_job(job_key, "SCHEDULER_LEASE_UNCERTAIN")
            recovered.append(job_key)
        self._manager_busy = False
        self._startup_reconciling = False
        return {"recoveredJobs": recovered, "ready": self.readiness()["ready"]}

    def reconcile_uncertain(self, *, delta_ids: Iterable[str] | None = None, operation_id: str | None = None, confirm_idempotent: bool = False) -> dict[str, Any]:
        """Explicitly authorize retry of a callback fenced by process loss.

        Recovery never guesses whether an external manager committed before
        the scheduler crashed.  A caller that has independently verified the
        manager's idempotency key may mark the retained fixture deltas
        retryable; the same deterministic operation ID is then required.
        """

        if type(confirm_idempotent) is not bool or not confirm_idempotent or delta_ids is None or not isinstance(operation_id, str):
            raise SchedulerError("SCHEDULER_RECONCILIATION_CONFIRMATION_REQUIRED")
        if isinstance(delta_ids, (str, bytes)):
            raise SchedulerError("SCHEDULER_RECONCILIATION_CONFIRMATION_REQUIRED")
        try:
            raw_ids = tuple(delta_ids)
            if any(not isinstance(delta_id, str) or not delta_id or len(delta_id) > 128 or any(ord(char) < 0x21 or ord(char) > 0x7E for char in delta_id) for delta_id in raw_ids):
                raise ValueError("delta identity is invalid")
            ids = tuple(sorted(set(raw_ids)))
        except (TypeError, ValueError):
            raise SchedulerError("SCHEDULER_RECONCILIATION_CONFIRMATION_REQUIRED")
        if not ids or any(not isinstance(delta_id, str) or not delta_id for delta_id in ids) or not _OPERATION_ID_RE.fullmatch(operation_id):
            raise SchedulerError("SCHEDULER_RECONCILIATION_CONFIRMATION_REQUIRED")
        rows = self._connection.execute(
            f"SELECT delta_id,job_key FROM scheduler_uncertain_deltas WHERE resolved_at IS NULL AND delta_id IN ({','.join('?' for _ in ids)})",
            ids,
        ).fetchall()
        if {row["delta_id"] for row in rows} != set(ids) or len({row["job_key"] for row in rows}) != 1:
            raise SchedulerError("SCHEDULER_RECONCILIATION_CONFIRMATION_REQUIRED")
        job_key = rows[0]["job_key"]
        job = self._connection.execute("SELECT input_delta_ids_json FROM scheduler_jobs WHERE job_key=? AND state='ABSTAINED'", (job_key,)).fetchone()
        try:
            captured = tuple(json.loads(job["input_delta_ids_json"] or "")) if job else ()
        except (TypeError, ValueError, json.JSONDecodeError):
            captured = ()
        if set(captured) != set(ids) or operation_id != self._operation_id(captured):
            raise SchedulerError("SCHEDULER_RECONCILIATION_CONFIRMATION_REQUIRED")
        now = self._now()
        self._connection.execute("BEGIN IMMEDIATE")
        try:
            changed = self._connection.execute(
                f"UPDATE scheduler_uncertain_deltas SET resolved_at=?, resolution_operation_id=? WHERE resolved_at IS NULL AND delta_id IN ({','.join('?' for _ in ids)})",
                (now, operation_id, *ids),
            ).rowcount
            if changed != len(ids):
                raise SchedulerFailure("SCHEDULER_RECONCILIATION_STATE_MISMATCH")
            requeued = self._connection.execute(
                "UPDATE scheduler_jobs SET state='QUEUED', completed_at=NULL, error_code=NULL, lease_id=NULL WHERE job_key=? AND state='ABSTAINED'",
                (job_key,),
            ).rowcount
            if requeued != 1:
                raise SchedulerFailure("SCHEDULER_RECONCILIATION_STATE_MISMATCH")
            self._connection.execute("INSERT INTO scheduler_incidents(occurred_at,code,job_key,detail_json) VALUES(?,?,?,?)", (now, "SCHEDULER_RECONCILIATION_CONFIRMED", job_key, _canonical_json({"exposure": False, "operationId": operation_id, "deltaIds": list(ids)})))
            self._connection.execute("COMMIT")
        except Exception:
            self._connection.execute("ROLLBACK")
            raise
        return {"resolvedDeltas": changed, "ready": self.readiness()["ready"]}

    def set_manager_busy(self, busy: bool) -> None:
        if not isinstance(busy, bool):
            raise TypeError("busy must be boolean")
        if busy and self._manager_busy:
            self._violations["overlap"] += 1
        self._manager_busy = busy

    def metrics(self) -> SchedulerMetrics:
        self._validate_runtime_metadata()
        if not self._validate_delta_rows():
            self._startup_halted = True
        counts = {row["state"]: row["count"] for row in self._connection.execute("SELECT state, COUNT(*) AS count FROM scheduler_jobs GROUP BY state")}
        delta_counts = {row["key"]: row["count"] for row in self._connection.execute("SELECT CASE WHEN material=1 AND state='PROCESSED' THEN 'processed' WHEN material=1 THEN 'material' ELSE 'nonmaterial' END AS key, COUNT(*) AS count FROM material_deltas GROUP BY key")}
        missed = self._connection.execute("SELECT COUNT(*) FROM scheduler_jobs WHERE state='QUEUED' AND scheduled_at + ? <= ?", (self.cadence_seconds, self._now())).fetchone()[0]
        lost = self._connection.execute("SELECT COUNT(*) FROM material_deltas d LEFT JOIN scheduler_jobs j ON j.job_key=d.processed_job_key WHERE d.state='PROCESSED' AND (j.job_key IS NULL OR j.state != 'COMPLETED')").fetchone()[0]
        unaudited = self._connection.execute("SELECT COUNT(*) FROM scheduler_jobs j WHERE j.state='ABSTAINED' AND NOT EXISTS (SELECT 1 FROM scheduler_incidents i WHERE i.job_key=j.job_key)").fetchone()[0]
        try:
            acceptance_rows = [item["result"] for item in self.acceptance_rows()]
        except SchedulerError:
            self._startup_halted = True
            acceptance_rows = []
        operation_ids = [item.get("operationId") for item in acceptance_rows if item.get("operationId") is not None]
        duplicate = len(operation_ids) - len(set(operation_ids))
        return SchedulerMetrics(
            scheduled_jobs=sum(counts.values()),
            completed_jobs=counts.get("COMPLETED", 0),
            abstained_jobs=counts.get("ABSTAINED", 0),
            manager_turns=self._connection.execute("SELECT COUNT(*) FROM scheduler_acceptances").fetchone()[0],
            material_deltas=delta_counts.get("material", 0) + delta_counts.get("processed", 0),
            nonmaterial_deltas=delta_counts.get("nonmaterial", 0),
            processed_material_deltas=delta_counts.get("processed", 0),
            traceable_nonmaterial_deltas=delta_counts.get("nonmaterial", 0),
            incidents=self._connection.execute("SELECT COUNT(*) FROM scheduler_incidents").fetchone()[0],
            overlap_violations=self._violations["overlap"],
            missed_job_violations=max(self._violations["missed"], missed),
            lost_delta_violations=max(self._violations["lost"], lost),
            unaudited_incident_violations=max(self._violations["unaudited"], unaudited),
            duplicate_acceptance_violations=max(self._violations["duplicate"], duplicate),
            latency_ms=tuple(self._latencies),
        )

    def readiness(self) -> dict[str, Any]:
        self._validate_runtime_metadata()
        if not self._validate_delta_rows():
            self._startup_halted = True
        running = [row["job_key"] for row in self._connection.execute("SELECT job_key FROM scheduler_jobs WHERE state='RUNNING'")]
        queued_material = self._connection.execute("SELECT COUNT(*) FROM material_deltas WHERE state='QUEUED'").fetchone()[0]
        queued_jobs = self._connection.execute("SELECT COUNT(*) FROM scheduler_jobs WHERE state='QUEUED'").fetchone()[0]
        if self._startup_halted:
            return {"ready": False, "reasonCode": "SCHEDULER_RECOVERY_BLOCKED", "runningJobs": running, "queuedMaterial": queued_material}
        if self._startup_reconciling:
            return {"ready": False, "reasonCode": "SCHEDULER_RECONCILIATION_PENDING", "runningJobs": running, "queuedMaterial": queued_material}
        if self._manager_busy:
            return {"ready": False, "reasonCode": "SCHEDULER_MANAGER_BUSY", "runningJobs": running, "queuedMaterial": queued_material}
        circuit_open = self._circuit_open()
        if self._startup_halted:
            return {"ready": False, "reasonCode": "SCHEDULER_RECOVERY_BLOCKED", "runningJobs": running, "queuedMaterial": queued_material}
        if running:
            return {"ready": False, "reasonCode": "SCHEDULER_RECONCILIATION_PENDING", "runningJobs": running, "queuedMaterial": queued_material}
        uncertain_lease = self._connection.execute("SELECT COUNT(*) FROM scheduler_jobs j JOIN scheduler_leases l ON l.job_key=j.job_key WHERE j.state='QUEUED' AND l.released_at IS NULL").fetchone()[0]
        if uncertain_lease:
            return {"ready": False, "reasonCode": "SCHEDULER_LEASE_UNCERTAIN", "runningJobs": [], "queuedMaterial": queued_material}
        uncertain_delta = self._connection.execute("SELECT COUNT(*) FROM scheduler_uncertain_deltas WHERE resolved_at IS NULL").fetchone()[0]
        if uncertain_delta:
            return {"ready": False, "reasonCode": "SCHEDULER_OPERATION_UNCERTAIN", "runningJobs": [], "queuedMaterial": queued_material}
        manager_lease = self._connection.execute("SELECT job_key FROM scheduler_manager_leases WHERE released_at IS NULL AND lease_key=?", (self._manager_lease_key(),)).fetchone()
        if manager_lease is not None:
            return {"ready": False, "reasonCode": "SCHEDULER_MANAGER_BUSY", "runningJobs": [], "queuedMaterial": queued_material}
        if circuit_open:
            return {"ready": False, "reasonCode": "SCHEDULER_CIRCUIT_OPEN", "runningJobs": [], "queuedMaterial": queued_material}
        if queued_material or queued_jobs:
            return {"ready": False, "reasonCode": "SCHEDULER_WORK_QUEUED", "runningJobs": [], "queuedMaterial": queued_material}
        return {"ready": True, "reasonCode": "SCHEDULER_READY", "runningJobs": [], "queuedMaterial": queued_material}

    def job_rows(self) -> list[dict[str, Any]]:
        return [dict(row) for row in self._connection.execute("SELECT * FROM scheduler_jobs ORDER BY scheduled_at")]

    def acceptance_rows(self) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        for row in self._connection.execute("SELECT acceptance_key,job_key,result_json,result_hash FROM scheduler_acceptances ORDER BY acceptance_key"):
            result_json = row["result_json"]
            try:
                if not isinstance(result_json, str):
                    raise TypeError("acceptance result JSON must be text")
                result = json.loads(result_json)
            except (TypeError, ValueError, json.JSONDecodeError) as error:
                self._startup_halted = True
                raise SchedulerError("SCHEDULER_ACCEPTANCE_INVALID") from error
            if not isinstance(row["result_hash"], str) or row["result_hash"] != hashlib.sha256(result_json.encode("utf-8")).hexdigest():
                self._startup_halted = True
                raise SchedulerError("SCHEDULER_ACCEPTANCE_INVALID")
            if not isinstance(result, dict):
                self._startup_halted = True
                raise SchedulerError("SCHEDULER_ACCEPTANCE_INVALID")
            job = self._connection.execute("SELECT state FROM scheduler_jobs WHERE job_key=?", (row["job_key"],)).fetchone()
            deltas = tuple(item["delta_id"] for item in self._connection.execute("SELECT delta_id FROM material_deltas WHERE processed_job_key=? ORDER BY observed_at, delta_id", (row["job_key"],)))
            try:
                if job is None or job["state"] != "COMPLETED" or not deltas:
                    raise SchedulerFailure("SCHEDULER_ACCEPTANCE_INVALID")
                self._validate_completed_result(result, self._operation_id(deltas))
                if not self._test_callback and result != _fixture_manager_callback(deltas, row["job_key"]):
                    raise SchedulerFailure("AUTHORITY_RESPONSE_MISMATCH")
            except (SchedulerError, TypeError, ValueError):
                self._startup_halted = True
                raise SchedulerError("SCHEDULER_ACCEPTANCE_INVALID")
            rows.append({"acceptanceKey": row["acceptance_key"], "jobKey": row["job_key"], "result": result})
        return rows

    def incident_rows(self) -> list[dict[str, Any]]:
        return [dict(row) for row in self._connection.execute("SELECT * FROM scheduler_incidents ORDER BY incident_id")]

    def delta_rows(self) -> list[dict[str, Any]]:
        return [dict(row) for row in self._connection.execute("SELECT * FROM material_deltas ORDER BY observed_at, delta_id")]

    def _attempt_job(self, job_key: str) -> dict[str, Any]:
        row = self._connection.execute("SELECT * FROM scheduler_jobs WHERE job_key=?", (job_key,)).fetchone()
        if row is None or row["state"] != "QUEUED":
            return {"jobKey": job_key, "status": row["state"] if row else "MISSING"}
        if self._manager_busy:
            return {"jobKey": job_key, "status": "QUEUED", "reasonCode": "MANAGER_BUSY_COALESCED"}
        if self._circuit_open():
            self._abstain_job(job_key, "SCHEDULER_CIRCUIT_OPEN", expected_state="QUEUED")
            return {"jobKey": job_key, "status": "ABSTAINED", "reasonCode": "SCHEDULER_CIRCUIT_OPEN"}
        if not self._acquire_lease(job_key):
            return {"jobKey": job_key, "status": "QUEUED", "reasonCode": "LEASE_HELD"}
        lease_row = self._connection.execute("SELECT lease_id FROM scheduler_leases WHERE job_key=? AND released_at IS NULL", (job_key,)).fetchone()
        if lease_row is None:
            return {"jobKey": job_key, "status": "QUEUED", "reasonCode": "LEASE_HELD"}
        lease_id = lease_row["lease_id"]
        queued_deltas = tuple(row["delta_id"] for row in self._connection.execute("SELECT delta_id FROM material_deltas WHERE state='QUEUED' ORDER BY observed_at, delta_id"))
        resolved_deltas = tuple(
            row["delta_id"] for row in self._connection.execute(
                "SELECT delta_id FROM scheduler_uncertain_deltas WHERE job_key=? AND resolved_at IS NOT NULL ORDER BY delta_id",
                (job_key,),
            )
        )
        # An uncertain callback is retried as the exact bounded operation that
        # was captured before the crash.  Newer queued deltas stay for a later
        # cadence instead of changing the old idempotency key.
        deltas = resolved_deltas or queued_deltas
        if not deltas:
            if not self._complete_no_material(job_key, lease_id):
                self._release_lease(job_key, lease_id)
                return {"jobKey": job_key, "status": "QUEUED", "reasonCode": "STALE_MANAGER_OWNER"}
            return {"jobKey": job_key, "status": "COMPLETED", "reasonCode": "NO_MATERIAL_DELTA", "deltaCount": 0}
        uncertain = self._connection.execute(
            f"SELECT COUNT(*) FROM scheduler_uncertain_deltas WHERE resolved_at IS NULL AND delta_id IN ({','.join('?' for _ in deltas)})",
            deltas,
        ).fetchone()[0]
        if uncertain:
            self._abstain_job(job_key, "SCHEDULER_OPERATION_UNCERTAIN", lease_id, expected_state="QUEUED")
            return {"jobKey": job_key, "status": "ABSTAINED", "reasonCode": "SCHEDULER_OPERATION_UNCERTAIN", "deltaCount": len(deltas)}
        started = self._now()
        self._manager_busy = True
        running_marked = False
        committed_result: dict[str, Any] | None = None
        try:
            if self._transaction("UPDATE scheduler_jobs SET state='RUNNING', attempts=attempts+1, started_at=?, input_delta_ids_json=? WHERE job_key=? AND state='QUEUED' AND lease_id=?", (started, _canonical_json(list(deltas)), job_key, lease_id)) != 1:
                raise SchedulerFailure("STALE_MANAGER_OWNER")
            running_marked = True
            result = self._manager_callback(deltas, job_key)
            if not isinstance(result, dict) or result.get("status") not in {"ACCEPTED", "REJECTED", "ABSTAINED"}:
                raise SchedulerFailure("MANAGER_RESULT_INVALID")
            if result.get("status") == "ABSTAINED":
                self._validate_abstained_result(result, self._operation_id(deltas))
                code = result.get("reasonCode") if isinstance(result.get("reasonCode"), str) else "MANAGER_ABSTAINED"
                if not self._abstain_job(
                    job_key,
                    code,
                    lease_id,
                    expected_state="RUNNING",
                    mark_uncertain=code in _UNCERTAIN_OPERATION_CODES,
                ):
                    return {"jobKey": job_key, "status": "ABSTAINED", "reasonCode": "STALE_MANAGER_OWNER", "deltaCount": len(deltas)}
                return {"jobKey": job_key, "status": "ABSTAINED", "reasonCode": code, "deltaCount": len(deltas)}
            self._validate_completed_result(result, self._operation_id(deltas))
            if not self._test_callback and result != _fixture_manager_callback(deltas, job_key):
                raise SchedulerFailure("AUTHORITY_RESPONSE_MISMATCH")
            elapsed = max(0.0, (self._now() - started) * 1000.0)
            self._latencies.append(elapsed)
            operation_id = result.get("operationId")
            # A successful scheduler operation is also an idempotent
            # authority operation.  Reusing an operation ID on a later job is
            # never a harmless duplicate: reject it before durable commit.
            acceptance_key = f"{job_key}:{operation_id}"
            existing_acceptance = self._connection.execute("SELECT 1 FROM scheduler_acceptances WHERE acceptance_key=?", (acceptance_key,)).fetchone()
            if existing_acceptance is not None:
                self._violations["duplicate"] += 1
                raise SchedulerFailure("DUPLICATE_ACCEPTANCE")
            for stored in self._connection.execute("SELECT result_json FROM scheduler_acceptances"):
                try:
                    stored_result = json.loads(stored["result_json"])
                    if not isinstance(stored_result, dict):
                        raise SchedulerFailure("SCHEDULER_ACCEPTANCE_INVALID")
                    if stored_result.get("operationId") == operation_id:
                        self._violations["duplicate"] += 1
                        raise SchedulerFailure("DUPLICATE_ACCEPTANCE")
                except (TypeError, ValueError, json.JSONDecodeError) as error:
                    raise SchedulerFailure("SCHEDULER_ACCEPTANCE_INVALID") from error
            if not self._complete_job(job_key, lease_id, acceptance_key, result, deltas):
                raise SchedulerFailure("STALE_MANAGER_OWNER")
            committed_result = {"jobKey": job_key, "status": "COMPLETED", "result": result, "deltaCount": len(deltas)}
        except SchedulerError as error:
            if running_marked and not self._abstain_job(
                job_key,
                error.code,
                lease_id,
                expected_state="RUNNING",
                mark_uncertain=error.code in _UNCERTAIN_OPERATION_CODES,
            ):
                return {"jobKey": job_key, "status": "ABSTAINED", "reasonCode": "STALE_MANAGER_OWNER", "deltaCount": len(deltas)}
            if not running_marked:
                self._release_lease(job_key, lease_id)
            return {"jobKey": job_key, "status": "ABSTAINED", "reasonCode": error.code, "deltaCount": len(deltas)}
        except Exception as error:  # noqa: BLE001 - external manager failures are typed
            if running_marked and not self._abstain_job(job_key, "MANAGER_PROCESS_FAILED", lease_id, expected_state="RUNNING"):
                return {"jobKey": job_key, "status": "ABSTAINED", "reasonCode": "STALE_MANAGER_OWNER", "deltaCount": len(deltas)}
            if not running_marked:
                self._release_lease(job_key, lease_id)
            return {"jobKey": job_key, "status": "ABSTAINED", "reasonCode": "MANAGER_PROCESS_FAILED", "deltaCount": len(deltas)}
        finally:
            self._manager_busy = False
        if committed_result is not None:
            try:
                self._record_live_success()
            except Exception:  # noqa: BLE001 - durable result wins over telemetry persistence
                self._startup_halted = True
                committed_result["telemetryStatus"] = "SCHEDULER_METRICS_PERSIST_FAILED"
            return committed_result
        raise SchedulerFailure("SCHEDULER_INTERNAL_STATE")

    def _validate_completed_result(self, result: dict[str, Any], expected_operation_id: str) -> None:
        if set(result) != _RESULT_KEYS:
            raise SchedulerFailure("MANAGER_RESULT_INVALID")
        operation_id = result.get("operationId")
        response_hash = result.get("responseHash")
        audit_count = result.get("auditEventCount")
        reason_code = result.get("reasonCode")
        audit_head_hash = result.get("auditHeadHash")
        gate_decision_id = result.get("gateDecisionId")
        order_plan_id = result.get("orderPlanId")
        execution_id = result.get("executionId")
        status = result.get("status")
        valid_audit_count = (status == "ACCEPTED" and audit_count == 7) or (status == "REJECTED" and audit_count in {4, 5})
        valid_artifacts = isinstance(gate_decision_id, str) and _GATE_ID_RE.fullmatch(gate_decision_id) and (
            (status == "ACCEPTED" and isinstance(order_plan_id, str) and _PLAN_ID_RE.fullmatch(order_plan_id) and isinstance(execution_id, str) and _EXECUTION_ID_RE.fullmatch(execution_id))
            or (status == "REJECTED" and order_plan_id is None and execution_id is None)
        )
        valid_reason = isinstance(reason_code, str) and (status == "ACCEPTED" and reason_code == "ACCEPTED" or status == "REJECTED" and reason_code in _REJECT_REASON_CODES)
        if not isinstance(reason_code, str) or not valid_reason or not isinstance(operation_id, str) or operation_id != expected_operation_id or not _OPERATION_ID_RE.fullmatch(operation_id) or not isinstance(response_hash, str) or not _RESPONSE_HASH_RE.fullmatch(response_hash) or not isinstance(audit_head_hash, str) or not _RESPONSE_HASH_RE.fullmatch(audit_head_hash) or type(audit_count) is not int or not valid_audit_count or not valid_artifacts:
            raise SchedulerFailure("MANAGER_RESULT_INVALID")

    def _validate_abstained_result(self, result: dict[str, Any], expected_operation_id: str) -> None:
        if set(result) - {"status", "reasonCode", "operationId"} or set(result) < {"status", "reasonCode"}:
            raise SchedulerFailure("MANAGER_RESULT_INVALID")
        reason_code = result.get("reasonCode")
        operation_id = result.get("operationId")
        if not isinstance(reason_code, str) or reason_code not in _ABSTAIN_CODES or (operation_id is not None and (not isinstance(operation_id, str) or operation_id != expected_operation_id)):
            raise SchedulerFailure("MANAGER_RESULT_INVALID")

    def _operation_id(self, deltas: tuple[str, ...]) -> str:
        return operation_id_for_deltas(deltas)

    def _complete_no_material(self, job_key: str, lease_id: str) -> bool:
        now = self._now()
        self._connection.execute("BEGIN IMMEDIATE")
        try:
            owner = self._connection.execute("SELECT 1 FROM scheduler_manager_leases WHERE lease_key=? AND job_key=? AND lease_id=? AND released_at IS NULL", (self._manager_lease_key(), job_key, lease_id)).fetchone()
            if owner is None:
                self._connection.execute("ROLLBACK")
                return False
            updated = self._connection.execute(
                "UPDATE scheduler_jobs SET state='COMPLETED', completed_at=?, error_code='NO_MATERIAL_DELTA' WHERE job_key=? AND state='QUEUED' AND lease_id=?",
                (now, job_key, lease_id),
            ).rowcount
            if updated != 1:
                self._connection.execute("ROLLBACK")
                return False
            released_job_lease = self._connection.execute("UPDATE scheduler_leases SET released_at=? WHERE job_key=? AND lease_id=? AND released_at IS NULL", (now, job_key, lease_id)).rowcount
            released_manager_lease = self._connection.execute("UPDATE scheduler_manager_leases SET released_at=? WHERE job_key=? AND lease_id=? AND released_at IS NULL", (now, job_key, lease_id)).rowcount
            if released_job_lease != 1 or released_manager_lease != 1:
                raise SchedulerFailure("SCHEDULER_LEASE_STATE_MISMATCH")
            self._connection.execute("COMMIT")
            return True
        except Exception:
            self._connection.execute("ROLLBACK")
            raise

    def _complete_job(self, job_key: str, lease_id: str, acceptance_key: str, result: dict[str, Any], deltas: tuple[str, ...]) -> bool:
        now = self._now()
        placeholders = ",".join("?" for _ in deltas)
        self._connection.execute("BEGIN IMMEDIATE")
        try:
            owner = self._connection.execute("SELECT 1 FROM scheduler_manager_leases WHERE lease_key=? AND job_key=? AND lease_id=? AND released_at IS NULL", (self._manager_lease_key(), job_key, lease_id)).fetchone()
            if owner is None:
                self._connection.execute("ROLLBACK")
                return False
            updated = self._connection.execute(
                "UPDATE scheduler_jobs SET state='COMPLETED', completed_at=?, error_code=NULL WHERE job_key=? AND state='RUNNING' AND lease_id=?",
                (now, job_key, lease_id),
            ).rowcount
            if updated != 1:
                self._connection.execute("ROLLBACK")
                return False
            result_json = _canonical_json(result)
            result_hash = hashlib.sha256(result_json.encode("utf-8")).hexdigest()
            self._connection.execute("INSERT INTO scheduler_acceptances(acceptance_key,job_key,result_json,result_hash) VALUES(?,?,?,?)", (acceptance_key, job_key, result_json, result_hash))
            processed = self._connection.execute(
                f"UPDATE material_deltas SET state='PROCESSED', processed_job_key=? WHERE state='QUEUED' AND delta_id IN ({placeholders})",
                (job_key, *deltas),
            ).rowcount
            if processed != len(deltas):
                raise SchedulerFailure("SCHEDULER_DELTA_STATE_MISMATCH")
            self._connection.execute(f"DELETE FROM scheduler_uncertain_deltas WHERE delta_id IN ({placeholders})", deltas)
            released_job_lease = self._connection.execute("UPDATE scheduler_leases SET released_at=? WHERE job_key=? AND lease_id=? AND released_at IS NULL", (now, job_key, lease_id)).rowcount
            released_manager_lease = self._connection.execute("UPDATE scheduler_manager_leases SET released_at=? WHERE job_key=? AND lease_id=? AND released_at IS NULL", (now, job_key, lease_id)).rowcount
            if released_job_lease != 1 or released_manager_lease != 1:
                raise SchedulerFailure("SCHEDULER_LEASE_STATE_MISMATCH")
            self._connection.execute("COMMIT")
            return True
        except Exception:
            self._connection.execute("ROLLBACK")
            raise

    def _abstain_job(
        self,
        job_key: str,
        code: str,
        lease_id: str | None = None,
        *,
        expected_state: str = "QUEUED",
        mark_uncertain: bool = False,
    ) -> bool:
        now = self._now()
        if expected_state not in {"QUEUED", "RUNNING"}:
            raise ValueError("invalid scheduler state")
        input_row = self._connection.execute("SELECT input_delta_ids_json FROM scheduler_jobs WHERE job_key=?", (job_key,)).fetchone()
        captured_ids: list[str] = []
        if input_row is not None and isinstance(input_row["input_delta_ids_json"], str):
            try:
                parsed_input = json.loads(input_row["input_delta_ids_json"])
                if isinstance(parsed_input, list) and all(isinstance(delta_id, str) for delta_id in parsed_input):
                    captured_ids = list(parsed_input)
            except (TypeError, ValueError, json.JSONDecodeError):
                captured_ids = []
        if lease_id is None:
            predicate = "job_key=? AND state=?"
            predicate_params: tuple[Any, ...] = (job_key, expected_state)
        else:
            predicate = "job_key=? AND state=? AND lease_id=?"
            predicate_params = (job_key, expected_state, lease_id)
        failure_times = [stamp for stamp in self._crash_failures if now - stamp <= CIRCUIT_WINDOW_SECONDS]
        if code in _FAILURE_CODES:
            failure_times.append(now)
        circuit_until = now + CIRCUIT_COOLDOWN_SECONDS if len(failure_times) >= 3 else (self._meta_float("circuitUntil") or 0.0)
        self._connection.execute("BEGIN IMMEDIATE")
        try:
            updated = self._connection.execute(
                f"UPDATE scheduler_jobs SET state='ABSTAINED', completed_at=?, error_code=? WHERE {predicate}",
                (now, code, *predicate_params),
            ).rowcount
            if updated != 1:
                self._connection.execute("ROLLBACK")
                return False
            if lease_id is None:
                self._connection.execute("UPDATE scheduler_leases SET released_at=? WHERE job_key=? AND released_at IS NULL", (now, job_key))
                self._connection.execute("UPDATE scheduler_manager_leases SET released_at=? WHERE job_key=? AND released_at IS NULL", (now, job_key))
            else:
                self._connection.execute("UPDATE scheduler_leases SET released_at=? WHERE job_key=? AND lease_id=? AND released_at IS NULL", (now, job_key, lease_id))
                self._connection.execute("UPDATE scheduler_manager_leases SET released_at=? WHERE job_key=? AND lease_id=? AND released_at IS NULL", (now, job_key, lease_id))
            self._connection.execute("INSERT INTO scheduler_incidents(occurred_at,code,job_key,detail_json) VALUES(?,?,?,?)", (now, code, job_key, _canonical_json({"exposure": False, "deltaIds": captured_ids})))
            if mark_uncertain:
                for delta_id in captured_ids:
                    self._connection.execute(
                        "INSERT OR IGNORE INTO scheduler_uncertain_deltas(delta_id,job_key,marked_at) VALUES(?,?,?)",
                        (delta_id, job_key, now),
                    )
            if code in _FAILURE_CODES:
                self._connection.execute("INSERT OR REPLACE INTO scheduler_meta(key,value) VALUES(?,?)", ("failureTimes", json.dumps(failure_times, separators=(",", ":"))))
                self._connection.execute("INSERT OR REPLACE INTO scheduler_meta(key,value) VALUES(?,?)", ("circuitUntil", str(circuit_until)))
            self._connection.execute("COMMIT")
        except Exception:
            self._connection.execute("ROLLBACK")
            raise
        if code in _FAILURE_CODES:
            self._crash_failures = failure_times
            self._live_since = None
        else:
            self._live_since = None
        return True

    def _acquire_lease(self, job_key: str) -> bool:
        now = self._now()
        lease_id = f"lease_{secrets.token_hex(16)}"
        lease_key = self._manager_lease_key()
        self._connection.execute("BEGIN IMMEDIATE")
        try:
            row = self._connection.execute("SELECT * FROM scheduler_leases WHERE job_key=?", (job_key,)).fetchone()
            if row is not None and row["released_at"] is None:
                self._connection.execute("ROLLBACK")
                return False
            manager = self._connection.execute("SELECT * FROM scheduler_manager_leases WHERE lease_key=?", (lease_key,)).fetchone()
            if manager is not None and manager["released_at"] is None:
                self._connection.execute("ROLLBACK")
                return False
            if row is None:
                self._connection.execute("INSERT INTO scheduler_leases(job_key,lease_id,acquired_at,expires_at,released_at) VALUES(?,?,?,?,NULL)", (job_key, lease_id, now, now + self.lease_seconds))
            else:
                self._connection.execute("UPDATE scheduler_leases SET lease_id=?, acquired_at=?, expires_at=?, released_at=NULL WHERE job_key=? AND released_at IS NOT NULL", (lease_id, now, now + self.lease_seconds, job_key))
            self._connection.execute("UPDATE scheduler_jobs SET lease_id=? WHERE job_key=? AND state='QUEUED'", (lease_id, job_key))
            if manager is None:
                self._connection.execute("INSERT INTO scheduler_manager_leases(lease_key,job_key,lease_id,acquired_at,expires_at,released_at) VALUES(?,?,?,?,?,NULL)", (lease_key, job_key, lease_id, now, now + self.lease_seconds))
            else:
                self._connection.execute("UPDATE scheduler_manager_leases SET job_key=?, lease_id=?, acquired_at=?, expires_at=?, released_at=NULL WHERE lease_key=? AND released_at IS NOT NULL", (job_key, lease_id, now, now + self.lease_seconds, lease_key))
            self._connection.execute("COMMIT")
            return True
        except Exception:
            self._connection.execute("ROLLBACK")
            raise

    def _manager_lease_key(self) -> str:
        return f"{self.portfolio_id}:{self.job_type}"

    def _release_lease(self, job_key: str, lease_id: str | None = None) -> None:
        now = self._now()
        self._connection.execute("BEGIN IMMEDIATE")
        try:
            if lease_id is None:
                self._connection.execute("UPDATE scheduler_leases SET released_at=? WHERE job_key=? AND released_at IS NULL", (now, job_key))
                self._connection.execute("UPDATE scheduler_manager_leases SET released_at=? WHERE job_key=? AND released_at IS NULL", (now, job_key))
            else:
                self._connection.execute("UPDATE scheduler_leases SET released_at=? WHERE job_key=? AND lease_id=? AND released_at IS NULL", (now, job_key, lease_id))
                self._connection.execute("UPDATE scheduler_manager_leases SET released_at=? WHERE job_key=? AND lease_id=? AND released_at IS NULL", (now, job_key, lease_id))
            self._connection.execute("COMMIT")
        except Exception:
            self._connection.execute("ROLLBACK")
            raise

    def _record_live_success(self) -> None:
        now = self._now()
        if self._live_since is None:
            self._live_since = now
        if now - self._live_since >= CIRCUIT_WINDOW_SECONDS:
            self._crash_failures.clear()
            self._set_meta("failureTimes", "[]")
            self._set_meta("circuitUntil", "0")

    def _circuit_open(self) -> bool:
        try:
            until = self._meta_float("circuitUntil") or 0.0
        except (TypeError, ValueError, OverflowError):
            self._startup_halted = True
            return True
        return until > self._now()

    def _job_key(self, scheduled_at: float) -> str:
        return f"{self.portfolio_id}:{self.job_type}:{scheduled_at:.3f}"

    def _now(self) -> float:
        return self._clock.now() if hasattr(self._clock, "now") else self._clock()  # type: ignore[operator]

    def _validate_runtime_metadata(self) -> bool:
        """Keep live readiness fail-closed if a metadata row is tampered."""

        for key in ("nextDue", "circuitUntil"):
            row = self._connection.execute("SELECT value FROM scheduler_meta WHERE key=?", (key,)).fetchone()
            if row is None:
                continue
            try:
                value = float(row["value"])
            except (TypeError, ValueError, OverflowError):
                self._startup_halted = True
                return False
            if not math.isfinite(value) or (key == "nextDue" and value < 0):
                self._startup_halted = True
                return False
        return True

    def _validate_delta_rows(self) -> bool:
        """Validate the closed fixture delta state before reporting readiness."""

        for row in self._connection.execute("SELECT delta_id,observed_at,material,payload_json,state,processed_job_key FROM material_deltas"):
            if not _safe_delta_id(row["delta_id"]) or isinstance(row["observed_at"], bool) or not isinstance(row["observed_at"], (int, float)) or not math.isfinite(float(row["observed_at"])):
                return False
            if type(row["material"]) is not int or row["material"] not in {0, 1}:
                return False
            if row["state"] not in {"QUEUED", "PROCESSED", "TRACEABLE"}:
                return False
            if row["material"] == 1 and row["state"] == "TRACEABLE":
                return False
            if row["material"] == 0 and row["state"] != "TRACEABLE":
                return False
            if row["state"] in {"QUEUED", "TRACEABLE"} and row["processed_job_key"] is not None:
                return False
            if row["state"] == "PROCESSED":
                if row["material"] != 1 or not isinstance(row["processed_job_key"], str):
                    return False
                job = self._connection.execute("SELECT state FROM scheduler_jobs WHERE job_key=?", (row["processed_job_key"],)).fetchone()
                if job is None or job["state"] != "COMPLETED":
                    return False
            payload_json = row["payload_json"]
            try:
                if not isinstance(payload_json, str) or len(payload_json.encode("utf-8")) > 2048:
                    return False
                payload = json.loads(payload_json)
                if not isinstance(payload, dict) or set(payload) - _ALLOWED_DELTA_PAYLOAD_KEYS or payload.get("fixture") != "public-event-001":
                    return False
                if "ordinal" in payload and (type(payload["ordinal"]) is not int or not 0 <= payload["ordinal"] <= 1_000_000_000):
                    return False
                if "material" in payload and (type(payload["material"]) is not bool or payload["material"] != bool(row["material"])):
                    return False
                if _canonical_json(payload) != payload_json:
                    return False
            except (TypeError, ValueError, OverflowError, json.JSONDecodeError):
                return False
        return True

    def _meta_float(self, key: str) -> float | None:
        row = self._connection.execute("SELECT value FROM scheduler_meta WHERE key=?", (key,)).fetchone()
        if row is None:
            return None
        value = float(row["value"])
        if not math.isfinite(value):
            raise ValueError(f"scheduler metadata {key} is non-finite")
        return value

    def _set_meta(self, key: str, value: str) -> None:
        self._transaction("INSERT OR REPLACE INTO scheduler_meta(key,value) VALUES(?,?)", (key, value))

    def _transaction(self, sql: str, params: Iterable[Any]) -> int:
        self._connection.execute("BEGIN IMMEDIATE")
        try:
            rowcount = self._connection.execute(sql, tuple(params)).rowcount
            self._connection.execute("COMMIT")
            return rowcount
        except Exception:
            self._connection.execute("ROLLBACK")
            raise

    def _transaction_batch(self, statements: Iterable[tuple[str, Iterable[Any]]]) -> tuple[int, ...]:
        self._connection.execute("BEGIN IMMEDIATE")
        try:
            rowcounts: list[int] = []
            for sql, params in statements:
                rowcounts.append(self._connection.execute(sql, tuple(params)).rowcount)
            self._connection.execute("COMMIT")
            return tuple(rowcounts)
        except Exception:
            self._connection.execute("ROLLBACK")
            raise

    def _has_unreconciled_state(self) -> bool:
        invalid_delta_rows = not self._validate_delta_rows()
        running = self._connection.execute("SELECT COUNT(*) FROM scheduler_jobs WHERE state='RUNNING'").fetchone()[0]
        active_leases = self._connection.execute("SELECT COUNT(*) FROM scheduler_leases WHERE released_at IS NULL").fetchone()[0]
        terminal_leases = self._connection.execute("SELECT COUNT(*) FROM scheduler_jobs j JOIN scheduler_leases l ON l.job_key=j.job_key WHERE l.released_at IS NULL AND j.state IN ('COMPLETED','ABSTAINED')").fetchone()[0]
        orphan_leases = self._connection.execute("SELECT COUNT(*) FROM scheduler_leases l LEFT JOIN scheduler_jobs j ON j.job_key=l.job_key WHERE l.released_at IS NULL AND j.job_key IS NULL").fetchone()[0]
        manager_active = self._connection.execute("SELECT COUNT(*) FROM scheduler_manager_leases WHERE released_at IS NULL AND lease_key=?", (self._manager_lease_key(),)).fetchone()[0]
        orphan_manager_leases = self._connection.execute("SELECT COUNT(*) FROM scheduler_manager_leases m LEFT JOIN scheduler_jobs j ON j.job_key=m.job_key WHERE m.released_at IS NULL AND (j.job_key IS NULL OR j.state != 'RUNNING')").fetchone()[0]
        running_lease_mismatch = self._connection.execute(
            "SELECT COUNT(*) FROM scheduler_jobs j LEFT JOIN scheduler_leases l ON l.job_key=j.job_key AND l.released_at IS NULL LEFT JOIN scheduler_manager_leases m ON m.job_key=j.job_key AND m.released_at IS NULL WHERE j.state='RUNNING' AND (l.lease_id IS NULL OR m.lease_id IS NULL OR j.lease_id IS NULL OR j.lease_id != l.lease_id OR j.lease_id != m.lease_id)"
        ).fetchone()[0]
        orphan_acceptances = self._connection.execute("SELECT COUNT(*) FROM scheduler_acceptances a LEFT JOIN scheduler_jobs j ON j.job_key=a.job_key WHERE j.job_key IS NULL OR j.state != 'COMPLETED'").fetchone()[0]
        orphan_processed = self._connection.execute("SELECT COUNT(*) FROM material_deltas d LEFT JOIN scheduler_jobs j ON j.job_key=d.processed_job_key WHERE d.state='PROCESSED' AND (j.job_key IS NULL OR j.state != 'COMPLETED')").fetchone()[0]
        orphan_uncertain = self._connection.execute("SELECT COUNT(*) FROM scheduler_uncertain_deltas u LEFT JOIN material_deltas d ON d.delta_id=u.delta_id WHERE d.delta_id IS NULL OR d.state != 'QUEUED'").fetchone()[0]
        unaudited = self._connection.execute("SELECT COUNT(*) FROM scheduler_jobs j WHERE j.state='ABSTAINED' AND NOT EXISTS (SELECT 1 FROM scheduler_incidents i WHERE i.job_key=j.job_key)").fetchone()[0]
        completed_linkage = self._connection.execute(
            "SELECT COUNT(*) FROM scheduler_jobs j WHERE j.state='COMPLETED' AND ((EXISTS (SELECT 1 FROM material_deltas d WHERE d.processed_job_key=j.job_key) AND (SELECT COUNT(*) FROM scheduler_acceptances a WHERE a.job_key=j.job_key) != 1) OR (NOT EXISTS (SELECT 1 FROM material_deltas d WHERE d.processed_job_key=j.job_key) AND EXISTS (SELECT 1 FROM scheduler_acceptances a WHERE a.job_key=j.job_key)))"
        ).fetchone()[0]
        invalid_job_integrity = 0
        job_inputs: dict[str, tuple[str, ...]] = {}
        job_states: dict[str, str] = {}
        for job in self._connection.execute("SELECT job_key,state,input_delta_ids_json FROM scheduler_jobs"):
            job_key = job["job_key"]
            job_states[job_key] = job["state"]
            try:
                captured = _decode_delta_ids(job["input_delta_ids_json"])
            except (TypeError, ValueError, json.JSONDecodeError):
                invalid_job_integrity += 1
                captured = ()
            job_inputs[job_key] = captured
            processed = tuple(item["delta_id"] for item in self._connection.execute("SELECT delta_id FROM material_deltas WHERE processed_job_key=? ORDER BY observed_at, delta_id", (job_key,)))
            if job["state"] == "QUEUED" and captured:
                resolved_markers = {item["delta_id"] for item in self._connection.execute("SELECT delta_id FROM scheduler_uncertain_deltas WHERE job_key=? AND resolved_at IS NOT NULL", (job_key,))}
                unresolved_markers = self._connection.execute("SELECT COUNT(*) FROM scheduler_uncertain_deltas WHERE job_key=? AND resolved_at IS NULL", (job_key,)).fetchone()[0]
                if resolved_markers != set(captured) or unresolved_markers:
                    invalid_job_integrity += 1
            elif job["state"] == "RUNNING" and not captured:
                invalid_job_integrity += 1
            elif job["state"] == "COMPLETED" and set(captured) != set(processed):
                invalid_job_integrity += 1
            elif job["state"] == "ABSTAINED" and captured:
                queued = {item["delta_id"] for item in self._connection.execute("SELECT delta_id FROM material_deltas WHERE state='QUEUED'")}
                uncertain = {item["delta_id"] for item in self._connection.execute("SELECT delta_id FROM scheduler_uncertain_deltas WHERE job_key=?", (job_key,))}
                if not set(captured) <= queued | uncertain:
                    invalid_job_integrity += 1

        invalid_incident = 0
        for incident in self._connection.execute("SELECT job_key,code,detail_json FROM scheduler_incidents WHERE job_key IS NOT NULL"):
            if incident["job_key"] not in job_states:
                continue
            try:
                detail = json.loads(incident["detail_json"])
                detail_ids = detail.get("deltaIds") if isinstance(detail, dict) else None
                if not isinstance(detail_ids, list) or any(not _safe_delta_id(delta_id) for delta_id in detail_ids) or len(detail_ids) != len(set(detail_ids)) or set(detail_ids) != set(job_inputs[incident["job_key"]]):
                    raise ValueError("incident input set is invalid")
                if incident["code"] == "SCHEDULER_RECONCILIATION_CONFIRMED":
                    expected_operation = self._operation_id(job_inputs[incident["job_key"]])
                    if detail.get("operationId") != expected_operation:
                        raise ValueError("reconciliation operation is invalid")
            except (TypeError, ValueError, json.JSONDecodeError):
                invalid_incident += 1

        uncertain_by_job: dict[str, set[str]] = {}
        invalid_uncertain = 0
        for marker in self._connection.execute("SELECT delta_id,job_key,marked_at,resolved_at,resolution_operation_id FROM scheduler_uncertain_deltas"):
            job_key = marker["job_key"]
            if job_key not in job_states or job_states[job_key] not in {"ABSTAINED", "QUEUED"} or not _safe_delta_id(marker["delta_id"]):
                invalid_uncertain += 1
                continue
            if job_states[job_key] == "QUEUED" and marker["resolved_at"] is None:
                invalid_uncertain += 1
                continue
            if job_states[job_key] == "ABSTAINED" and marker["resolved_at"] is not None:
                invalid_uncertain += 1
                continue
            uncertain_by_job.setdefault(job_key, set()).add(marker["delta_id"])
            try:
                if not isinstance(marker["marked_at"], (int, float)) or isinstance(marker["marked_at"], bool) or not math.isfinite(float(marker["marked_at"])):
                    raise ValueError("uncertain marker timestamp is invalid")
                if marker["resolved_at"] is None:
                    if marker["resolution_operation_id"] is not None:
                        raise ValueError("unresolved marker has a resolution")
                else:
                    if not isinstance(marker["resolved_at"], (int, float)) or isinstance(marker["resolved_at"], bool) or not math.isfinite(float(marker["resolved_at"])):
                        raise ValueError("resolution timestamp is invalid")
                    expected_operation = self._operation_id(job_inputs[job_key])
                    if marker["resolution_operation_id"] != expected_operation:
                        raise ValueError("resolution operation is invalid")
                    confirmation = self._connection.execute(
                        "SELECT detail_json FROM scheduler_incidents WHERE job_key=? AND code='SCHEDULER_RECONCILIATION_CONFIRMED'",
                        (job_key,),
                    ).fetchall()
                    if not any(
                        isinstance((detail := json.loads(row["detail_json"])), dict)
                        and detail.get("operationId") == expected_operation
                        and isinstance(detail.get("deltaIds"), list)
                        and set(detail["deltaIds"]) == set(job_inputs[job_key])
                        for row in confirmation
                    ):
                        raise ValueError("resolution confirmation is missing")
            except (TypeError, ValueError, json.JSONDecodeError):
                invalid_uncertain += 1
        for job_key, marker_ids in uncertain_by_job.items():
            if marker_ids != set(job_inputs.get(job_key, ())):
                invalid_uncertain += 1

        invalid_acceptance = 0
        seen_operation_ids: set[str] = set()
        for row in self._connection.execute("SELECT acceptance_key,job_key,result_json,result_hash FROM scheduler_acceptances"):
            result_json = row["result_json"]
            try:
                if not isinstance(result_json, str):
                    raise TypeError("acceptance result JSON must be text")
                result = json.loads(result_json)
            except (TypeError, ValueError, json.JSONDecodeError):
                invalid_acceptance += 1
                continue
            deltas = tuple(item["delta_id"] for item in self._connection.execute("SELECT delta_id FROM material_deltas WHERE processed_job_key=? ORDER BY observed_at, delta_id", (row["job_key"],)))
            try:
                if not isinstance(row["result_hash"], str) or row["result_hash"] != hashlib.sha256(result_json.encode("utf-8")).hexdigest() or not isinstance(result, dict) or row["acceptance_key"] != f"{row['job_key']}:{result.get('operationId')}" or not deltas:
                    raise SchedulerFailure("SCHEDULER_ACCEPTANCE_INVALID")
                self._validate_completed_result(result, self._operation_id(deltas))
                if not self._test_callback and result != _fixture_manager_callback(deltas, row["job_key"]):
                    raise SchedulerFailure("AUTHORITY_RESPONSE_MISMATCH")
                operation_id = result["operationId"]
                if operation_id in seen_operation_ids:
                    raise SchedulerFailure("DUPLICATE_ACCEPTANCE")
                seen_operation_ids.add(operation_id)
            except (SchedulerError, TypeError, ValueError):
                invalid_acceptance += 1
        orphan_incidents = self._connection.execute("SELECT COUNT(*) FROM scheduler_incidents i LEFT JOIN scheduler_jobs j ON j.job_key=i.job_key WHERE i.job_key IS NOT NULL AND j.job_key IS NULL").fetchone()[0]
        if invalid_delta_rows or terminal_leases or orphan_leases or orphan_manager_leases or running_lease_mismatch or orphan_acceptances or orphan_processed or orphan_uncertain or orphan_incidents or completed_linkage or unaudited or invalid_job_integrity or invalid_incident or invalid_uncertain or invalid_acceptance:
            self._startup_halted = True
        return bool(running or active_leases or manager_active)


def _canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def operation_id_for_deltas(delta_ids: Iterable[str]) -> str:
    digest = hashlib.sha256(_canonical_json(sorted(delta_ids)).encode("utf-8")).hexdigest()
    return f"op_sched_{digest[:32]}"


def _fixture_manager_callback(delta_ids: tuple[str, ...], job_key: str) -> dict[str, Any]:
    """Run one bounded fixture authority turn for local loop/soak tests.

    This is deliberately not a model or broker adapter.  It feeds a fresh,
    deterministic public MPTEST request through the already-qualified Python
    authority so every completed scheduler turn has a gate and immutable audit
    identity.  The real manager/critic hosted walkthrough remains the WI-006
    command; the soak itself never depends on hosted capacity.
    """

    if not delta_ids:
        return {"status": "ABSTAINED", "reasonCode": "NO_MATERIAL_DELTA", "operationId": job_key}
    from .paper_fixture_authority import compute_hash, evaluate_request, verify_response
    from .paper_fixtures import accepted_request, rejected_quantity_request

    # Hash-derived IDs keep each cadence turn idempotent without introducing
    # clocks, randomness, process IDs, or any production identity into the
    # fixture contract.  The parity is intentionally mixed by the digest so
    # the long run exercises both accepted and rejected domain paths.
    digest = hashlib.sha256(_canonical_json(sorted(delta_ids)).encode("utf-8")).hexdigest()
    operation_id = f"op_sched_{digest[:32]}"
    request_id = f"req_soak_{digest[32:64]}"
    request = (rejected_quantity_request() if int(digest[-2:], 16) % 2 else accepted_request())
    request["requestId"] = request_id
    request["operationId"] = operation_id
    intent = request["bundle"]["tradeIntent"]
    intent["operationId"] = operation_id
    intent["intentHash"] = compute_hash(intent, "trade-intent", "intentHash")
    critic = request["bundle"]["criticVerdict"]
    critic["operationId"] = operation_id
    critic["intentHash"] = intent["intentHash"]
    critic["verdictHash"] = compute_hash(critic, "critic-verdict", "verdictHash")
    response = evaluate_request(request)
    if not verify_response(response, request):
        raise SchedulerFailure("AUTHORITY_OUTPUT_INVALID")
    return {
        "status": response["status"],
        "reasonCode": response["primaryReasonCode"],
        "operationId": response["operationId"],
        "responseHash": response["responseHash"],
        "auditEventCount": len(response["auditEvents"]),
        "auditHeadHash": response["headHash"],
        "gateDecisionId": response["gateDecision"]["decisionId"],
        "orderPlanId": None if response["orderPlan"] is None else response["orderPlan"]["planId"],
        "executionId": None if response["executionEvent"] is None else response["executionEvent"]["executionId"],
    }


def run_soak() -> dict[str, Any]:
    """Run the required uninterrupted two-hour real-clock soak.

    There is intentionally no duration argument: a shortened diagnostic run
    cannot be reported as WI-008 acceptance evidence.
    """

    # Monotonic time is required for real-duration evidence: NTP/manual wall
    # clock adjustments must not shorten the soak or manufacture cadence gaps.
    started_wall = time.monotonic()
    started_cpu = resource.getrusage(resource.RUSAGE_SELF)
    expected_jobs = SOAK_SECONDS // CADENCE_SECONDS
    with tempfile.TemporaryDirectory(prefix="marketpilot-wi008-soak-") as directory:
        database = Path(directory) / "materiality.sqlite"
        before_bytes = database.stat().st_size if database.exists() else 0
        with MaterialityScheduler(database, clock=time.monotonic) as scheduler:
            delta_index = 0
            generated_material = 0
            generated_nonmaterial = 0
            while time.monotonic() - started_wall < SOAK_SECONDS:
                elapsed = time.monotonic() - started_wall
                # Stop scheduling work after the final due cadence.  The
                # remaining wall-clock interval is still part of the required
                # uninterrupted soak, but must not create a 41st boundary at
                # exactly the two-hour mark or leave a final queued delta.
                if elapsed >= SOAK_SECONDS - CADENCE_SECONDS and scheduler.metrics().scheduled_jobs >= expected_jobs:
                    break
                if elapsed < SOAK_SECONDS - CADENCE_SECONDS:
                    delta_index += 1
                    scheduler.ingest_delta(f"delta_soak_{delta_index:04d}", material=True, payload={"fixture": "public-event-001", "ordinal": delta_index})
                    generated_material += 1
                    if delta_index % 2 == 0:
                        scheduler.ingest_delta(f"delta_nonmaterial_{delta_index:04d}", material=False, payload={"fixture": "public-event-001", "material": False})
                        generated_nonmaterial += 1
                scheduler.tick()
                next_due = scheduler._meta_float("nextDue") or scheduler._now() + CADENCE_SECONDS
                delay = max(0.1, min(5.0, next_due - scheduler._now()))
                time.sleep(delay)
            remaining = SOAK_SECONDS - (time.monotonic() - started_wall)
            if remaining > 0:
                time.sleep(remaining)
            final_metrics = scheduler.metrics()
            readiness = scheduler.readiness()
            after_bytes = database.stat().st_size if database.exists() else before_bytes
            jobs = scheduler.job_rows()
            incidents = scheduler.incident_rows()
            acceptances = scheduler.acceptance_rows()
    ended_cpu = resource.getrusage(resource.RUSAGE_SELF)
    elapsed = time.monotonic() - started_wall
    violations = []
    if final_metrics.scheduled_jobs != expected_jobs:
        violations.append("SCHEDULED_JOB_COUNT")
    if final_metrics.overlap_violations or final_metrics.missed_job_violations or final_metrics.lost_delta_violations or final_metrics.unaudited_incident_violations or final_metrics.duplicate_acceptance_violations:
        violations.append("METRIC_VIOLATION")
    if final_metrics.processed_material_deltas != final_metrics.material_deltas:
        violations.append("LOST_MATERIAL_DELTA")
    if final_metrics.material_deltas != generated_material or final_metrics.processed_material_deltas != generated_material:
        violations.append("GENERATED_MATERIAL_COUNT_MISMATCH")
    if final_metrics.nonmaterial_deltas != generated_nonmaterial or final_metrics.traceable_nonmaterial_deltas != generated_nonmaterial:
        violations.append("GENERATED_NONMATERIAL_COUNT_MISMATCH")
    if any(job["state"] == "QUEUED" for job in jobs):
        violations.append("STALE_QUEUED_JOB")
    if final_metrics.abstained_jobs:
        violations.append("UNEXPECTED_ABSTAIN")
    if incidents:
        violations.append("UNEXPECTED_INCIDENT")
    if not readiness["ready"]:
        violations.append("FALSE_NOT_READY")
    latency = sorted(final_metrics.latency_ms)
    p95 = latency[max(0, math.ceil(len(latency) * 0.95) - 1)] if latency else 0.0
    return {
        "schemaVersion": 1,
        "profile": SOAK_PROFILE,
        "durationSeconds": round(elapsed, 3),
        "requiredDurationSeconds": SOAK_SECONDS,
        "cadenceSeconds": CADENCE_SECONDS,
        "workload": {"expectedJobs": expected_jobs, "scheduledJobs": final_metrics.scheduled_jobs, "completedJobs": final_metrics.completed_jobs, "abstainedJobs": final_metrics.abstained_jobs, "managerTurns": final_metrics.manager_turns, "acceptedTurns": sum(item["result"].get("status") == "ACCEPTED" for item in acceptances), "rejectedTurns": sum(item["result"].get("status") == "REJECTED" for item in acceptances), "generatedMaterialDeltas": generated_material, "materialDeltas": final_metrics.material_deltas, "processedMaterialDeltas": final_metrics.processed_material_deltas, "generatedNonmaterialDeltas": generated_nonmaterial, "nonmaterialDeltas": final_metrics.nonmaterial_deltas, "traceableNonmaterialDeltas": final_metrics.traceable_nonmaterial_deltas},
        "latencyMs": {"count": len(latency), "min": round(min(latency), 4) if latency else 0.0, "median": round(latency[len(latency) // 2], 4) if latency else 0.0, "p95": round(p95, 4), "max": round(max(latency), 4) if latency else 0.0},
        "databaseGrowthBytes": max(0, after_bytes - before_bytes),
        "resource": {"userCpuSeconds": round(ended_cpu.ru_utime - started_cpu.ru_utime, 3), "systemCpuSeconds": round(ended_cpu.ru_stime - started_cpu.ru_stime, 3), "maxRssKb": ended_cpu.ru_maxrss},
        "incidents": len(incidents),
        "authorityAudit": {"responseHashCount": len(acceptances), "responseHashes": [item["result"]["responseHash"] for item in acceptances], "auditHeadHashes": [item["result"]["auditHeadHash"] for item in acceptances], "gateDecisionIds": [item["result"]["gateDecisionId"] for item in acceptances], "orderPlanIds": [item["result"]["orderPlanId"] for item in acceptances if item["result"]["orderPlanId"] is not None], "executionIds": [item["result"]["executionId"] for item in acceptances if item["result"]["executionId"] is not None], "auditEventCounts": {str(count): sum(item["result"].get("auditEventCount") == count for item in acceptances) for count in (4, 5, 7)}},
        "violations": violations,
        "status": "PASSED" if elapsed >= SOAK_SECONDS and not violations else "FAILED",
        "readiness": readiness,
        "databaseEphemeral": True,
        "hostedTurns": 0,
        "hostedFixtureOnly": True,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="MarketPilot WI-008 materiality loop")
    parser.add_argument("--soak", action="store_true", help="run the required uninterrupted two-hour fixture soak")
    args = parser.parse_args(argv)
    if not args.soak:
        parser.error("only --soak is an acceptance command; shortened runs are not supported")
    report = run_soak()
    evidence_dir = Path(__file__).resolve().parents[2] / "artifacts" / "work"
    evidence_dir.mkdir(parents=True, exist_ok=True)
    (evidence_dir / "wi-008-soak-report.json").write_text(json.dumps(report, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")
    print(json.dumps(report, sort_keys=True, separators=(",", ":")))
    return 0 if report["status"] == "PASSED" else 1


__all__ = [
    "CADENCE_SECONDS",
    "CIRCUIT_COOLDOWN_SECONDS",
    "DeterministicClock",
    "LEASE_SECONDS",
    "MaterialityScheduler",
    "operation_id_for_deltas",
    "SchedulerError",
    "SchedulerFailure",
    "SchedulerMetrics",
    "SOAK_SECONDS",
    "run_soak",
]


if __name__ == "__main__":
    raise SystemExit(main())
