"""Deterministic WI-008 cadence, lease, coalescing, and circuit tests."""

from __future__ import annotations

import sys
import hashlib
import sqlite3
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "src"))

from marketpilot.materiality_loop import (  # noqa: E402
    CADENCE_SECONDS,
    CIRCUIT_COOLDOWN_SECONDS,
    DeterministicClock,
    MaterialityScheduler,
    operation_id_for_deltas,
    SchedulerError,
    SchedulerFailure,
    _fixture_manager_callback,
)


class MaterialityTests(unittest.TestCase):
    @staticmethod
    def _result(status, operation_id, audit_event_count=7):
        return {
            "status": status,
            "reasonCode": "ACCEPTED" if status == "ACCEPTED" else "FIXTURE_TEST",
            "operationId": operation_id,
            "responseHash": "0" * 64,
            "auditEventCount": audit_event_count,
            "auditHeadHash": "0" * 64,
            "gateDecisionId": "gd_fixture_test_001",
            "orderPlanId": "plan_fixture_test_001" if status == "ACCEPTED" else None,
            "executionId": "exec_fixture_test_001" if status == "ACCEPTED" else None,
        }

    def test_public_scheduler_rejects_injected_acceptance_callback(self):
        with self.assertRaises(SchedulerError) as raised:
            MaterialityScheduler(manager_callback=lambda _deltas, _job_key: {})
        self.assertEqual(raised.exception.code, "SCHEDULER_AUTHORITY_CALLBACK_FORBIDDEN")

    def test_default_authority_replay_rejects_fabricated_summary(self):
        clock = DeterministicClock()
        with MaterialityScheduler(clock=clock) as scheduler:
            scheduler._manager_callback = lambda deltas, _job_key: self._result("ACCEPTED", operation_id_for_deltas(deltas))
            scheduler.ingest_delta("delta_material_001", material=True)
            outcome = scheduler.tick()[0]
            self.assertEqual(outcome["status"], "ABSTAINED")
            self.assertEqual(outcome["reasonCode"], "AUTHORITY_RESPONSE_MISMATCH")

    def test_runtime_metadata_tamper_blocks_live_readiness_and_tick(self):
        with MaterialityScheduler(clock=DeterministicClock()) as scheduler:
            scheduler._set_meta("nextDue", "nan")
            self.assertEqual(scheduler.readiness()["reasonCode"], "SCHEDULER_RECOVERY_BLOCKED")
            self.assertEqual(scheduler.tick()[0]["reasonCode"], "SCHEDULER_RECOVERY_BLOCKED")

    def test_live_metrics_fail_closed_for_valid_hash_non_object_summary(self):
        clock = DeterministicClock()

        def manager(deltas, job_key):
            return self._result("ACCEPTED", operation_id_for_deltas(deltas))

        with MaterialityScheduler.for_test(clock=clock, manager_callback=manager) as scheduler:
            scheduler.ingest_delta("delta_material_001", material=True)
            self.assertEqual(scheduler.tick()[0]["status"], "COMPLETED")
            scheduler._transaction(
                "UPDATE scheduler_acceptances SET result_json=?, result_hash=?",
                ("[]", hashlib.sha256(b"[]").hexdigest()),
            )
            scheduler.metrics()
            self.assertEqual(scheduler.readiness()["reasonCode"], "SCHEDULER_RECOVERY_BLOCKED")

    def test_live_tick_tampered_acceptance_is_typed_and_retains_new_delta(self):
        clock = DeterministicClock()

        def manager(deltas, _job_key):
            return self._result("ACCEPTED", operation_id_for_deltas(deltas))

        with MaterialityScheduler.for_test(clock=clock, manager_callback=manager) as scheduler:
            scheduler.ingest_delta("delta_material_001", material=True)
            self.assertEqual(scheduler.tick()[0]["status"], "COMPLETED")
            scheduler._transaction(
                "UPDATE scheduler_acceptances SET result_json=?, result_hash=?",
                ("[]", hashlib.sha256(b"[]").hexdigest()),
            )
            clock.advance(CADENCE_SECONDS)
            scheduler.ingest_delta("delta_material_002", material=True)
            outcome = scheduler.tick()[0]
            self.assertEqual(outcome["status"], "ABSTAINED")
            self.assertEqual(outcome["reasonCode"], "SCHEDULER_ACCEPTANCE_INVALID")
            self.assertEqual(scheduler.delta_rows()[-1]["state"], "QUEUED")

    def test_delta_state_tamper_blocks_live_scheduler(self):
        with MaterialityScheduler(clock=DeterministicClock()) as scheduler:
            scheduler.ingest_delta("delta_material_001", material=True)
            scheduler._transaction("UPDATE material_deltas SET state='TRACEABLE'", ())
            self.assertEqual(scheduler.readiness()["reasonCode"], "SCHEDULER_RECOVERY_BLOCKED")
            self.assertEqual(scheduler.tick()[0]["reasonCode"], "SCHEDULER_RECOVERY_BLOCKED")

    def test_one_job_per_three_minute_cadence_and_traceable_nonmaterial_delta(self):
        clock = DeterministicClock()
        calls = []

        def manager(deltas, job_key):
            calls.append((deltas, job_key))
            return self._result("ACCEPTED", operation_id_for_deltas(deltas))

        with MaterialityScheduler.for_test(clock=clock, manager_callback=manager) as scheduler:
            scheduler.ingest_delta("delta_material_001", material=True)
            scheduler.ingest_delta("delta_nonmaterial_001", material=False)
            first = scheduler.tick()
            self.assertEqual(len(first), 1)
            self.assertEqual(first[0]["status"], "COMPLETED")
            self.assertEqual(calls[0][0], ("delta_material_001",))
            self.assertEqual(scheduler.metrics().scheduled_jobs, 1)
            self.assertEqual(scheduler.metrics().traceable_nonmaterial_deltas, 1)
            self.assertTrue(scheduler.readiness()["ready"])
            clock.advance(CADENCE_SECONDS)
            second = scheduler.tick()
            self.assertEqual(len(second), 1)
            self.assertEqual(scheduler.metrics().scheduled_jobs, 2)

    def test_empty_cadence_drain_breaks_when_another_scheduler_holds_lease(self):
        with tempfile.TemporaryDirectory(prefix="marketpilot-wi008-concurrent-empty-") as directory:
            database = Path(directory) / "scheduler.sqlite"
            clock = DeterministicClock()
            with MaterialityScheduler(database, clock=clock) as owner, MaterialityScheduler(database, clock=clock) as contender:
                job_key = owner._job_key(0.0)
                owner._transaction(
                    "INSERT INTO scheduler_jobs(job_key,scheduled_at,state) VALUES(?,?, 'QUEUED')",
                    (job_key, 0.0),
                )
                self.assertTrue(contender._acquire_lease(job_key))
                result = owner.tick()
                self.assertEqual(result[0]["status"], "QUEUED")
                self.assertEqual(result[0]["reasonCode"], "LEASE_HELD")

    def test_material_deltas_coalesce_while_manager_is_busy(self):
        clock = DeterministicClock()
        calls = []

        def manager(deltas, job_key):
            calls.append(deltas)
            return self._result("REJECTED", operation_id_for_deltas(deltas), 5)

        with MaterialityScheduler.for_test(clock=clock, manager_callback=manager) as scheduler:
            scheduler.set_manager_busy(True)
            scheduler.ingest_delta("delta_material_001", material=True)
            scheduler.ingest_delta("delta_material_002", material=True)
            self.assertEqual(scheduler.tick()[0]["reasonCode"], "MANAGER_BUSY_COALESCED")
            self.assertFalse(scheduler.readiness()["ready"])
            scheduler.set_manager_busy(False)
            clock.advance(CADENCE_SECONDS)
            result = scheduler.tick()  # next cadence consumes one coalesced bundle
            self.assertEqual(result[0]["status"], "COMPLETED")
            self.assertEqual(calls, [("delta_material_001", "delta_material_002")])
            self.assertEqual(scheduler.metrics().processed_material_deltas, 2)
            self.assertEqual(scheduler.metrics().overlap_violations, 0)
            self.assertTrue(all(row["state"] == "COMPLETED" for row in scheduler.job_rows()))

    def test_transient_overdue_cadence_is_retained_as_missed_metric(self):
        clock = DeterministicClock()
        with MaterialityScheduler(clock=clock) as scheduler:
            scheduler.set_manager_busy(True)
            scheduler.ingest_delta("delta_material_001", material=True)
            self.assertEqual(scheduler.tick()[0]["reasonCode"], "MANAGER_BUSY_COALESCED")
            clock.advance(CADENCE_SECONDS)
            scheduler.set_manager_busy(False)
            self.assertEqual(scheduler.tick()[0]["status"], "COMPLETED")
            self.assertEqual(scheduler.metrics().missed_job_violations, 1)

    def test_delta_arriving_during_callback_is_reserved_for_next_job(self):
        clock = DeterministicClock()
        calls = []

        def manager(deltas, job_key):
            calls.append(deltas)
            if len(calls) == 1:
                scheduler.ingest_delta("delta_material_002", material=True)
            return self._result("ACCEPTED", operation_id_for_deltas(deltas))

        with MaterialityScheduler.for_test(clock=clock, manager_callback=manager) as scheduler:
            scheduler.ingest_delta("delta_material_001", material=True)
            self.assertEqual(scheduler.tick()[0]["status"], "COMPLETED")
            self.assertEqual(calls, [("delta_material_001",)])
            self.assertEqual(scheduler.delta_rows()[0]["state"], "PROCESSED")
            self.assertEqual(scheduler.delta_rows()[1]["state"], "QUEUED")
            clock.advance(CADENCE_SECONDS)
            scheduler.tick()
            self.assertEqual(calls, [("delta_material_001",), ("delta_material_002",)])
            self.assertEqual(scheduler.metrics().processed_material_deltas, 2)

    def test_authority_fixture_callback_proves_accept_and_reject_audit_identities(self):
        accepted = _fixture_manager_callback(("delta_material_001",), "portfolio:materiality_decision:0.000")
        rejected = _fixture_manager_callback(("delta_material_002",), "portfolio:materiality_decision:180.000")
        self.assertIn(accepted["status"], {"ACCEPTED", "REJECTED"})
        self.assertIn(rejected["status"], {"ACCEPTED", "REJECTED"})
        self.assertNotEqual(accepted["operationId"], rejected["operationId"])
        self.assertEqual(accepted["auditEventCount"], 7 if accepted["status"] == "ACCEPTED" else 5)
        self.assertEqual(rejected["auditEventCount"], 7 if rejected["status"] == "ACCEPTED" else 5)
        self.assertEqual(len(accepted["responseHash"]), 64)
        self.assertEqual(len(rejected["responseHash"]), 64)

    def test_completed_result_validation_fails_closed_for_malformed_types(self):
        clock = DeterministicClock()

        def manager(deltas, job_key):
            result = self._result("ACCEPTED", operation_id_for_deltas(deltas))
            result["operationId"] = 123
            result["gateDecisionId"] = 123
            result["reasonCode"] = []
            return result

        with MaterialityScheduler.for_test(clock=clock, manager_callback=manager) as scheduler:
            scheduler.ingest_delta("delta_material_001", material=True)
            outcome = scheduler.tick()[0]
            self.assertEqual(outcome["status"], "ABSTAINED")
            self.assertEqual(outcome["reasonCode"], "MANAGER_RESULT_INVALID")

    def test_timeout_retains_deltas_then_recovers_without_duplicate_acceptance(self):
        clock = DeterministicClock()
        fail = True
        calls = []

        def manager(deltas, job_key):
            calls.append(deltas)
            if fail:
                raise SchedulerFailure("TURN_TIMEOUT")
            return self._result("ACCEPTED", operation_id_for_deltas(deltas))

        with MaterialityScheduler.for_test(clock=clock, manager_callback=manager) as scheduler:
            scheduler.ingest_delta("delta_material_001", material=True)
            result = scheduler.tick()[0]
            self.assertEqual(result["status"], "ABSTAINED")
            self.assertEqual(result["reasonCode"], "TURN_TIMEOUT")
            self.assertEqual(scheduler.metrics().processed_material_deltas, 0)
            self.assertFalse(scheduler.readiness()["ready"])
            fail = False
            scheduler.ingest_delta("delta_material_002", material=True)
            clock.advance(CADENCE_SECONDS)
            blocked = scheduler.tick()[0]
            self.assertEqual(blocked["reasonCode"], "SCHEDULER_OPERATION_UNCERTAIN")
            self.assertEqual(calls, [("delta_material_001",)])
            scheduler.reconcile_uncertain(
                delta_ids=("delta_material_001",),
                operation_id=operation_id_for_deltas(("delta_material_001",)),
                confirm_idempotent=True,
            )
            recovered = scheduler.tick()[0]
            self.assertEqual(recovered["status"], "COMPLETED")
            self.assertEqual(calls, [("delta_material_001",), ("delta_material_001",)])
            clock.advance(CADENCE_SECONDS)
            newer = scheduler.tick()[0]
            self.assertEqual(newer["status"], "COMPLETED")
            self.assertEqual(calls[-1], ("delta_material_002",))
            self.assertTrue(scheduler.readiness()["ready"])
            self.assertEqual(scheduler.metrics().duplicate_acceptance_violations, 0)
            self.assertEqual(len(scheduler.incident_rows()), 2)

    def test_typed_timeout_abstention_also_requires_reconciliation(self):
        clock = DeterministicClock()

        def manager(deltas, _job_key):
            return {"status": "ABSTAINED", "reasonCode": "TURN_TIMEOUT", "operationId": operation_id_for_deltas(deltas)}

        with MaterialityScheduler.for_test(clock=clock, manager_callback=manager) as scheduler:
            scheduler.ingest_delta("delta_material_001", material=True)
            outcome = scheduler.tick()[0]
            self.assertEqual(outcome["reasonCode"], "TURN_TIMEOUT")
            self.assertEqual(scheduler.readiness()["reasonCode"], "SCHEDULER_OPERATION_UNCERTAIN")
            marker = scheduler._connection.execute("SELECT delta_id FROM scheduler_uncertain_deltas").fetchone()
            self.assertEqual(marker["delta_id"], "delta_material_001")

    def test_authority_process_failure_blocks_new_delta_widening(self):
        clock = DeterministicClock()

        def manager(_deltas, _job_key):
            raise SchedulerFailure("AUTHORITY_PROCESS_FAILED")

        with MaterialityScheduler.for_test(clock=clock, manager_callback=manager) as scheduler:
            scheduler.ingest_delta("delta_material_001", material=True)
            self.assertEqual(scheduler.tick()[0]["reasonCode"], "AUTHORITY_PROCESS_FAILED")
            scheduler.ingest_delta("delta_material_002", material=True)
            clock.advance(CADENCE_SECONDS)
            self.assertEqual(scheduler.tick()[0]["reasonCode"], "SCHEDULER_OPERATION_UNCERTAIN")
            self.assertEqual(
                [row["delta_id"] for row in scheduler._connection.execute("SELECT delta_id FROM scheduler_uncertain_deltas")],
                ["delta_material_001"],
            )

    def test_three_failures_open_circuit_and_cooldown_is_explicit(self):
        clock = DeterministicClock()

        def manager(deltas, job_key):
            raise SchedulerFailure("MANAGER_PROCESS_FAILED")

        with MaterialityScheduler.for_test(clock=clock, manager_callback=manager) as scheduler:
            for index in range(3):
                scheduler.ingest_delta(f"delta_material_{index:03d}", material=True)
                scheduler.tick()
                if index < 2:
                    clock.advance(CADENCE_SECONDS)
            self.assertEqual(scheduler.readiness()["reasonCode"], "SCHEDULER_CIRCUIT_OPEN")
            clock.advance(1)
            scheduler._set_meta("nextDue", str(clock.now()))
            self.assertEqual(scheduler.tick()[0]["reasonCode"], "SCHEDULER_CIRCUIT_OPEN")
            clock.advance(CIRCUIT_COOLDOWN_SECONDS)
            self.assertFalse(scheduler.readiness()["ready"], "queued deltas are not falsely ready")

    def test_recovering_running_job_abstains_and_keeps_material_delta(self):
        with tempfile.TemporaryDirectory(prefix="marketpilot-wi008-recover-") as directory:
            clock = DeterministicClock()
            with MaterialityScheduler(Path(directory) / "scheduler.sqlite", clock=clock) as scheduler:
                scheduler.ingest_delta("delta_material_001", material=True)
                # Simulate a process dying after the durable RUNNING mark.
                job_key = scheduler._job_key(0.0)
                scheduler._transaction("INSERT INTO scheduler_jobs(job_key,scheduled_at,state,lease_id,input_delta_ids_json,attempts) VALUES(?,?, 'RUNNING',?,?,1)", (job_key, 0.0, "lease_fixture", '["delta_material_001"]'))
                scheduler._transaction("INSERT INTO scheduler_leases(job_key,lease_id,acquired_at,expires_at,released_at) VALUES(?,?,?,?,NULL)", (job_key, "lease_fixture", 0.0, 30.0))
                scheduler._transaction("INSERT INTO scheduler_manager_leases(lease_key,job_key,lease_id,acquired_at,expires_at,released_at) VALUES(?,?,?,?,?,NULL)", (scheduler._manager_lease_key(), job_key, "lease_fixture", 0.0, 30.0))
                recovered = scheduler.recover()
                self.assertEqual(len(recovered["recoveredJobs"]), 1)
                self.assertFalse(scheduler.readiness()["ready"])
                self.assertEqual(scheduler.incident_rows()[0]["code"], "SCHEDULER_RECOVERY_ABSTAINED")
                self.assertEqual(scheduler.delta_rows()[0]["state"], "QUEUED")
                before_jobs = len(scheduler.job_rows())
                self.assertEqual(scheduler.tick()[0]["reasonCode"], "SCHEDULER_OPERATION_UNCERTAIN")
                self.assertEqual(len(scheduler.job_rows()), before_jobs)
                with self.assertRaises(SchedulerError):
                    scheduler.reconcile_uncertain()

    def test_recovery_releases_lease_atomically_and_reopen_blocks_until_reconciled(self):
        with tempfile.TemporaryDirectory(prefix="marketpilot-wi008-lease-recover-") as directory:
            database = Path(directory) / "scheduler.sqlite"
            clock = DeterministicClock()
            with MaterialityScheduler(database, clock=clock) as scheduler:
                scheduler.ingest_delta("delta_material_001", material=True)
                job_key = scheduler._job_key(0.0)
                scheduler._transaction("INSERT INTO scheduler_jobs(job_key,scheduled_at,state,lease_id,input_delta_ids_json,attempts) VALUES(?,?, 'RUNNING',?,?,1)", (job_key, 0.0, "lease_fixture", '["delta_material_001"]'))
                scheduler._transaction("INSERT INTO scheduler_leases(job_key,lease_id,acquired_at,expires_at,released_at) VALUES(?,?,?,?,NULL)", (job_key, "lease_fixture", 0.0, 30.0))
                scheduler._transaction("INSERT INTO scheduler_manager_leases(lease_key,job_key,lease_id,acquired_at,expires_at,released_at) VALUES(?,?,?,?,?,NULL)", (scheduler._manager_lease_key(), job_key, "lease_fixture", 0.0, 30.0))
            with MaterialityScheduler(database, clock=clock) as reopened:
                self.assertEqual(reopened.tick()[0]["reasonCode"], "SCHEDULER_RECONCILIATION_PENDING")
                recovered = reopened.recover()
                self.assertEqual(recovered["recoveredJobs"], [job_key])
                lease = reopened._connection.execute("SELECT released_at FROM scheduler_leases WHERE job_key=?", (job_key,)).fetchone()
                self.assertIsNotNone(lease["released_at"])
                self.assertFalse(reopened.readiness()["ready"])
                self.assertEqual(reopened.readiness()["reasonCode"], "SCHEDULER_OPERATION_UNCERTAIN")
                self.assertEqual(reopened.incident_rows()[0]["code"], "SCHEDULER_RECOVERY_ABSTAINED")

    def test_duplicate_delta_identity_conflict_is_typed(self):
        clock = DeterministicClock()
        with MaterialityScheduler(clock=clock) as scheduler:
            scheduler.ingest_delta("delta_material_001", material=True, payload={"fixture": "public-event-001"})
            with self.assertRaises(SchedulerError) as raised:
                scheduler.ingest_delta("delta_material_001", material=False, payload={"fixture": "public-event-001"})
            self.assertEqual(raised.exception.code, "DELTA_IDEMPOTENCY_CONFLICT")

    def test_delta_payload_is_closed_bounded_and_finite(self):
        with MaterialityScheduler(clock=DeterministicClock()) as scheduler:
            with self.assertRaises(SchedulerError) as extra:
                scheduler.ingest_delta("delta_extra", material=True, payload={"fixture": "public-event-001", "secret": "no"})
            self.assertEqual(extra.exception.code, "NON_PUBLIC_DELTA")
            with self.assertRaises(SchedulerError) as marker:
                scheduler.ingest_delta("delta_marker", material=True, payload={"fixture": True})
            self.assertEqual(marker.exception.code, "NON_PUBLIC_DELTA")
            with self.assertRaises(SchedulerError) as ordinal:
                scheduler.ingest_delta("delta_ordinal", material=True, payload={"fixture": "public-event-001", "ordinal": 1_000_000_001})
            self.assertEqual(ordinal.exception.code, "NON_PUBLIC_DELTA")

    def test_manager_lease_blocks_a_second_scheduler_connection(self):
        with tempfile.TemporaryDirectory(prefix="marketpilot-wi008-manager-lease-") as directory:
            database = Path(directory) / "scheduler.sqlite"
            clock = DeterministicClock()
            with MaterialityScheduler(database, clock=clock) as first, MaterialityScheduler(database, clock=clock) as second:
                first._transaction("INSERT INTO scheduler_jobs(job_key,scheduled_at,state) VALUES(?,?, 'QUEUED')", (first._job_key(0.0), 0.0))
                second._transaction("INSERT INTO scheduler_jobs(job_key,scheduled_at,state) VALUES(?,?, 'QUEUED')", (second._job_key(CADENCE_SECONDS), float(CADENCE_SECONDS)))
                self.assertTrue(first._acquire_lease(first._job_key(0.0)))
                self.assertFalse(second._acquire_lease(second._job_key(float(CADENCE_SECONDS))))
                first._release_lease(first._job_key(0.0))

    def test_stale_callback_cannot_resurrect_recovered_job(self):
        with tempfile.TemporaryDirectory(prefix="marketpilot-wi008-stale-") as directory:
            database = Path(directory) / "scheduler.sqlite"
            clock = DeterministicClock()
            second = MaterialityScheduler(database, clock=clock)
            try:
                def manager(deltas, job_key):
                    recovered = second.recover()
                    self.assertEqual(recovered["recoveredJobs"], [job_key])
                    return self._result("ACCEPTED", operation_id_for_deltas(deltas))

                with MaterialityScheduler.for_test(database, clock=clock, manager_callback=manager) as first:
                    first.ingest_delta("delta_material_001", material=True)
                    result = first.tick()[0]
                    self.assertEqual(result["reasonCode"], "STALE_MANAGER_OWNER")
                    self.assertEqual(first.job_rows()[0]["state"], "ABSTAINED")
                    self.assertEqual(first.delta_rows()[0]["state"], "QUEUED")
                    self.assertEqual(first.metrics().manager_turns, 0)
            finally:
                second.close()

    def test_orphan_lease_is_recovery_blocked_and_never_reported_ready(self):
        with tempfile.TemporaryDirectory(prefix="marketpilot-wi008-orphan-") as directory:
            database = Path(directory) / "scheduler.sqlite"
            with MaterialityScheduler(database, clock=DeterministicClock()) as scheduler:
                # Deliberately corrupt the fixture store to prove the startup
                # reconciliation guard still catches an orphan despite FK
                # enforcement on the normal scheduler path.
                scheduler._connection.execute("PRAGMA foreign_keys = OFF")
                scheduler._transaction("INSERT INTO scheduler_leases(job_key,lease_id,acquired_at,expires_at,released_at) VALUES(?,?,?,?,NULL)", ("orphan_job", "lease_orphan", 0.0, 30.0))
                scheduler._connection.execute("PRAGMA foreign_keys = ON")
            with MaterialityScheduler(database, clock=DeterministicClock()) as reopened:
                self.assertEqual(reopened.readiness()["reasonCode"], "SCHEDULER_RECOVERY_BLOCKED")

    def test_non_text_acceptance_json_halts_on_reopen(self):
        with tempfile.TemporaryDirectory(prefix="marketpilot-wi008-bad-json-") as directory:
            database = Path(directory) / "scheduler.sqlite"
            clock = DeterministicClock()

            def manager(deltas, job_key):
                return self._result("ACCEPTED", operation_id_for_deltas(deltas))

            with MaterialityScheduler.for_test(database, clock=clock, manager_callback=manager) as scheduler:
                scheduler.ingest_delta("delta_material_001", material=True)
                self.assertEqual(scheduler.tick()[0]["status"], "COMPLETED")
                scheduler._transaction(
                    "UPDATE scheduler_acceptances SET result_json=?",
                    (sqlite3.Binary(b"{}"),),
                )
            with MaterialityScheduler(database, clock=clock) as reopened:
                self.assertEqual(reopened.readiness()["reasonCode"], "SCHEDULER_RECOVERY_BLOCKED")

    def test_completed_input_set_tamper_halts_on_reopen(self):
        with tempfile.TemporaryDirectory(prefix="marketpilot-wi008-bad-input-") as directory:
            database = Path(directory) / "scheduler.sqlite"
            clock = DeterministicClock()

            def manager(deltas, job_key):
                return self._result("ACCEPTED", operation_id_for_deltas(deltas))

            with MaterialityScheduler.for_test(database, clock=clock, manager_callback=manager) as scheduler:
                scheduler.ingest_delta("delta_material_001", material=True)
                self.assertEqual(scheduler.tick()[0]["status"], "COMPLETED")
                scheduler._transaction("UPDATE scheduler_jobs SET input_delta_ids_json=NULL", ())
            with MaterialityScheduler(database, clock=clock) as reopened:
                self.assertEqual(reopened.readiness()["reasonCode"], "SCHEDULER_RECOVERY_BLOCKED")

    def test_resolved_uncertainty_metadata_tamper_halts_on_reopen(self):
        with tempfile.TemporaryDirectory(prefix="marketpilot-wi008-bad-resolution-") as directory:
            database = Path(directory) / "scheduler.sqlite"
            clock = DeterministicClock()

            def crash(_deltas, _job_key):
                raise KeyboardInterrupt()

            first = MaterialityScheduler.for_test(database, clock=clock, manager_callback=crash)
            first.ingest_delta("delta_material_001", material=True)
            with self.assertRaises(KeyboardInterrupt):
                first.tick()
            first.close()
            with MaterialityScheduler(database, clock=clock) as recovered:
                recovered.recover()
                operation_id = operation_id_for_deltas(("delta_material_001",))
                recovered.reconcile_uncertain(delta_ids=("delta_material_001",), operation_id=operation_id, confirm_idempotent=True)
                recovered._transaction("UPDATE scheduler_uncertain_deltas SET resolution_operation_id=NULL", ())
            with MaterialityScheduler(database, clock=clock) as reopened:
                self.assertEqual(reopened.readiness()["reasonCode"], "SCHEDULER_RECOVERY_BLOCKED")
                self.assertEqual(reopened.recover()["reasonCode"], "SCHEDULER_RECOVERY_BLOCKED")

    def test_crash_recovery_requires_explicit_idempotent_retry_and_reuses_operation_key(self):
        with tempfile.TemporaryDirectory(prefix="marketpilot-wi008-crash-retry-") as directory:
            database = Path(directory) / "scheduler.sqlite"
            clock = DeterministicClock()

            def crash(_deltas, _job_key):
                raise KeyboardInterrupt()

            first = MaterialityScheduler.for_test(database, clock=clock, manager_callback=crash)
            first.ingest_delta("delta_material_001", material=True)
            with self.assertRaises(KeyboardInterrupt):
                first.tick()
            first.close()

            calls = []

            def retry(deltas, _job_key):
                calls.append(deltas)
                return self._result("REJECTED", operation_id_for_deltas(deltas), 4)

            with MaterialityScheduler.for_test(database, clock=clock, manager_callback=retry) as reopened:
                recovered = reopened.recover()
                self.assertFalse(recovered["ready"])
                self.assertEqual(reopened.tick()[0]["reasonCode"], "SCHEDULER_OPERATION_UNCERTAIN")
                self.assertEqual(reopened.reconcile_uncertain(delta_ids=("delta_material_001",), operation_id=operation_id_for_deltas(("delta_material_001",)), confirm_idempotent=True)["resolvedDeltas"], 1)
                reopened.ingest_delta("delta_material_002", material=True)
                clock.advance(CADENCE_SECONDS)
                self.assertEqual(reopened.tick()[0]["status"], "COMPLETED")
                self.assertEqual(calls, [("delta_material_001",)])
                self.assertEqual(reopened.delta_rows()[1]["state"], "QUEUED")
                clock.advance(CADENCE_SECONDS)
                self.assertEqual(reopened.tick()[0]["status"], "COMPLETED")
                self.assertEqual(calls, [("delta_material_001",), ("delta_material_002",)])
                self.assertTrue(reopened.readiness()["ready"])
            with MaterialityScheduler.for_test(database, clock=clock, manager_callback=retry) as after_restart:
                self.assertTrue(after_restart.readiness()["ready"])


if __name__ == "__main__":
    unittest.main()
