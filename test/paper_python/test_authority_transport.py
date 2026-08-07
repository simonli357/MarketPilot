"""Byte-level process-envelope tests for the Python paper authority."""

from __future__ import annotations

import copy
import json
import sys
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "src"))

from marketpilot import paper_fixture_authority as authority  # noqa: E402
from marketpilot.paper_contract_schema import validate_instance  # noqa: E402
from marketpilot.paper_fixtures import accepted_request  # noqa: E402


_UNSET = object()
_ENVELOPE_KEYS = {
    "schemaVersion",
    "profile",
    "policyId",
    "messageType",
    "requestId",
    "status",
    "errorCode",
    "responseHash",
}


def _wire(value: Any) -> bytes:
    return authority.canonical_json_bytes(value) + b"\n"


class AuthorityTransportTests(unittest.TestCase):
    def assert_protocol_error(
        self,
        raw: bytes,
        error_code: str,
        *,
        request_id: object = _UNSET,
        exit_code: int = 2,
        message_type: str = "FIXTURE_AUTHORITY_PROTOCOL_ERROR",
    ) -> dict[str, Any]:
        observed_exit, envelope = authority._process(raw)
        self.assertEqual(observed_exit, exit_code)
        self.assertEqual(set(envelope), _ENVELOPE_KEYS)
        self.assertEqual(envelope["schemaVersion"], 1)
        self.assertEqual(envelope["profile"], authority.PROFILE)
        self.assertEqual(envelope["policyId"], authority.POLICY_ID)
        self.assertEqual(envelope["messageType"], message_type)
        self.assertEqual(envelope["status"], "ERROR")
        self.assertEqual(envelope["errorCode"], error_code)
        if request_id is not _UNSET:
            self.assertEqual(envelope["requestId"], request_id)
        self.assertEqual(
            envelope["responseHash"],
            authority.compute_hash(envelope, "response", "responseHash"),
        )
        validate_instance("ProtocolError", envelope)

        encoded = authority.canonical_json_bytes(envelope)
        independently_sorted = json.dumps(
            envelope,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
        self.assertEqual(encoded, independently_sorted)
        self.assertTrue(encoded.startswith(b'{"errorCode":'))
        for forbidden in (
            b"artifact",
            b"auditEvents",
            b"executionEvent",
            b"gateDecision",
            b"operationId",
            b"orderPlan",
            b"stack",
            b"traceback",
        ):
            self.assertNotIn(forbidden, encoded)
        return envelope

    def test_message_limit_is_inclusive_and_first_excess_byte_is_rejected(self) -> None:
        accepted = _wire(accepted_request())
        padding = authority.PROTOCOL_MAX_BYTES - len(accepted)
        self.assertGreater(padding, 0)
        exact = b"{" + (b" " * padding) + accepted[1:]
        self.assertEqual(len(exact), authority.PROTOCOL_MAX_BYTES)

        exit_code, response = authority._process(exact)
        self.assertEqual(exit_code, 0)
        self.assertEqual(response["requestId"], "req_fixture_mptest_v1")
        validate_instance("FixtureAuthorityResponse", response)

        self.assert_protocol_error(
            b"{" + (b" " * (padding + 1)) + accepted[1:],
            "INPUT_LIMIT_EXCEEDED",
            request_id=None,
        )

    def test_invalid_utf8_has_its_exact_protocol_code(self) -> None:
        self.assert_protocol_error(
            b'{"x":"\x80"}\n',
            "INPUT_ENCODING_INVALID",
            request_id=None,
        )

    def test_every_forbidden_framing_form_is_rejected_before_json(self) -> None:
        vectors = {
            "missing-lf": b"{}",
            "cr": b"{}\r\n",
            "nul": b'{"x":"\x00"}\n',
            "bom": b"\xef\xbb\xbf{}\n",
            "blank": b"\n",
            "trailing-space": b"{} \n",
            "bytes-after-line": b"{}\nX",
            "second-line": b"{}\n{}\n",
        }
        for label, raw in vectors.items():
            with self.subTest(label=label):
                self.assert_protocol_error(
                    raw,
                    "INPUT_FRAMING_INVALID",
                    request_id=None,
                )

    def test_malformed_duplicate_and_deep_json_are_typed(self) -> None:
        malformed = {
            "adjacent-values": b"{}{}\n",
            "trailing-comma": b'{"requestId":"req_fixture_mptest_v1",}\n',
            "non-finite": b'{"x":NaN}\n',
            "float": b'{"x":1.0}\n',
        }
        for label, raw in malformed.items():
            with self.subTest(label=label):
                self.assert_protocol_error(raw, "INPUT_JSON_INVALID")

        self.assert_protocol_error(
            b'{"requestId":"req_fixture_mptest_v1","x":{"a":1,"a":2}}\n',
            "INPUT_DUPLICATE_KEY",
        )
        deep = b'{"x":' + (b"[" * 20_000) + (b"]" * 20_000) + b"}\n"
        self.assert_protocol_error(deep, "INPUT_JSON_INVALID", request_id=None)

    def test_unsupported_profile_and_schema_are_distinct(self) -> None:
        profile = accepted_request()
        profile["profile"] = "marketpilot.paper-intent-fixture.v2"
        self.assert_protocol_error(
            _wire(profile),
            "PROFILE_UNSUPPORTED",
            request_id="req_fixture_mptest_v1",
        )

        schema = accepted_request()
        schema["schemaVersion"] = 2
        self.assert_protocol_error(
            _wire(schema),
            "SCHEMA_UNSUPPORTED",
            request_id="req_fixture_mptest_v1",
        )

    def test_schema_invalid_input_retains_only_a_safe_request_id(self) -> None:
        incomplete = {
            "schemaVersion": 1,
            "profile": authority.PROFILE,
            "requestId": "req_fixture_mptest_v1",
        }
        self.assert_protocol_error(
            _wire(incomplete),
            "INPUT_SCHEMA_INVALID",
            request_id="req_fixture_mptest_v1",
        )

        unsafe = copy.deepcopy(incomplete)
        unsafe["requestId"] = "unsafe/path"
        envelope = self.assert_protocol_error(
            _wire(unsafe),
            "INPUT_SCHEMA_INVALID",
            request_id=None,
        )
        self.assertNotIn(b"unsafe/path", authority.canonical_json_bytes(envelope))

    def test_schema_valid_but_hash_invalid_artifact_is_rejected(self) -> None:
        request = accepted_request()
        request["bundle"]["tradeIntent"]["intentHash"] = "0" * 64
        self.assert_protocol_error(
            _wire(request),
            "INPUT_ARTIFACT_HASH_INVALID",
            request_id="req_fixture_mptest_v1",
        )

    def test_internal_failure_is_a_redacted_canonical_exit_one_envelope(self) -> None:
        detail = "sensitive runtime detail /home/example/authority.py:99"
        with patch.object(
            authority, "evaluate_request", side_effect=RuntimeError(detail)
        ):
            envelope = self.assert_protocol_error(
                _wire(accepted_request()),
                "INTERNAL_ERROR",
                request_id="req_fixture_mptest_v1",
                exit_code=1,
                message_type="FIXTURE_AUTHORITY_INTERNAL_ERROR",
            )
        encoded = authority.canonical_json_bytes(envelope) + b"\n"
        self.assertNotIn(detail.encode("utf-8"), encoded)
        self.assertNotIn(b"RuntimeError", encoded)


if __name__ == "__main__":
    unittest.main()
