"""WI-007 deterministic matrix, durable recovery, and benchmark tests."""

from __future__ import annotations

import copy
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "src"))

from marketpilot.paper_fixture_recovery import (  # noqa: E402
    SCENARIO_NAMES,
    benchmark_gate,
    run_matrix,
    run_recovery_boundaries,
)
from marketpilot.paper_fixture_store import (  # noqa: E402
    CRASH_BOUNDARIES,
    CrashInjected,
    FixtureAuthorityStore,
    IdempotencyConflict,
    NonPublicFixture,
    RecoveryBlocked,
)
from marketpilot.paper_fixtures import accepted_request  # noqa: E402


class RecoveryTests(unittest.TestCase):
    def test_exactly_thirty_named_cases_are_executed(self):
        self.assertEqual(len(SCENARIO_NAMES), 30)
        self.assertEqual(len(set(SCENARIO_NAMES)), 30)
        report = run_matrix()
        self.assertEqual(report["scenarioCount"], 30)
        self.assertTrue(report["allNamed"])
        self.assertTrue(report["noUnexpectedExposure"])
        self.assertEqual({item["name"] for item in report["results"]}, set(SCENARIO_NAMES))

    def test_every_durable_boundary_recovers_after_reopen(self):
        report = run_recovery_boundaries()
        self.assertEqual(report["boundaryCount"], len(CRASH_BOUNDARIES))
        self.assertTrue(report["allRecovered"])
        self.assertTrue(all(item["duplicateAuditCount"] == 0 for item in report["checks"]))

    def test_duplicate_job_is_byte_stable_and_conflict_fails_closed(self):
        with FixtureAuthorityStore() as store:
            request = accepted_request()
            first = store.process(request)
            second = store.process(copy.deepcopy(request))
            self.assertEqual(first, second)
            self.assertEqual(len(store.audit_events(request["operationId"])), 7)
            changed = copy.deepcopy(request)
            changed["decisionAt"] = "2026-08-03T14:30:01.000Z"
            # The changed request is valid enough to produce a distinct
            # authority identity but cannot reuse the original operation key.
            with self.assertRaises(IdempotencyConflict):
                store.process(changed)

    def test_non_public_data_is_rejected_before_any_row_is_written(self):
        with tempfile.TemporaryDirectory(prefix="marketpilot-wi007-public-") as directory:
            path = Path(directory) / "fixture.sqlite"
            request = accepted_request()
            request["bundle"]["researchEvent"]["rightsClass"] = "LOCAL_RESTRICTED"
            with self.assertRaises(NonPublicFixture):
                with FixtureAuthorityStore(path) as store:
                    store.process(request)
            connection = sqlite3.connect(path)
            try:
                self.assertEqual(connection.execute("SELECT COUNT(*) FROM operations").fetchone()[0], 0)
            finally:
                connection.close()

    def test_tampered_audit_blocks_readiness_instead_of_repairing(self):
        with tempfile.TemporaryDirectory(prefix="marketpilot-wi007-tamper-") as directory:
            path = Path(directory) / "fixture.sqlite"
            request = accepted_request()
            with FixtureAuthorityStore(path) as store:
                response = store.process(request)
                self.assertTrue(store.verify_operation(response["operationId"]))
            connection = sqlite3.connect(path)
            try:
                connection.execute("UPDATE audit_events SET event_json = ? WHERE operation_id = ? AND sequence = 1", ('{"forged":true}', request["operationId"]))
                connection.commit()
            finally:
                connection.close()
            with FixtureAuthorityStore(path) as reopened:
                self.assertFalse(reopened.verify_operation(request["operationId"]))
                self.assertFalse(reopened.readiness()["ready"])

    def test_tampered_audit_hash_column_and_pending_gap_fail_closed(self):
        with tempfile.TemporaryDirectory(prefix="marketpilot-wi007-integrity-") as directory:
            path = Path(directory) / "fixture.sqlite"
            request = accepted_request()
            with FixtureAuthorityStore(path) as store:
                response = store.process(request)
                self.assertTrue(store.verify_operation(response["operationId"]))
            connection = sqlite3.connect(path)
            try:
                connection.execute("UPDATE audit_events SET event_hash = ? WHERE operation_id = ? AND sequence = 1", ("0" * 64, request["operationId"]))
                connection.commit()
            finally:
                connection.close()
            with FixtureAuthorityStore(path) as reopened:
                self.assertFalse(reopened.verify_operation(request["operationId"]))
                self.assertEqual(reopened.readiness()["reasonCode"], "RECOVERY_BLOCKED")

        with tempfile.TemporaryDirectory(prefix="marketpilot-wi007-gap-") as directory:
            path = Path(directory) / "fixture.sqlite"
            with FixtureAuthorityStore(path) as store:
                with self.assertRaises(CrashInjected):
                    store.process(accepted_request(), crash_at="after_gate_commit")
            connection = sqlite3.connect(path)
            try:
                connection.execute("DELETE FROM audit_events WHERE operation_id = ? AND sequence = 2", (accepted_request()["operationId"],))
                connection.commit()
            finally:
                connection.close()
            with FixtureAuthorityStore(path) as reopened:
                with self.assertRaises(RecoveryBlocked):
                    reopened.recover(accepted_request()["operationId"])
                self.assertFalse(reopened.readiness()["ready"])

    def test_live_candidate_is_rejected_before_persistence(self):
        with FixtureAuthorityStore() as store:
            request = accepted_request()
            request["bundle"]["candidateManifest"]["mode"] = "LIVE"
            request["bundle"]["candidateManifest"]["liveEligible"] = True
            with self.assertRaises(NonPublicFixture):
                store.process(request)
            self.assertIsNone(store.get_operation(request["operationId"]))

    def test_benchmark_is_exactly_one_thousand_and_under_budget(self):
        report = benchmark_gate()
        self.assertEqual(report["fixtureCount"], 1000)
        self.assertEqual(report["distribution"], {"ACCEPTED": 800, "REJECTED": 200, "ERROR": 0})
        self.assertLess(report["p95Ms"], 250.0)


if __name__ == "__main__":
    unittest.main()
