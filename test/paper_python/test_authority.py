"""Focused stdlib tests for the WI-005 Python authority."""

from __future__ import annotations

import copy
import json
import subprocess
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "src"))

from marketpilot.paper_fixture_authority import (  # noqa: E402
    InputContractError,
    canonical_json_bytes,
    compute_hash,
    evaluate_request,
    verify_response,
)
from marketpilot.paper_fixtures import accepted_request, rejected_quantity_request  # noqa: E402


class PaperAuthorityTests(unittest.TestCase):
    def test_accepted_fixture_has_plan_fill_and_verified_chain(self):
        request = accepted_request()
        response = evaluate_request(request)
        self.assertEqual(response["status"], "ACCEPTED")
        self.assertEqual(response["reasonCodes"], ["ACCEPTED"])
        self.assertIsNotNone(response["orderPlan"])
        self.assertIsNotNone(response["executionEvent"])
        self.assertEqual(len(response["auditEvents"]), 7)
        self.assertTrue(verify_response(response, request))

    def test_quantity_fixture_rejects_without_money_artifacts(self):
        request = rejected_quantity_request()
        response = evaluate_request(request)
        self.assertEqual(response["status"], "REJECTED")
        self.assertEqual(response["reasonCodes"], ["QUANTITY_LIMIT_EXCEEDED", "NOTIONAL_LIMIT_EXCEEDED"])
        self.assertIsNone(response["orderPlan"])
        self.assertIsNone(response["executionEvent"])
        self.assertEqual(len(response["auditEvents"]), 5)
        self.assertTrue(verify_response(response, request))

    def test_hash_tamper_is_input_error(self):
        request = accepted_request()
        request["bundle"]["tradeIntent"]["intentHash"] = "0" * 64
        with self.assertRaises(InputContractError) as raised:
            evaluate_request(request)
        self.assertEqual(raised.exception.code, "INPUT_ARTIFACT_HASH_INVALID")

    def test_response_tamper_fails_closed(self):
        request = accepted_request()
        response = evaluate_request(request)
        response["auditEvents"][1]["sequence"] = 99
        self.assertFalse(verify_response(response, request))

    def test_process_boundary_is_one_line_and_redacted(self):
        payload = canonical_json_bytes(accepted_request()) + b"\n"
        proc = subprocess.run(
            [sys.executable, "-m", "marketpilot.paper_fixture_authority"],
            input=payload,
            cwd=ROOT,
            env={"PYTHONPATH": str(ROOT / "src")},
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(proc.stderr, b"")
        self.assertEqual(proc.stdout.count(b"\n"), 1)
        self.assertEqual(json.loads(proc.stdout)["status"], "ACCEPTED")

    def test_duplicate_key_protocol_error(self):
        proc = subprocess.run(
            [sys.executable, "-m", "marketpilot.paper_fixture_authority"],
            input=b'{"schemaVersion":1,"schemaVersion":1}\n',
            cwd=ROOT,
            env={"PYTHONPATH": str(ROOT / "src")},
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        self.assertEqual(proc.returncode, 2)
        self.assertEqual(proc.stderr, b"")
        error = json.loads(proc.stdout)
        self.assertEqual(error["errorCode"], "INPUT_DUPLICATE_KEY")
        self.assertNotIn("operationId", error)

    def test_deep_json_is_a_redacted_protocol_error(self):
        payload = (b'{"x":' + b"[" * 20000 + b"]" * 20000 + b"}\n")
        proc = subprocess.run(
            [sys.executable, "-m", "marketpilot.paper_fixture_authority"],
            input=payload,
            cwd=ROOT,
            env={"PYTHONPATH": str(ROOT / "src")},
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        self.assertEqual(proc.returncode, 2)
        self.assertEqual(proc.stderr, b"")
        self.assertEqual(json.loads(proc.stdout)["errorCode"], "INPUT_JSON_INVALID")

    def test_decimal_lexical_forms_are_not_coerced(self):
        request = accepted_request()
        request["bundle"]["tradeIntent"]["proposal"]["quantity"] = "1e0"
        request["bundle"]["tradeIntent"]["intentHash"] = compute_hash(request["bundle"]["tradeIntent"], "trade-intent", "intentHash")
        with self.assertRaises(InputContractError) as raised:
            evaluate_request(request)
        self.assertEqual(raised.exception.code, "INPUT_SCHEMA_INVALID")

    def test_expired_intent_is_a_domain_rejection(self):
        request = accepted_request()
        intent = request["bundle"]["tradeIntent"]
        intent["expiresAt"] = "2026-08-03T14:29:59.999Z"
        intent["intentHash"] = compute_hash(intent, "trade-intent", "intentHash")
        critic = request["bundle"]["criticVerdict"]
        critic["intentHash"] = intent["intentHash"]
        critic["verdictHash"] = compute_hash(critic, "critic-verdict", "verdictHash")
        response = evaluate_request(request)
        self.assertEqual(response["status"], "REJECTED")
        self.assertIn("INTENT_STALE", response["reasonCodes"])
        self.assertIsNone(response["orderPlan"])

    def test_nonpublic_provenance_is_a_domain_rejection(self):
        request = accepted_request()
        research = request["bundle"]["researchEvent"]
        research["rightsClass"] = "LOCAL_RESTRICTED"
        for fact in research["facts"]:
            fact["rightsClass"] = "LOCAL_RESTRICTED"
        research["provenance"][0]["sourceClass"] = "LOCAL"
        research["eventHash"] = compute_hash(research, "research-event", "eventHash")
        intent = request["bundle"]["tradeIntent"]
        intent["evidenceRefs"][0]["eventHash"] = research["eventHash"]
        intent["intentHash"] = compute_hash(intent, "trade-intent", "intentHash")
        critic = request["bundle"]["criticVerdict"]
        critic["eventHash"] = research["eventHash"]
        critic["intentHash"] = intent["intentHash"]
        critic["verdictHash"] = compute_hash(critic, "critic-verdict", "verdictHash")
        response = evaluate_request(request)
        self.assertEqual(response["status"], "REJECTED")
        self.assertIn("RIGHTS_NOT_PUBLIC", response["reasonCodes"])

    def test_operation_linkage_is_not_authority_ambiguous(self):
        request = accepted_request()
        request["bundle"]["criticVerdict"]["operationId"] = "op_other_fixture_v1"
        request["bundle"]["criticVerdict"]["verdictHash"] = compute_hash(request["bundle"]["criticVerdict"], "critic-verdict", "verdictHash")
        response = evaluate_request(request)
        self.assertEqual(response["status"], "REJECTED")
        self.assertEqual(response["primaryReasonCode"], "CRITIC_INTENT_MISMATCH")

    def test_evidence_instrument_linkage_is_required(self):
        request = accepted_request()
        research = request["bundle"]["researchEvent"]
        research["instrumentId"] = "OTHER"
        research["eventHash"] = compute_hash(research, "research-event", "eventHash")
        request["bundle"]["tradeIntent"]["evidenceRefs"][0]["eventHash"] = research["eventHash"]
        request["bundle"]["tradeIntent"]["intentHash"] = compute_hash(request["bundle"]["tradeIntent"], "trade-intent", "intentHash")
        request["bundle"]["criticVerdict"]["eventHash"] = research["eventHash"]
        request["bundle"]["criticVerdict"]["intentHash"] = request["bundle"]["tradeIntent"]["intentHash"]
        request["bundle"]["criticVerdict"]["verdictHash"] = compute_hash(request["bundle"]["criticVerdict"], "critic-verdict", "verdictHash")
        response = evaluate_request(request)
        self.assertEqual(response["status"], "REJECTED")
        self.assertEqual(response["primaryReasonCode"], "INTENT_EVIDENCE_MISMATCH")

    def test_critic_evidence_fact_ids_must_resolve(self):
        request = accepted_request()
        critic = request["bundle"]["criticVerdict"]
        critic["evidenceFactIds"] = ["fact_unknown_fixture_v1"]
        critic["verdictHash"] = compute_hash(critic, "critic-verdict", "verdictHash")
        response = evaluate_request(request)
        self.assertEqual(response["status"], "REJECTED")
        self.assertEqual(response["primaryReasonCode"], "INTENT_EVIDENCE_MISMATCH")
        self.assertIsNone(response["orderPlan"])


if __name__ == "__main__":
    unittest.main()
