"""The WI-005 fixture-only Python authority.

This module has no product-state or network access.  The committed executable
JSON Schema registry owns structural and lexical validation; this module owns
the planning-approved cross-artifact, hashing, policy, Decimal, simulation, and
audit semantics for ``marketpilot.paper-intent-fixture.v1``.  JSON is accepted
at the process boundary only after framing and duplicate-key checks.

The public functions are useful to the Node adapter and to focused contract
tests:

``canonical_json_bytes(value)``
    RFC-8785-compatible canonical bytes for this profile's JSON values.
``compute_hash(value, domain_suffix, own_hash_field=None)``
    The profile's domain-separated SHA-256 digest.
``evaluate_request(request)``
    Return an accepted/rejected authority response, or raise
    :class:`InputContractError` for a protocol/input contract failure.

Run ``python -m marketpilot.paper_fixture_authority`` for the one-request,
one-response JSONL process boundary described by BLK-agent-runtime.
"""

from __future__ import annotations

import datetime as _dt
import hashlib
import json
import re
import sys
from collections.abc import Mapping
from decimal import Decimal, InvalidOperation, ROUND_DOWN, ROUND_HALF_EVEN, localcontext
from typing import Any

from .paper_contract_schema import PaperSchemaValidationError, validate_instance


PROFILE = "marketpilot.paper-intent-fixture.v1"
POLICY_ID = "FIXTURE_LONG_US_EQUITY_100_V1"
PROTOCOL_MAX_BYTES = 131_072
_DOMAIN_PREFIX = PROFILE + "/"

_ID_RE = re.compile(r"^[a-z][a-z0-9_]{2,63}$")

_DOMAIN_CODES = (
    "INTENT_CANDIDATE_MISMATCH",
    "INTENT_EVIDENCE_MISMATCH",
    "CRITIC_INTENT_MISMATCH",
    "CRITIC_CANDIDATE_MISMATCH",
    "CRITIC_NOT_DISTINCT",
    "TIME_ORDER_INVALID",
    "CANDIDATE_INACTIVE",
    "RIGHTS_NOT_PUBLIC",
    "EVIDENCE_STALE",
    "INTENT_STALE",
    "CRITIC_STALE",
    "INTENT_ABSTAINED",
    "CRITIC_MISSING",
    "CRITIC_REJECTED",
    "CRITIC_ABSTAINED",
    "FIXTURE_POLICY_MISMATCH",
    "CANDIDATE_NOT_PAPER",
    "CANDIDATE_LIVE_ELIGIBLE",
    "INSTRUMENT_NOT_ALLOWED",
    "CURRENCY_NOT_USD",
    "ACTION_NOT_ALLOWED",
    "SIDE_NOT_ALLOWED",
    "SESSION_NOT_REGULAR",
    "QUANTITY_LIMIT_EXCEEDED",
    "NOTIONAL_LIMIT_EXCEEDED",
    "PRICE_NOT_MARKETABLE",
)

_PROTOCOL_CODES = {
    "INPUT_LIMIT_EXCEEDED",
    "INPUT_ENCODING_INVALID",
    "INPUT_FRAMING_INVALID",
    "INPUT_JSON_INVALID",
    "INPUT_DUPLICATE_KEY",
    "PROFILE_UNSUPPORTED",
    "SCHEMA_UNSUPPORTED",
    "INPUT_SCHEMA_INVALID",
    "INPUT_ARTIFACT_HASH_INVALID",
}

_POLICY = {
    "allowedAction": "OPEN_LONG",
    "side": "BUY",
    "session": "REGULAR",
    "maxQuantity": "1.000000",
    "maxGrossNotionalUsd": "100.00",
    "buyCollarRatio": "0.005000",
}

_ARTIFACT_HASH_FIELDS = {
    "ResearchEvent": "eventHash",
    "CandidateManifest": "candidateHash",
    "TradeIntent": "intentHash",
    "CriticVerdict": "verdictHash",
}


class InputContractError(ValueError):
    """A malformed or cryptographically invalid fixture request."""

    def __init__(self, code: str, message: str = "input contract rejected") -> None:
        if code not in _PROTOCOL_CODES:
            raise ValueError(f"unknown input code: {code}")
        super().__init__(message)
        self.code = code


class _DuplicateKey(ValueError):
    pass


_MAX_SAFE_JSON_INTEGER = 9_007_199_254_740_991


def _json_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise _DuplicateKey(key)
        result[key] = value
    return result


def _json_constant(value: str) -> Any:
    raise ValueError(f"non-finite JSON constant: {value}")


def _json_integer(value: str) -> int:
    parsed = int(value)
    if abs(parsed) > _MAX_SAFE_JSON_INTEGER:
        raise ValueError("integer outside the shared JSON safe range")
    return parsed


def _json_loads_strict(raw: bytes) -> Any:
    try:
        text = raw.decode("utf-8", errors="strict")
    except UnicodeDecodeError as exc:
        raise InputContractError("INPUT_ENCODING_INVALID") from exc
    if text.startswith("\ufeff") or "\x00" in text:
        raise InputContractError("INPUT_FRAMING_INVALID")
    try:
        return json.loads(
            text,
            object_pairs_hook=_json_pairs,
            parse_constant=_json_constant,
            parse_float=lambda _: (_ for _ in ()).throw(ValueError("float")),
            parse_int=_json_integer,
        )
    except _DuplicateKey as exc:
        raise InputContractError("INPUT_DUPLICATE_KEY") from exc
    except (TypeError, ValueError, json.JSONDecodeError) as exc:
        raise InputContractError("INPUT_JSON_INVALID") from exc


def _escape_string(value: str) -> str:
    # ensure_ascii=False is required by JCS.  Python emits the same short
    # escapes as JSON.stringify for control characters; all contract text is
    # NFC and control-free, so this path is intentionally narrow.
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def canonical_json_bytes(value: Any) -> bytes:
    """Return canonical JSON bytes for the profile's JSON subset.

    The profile only permits integer JSON numbers for ``schemaVersion`` and
    ``sequence``.  Rejecting all floats here prevents accidental financial
    number coercion and keeps the JCS implementation deterministic.
    """

    def encode(item: Any) -> str:
        if item is None:
            return "null"
        if item is True:
            return "true"
        if item is False:
            return "false"
        if type(item) is int:
            if abs(item) > _MAX_SAFE_JSON_INTEGER:
                raise ValueError("integer outside the shared JSON safe range")
            return str(item)
        if type(item) is float:
            raise ValueError("binary float is not part of the fixture contract")
        if isinstance(item, str):
            return _escape_string(item)
        if isinstance(item, list):
            return "[" + ",".join(encode(part) for part in item) + "]"
        if isinstance(item, dict):
            # Contract keys are ASCII, so Python's code-point order is the
            # same ordering as the UTF-16 ordering used by RFC 8785 here.
            parts = []
            for key in sorted(item):
                if not isinstance(key, str):
                    raise ValueError("JSON object key must be a string")
                parts.append(_escape_string(key) + ":" + encode(item[key]))
            return "{" + ",".join(parts) + "}"
        raise ValueError(f"unsupported JSON value: {type(item).__name__}")

    return encode(value).encode("utf-8")


def compute_hash(
    value: Mapping[str, Any], domain_suffix: str, own_hash_field: str | None = None
) -> str:
    """Compute the profile's lower-case domain-separated SHA-256 hash."""

    view = dict(value)
    if own_hash_field is not None:
        view.pop(own_hash_field, None)
    domain = (_DOMAIN_PREFIX + domain_suffix).encode("ascii")
    return hashlib.sha256(domain + b"\0" + canonical_json_bytes(view)).hexdigest()


def _deterministic_id(
    prefix: str, operation_id: str, artifact_type: str, sequence: int | None = None
) -> str:
    raw = (
        PROFILE.encode("ascii")
        + b"\0"
        + operation_id.encode("ascii")
        + b"\0"
        + artifact_type.encode("ascii")
    )
    if sequence is not None:
        raw += b"\0" + str(sequence).encode("ascii")
    return prefix + hashlib.sha256(raw).hexdigest()[:32]


def _moment(value: str) -> _dt.datetime:
    """Parse a timestamp already accepted by the executable schema."""

    try:
        return _dt.datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ").replace(
            tzinfo=_dt.UTC
        )
    except (TypeError, ValueError) as exc:
        raise RuntimeError("schema-validated timestamp could not be parsed") from exc


def _contract_decimal(value: str) -> Decimal:
    """Parse a fixed-scale string already accepted by the executable schema."""

    try:
        with localcontext() as context:
            context.prec = 38
            parsed = Decimal(value)
    except (InvalidOperation, TypeError, ValueError) as exc:
        raise RuntimeError("schema-validated decimal could not be parsed") from exc
    if not parsed.is_finite():
        raise RuntimeError("schema-validated decimal was not finite")
    return parsed


def _frozen_buy_collar(reference_value: str) -> tuple[Decimal, Decimal]:
    reference = _contract_decimal(reference_value)
    ratio = _contract_decimal(_POLICY["buyCollarRatio"])
    with localcontext() as context:
        context.prec = 38
        unrounded = reference * (Decimal(1) + ratio)
        rounded = unrounded.quantize(Decimal("0.0001"), rounding=ROUND_DOWN)
    return unrounded, rounded


def _validate_request(
    request: Any,
) -> tuple[
    dict[str, Any],
    dict[str, Any],
    dict[str, Any],
    dict[str, Any],
    dict[str, Any] | None,
]:
    """Execute the request schema, then verify only cryptographic integrity."""

    if type(request) is dict:
        if "schemaVersion" in request and (
            type(request["schemaVersion"]) is not int or request["schemaVersion"] != 1
        ):
            raise InputContractError("SCHEMA_UNSUPPORTED")
        if "profile" in request and request["profile"] != PROFILE:
            raise InputContractError("PROFILE_UNSUPPORTED")
    try:
        validate_instance("FixtureAuthorityRequest", request)
    except PaperSchemaValidationError as exc:
        raise InputContractError("INPUT_SCHEMA_INVALID") from exc

    outer = request
    bundle = outer["bundle"]
    research = bundle["researchEvent"]
    candidate = bundle["candidateManifest"]
    intent = bundle["tradeIntent"]
    critic = bundle["criticVerdict"]
    for name, artifact in (
        ("ResearchEvent", research),
        ("CandidateManifest", candidate),
        ("TradeIntent", intent),
    ):
        field = _ARTIFACT_HASH_FIELDS[name]
        if artifact[field] != compute_hash(artifact, name_to_domain(name), field):
            raise InputContractError("INPUT_ARTIFACT_HASH_INVALID")
    if critic is not None and critic["verdictHash"] != compute_hash(
        critic, "critic-verdict", "verdictHash"
    ):
        raise InputContractError("INPUT_ARTIFACT_HASH_INVALID")
    return outer, research, candidate, intent, critic


def name_to_domain(name: str) -> str:
    return {
        "ResearchEvent": "research-event",
        "CandidateManifest": "candidate",
        "TradeIntent": "trade-intent",
        "CriticVerdict": "critic-verdict",
    }[name]


def _facts(research: Mapping[str, Any]) -> dict[str, Mapping[str, Any]]:
    return {item["kind"]: item for item in research["facts"]}


def _domain_reasons(
    request: Mapping[str, Any],
    research: Mapping[str, Any],
    candidate: Mapping[str, Any],
    intent: Mapping[str, Any],
    critic: Mapping[str, Any] | None,
) -> list[str]:
    decision = _moment(request["decisionAt"])
    reasons: list[str] = []
    proposal = intent["proposal"]
    # Linkage and identity are intentionally kept separate from policy checks.
    if (
        intent["candidateId"] != candidate["candidateId"]
        or intent["candidateHash"] != candidate["candidateHash"]
        or intent["operationId"] != request["operationId"]
    ):
        reasons.append("INTENT_CANDIDATE_MISMATCH")
    facts = _facts(research)
    evidence_refs = intent["evidenceRefs"]
    research_fact_ids = {item["factId"] for item in research["facts"]}
    evidence_mismatch = (
        research["instrumentId"] != candidate["instrumentId"]
        or research["assetClass"] != candidate["assetClass"]
        or research["currency"] != candidate["currency"]
        or (
            proposal is not None
            and (
                research["instrumentId"] != proposal["instrumentId"]
                or research["assetClass"] != proposal["assetClass"]
                or research["currency"] != proposal["currency"]
            )
        )
    )
    if intent["disposition"] == "PROPOSE":
        evidence_mismatch = evidence_mismatch or (
            len(evidence_refs) != 1
            or evidence_refs[0]["eventId"] != research["eventId"]
            or evidence_refs[0]["eventHash"] != research["eventHash"]
            or set(evidence_refs[0]["factIds"]) != research_fact_ids
        )
    elif evidence_refs:
        evidence_mismatch = evidence_mismatch or (
            len(evidence_refs) != 1
            or evidence_refs[0]["eventId"] != research["eventId"]
            or evidence_refs[0]["eventHash"] != research["eventHash"]
            or not set(evidence_refs[0]["factIds"]).issubset(research_fact_ids)
        )
    if evidence_mismatch:
        reasons.append("INTENT_EVIDENCE_MISMATCH")
    if critic is not None:
        if (
            critic["intentId"] != intent["intentId"]
            or critic["intentHash"] != intent["intentHash"]
            or critic["operationId"] != intent["operationId"]
        ):
            reasons.append("CRITIC_INTENT_MISMATCH")
        if (
            critic["candidateId"] != candidate["candidateId"]
            or critic["candidateHash"] != candidate["candidateHash"]
        ):
            reasons.append("CRITIC_CANDIDATE_MISMATCH")
        if (
            critic["eventId"] != research["eventId"]
            or critic["eventHash"] != research["eventHash"]
        ):
            reasons.append("INTENT_EVIDENCE_MISMATCH")
        if not set(critic["evidenceFactIds"]).issubset(
            {item["factId"] for item in research["facts"]}
        ):
            reasons.append("INTENT_EVIDENCE_MISMATCH")
        if critic["producer"]["runId"] == intent["producer"]["runId"]:
            reasons.append("CRITIC_NOT_DISTINCT")
    moments = [
        _moment(candidate["createdAt"]),
        _moment(research["publishedAt"]),
        _moment(research["observedAt"]),
        _moment(intent["createdAt"]),
    ]
    if critic is not None:
        moments.append(_moment(critic["createdAt"]))
    moments.append(decision)
    if moments != sorted(moments):
        reasons.append("TIME_ORDER_INVALID")
    if not (
        _moment(candidate["validFrom"]) <= decision <= _moment(candidate["validUntil"])
    ):
        reasons.append("CANDIDATE_INACTIVE")
    source_rights = {
        "PUBLIC_OFFICIAL": "PUBLIC_OFFICIAL",
        "LICENSED_VENDOR": "LICENSED_MODEL_OK",
        "LOCAL": "LOCAL_RESTRICTED",
    }
    provenance_ids = {item["provenanceId"] for item in research["provenance"]}
    referenced_provenance_ids = {item["provenanceId"] for item in research["facts"]}
    provenance_complete = referenced_provenance_ids == provenance_ids
    rights_values = [research["rightsClass"]] + [
        item["rightsClass"] for item in research["facts"]
    ]
    rights_values.extend(
        source_rights[item["sourceClass"]] for item in research["provenance"]
    )
    strictest_right = max(
        rights_values,
        key=("PUBLIC_OFFICIAL", "LICENSED_MODEL_OK", "LOCAL_RESTRICTED").index,
    )
    if (
        not provenance_complete
        or strictest_right != research["rightsClass"]
        or strictest_right != "PUBLIC_OFFICIAL"
    ):
        reasons.append("RIGHTS_NOT_PUBLIC")
    if (decision - _moment(research["observedAt"])).total_seconds() > 180:
        reasons.append("EVIDENCE_STALE")
    if (
        decision - _moment(intent["createdAt"])
    ).total_seconds() > 60 or decision > _moment(intent["expiresAt"]):
        reasons.append("INTENT_STALE")
    if critic is not None and (
        (decision - _moment(critic["createdAt"])).total_seconds() > 30
        or decision > _moment(critic["expiresAt"])
    ):
        reasons.append("CRITIC_STALE")
    if intent["disposition"] == "ABSTAIN":
        reasons.append("INTENT_ABSTAINED")
    if critic is None:
        reasons.append("CRITIC_MISSING")
    elif critic["verdict"] == "REJECT":
        reasons.append("CRITIC_REJECTED")
    elif critic["verdict"] == "ABSTAIN":
        reasons.append("CRITIC_ABSTAINED")
    expected_policy = {"policyId": POLICY_ID, **_POLICY}
    if candidate["policy"] != expected_policy:
        reasons.append("FIXTURE_POLICY_MISMATCH")
    if candidate["mode"] != "PAPER":
        reasons.append("CANDIDATE_NOT_PAPER")
    if candidate["liveEligible"]:
        reasons.append("CANDIDATE_LIVE_ELIGIBLE")
    if candidate["instrumentId"] != "MPTEST" or (
        proposal is not None and proposal["instrumentId"] != "MPTEST"
    ):
        reasons.append("INSTRUMENT_NOT_ALLOWED")
    if candidate["currency"] != "USD" or (
        proposal is not None and proposal["currency"] != "USD"
    ):
        reasons.append("CURRENCY_NOT_USD")
    if candidate["assetClass"] != "US_PRIMARY_LISTED_COMMON_STOCK" or (
        proposal is not None
        and proposal["assetClass"] != "US_PRIMARY_LISTED_COMMON_STOCK"
    ):
        reasons.append("INSTRUMENT_NOT_ALLOWED")
    if proposal is not None and proposal["action"] != "OPEN_LONG":
        reasons.append("ACTION_NOT_ALLOWED")
    if proposal is not None and proposal["side"] != "BUY":
        reasons.append("SIDE_NOT_ALLOWED")
    if proposal is not None and proposal["session"] != "REGULAR":
        reasons.append("SESSION_NOT_REGULAR")
    if proposal is not None:
        quantity = _contract_decimal(proposal["quantity"])
        maximum_quantity = _contract_decimal(_POLICY["maxQuantity"])
        if quantity > maximum_quantity:
            reasons.append("QUANTITY_LIMIT_EXCEEDED")
        collar_unrounded, collar = _frozen_buy_collar(
            facts["REFERENCE_PRICE_USD"]["value"]
        )
        with localcontext() as context:
            context.prec = 38
            notional_limit = _contract_decimal(_POLICY["maxGrossNotionalUsd"])
            if quantity * collar_unrounded > notional_limit:
                reasons.append("NOTIONAL_LIMIT_EXCEEDED")
            maximum_entry = _contract_decimal(proposal["maximumEntryPrice"])
            limit = min(collar, maximum_entry)
            ask = _contract_decimal(facts["ASK_PRICE_USD"]["value"])
            if ask > limit:
                reasons.append("PRICE_NOT_MARKETABLE")
    return [code for code in _DOMAIN_CODES if code in reasons]


def _artifact_with_hash(
    artifact: dict[str, Any], field: str, domain: str
) -> dict[str, Any]:
    artifact[field] = compute_hash(artifact, domain, field)
    return artifact


def _base_artifact(
    artifact_type: str,
    operation_id: str,
    prefix: str,
    field: str,
    domain: str,
    **fields: Any,
) -> dict[str, Any]:
    artifact: dict[str, Any] = {
        "schemaVersion": 1,
        "profile": PROFILE,
        "artifactType": artifact_type,
    }
    artifact[field.replace("Hash", "Id")] = _deterministic_id(
        prefix, operation_id, artifact_type
    )
    artifact.update(fields)
    return _artifact_with_hash(artifact, field, domain)


def _audit_events(
    request: Mapping[str, Any],
    research: Mapping[str, Any],
    candidate: Mapping[str, Any],
    intent: Mapping[str, Any],
    critic: Mapping[str, Any] | None,
    gate: Mapping[str, Any],
    plan: Mapping[str, Any] | None,
    execution: Mapping[str, Any] | None,
    request_hash: str,
) -> list[dict[str, Any]]:
    subjects: list[tuple[str, str, str, str]] = [
        (
            "INPUT_RESEARCH_RECORDED",
            "ResearchEvent",
            research["eventId"],
            research["eventHash"],
        ),
        (
            "INPUT_CANDIDATE_RECORDED",
            "CandidateManifest",
            candidate["candidateId"],
            candidate["candidateHash"],
        ),
        (
            "INPUT_INTENT_RECORDED",
            "TradeIntent",
            intent["intentId"],
            intent["intentHash"],
        ),
    ]
    if critic is not None:
        subjects.append(
            (
                "INPUT_CRITIC_RECORDED",
                "CriticVerdict",
                critic["verdictId"],
                critic["verdictHash"],
            )
        )
    subjects.append(
        ("GATE_DECIDED", "GateDecision", gate["decisionId"], gate["decisionHash"])
    )
    if plan is not None and execution is not None:
        subjects.extend(
            [
                ("ORDER_PLANNED", "OrderPlan", plan["planId"], plan["planHash"]),
                (
                    "EXECUTION_SIMULATED",
                    "ExecutionEvent",
                    execution["executionId"],
                    execution["executionHash"],
                ),
            ]
        )
    previous = hashlib.sha256(
        (PROFILE + "/audit-genesis").encode("ascii")
        + b"\0"
        + request_hash.encode("ascii")
    ).hexdigest()
    events: list[dict[str, Any]] = []
    for sequence, (event_type, subject_type, subject_id, subject_hash) in enumerate(
        subjects, 1
    ):
        event: dict[str, Any] = {
            "schemaVersion": 1,
            "profile": PROFILE,
            "policyId": POLICY_ID,
            "artifactType": "AuditEvent",
            "auditId": _deterministic_id(
                "audit_", request["operationId"], "AuditEvent", sequence
            ),
            "auditEventId": _deterministic_id(
                "ae_", request["operationId"], "AuditEvent", sequence
            ),
            "sequence": sequence,
            "occurredAt": request["decisionAt"],
            "eventType": event_type,
            "subjectType": subject_type,
            "subjectId": subject_id,
            "subjectHash": subject_hash,
            "previousEventHash": previous,
        }
        event["eventHash"] = compute_hash(event, "audit-event", "eventHash")
        events.append(event)
        previous = event["eventHash"]
    return events


def _build_response(
    request: Mapping[str, Any],
    research: Mapping[str, Any],
    candidate: Mapping[str, Any],
    intent: Mapping[str, Any],
    critic: Mapping[str, Any] | None,
    request_hash: str,
    reason_codes: list[str],
) -> dict[str, Any]:
    decision_at = request["decisionAt"]
    decision = "ACCEPT" if not reason_codes else "REJECT"
    gate: dict[str, Any] = {
        "schemaVersion": 1,
        "profile": PROFILE,
        "policyId": POLICY_ID,
        "artifactType": "GateDecision",
        "decisionId": _deterministic_id("gd_", request["operationId"], "GateDecision"),
        "producer": {
            "kind": "PYTHON_AUTHORITY",
            "runId": _deterministic_id(
                "run_", request["operationId"], "PYTHON_AUTHORITY"
            ),
        },
        "operationId": request["operationId"],
        "requestHash": request_hash,
        "decidedAt": decision_at,
        "decision": decision,
        "primaryReasonCode": "ACCEPTED" if decision == "ACCEPT" else reason_codes[0],
        "reasonCodes": ["ACCEPTED"] if decision == "ACCEPT" else reason_codes,
        "inputRefs": {
            "eventId": research["eventId"],
            "eventHash": research["eventHash"],
            "candidateId": candidate["candidateId"],
            "candidateHash": candidate["candidateHash"],
            "intentId": intent["intentId"],
            "intentHash": intent["intentHash"],
            "verdictId": None if critic is None else critic["verdictId"],
            "verdictHash": None if critic is None else critic["verdictHash"],
        },
    }
    gate["decisionHash"] = compute_hash(gate, "gate-decision", "decisionHash")
    plan = None
    execution = None
    if decision == "ACCEPT":
        facts = _facts(research)
        proposal = intent["proposal"]
        ask = _contract_decimal(facts["ASK_PRICE_USD"]["value"])
        _, collar = _frozen_buy_collar(facts["REFERENCE_PRICE_USD"]["value"])
        with localcontext() as context:
            context.prec = 38
            limit = min(collar, _contract_decimal(proposal["maximumEntryPrice"]))
            quantity = _contract_decimal(proposal["quantity"])
            fill_notional = (quantity * ask).quantize(
                Decimal("0.01"), rounding=ROUND_HALF_EVEN
            )
        plan = {
            "schemaVersion": 1,
            "profile": PROFILE,
            "policyId": POLICY_ID,
            "artifactType": "OrderPlan",
            "planId": _deterministic_id("plan_", request["operationId"], "OrderPlan"),
            "producer": {
                "kind": "PYTHON_AUTHORITY",
                "runId": gate["producer"]["runId"],
            },
            "operationId": request["operationId"],
            "decisionId": gate["decisionId"],
            "decisionHash": gate["decisionHash"],
            "candidateId": candidate["candidateId"],
            "candidateHash": candidate["candidateHash"],
            "intentId": intent["intentId"],
            "intentHash": intent["intentHash"],
            "createdAt": decision_at,
            "instrumentId": proposal["instrumentId"],
            "assetClass": proposal["assetClass"],
            "currency": proposal["currency"],
            "side": "BUY",
            "quantity": proposal["quantity"],
            "orderType": "LIMIT",
            "limitPrice": f"{limit:.4f}",
            "routing": "SMART",
            "timeInForce": "DAY",
            "session": "REGULAR",
            "simulationOnly": True,
            "priceCollar": {
                "referencePrice": facts["REFERENCE_PRICE_USD"]["value"],
                "maximumLimitPrice": f"{collar:.4f}",
                "ratio": _POLICY["buyCollarRatio"],
            },
        }
        plan["planHash"] = compute_hash(plan, "order-plan", "planHash")
        execution = {
            "schemaVersion": 1,
            "profile": PROFILE,
            "policyId": POLICY_ID,
            "artifactType": "ExecutionEvent",
            "executionId": _deterministic_id(
                "exec_", request["operationId"], "ExecutionEvent"
            ),
            "producer": {
                "kind": "PYTHON_AUTHORITY",
                "runId": gate["producer"]["runId"],
            },
            "operationId": request["operationId"],
            "planId": plan["planId"],
            "planHash": plan["planHash"],
            "occurredAt": decision_at,
            "status": "FILLED",
            "instrumentId": proposal["instrumentId"],
            "assetClass": proposal["assetClass"],
            "currency": proposal["currency"],
            "side": "BUY",
            "quantity": proposal["quantity"],
            "fillPrice": facts["ASK_PRICE_USD"]["value"],
            "fillNotionalUsd": f"{fill_notional:.2f}",
            "commissionUsd": "0.00",
            "simulationOnly": True,
        }
        execution["executionHash"] = compute_hash(
            execution, "execution-event", "executionHash"
        )
    audits = _audit_events(
        request,
        research,
        candidate,
        intent,
        critic,
        gate,
        plan,
        execution,
        request_hash,
    )
    response: dict[str, Any] = {
        "schemaVersion": 1,
        "profile": PROFILE,
        "policyId": POLICY_ID,
        "messageType": "FIXTURE_PAPER_INTENT_RESULT",
        "requestId": request["requestId"],
        "operationId": request["operationId"],
        "requestHash": request_hash,
        "status": "ACCEPTED" if decision == "ACCEPT" else "REJECTED",
        "primaryReasonCode": "ACCEPTED" if decision == "ACCEPT" else reason_codes[0],
        "reasonCodes": ["ACCEPTED"] if decision == "ACCEPT" else reason_codes,
        "gateDecision": gate,
        "orderPlan": plan,
        "executionEvent": execution,
        "auditEvents": audits,
        "headHash": audits[-1]["eventHash"],
    }
    response["responseHash"] = compute_hash(response, "response", "responseHash")
    return response


def evaluate_request(request: dict[str, Any]) -> dict[str, Any]:
    """Validate and evaluate one fixture request.

    A structurally invalid or hash-invalid request raises
    :class:`InputContractError`.  A valid request always returns a complete
    accepted/rejected domain response with a gate and audit chain.
    """

    outer, research, candidate, intent, critic = _validate_request(request)
    request_hash = compute_hash(outer, "request")
    reasons = _domain_reasons(outer, research, candidate, intent, critic)
    response = _build_response(
        outer, research, candidate, intent, critic, request_hash, reasons
    )
    try:
        validate_instance("FixtureAuthorityResponse", response)
    except PaperSchemaValidationError as exc:
        raise RuntimeError("generated authority response violated its schema") from exc
    if not verify_response(response, outer):
        raise RuntimeError("generated authority response failed semantic verification")
    return response


def verify_response(
    response: Mapping[str, Any], request: Mapping[str, Any] | None = None
) -> bool:
    """Verify an authority response and its in-memory audit chain.

    This is deliberately independent of :func:`evaluate_request`: callers can
    use it on bytes returned by an untrusted Python process or on a bundle that
    has crossed the Node boundary.  It returns ``False`` for any mismatch and
    never repairs the response.
    """

    try:
        validate_instance("FixtureAuthorityResponse", response)
        if request is not None:
            validate_instance("FixtureAuthorityRequest", request)

        if response["responseHash"] != compute_hash(
            response, "response", "responseHash"
        ):
            return False

        gate = response["gateDecision"]
        plan = response["orderPlan"]
        execution = response["executionEvent"]
        reason_codes = response["reasonCodes"]
        reason_positions = {code: index for index, code in enumerate(_DOMAIN_CODES)}

        if (
            response["primaryReasonCode"] != gate["primaryReasonCode"]
            or reason_codes != gate["reasonCodes"]
        ):
            return False
        if response["status"] == "ACCEPTED":
            if (
                gate["decision"] != "ACCEPT"
                or response["primaryReasonCode"] != "ACCEPTED"
                or reason_codes != ["ACCEPTED"]
            ):
                return False
        elif (
            gate["decision"] != "REJECT"
            or reason_codes[0] != response["primaryReasonCode"]
            or len(reason_codes) != len(set(reason_codes))
            or any(code not in reason_positions for code in reason_codes)
            or reason_codes != sorted(reason_codes, key=reason_positions.__getitem__)
        ):
            return False

        operation_id = response["operationId"]
        authority_run_id = _deterministic_id("run_", operation_id, "PYTHON_AUTHORITY")
        expected_producer = {
            "kind": "PYTHON_AUTHORITY",
            "runId": authority_run_id,
        }
        if (
            gate["decisionHash"] != compute_hash(gate, "gate-decision", "decisionHash")
            or gate["decisionId"]
            != _deterministic_id("gd_", operation_id, "GateDecision")
            or gate["producer"] != expected_producer
            or gate["operationId"] != operation_id
            or gate["requestHash"] != response["requestHash"]
        ):
            return False

        refs = gate["inputRefs"]
        if (refs["verdictId"] is None) != (refs["verdictHash"] is None):
            return False

        if plan is not None:
            if (
                plan["planHash"] != compute_hash(plan, "order-plan", "planHash")
                or plan["planId"]
                != _deterministic_id("plan_", operation_id, "OrderPlan")
                or plan["producer"] != expected_producer
                or plan["operationId"] != operation_id
                or plan["decisionId"] != gate["decisionId"]
                or plan["decisionHash"] != gate["decisionHash"]
                or plan["candidateId"] != refs["candidateId"]
                or plan["candidateHash"] != refs["candidateHash"]
                or plan["intentId"] != refs["intentId"]
                or plan["intentHash"] != refs["intentHash"]
                or plan["createdAt"] != gate["decidedAt"]
            ):
                return False
        if execution is not None:
            if (
                plan is None
                or execution["executionHash"]
                != compute_hash(execution, "execution-event", "executionHash")
                or execution["executionId"]
                != _deterministic_id("exec_", operation_id, "ExecutionEvent")
                or execution["producer"] != expected_producer
                or execution["operationId"] != operation_id
                or execution["planId"] != plan["planId"]
                or execution["planHash"] != plan["planHash"]
                or execution["occurredAt"] != gate["decidedAt"]
            ):
                return False

        subjects: list[tuple[str, str, str, str]] = [
            (
                "INPUT_RESEARCH_RECORDED",
                "ResearchEvent",
                refs["eventId"],
                refs["eventHash"],
            ),
            (
                "INPUT_CANDIDATE_RECORDED",
                "CandidateManifest",
                refs["candidateId"],
                refs["candidateHash"],
            ),
            (
                "INPUT_INTENT_RECORDED",
                "TradeIntent",
                refs["intentId"],
                refs["intentHash"],
            ),
        ]
        if refs["verdictId"] is not None:
            subjects.append(
                (
                    "INPUT_CRITIC_RECORDED",
                    "CriticVerdict",
                    refs["verdictId"],
                    refs["verdictHash"],
                )
            )
        subjects.append(
            (
                "GATE_DECIDED",
                "GateDecision",
                gate["decisionId"],
                gate["decisionHash"],
            )
        )
        if plan is not None and execution is not None:
            subjects.extend(
                [
                    (
                        "ORDER_PLANNED",
                        "OrderPlan",
                        plan["planId"],
                        plan["planHash"],
                    ),
                    (
                        "EXECUTION_SIMULATED",
                        "ExecutionEvent",
                        execution["executionId"],
                        execution["executionHash"],
                    ),
                ]
            )
        if len(response["auditEvents"]) != len(subjects):
            return False

        previous = hashlib.sha256(
            (PROFILE + "/audit-genesis").encode("ascii")
            + b"\0"
            + response["requestHash"].encode("ascii")
        ).hexdigest()
        for sequence, (audit, subject) in enumerate(
            zip(response["auditEvents"], subjects, strict=True), 1
        ):
            if (
                audit["auditId"]
                != _deterministic_id("audit_", operation_id, "AuditEvent", sequence)
                or audit["auditEventId"]
                != _deterministic_id("ae_", operation_id, "AuditEvent", sequence)
                or audit["sequence"] != sequence
                or audit["occurredAt"] != gate["decidedAt"]
                or audit["previousEventHash"] != previous
                or audit["eventHash"] != compute_hash(audit, "audit-event", "eventHash")
                or (
                    audit["eventType"],
                    audit["subjectType"],
                    audit["subjectId"],
                    audit["subjectHash"],
                )
                != subject
            ):
                return False
            previous = audit["eventHash"]
        if response["headHash"] != previous:
            return False

        if request is not None:
            bundle = request["bundle"]
            expected_research = bundle["researchEvent"]
            expected_candidate = bundle["candidateManifest"]
            expected_intent = bundle["tradeIntent"]
            expected_critic = bundle["criticVerdict"]
            for artifact_type, artifact in (
                ("ResearchEvent", expected_research),
                ("CandidateManifest", expected_candidate),
                ("TradeIntent", expected_intent),
            ):
                hash_field = _ARTIFACT_HASH_FIELDS[artifact_type]
                if artifact[hash_field] != compute_hash(
                    artifact,
                    name_to_domain(artifact_type),
                    hash_field,
                ):
                    return False
            if expected_critic is not None and expected_critic[
                "verdictHash"
            ] != compute_hash(expected_critic, "critic-verdict", "verdictHash"):
                return False
            if (
                compute_hash(request, "request") != response["requestHash"]
                or request["requestId"] != response["requestId"]
                or request["operationId"] != operation_id
                or request["decisionAt"] != gate["decidedAt"]
                or refs["eventId"] != expected_research["eventId"]
                or refs["eventHash"] != expected_research["eventHash"]
                or refs["candidateId"] != expected_candidate["candidateId"]
                or refs["candidateHash"] != expected_candidate["candidateHash"]
                or refs["intentId"] != expected_intent["intentId"]
                or refs["intentHash"] != expected_intent["intentHash"]
                or (expected_critic is None) != (refs["verdictId"] is None)
            ):
                return False
            if expected_critic is not None and (
                refs["verdictId"] != expected_critic["verdictId"]
                or refs["verdictHash"] != expected_critic["verdictHash"]
            ):
                return False
        return True
    except (
        PaperSchemaValidationError,
        KeyError,
        TypeError,
        ValueError,
        InvalidOperation,
    ):
        return False


def _safe_request_id(value: Any) -> str | None:
    if isinstance(value, str) and _ID_RE.fullmatch(value) and value.startswith("req_"):
        return value
    return None


def protocol_error(
    code: str, request_id: str | None = None, *, internal: bool = False
) -> dict[str, Any]:
    message_type = (
        "FIXTURE_AUTHORITY_INTERNAL_ERROR"
        if internal
        else "FIXTURE_AUTHORITY_PROTOCOL_ERROR"
    )
    if internal:
        code = "INTERNAL_ERROR"
    error: dict[str, Any] = {
        "schemaVersion": 1,
        "profile": PROFILE,
        "policyId": POLICY_ID,
        "messageType": message_type,
        "requestId": request_id,
        "status": "ERROR",
        "errorCode": code,
    }
    error["responseHash"] = compute_hash(error, "response", "responseHash")
    try:
        validate_instance("ProtocolError", error)
    except PaperSchemaValidationError as exc:
        raise RuntimeError("generated protocol error violated its schema") from exc
    return error


def _process(raw: bytes) -> tuple[int, dict[str, Any]]:
    if len(raw) > PROTOCOL_MAX_BYTES:
        return 2, protocol_error("INPUT_LIMIT_EXCEEDED")
    body = raw[:-1] if raw.endswith(b"\n") else b""
    if (
        not raw.endswith(b"\n")
        or raw.count(b"\n") != 1
        or b"\r" in raw
        or raw.startswith(b"\xef\xbb\xbf")
        or b"\x00" in raw
        or not (body.startswith(b"{") and body.endswith(b"}"))
    ):
        return 2, protocol_error("INPUT_FRAMING_INVALID")
    try:
        value = _json_loads_strict(raw[:-1])
    except RecursionError:
        # A bounded byte line can still contain adversarial nesting. Keep the
        # protocol redacted and typed rather than leaking a traceback.
        return 2, protocol_error("INPUT_JSON_INVALID")
    except InputContractError as exc:
        request_id = None
        # Parsing was intentionally strict; never echo untrusted text.  A
        # safely parseable request id may still be retained for correlation.
        if exc.code != "INPUT_DUPLICATE_KEY":
            try:
                rough = json.loads(raw[:-1])
                request_id = (
                    _safe_request_id(rough.get("requestId"))
                    if isinstance(rough, dict)
                    else None
                )
            except Exception:
                pass
        return 2, protocol_error(exc.code, request_id)
    try:
        response = evaluate_request(value)
    except InputContractError as exc:
        return 2, protocol_error(
            exc.code,
            _safe_request_id(value.get("requestId"))
            if isinstance(value, dict)
            else None,
        )
    except Exception:
        return 1, protocol_error(
            "INTERNAL_ERROR",
            _safe_request_id(value.get("requestId"))
            if isinstance(value, dict)
            else None,
            internal=True,
        )
    return 0, response


def main() -> int:
    raw = sys.stdin.buffer.read(PROTOCOL_MAX_BYTES + 1)
    code, response = _process(raw)
    sys.stdout.buffer.write(canonical_json_bytes(response) + b"\n")
    sys.stdout.buffer.flush()
    return code


if __name__ == "__main__":  # pragma: no cover - exercised by subprocess tests
    raise SystemExit(main())
