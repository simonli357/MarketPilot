#!/usr/bin/env python3
"""Deterministic hostile-process fixture for the Node authority adapter.

The adapter invokes this executable in place of Python.  Every behavior is
selected only by the already schema-valid requestId, so the parent always
crosses its normal request-validation boundary before the fake process acts.
"""

from __future__ import annotations

import hashlib
import json
import os
import signal
import sys
import time
from typing import Any


MAX_OUTPUT_BYTES = 131_072
REQUEST_PREFIX = "req_transport_"


def _canonical_json(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def _response_hash(envelope: dict[str, Any]) -> str:
    view = dict(envelope)
    view.pop("responseHash", None)
    domain = b"marketpilot.paper-intent-fixture.v1/response"
    return hashlib.sha256(domain + b"\0" + _canonical_json(view)).hexdigest()


def _protocol_error(request: dict[str, Any]) -> dict[str, Any]:
    envelope: dict[str, Any] = {
        "schemaVersion": 1,
        "profile": request["profile"],
        "policyId": request["policyId"],
        "messageType": "FIXTURE_AUTHORITY_PROTOCOL_ERROR",
        "requestId": request["requestId"],
        "status": "ERROR",
        "errorCode": "INPUT_SCHEMA_INVALID",
    }
    envelope["responseHash"] = _response_hash(envelope)
    return envelope


def _write_bounded_overflow(stream: Any) -> None:
    try:
        stream.buffer.write(b"x" * (MAX_OUTPUT_BYTES + 1))
        stream.buffer.flush()
    except BrokenPipeError:
        # The adapter is expected to kill the process as soon as the bound is
        # crossed.  A traceback would introduce an unrelated stderr outcome.
        pass


def main() -> int:
    request = json.loads(sys.stdin.buffer.read())
    request_id = request.get("requestId")
    if not isinstance(request_id, str) or not request_id.startswith(REQUEST_PREFIX):
        return 64
    scenario = request_id[len(REQUEST_PREFIX) :]

    if scenario == "timeout":
        time.sleep(10)
        return 0
    if scenario == "stdout_limit":
        _write_bounded_overflow(sys.stdout)
        return 0
    if scenario == "stderr_limit":
        _write_bounded_overflow(sys.stderr)
        return 0
    if scenario == "stderr":
        sys.stderr.write("untrusted child detail\n")
        sys.stderr.flush()
        return 0
    if scenario == "internal_exit":
        return 70
    if scenario == "signal":
        os.kill(os.getpid(), signal.SIGTERM)
        return 70
    if scenario == "malformed_json":
        sys.stdout.buffer.write(b'{"broken":}\n')
        return 0
    if scenario == "empty_output":
        return 0
    if scenario == "missing_lf":
        sys.stdout.buffer.write(b"{}")
        return 0
    if scenario == "extra_line":
        sys.stdout.buffer.write(b"{}\n{}\n")
        return 0

    envelope = _protocol_error(request)
    if scenario == "protocol_error":
        sys.stdout.buffer.write(_canonical_json(envelope) + b"\n")
        return 2
    if scenario == "forged_protocol":
        envelope["messageType"] = "FIXTURE_AUTHORITY_INTERNAL_ERROR"
        envelope["errorCode"] = "INTERNAL_ERROR"
        envelope["responseHash"] = _response_hash(envelope)
        sys.stdout.buffer.write(_canonical_json(envelope) + b"\n")
        return 2
    if scenario == "forged_hash":
        envelope["responseHash"] = "0" * 64
        sys.stdout.buffer.write(_canonical_json(envelope) + b"\n")
        return 2
    return 64


if __name__ == "__main__":
    raise SystemExit(main())
