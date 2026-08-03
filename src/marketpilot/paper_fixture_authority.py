"""The WI-005 fixture-only Python authority.

This module deliberately has no third-party dependencies and no product-state or
network access.  It is a small, closed implementation of the planning-owned
``marketpilot.paper-intent-fixture.v1`` contract.  JSON is accepted at the
process boundary only after framing and duplicate-key checks; structurally and
cryptographically valid bundles are then evaluated by Python's domain gate.

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
import unicodedata
from decimal import Decimal, InvalidOperation, ROUND_DOWN, ROUND_HALF_EVEN, localcontext
from pathlib import Path
from typing import Any, Iterable, Mapping


PROFILE = "marketpilot.paper-intent-fixture.v1"
POLICY_ID = "FIXTURE_LONG_US_EQUITY_100_V1"
PROTOCOL_MAX_BYTES = 131_072
_DOMAIN_PREFIX = PROFILE + "/"

_ID_RE = re.compile(r"^[a-z][a-z0-9_]{2,63}$")
_INSTRUMENT_RE = re.compile(r"^[A-Z][A-Z0-9.]{0,9}$")
_CURRENCY_RE = re.compile(r"^[A-Z]{3}$")
_SOURCE_RE = re.compile(r"^[a-z][a-z0-9.-]{2,63}$")
_HASH_RE = re.compile(r"^[0-9a-f]{64}$")
_UTC_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
_USD_PRICE_RE = re.compile(r"^(0|[1-9][0-9]*)\.[0-9]{4}$")
_SHARES_RE = re.compile(r"^(0|[1-9][0-9]*)\.[0-9]{6}$")
_USD_AMOUNT_RE = re.compile(r"^(0|[1-9][0-9]*)\.[0-9]{2}$")
_RATIO_RE = re.compile(r"^(0|1)\.[0-9]{6}$")

_RIGHTS = {"PUBLIC_OFFICIAL", "LICENSED_MODEL_OK", "LOCAL_RESTRICTED"}
_MODES = {"PAPER", "LIVE"}
_ASSET_CLASSES = {"US_PRIMARY_LISTED_COMMON_STOCK", "PLAIN_UNLEVERED_ETF"}
_ACTIONS = {"OPEN_LONG", "CLOSE_LONG", "HOLD"}
_SIDES = {"BUY", "SELL"}
_SESSIONS = {"REGULAR", "EXTENDED"}

_PREFIXES = {
    "requestId": "req_",
    "operationId": "op_",
    "eventId": "re_",
    "revisionId": "rev_",
    "factId": "fact_",
    "provenanceId": "prov_",
    "candidateId": "cand_",
    "intentId": "ti_",
    "verdictId": "cv_",
    "decisionId": "gd_",
    "planId": "plan_",
    "executionId": "exec_",
    "auditId": "audit_",
    "auditEventId": "ae_",
    "runId": "run_",
}

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


def _assert_local_registry() -> None:
    """Fail closed if the committed Draft 2020-12 registry is missing or widened."""
    directory = Path(__file__).resolve().parents[2] / "contracts" / "paper-intent" / "fixture-l1" / "v1"
    registry_path = directory / "registry.json"
    registry = json.loads(registry_path.read_text(encoding="utf-8"))
    if registry.get("$schema") != "https://json-schema.org/draft/2020-12/schema" or registry.get("profile") != PROFILE or registry.get("localOnly") is not True or registry.get("formatAssertion") is not True:
        raise RuntimeError("paper fixture registry identity is invalid")
    ids: set[str] = set()
    schemas: list[dict[str, Any]] = []
    for name, relative in registry.get("schemas", {}).items():
        if not isinstance(relative, str) or relative.startswith("/") or ".." in Path(relative).parts:
            raise RuntimeError(f"paper fixture registry path is not local: {name}")
        schema = json.loads((directory / relative).read_text(encoding="utf-8"))
        if schema.get("additionalProperties") is not False or schema.get("unevaluatedProperties") is not False or not isinstance(schema.get("$id"), str):
            raise RuntimeError(f"paper fixture schema is not closed: {name}")
        if schema["$id"] in ids:
            raise RuntimeError(f"paper fixture schema id is duplicated: {schema['$id']}")
        ids.add(schema["$id"]); schemas.append(schema)
    for schema in schemas:
        for reference in re.findall(r"urn:marketpilot:paper-intent-fixture:v1:[a-z-]+", json.dumps(schema, ensure_ascii=False)):
            if reference not in ids:
                raise RuntimeError(f"paper fixture schema reference is not local: {reference}")


_assert_local_registry()

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


def _json_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise _DuplicateKey(key)
        result[key] = value
    return result


def _json_constant(value: str) -> Any:
    raise ValueError(f"non-finite JSON constant: {value}")


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


def compute_hash(value: Mapping[str, Any], domain_suffix: str, own_hash_field: str | None = None) -> str:
    """Compute the profile's lower-case domain-separated SHA-256 hash."""

    view = dict(value)
    if own_hash_field is not None:
        view.pop(own_hash_field, None)
    domain = (_DOMAIN_PREFIX + domain_suffix).encode("ascii")
    return hashlib.sha256(domain + b"\0" + canonical_json_bytes(view)).hexdigest()


def _deterministic_id(prefix: str, operation_id: str, artifact_type: str, sequence: int | None = None) -> str:
    raw = PROFILE.encode("ascii") + b"\0" + operation_id.encode("ascii") + b"\0" + artifact_type.encode("ascii")
    if sequence is not None:
        raw += b"\0" + str(sequence).encode("ascii")
    return prefix + hashlib.sha256(raw).hexdigest()[:32]


def _keys(value: Any, expected: Iterable[str], path: str) -> dict[str, Any]:
    if type(value) is not dict:
        raise InputContractError("INPUT_SCHEMA_INVALID", f"{path} must be an object")
    expected_set = set(expected)
    if set(value) != expected_set:
        raise InputContractError("INPUT_SCHEMA_INVALID", f"{path} has closed-schema keys")
    return value


def _schema_header(value: Mapping[str, Any], path: str, artifact_type: str | None = None) -> None:
    if type(value.get("schemaVersion")) is not int or value["schemaVersion"] != 1:
        raise InputContractError("SCHEMA_UNSUPPORTED", f"{path}.schemaVersion")
    if value.get("profile") != PROFILE:
        raise InputContractError("PROFILE_UNSUPPORTED", f"{path}.profile")
    if artifact_type is not None and value.get("artifactType") != artifact_type:
        raise InputContractError("INPUT_SCHEMA_INVALID", f"{path}.artifactType")


def _string(value: Any, path: str, *, text: bool = False, ascii_only: bool = False) -> str:
    if not isinstance(value, str):
        raise InputContractError("INPUT_SCHEMA_INVALID", f"{path} must be a string")
    if unicodedata.normalize("NFC", value) != value:
        raise InputContractError("INPUT_SCHEMA_INVALID", f"{path} must already be NFC")
    if any(unicodedata.category(ch) == "Cc" for ch in value):
        raise InputContractError("INPUT_SCHEMA_INVALID", f"{path} contains a control character")
    if any(0xD800 <= ord(ch) <= 0xDFFF for ch in value):
        raise InputContractError("INPUT_SCHEMA_INVALID", f"{path} contains an unpaired surrogate")
    if not (1 <= len(value) <= 1024):
        raise InputContractError("INPUT_SCHEMA_INVALID", f"{path} length")
    if ascii_only and any(ord(ch) > 127 for ch in value):
        raise InputContractError("INPUT_SCHEMA_INVALID", f"{path} must be ASCII")
    return value


def _nullable_string(value: Any, path: str, *, ascii_only: bool = False) -> str | None:
    if value is None:
        return None
    return _string(value, path, ascii_only=ascii_only)


def _id(value: Any, field: str, path: str) -> str:
    result = _string(value, path, ascii_only=True)
    prefix = _PREFIXES[field]
    if not _ID_RE.fullmatch(result) or not result.startswith(prefix):
        raise InputContractError("INPUT_SCHEMA_INVALID", f"{path} identifier")
    return result


def _hash(value: Any, path: str) -> str:
    result = _string(value, path, ascii_only=True)
    if not _HASH_RE.fullmatch(result):
        raise InputContractError("INPUT_SCHEMA_INVALID", f"{path} hash")
    return result


def _enum(value: Any, allowed: set[str], path: str) -> str:
    result = _string(value, path, ascii_only=True)
    if result not in allowed:
        raise InputContractError("INPUT_SCHEMA_INVALID", f"{path} enum")
    return result


def _instrument(value: Any, path: str) -> str:
    result = _string(value, path, ascii_only=True)
    if not _INSTRUMENT_RE.fullmatch(result):
        raise InputContractError("INPUT_SCHEMA_INVALID", f"{path} instrument")
    return result


def _currency(value: Any, path: str) -> str:
    result = _string(value, path, ascii_only=True)
    if not _CURRENCY_RE.fullmatch(result):
        raise InputContractError("INPUT_SCHEMA_INVALID", f"{path} currency")
    return result


def _source_id(value: Any, path: str) -> str:
    result = _string(value, path, ascii_only=True)
    if not _SOURCE_RE.fullmatch(result):
        raise InputContractError("INPUT_SCHEMA_INVALID", f"{path} sourceId")
    return result


def _timestamp(value: Any, path: str) -> str:
    result = _string(value, path, ascii_only=True)
    if not _UTC_RE.fullmatch(result):
        raise InputContractError("INPUT_SCHEMA_INVALID", f"{path} timestamp lexical form")
    try:
        _dt.datetime.strptime(result, "%Y-%m-%dT%H:%M:%S.%fZ")
    except ValueError as exc:
        raise InputContractError("INPUT_SCHEMA_INVALID", f"{path} timestamp value") from exc
    return result


def _moment(value: str) -> _dt.datetime:
    return _dt.datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=_dt.timezone.utc)


def _decimal(value: Any, path: str, pattern: re.Pattern[str], scale: int, minimum: Decimal, maximum: Decimal) -> Decimal:
    result = _string(value, path, ascii_only=True)
    if not pattern.fullmatch(result):
        raise InputContractError("INPUT_SCHEMA_INVALID", f"{path} decimal lexical form")
    try:
        with localcontext() as context:
            context.prec = 38
            parsed = Decimal(result)
    except InvalidOperation as exc:
        raise InputContractError("INPUT_SCHEMA_INVALID", f"{path} decimal") from exc
    if parsed < minimum or parsed > maximum or parsed.as_tuple().exponent != -scale:
        raise InputContractError("INPUT_SCHEMA_INVALID", f"{path} decimal range")
    return parsed


def _price(value: Any, path: str) -> Decimal:
    return _decimal(value, path, _USD_PRICE_RE, 4, Decimal("0.0001"), Decimal("999999.9999"))


def _quantity(value: Any, path: str) -> Decimal:
    return _decimal(value, path, _SHARES_RE, 6, Decimal("0.000001"), Decimal("1000000.000000"))


def _amount(value: Any, path: str) -> Decimal:
    return _decimal(value, path, _USD_AMOUNT_RE, 2, Decimal("0.00"), Decimal("999999999.99"))


def _ratio(value: Any, path: str) -> Decimal:
    return _decimal(value, path, _RATIO_RE, 6, Decimal("0.000000"), Decimal("1.000000"))


def _producer(value: Any, path: str, allowed: set[str]) -> dict[str, Any]:
    producer = _keys(value, ("kind", "runId"), path)
    _enum(producer["kind"], allowed, path + ".kind")
    _id(producer["runId"], "runId", path + ".runId")
    return producer


def _sorted_ids(items: list[Mapping[str, Any]], field: str, path: str) -> None:
    values = [_string(item[field], path + f"[{index}].{field}", ascii_only=True) for index, item in enumerate(items)]
    if len(values) != len(set(values)) or values != sorted(values):
        raise InputContractError("INPUT_SCHEMA_INVALID", f"{path} must be unique and sorted")


def _list(value: Any, path: str, *, minimum: int = 0) -> list[Any]:
    if type(value) is not list or not (minimum <= len(value) <= 16):
        raise InputContractError("INPUT_SCHEMA_INVALID", f"{path} collection")
    return value


def _validate_provenance(value: Any, path: str) -> dict[str, Any]:
    provenance = _keys(
        value,
        ("provenanceId", "sourceId", "sourceClass", "sourceRef", "sourceRevision", "publishedAt", "retrievedAt", "contentHash"),
        path,
    )
    _id(provenance["provenanceId"], "provenanceId", path + ".provenanceId")
    _source_id(provenance["sourceId"], path + ".sourceId")
    _enum(provenance["sourceClass"], {"PUBLIC_OFFICIAL", "LICENSED_VENDOR", "LOCAL"}, path + ".sourceClass")
    _string(provenance["sourceRef"], path + ".sourceRef")
    revision = _string(provenance["sourceRevision"], path + ".sourceRevision", ascii_only=True)
    if any(ord(ch) < 0x21 or ord(ch) > 0x7E for ch in revision):
        raise InputContractError("INPUT_SCHEMA_INVALID", path + ".sourceRevision lexical form")
    _timestamp(provenance["publishedAt"], path + ".publishedAt")
    _timestamp(provenance["retrievedAt"], path + ".retrievedAt")
    _hash(provenance["contentHash"], path + ".contentHash")
    return provenance


def _validate_research(value: Any) -> dict[str, Any]:
    path = "bundle.researchEvent"
    event = _keys(
        value,
        (
            "schemaVersion",
            "profile",
            "artifactType",
            "eventId",
            "eventHash",
            "producer",
            "instrumentId",
            "assetClass",
            "currency",
            "eventKind",
            "revisionId",
            "supersedesEventId",
            "rightsClass",
            "publishedAt",
            "observedAt",
            "facts",
            "provenance",
        ),
        path,
    )
    _schema_header(event, path, "ResearchEvent")
    _id(event["eventId"], "eventId", path + ".eventId")
    _hash(event["eventHash"], path + ".eventHash")
    _producer(event["producer"], path + ".producer", {"FIXTURE_SOURCE", "FIXTURE_REGISTRY", "MANAGER", "CRITIC", "PYTHON_AUTHORITY"})
    _instrument(event["instrumentId"], path + ".instrumentId")
    _enum(event["assetClass"], _ASSET_CLASSES, path + ".assetClass")
    _currency(event["currency"], path + ".currency")
    if event["eventKind"] != "FIXTURE_ISSUER_NOTICE":
        raise InputContractError("INPUT_SCHEMA_INVALID", f"{path}.eventKind")
    _id(event["revisionId"], "revisionId", path + ".revisionId")
    if event["supersedesEventId"] is not None:
        _id(event["supersedesEventId"], "eventId", path + ".supersedesEventId")
    _enum(event["rightsClass"], _RIGHTS, path + ".rightsClass")
    _timestamp(event["publishedAt"], path + ".publishedAt")
    _timestamp(event["observedAt"], path + ".observedAt")
    facts = _list(event["facts"], path + ".facts", minimum=1)
    _sorted_ids([_keys(item, ("factId", "kind", "value", "rightsClass", "provenanceId"), path + ".facts[]") for item in facts], "factId", path + ".facts")
    seen_kinds: set[str] = set()
    for index, item in enumerate(facts):
        fact_path = f"{path}.facts[{index}]"
        fact = _keys(item, ("factId", "kind", "value", "rightsClass", "provenanceId"), fact_path)
        _id(fact["factId"], "factId", fact_path + ".factId")
        kind = _string(fact["kind"], fact_path + ".kind", ascii_only=True)
        if kind not in {"NOTICE_TEXT", "REFERENCE_PRICE_USD", "ASK_PRICE_USD"} or kind in seen_kinds:
            raise InputContractError("INPUT_SCHEMA_INVALID", f"{fact_path}.kind")
        seen_kinds.add(kind)
        if kind == "NOTICE_TEXT":
            _string(fact["value"], fact_path + ".value", text=True)
        else:
            _price(fact["value"], fact_path + ".value")
        _enum(fact["rightsClass"], _RIGHTS, fact_path + ".rightsClass")
        _id(fact["provenanceId"], "provenanceId", fact_path + ".provenanceId")
    if seen_kinds != {"NOTICE_TEXT", "REFERENCE_PRICE_USD", "ASK_PRICE_USD"}:
        raise InputContractError("INPUT_SCHEMA_INVALID", f"{path}.facts kinds")
    provenance = _list(event["provenance"], path + ".provenance", minimum=1)
    _sorted_ids([_keys(item, ("provenanceId", "sourceId", "sourceClass", "sourceRef", "sourceRevision", "publishedAt", "retrievedAt", "contentHash"), path + ".provenance[]") for item in provenance], "provenanceId", path + ".provenance")
    for index, item in enumerate(provenance):
        _validate_provenance(item, f"{path}.provenance[{index}]")
    provenance_ids = {item["provenanceId"] for item in provenance}
    for item in facts:
        if item["provenanceId"] not in provenance_ids:
            raise InputContractError("INPUT_SCHEMA_INVALID", f"{path}.facts provenance reference")
    # Rights strictness and public-only acceptance are domain decisions.  The
    # contract validator checks the closed enum and references; Python's gate
    # below deliberately owns the semantic rights calculation.
    return event


def _validate_candidate(value: Any) -> dict[str, Any]:
    path = "bundle.candidateManifest"
    candidate = _keys(
        value,
        (
            "schemaVersion",
            "profile",
            "artifactType",
            "candidateId",
            "candidateHash",
            "producer",
            "createdAt",
            "validFrom",
            "validUntil",
            "mode",
            "liveEligible",
            "strategyKind",
            "instrumentId",
            "assetClass",
            "currency",
            "policy",
        ),
        path,
    )
    _schema_header(candidate, path, "CandidateManifest")
    _id(candidate["candidateId"], "candidateId", path + ".candidateId")
    _hash(candidate["candidateHash"], path + ".candidateHash")
    _producer(candidate["producer"], path + ".producer", {"FIXTURE_SOURCE", "FIXTURE_REGISTRY", "MANAGER", "CRITIC", "PYTHON_AUTHORITY"})
    for field in ("createdAt", "validFrom", "validUntil"):
        _timestamp(candidate[field], path + "." + field)
    _enum(candidate["mode"], _MODES, path + ".mode")
    if type(candidate["liveEligible"]) is not bool:
        raise InputContractError("INPUT_SCHEMA_INVALID", path + ".liveEligible")
    _string(candidate["strategyKind"], path + ".strategyKind", ascii_only=True)
    _instrument(candidate["instrumentId"], path + ".instrumentId")
    _enum(candidate["assetClass"], _ASSET_CLASSES, path + ".assetClass")
    _currency(candidate["currency"], path + ".currency")
    policy = _keys(
        candidate["policy"],
        ("policyId", "allowedAction", "side", "session", "maxQuantity", "maxGrossNotionalUsd", "buyCollarRatio"),
        path + ".policy",
    )
    if policy["policyId"] != POLICY_ID:
        raise InputContractError("INPUT_SCHEMA_INVALID", path + ".policy.policyId")
    _enum(policy["allowedAction"], _ACTIONS, path + ".policy.allowedAction")
    _enum(policy["side"], _SIDES, path + ".policy.side")
    _enum(policy["session"], _SESSIONS, path + ".policy.session")
    _quantity(policy["maxQuantity"], path + ".policy.maxQuantity")
    _amount(policy["maxGrossNotionalUsd"], path + ".policy.maxGrossNotionalUsd")
    _ratio(policy["buyCollarRatio"], path + ".policy.buyCollarRatio")
    return candidate


def _validate_intent(value: Any) -> dict[str, Any]:
    path = "bundle.tradeIntent"
    intent = _keys(
        value,
        (
            "schemaVersion",
            "profile",
            "artifactType",
            "intentId",
            "intentHash",
            "producer",
            "operationId",
            "createdAt",
            "expiresAt",
            "candidateId",
            "candidateHash",
            "disposition",
            "proposal",
            "abstainReasonCode",
            "thesis",
            "evidenceRefs",
        ),
        path,
    )
    _schema_header(intent, path, "TradeIntent")
    _id(intent["intentId"], "intentId", path + ".intentId")
    _hash(intent["intentHash"], path + ".intentHash")
    producer = _producer(intent["producer"], path + ".producer", {"FIXTURE_SOURCE", "FIXTURE_REGISTRY", "MANAGER", "CRITIC", "PYTHON_AUTHORITY"})
    _id(intent["operationId"], "operationId", path + ".operationId")
    for field in ("createdAt", "expiresAt"):
        _timestamp(intent[field], path + "." + field)
    _id(intent["candidateId"], "candidateId", path + ".candidateId")
    _hash(intent["candidateHash"], path + ".candidateHash")
    disposition = _enum(intent["disposition"], {"PROPOSE", "ABSTAIN"}, path + ".disposition")
    proposal = intent["proposal"]
    if disposition == "PROPOSE":
        if proposal is None:
            raise InputContractError("INPUT_SCHEMA_INVALID", path + ".proposal")
        proposal = _keys(
            proposal,
            ("action", "instrumentId", "assetClass", "currency", "side", "session", "quantity", "maximumEntryPrice"),
            path + ".proposal",
        )
        _enum(proposal["action"], _ACTIONS, path + ".proposal.action")
        _instrument(proposal["instrumentId"], path + ".proposal.instrumentId")
        _enum(proposal["assetClass"], _ASSET_CLASSES, path + ".proposal.assetClass")
        _currency(proposal["currency"], path + ".proposal.currency")
        _enum(proposal["side"], _SIDES, path + ".proposal.side")
        _enum(proposal["session"], _SESSIONS, path + ".proposal.session")
        _quantity(proposal["quantity"], path + ".proposal.quantity")
        _price(proposal["maximumEntryPrice"], path + ".proposal.maximumEntryPrice")
        if intent["abstainReasonCode"] is not None:
            raise InputContractError("INPUT_SCHEMA_INVALID", path + ".abstainReasonCode")
    else:
        if proposal is not None:
            raise InputContractError("INPUT_SCHEMA_INVALID", path + ".proposal")
        if intent["abstainReasonCode"] not in {"INSUFFICIENT_EVIDENCE", "NO_SUPPORTED_ACTION", "UNSAFE_CONTEXT"}:
            raise InputContractError("INPUT_SCHEMA_INVALID", path + ".abstainReasonCode")
    _string(intent["thesis"], path + ".thesis", text=True)
    evidence = _list(intent["evidenceRefs"], path + ".evidenceRefs")
    _sorted_ids([_keys(item, ("eventId", "eventHash", "factIds"), path + ".evidenceRefs[]") for item in evidence], "eventId", path + ".evidenceRefs")
    for index, item in enumerate(evidence):
        ref_path = f"{path}.evidenceRefs[{index}]"
        ref = _keys(item, ("eventId", "eventHash", "factIds"), ref_path)
        _id(ref["eventId"], "eventId", ref_path + ".eventId")
        _hash(ref["eventHash"], ref_path + ".eventHash")
        fact_ids = _list(ref["factIds"], ref_path + ".factIds")
        if any(not isinstance(fact_id, str) for fact_id in fact_ids) or fact_ids != sorted(fact_ids) or len(set(fact_ids)) != len(fact_ids):
            raise InputContractError("INPUT_SCHEMA_INVALID", ref_path + ".factIds")
        for fact_id in fact_ids:
            _id(fact_id, "factId", ref_path + ".factIds[]")
    return intent


def _validate_critic(value: Any) -> dict[str, Any]:
    path = "bundle.criticVerdict"
    critic = _keys(
        value,
        (
            "schemaVersion",
            "profile",
            "artifactType",
            "verdictId",
            "verdictHash",
            "producer",
            "operationId",
            "createdAt",
            "expiresAt",
            "candidateId",
            "candidateHash",
            "intentId",
            "intentHash",
            "eventId",
            "eventHash",
            "verdict",
            "reasonCode",
            "counterargument",
            "evidenceFactIds",
        ),
        path,
    )
    _schema_header(critic, path, "CriticVerdict")
    _id(critic["verdictId"], "verdictId", path + ".verdictId")
    _hash(critic["verdictHash"], path + ".verdictHash")
    _producer(critic["producer"], path + ".producer", {"FIXTURE_SOURCE", "FIXTURE_REGISTRY", "MANAGER", "CRITIC", "PYTHON_AUTHORITY"})
    _id(critic["operationId"], "operationId", path + ".operationId")
    for field in ("createdAt", "expiresAt"):
        _timestamp(critic[field], path + "." + field)
    for field, kind in (("candidateId", "candidateId"), ("intentId", "intentId"), ("eventId", "eventId")):
        _id(critic[field], kind, path + "." + field)
    for field in ("candidateHash", "intentHash", "eventHash"):
        _hash(critic[field], path + "." + field)
    verdict = _enum(critic["verdict"], {"APPROVE", "REJECT", "ABSTAIN"}, path + ".verdict")
    reason_allowed = {
        "APPROVE": {"NO_BLOCKING_ISSUE"},
        "REJECT": {"EVIDENCE_GAP", "THESIS_CONTRADICTION", "FIXTURE_POLICY_CONCERN"},
        "ABSTAIN": {"INSUFFICIENT_EVIDENCE"},
    }
    reason_code = _string(critic["reasonCode"], path + ".reasonCode", ascii_only=True)
    if reason_code not in reason_allowed[verdict]:
        raise InputContractError("INPUT_SCHEMA_INVALID", path + ".reasonCode")
    _string(critic["counterargument"], path + ".counterargument", text=True)
    fact_ids = _list(critic["evidenceFactIds"], path + ".evidenceFactIds")
    if fact_ids != sorted(fact_ids) or len(set(fact_ids)) != len(fact_ids):
        raise InputContractError("INPUT_SCHEMA_INVALID", path + ".evidenceFactIds")
    for index, fact_id in enumerate(fact_ids):
        _id(fact_id, "factId", f"{path}.evidenceFactIds[{index}]")
    return critic


def _validate_request(request: Any) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any], dict[str, Any], dict[str, Any] | None]:
    outer = _keys(request, ("schemaVersion", "profile", "policyId", "messageType", "requestId", "operationId", "decisionAt", "bundle"), "request")
    _schema_header(outer, "request")
    if outer["policyId"] != POLICY_ID:
        raise InputContractError("INPUT_SCHEMA_INVALID", "request.policyId")
    if outer["messageType"] != "EVALUATE_FIXTURE_PAPER_INTENT":
        raise InputContractError("INPUT_SCHEMA_INVALID", "request.messageType")
    _id(outer["requestId"], "requestId", "request.requestId")
    _id(outer["operationId"], "operationId", "request.operationId")
    _timestamp(outer["decisionAt"], "request.decisionAt")
    bundle = _keys(outer["bundle"], ("researchEvent", "candidateManifest", "tradeIntent", "criticVerdict"), "request.bundle")
    research = _validate_research(bundle["researchEvent"])
    candidate = _validate_candidate(bundle["candidateManifest"])
    intent = _validate_intent(bundle["tradeIntent"])
    critic = None if bundle["criticVerdict"] is None else _validate_critic(bundle["criticVerdict"])
    for name, artifact in (("ResearchEvent", research), ("CandidateManifest", candidate), ("TradeIntent", intent)):
        field = _ARTIFACT_HASH_FIELDS[name]
        expected = compute_hash(artifact, name_to_domain(name), field)
        if artifact[field] != expected:
            raise InputContractError("INPUT_ARTIFACT_HASH_INVALID", f"{name} hash")
    if critic is not None and critic["verdictHash"] != compute_hash(critic, "critic-verdict", "verdictHash"):
        raise InputContractError("INPUT_ARTIFACT_HASH_INVALID", "CriticVerdict hash")
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


def _domain_reasons(request: Mapping[str, Any], research: Mapping[str, Any], candidate: Mapping[str, Any], intent: Mapping[str, Any], critic: Mapping[str, Any] | None) -> list[str]:
    decision = _moment(request["decisionAt"])
    reasons: list[str] = []
    proposal = intent["proposal"]
    # Linkage and identity are intentionally kept separate from policy checks.
    if intent["candidateId"] != candidate["candidateId"] or intent["candidateHash"] != candidate["candidateHash"] or intent["operationId"] != request["operationId"]:
        reasons.append("INTENT_CANDIDATE_MISMATCH")
    facts = _facts(research)
    evidence_refs = intent["evidenceRefs"]
    if len(evidence_refs) != 1 or evidence_refs[0]["eventId"] != research["eventId"] or evidence_refs[0]["eventHash"] != research["eventHash"] or set(evidence_refs[0]["factIds"]) != {item["factId"] for item in research["facts"]} or research["instrumentId"] != candidate["instrumentId"] or research["assetClass"] != candidate["assetClass"] or research["currency"] != candidate["currency"] or (proposal is not None and (research["instrumentId"] != proposal["instrumentId"] or research["assetClass"] != proposal["assetClass"] or research["currency"] != proposal["currency"])):
        reasons.append("INTENT_EVIDENCE_MISMATCH")
    if critic is not None:
        if critic["intentId"] != intent["intentId"] or critic["intentHash"] != intent["intentHash"] or critic["operationId"] != intent["operationId"]:
            reasons.append("CRITIC_INTENT_MISMATCH")
        if critic["candidateId"] != candidate["candidateId"] or critic["candidateHash"] != candidate["candidateHash"]:
            reasons.append("CRITIC_CANDIDATE_MISMATCH")
        if critic["eventId"] != research["eventId"] or critic["eventHash"] != research["eventHash"]:
            reasons.append("INTENT_EVIDENCE_MISMATCH")
        if not set(critic["evidenceFactIds"]).issubset({item["factId"] for item in research["facts"]}):
            reasons.append("INTENT_EVIDENCE_MISMATCH")
        if critic["producer"]["runId"] == intent["producer"]["runId"]:
            reasons.append("CRITIC_NOT_DISTINCT")
        if critic["producer"]["kind"] != "CRITIC":
            reasons.append("FIXTURE_POLICY_MISMATCH")
    if intent["producer"]["kind"] != "MANAGER":
        reasons.append("FIXTURE_POLICY_MISMATCH")
    if research["producer"]["kind"] != "FIXTURE_SOURCE" or candidate["producer"]["kind"] != "FIXTURE_REGISTRY":
        reasons.append("FIXTURE_POLICY_MISMATCH")
    moments = [_moment(candidate["createdAt"]), _moment(research["publishedAt"]), _moment(research["observedAt"]), _moment(intent["createdAt"])]
    if critic is not None:
        moments.append(_moment(critic["createdAt"]))
    moments.append(decision)
    if moments != sorted(moments):
        reasons.append("TIME_ORDER_INVALID")
    if not (_moment(candidate["validFrom"]) <= decision <= _moment(candidate["validUntil"])):
        reasons.append("CANDIDATE_INACTIVE")
    rights_order = {"PUBLIC_OFFICIAL": 0, "LICENSED_MODEL_OK": 1, "LOCAL_RESTRICTED": 2}
    source_rights = {"PUBLIC_OFFICIAL": "PUBLIC_OFFICIAL", "LICENSED_VENDOR": "LICENSED_MODEL_OK", "LOCAL": "LOCAL_RESTRICTED"}
    provenance_by_id = {item["provenanceId"]: item for item in research["provenance"]}
    rights_values = [research["rightsClass"]] + [item["rightsClass"] for item in research["facts"]]
    rights_values.extend(source_rights[provenance_by_id[item["provenanceId"]]["sourceClass"]] for item in research["facts"])
    strictest_right = max(rights_values, key=("PUBLIC_OFFICIAL", "LICENSED_MODEL_OK", "LOCAL_RESTRICTED").index)
    if strictest_right != research["rightsClass"] or strictest_right != "PUBLIC_OFFICIAL":
        reasons.append("RIGHTS_NOT_PUBLIC")
    if (decision - _moment(research["observedAt"])).total_seconds() > 180:
        reasons.append("EVIDENCE_STALE")
    if (decision - _moment(intent["createdAt"])).total_seconds() > 60 or decision > _moment(intent["expiresAt"]):
        reasons.append("INTENT_STALE")
    if critic is not None and ((decision - _moment(critic["createdAt"])).total_seconds() > 30 or decision > _moment(critic["expiresAt"])):
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
    if candidate["instrumentId"] != "MPTEST" or (proposal is not None and proposal["instrumentId"] != "MPTEST"):
        reasons.append("INSTRUMENT_NOT_ALLOWED")
    if candidate["currency"] != "USD" or (proposal is not None and proposal["currency"] != "USD"):
        reasons.append("CURRENCY_NOT_USD")
    if candidate["assetClass"] != "US_PRIMARY_LISTED_COMMON_STOCK" or (proposal is not None and proposal["assetClass"] != "US_PRIMARY_LISTED_COMMON_STOCK"):
        reasons.append("INSTRUMENT_NOT_ALLOWED")
    if proposal is not None and proposal["action"] != "OPEN_LONG":
        reasons.append("ACTION_NOT_ALLOWED")
    if proposal is not None and proposal["side"] != "BUY":
        reasons.append("SIDE_NOT_ALLOWED")
    if proposal is not None and proposal["session"] != "REGULAR":
        reasons.append("SESSION_NOT_REGULAR")
    if proposal is not None:
        quantity = _quantity(proposal["quantity"], "proposal.quantity")
        maximum_quantity = _quantity(candidate["policy"]["maxQuantity"], "candidate.policy.maxQuantity")
        if quantity > maximum_quantity:
            reasons.append("QUANTITY_LIMIT_EXCEEDED")
        reference = _price(facts["REFERENCE_PRICE_USD"]["value"], "reference")
        ratio = _ratio(candidate["policy"]["buyCollarRatio"], "ratio")
        with localcontext() as context:
            context.prec = 38
            collar_unrounded = reference * (Decimal(1) + ratio)
            notional_limit = _amount(candidate["policy"]["maxGrossNotionalUsd"], "notional")
            if quantity * collar_unrounded > notional_limit:
                reasons.append("NOTIONAL_LIMIT_EXCEEDED")
            collar = collar_unrounded.quantize(Decimal("0.0001"), rounding=ROUND_DOWN)
            maximum_entry = _price(proposal["maximumEntryPrice"], "maximumEntry")
            limit = min(collar, maximum_entry)
            ask = _price(facts["ASK_PRICE_USD"]["value"], "ask")
            if ask > limit:
                reasons.append("PRICE_NOT_MARKETABLE")
    return [code for code in _DOMAIN_CODES if code in reasons]


def _artifact_with_hash(artifact: dict[str, Any], field: str, domain: str) -> dict[str, Any]:
    artifact[field] = compute_hash(artifact, domain, field)
    return artifact


def _base_artifact(artifact_type: str, operation_id: str, prefix: str, field: str, domain: str, **fields: Any) -> dict[str, Any]:
    artifact: dict[str, Any] = {"schemaVersion": 1, "profile": PROFILE, "artifactType": artifact_type}
    artifact[field.replace("Hash", "Id")] = _deterministic_id(prefix, operation_id, artifact_type)
    artifact.update(fields)
    return _artifact_with_hash(artifact, field, domain)


def _audit_events(request: Mapping[str, Any], research: Mapping[str, Any], candidate: Mapping[str, Any], intent: Mapping[str, Any], critic: Mapping[str, Any] | None, gate: Mapping[str, Any], plan: Mapping[str, Any] | None, execution: Mapping[str, Any] | None, request_hash: str) -> list[dict[str, Any]]:
    subjects: list[tuple[str, str, str, str]] = [
        ("INPUT_RESEARCH_RECORDED", "ResearchEvent", research["eventId"], research["eventHash"]),
        ("INPUT_CANDIDATE_RECORDED", "CandidateManifest", candidate["candidateId"], candidate["candidateHash"]),
        ("INPUT_INTENT_RECORDED", "TradeIntent", intent["intentId"], intent["intentHash"]),
    ]
    if critic is not None:
        subjects.append(("INPUT_CRITIC_RECORDED", "CriticVerdict", critic["verdictId"], critic["verdictHash"]))
    subjects.append(("GATE_DECIDED", "GateDecision", gate["decisionId"], gate["decisionHash"]))
    if plan is not None and execution is not None:
        subjects.extend(
            [
                ("ORDER_PLANNED", "OrderPlan", plan["planId"], plan["planHash"]),
                ("EXECUTION_SIMULATED", "ExecutionEvent", execution["executionId"], execution["executionHash"]),
            ]
        )
    previous = hashlib.sha256((PROFILE + "/audit-genesis").encode("ascii") + b"\0" + request_hash.encode("ascii")).hexdigest()
    events: list[dict[str, Any]] = []
    for sequence, (event_type, subject_type, subject_id, subject_hash) in enumerate(subjects, 1):
        event: dict[str, Any] = {
            "schemaVersion": 1,
            "profile": PROFILE,
            "policyId": POLICY_ID,
            "artifactType": "AuditEvent",
            "auditId": _deterministic_id("audit_", request["operationId"], "AuditEvent", sequence),
            "auditEventId": _deterministic_id("ae_", request["operationId"], "AuditEvent", sequence),
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


def _build_response(request: Mapping[str, Any], research: Mapping[str, Any], candidate: Mapping[str, Any], intent: Mapping[str, Any], critic: Mapping[str, Any] | None, request_hash: str, reason_codes: list[str]) -> dict[str, Any]:
    decision_at = request["decisionAt"]
    decision = "ACCEPT" if not reason_codes else "REJECT"
    gate: dict[str, Any] = {
        "schemaVersion": 1,
        "profile": PROFILE,
        "policyId": POLICY_ID,
        "artifactType": "GateDecision",
        "decisionId": _deterministic_id("gd_", request["operationId"], "GateDecision"),
        "producer": {"kind": "PYTHON_AUTHORITY", "runId": _deterministic_id("run_", request["operationId"], "PYTHON_AUTHORITY")},
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
        reference = _price(facts["REFERENCE_PRICE_USD"]["value"], "reference")
        ask = _price(facts["ASK_PRICE_USD"]["value"], "ask")
        ratio = _ratio(candidate["policy"]["buyCollarRatio"], "ratio")
        with localcontext() as context:
            context.prec = 38
            collar = (reference * (Decimal(1) + ratio)).quantize(Decimal("0.0001"), rounding=ROUND_DOWN)
            limit = min(collar, _price(proposal["maximumEntryPrice"], "maximumEntryPrice"))
            quantity = _quantity(proposal["quantity"], "quantity")
            fill_notional = (quantity * ask).quantize(Decimal("0.01"), rounding=ROUND_HALF_EVEN)
        plan = {
            "schemaVersion": 1,
            "profile": PROFILE,
            "policyId": POLICY_ID,
            "artifactType": "OrderPlan",
            "planId": _deterministic_id("plan_", request["operationId"], "OrderPlan"),
            "producer": {"kind": "PYTHON_AUTHORITY", "runId": gate["producer"]["runId"]},
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
            "priceCollar": {"referencePrice": facts["REFERENCE_PRICE_USD"]["value"], "maximumLimitPrice": f"{collar:.4f}", "ratio": candidate["policy"]["buyCollarRatio"]},
        }
        plan["planHash"] = compute_hash(plan, "order-plan", "planHash")
        execution = {
            "schemaVersion": 1,
            "profile": PROFILE,
            "policyId": POLICY_ID,
            "artifactType": "ExecutionEvent",
            "executionId": _deterministic_id("exec_", request["operationId"], "ExecutionEvent"),
            "producer": {"kind": "PYTHON_AUTHORITY", "runId": gate["producer"]["runId"]},
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
        execution["executionHash"] = compute_hash(execution, "execution-event", "executionHash")
    audits = _audit_events(request, research, candidate, intent, critic, gate, plan, execution, request_hash)
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
    return _build_response(outer, research, candidate, intent, critic, request_hash, reasons)


def verify_response(response: Mapping[str, Any], request: Mapping[str, Any] | None = None) -> bool:
    """Verify an authority response and its in-memory audit chain.

    This is deliberately independent of :func:`evaluate_request`: callers can
    use it on bytes returned by an untrusted Python process or on a bundle that
    has crossed the Node boundary.  It returns ``False`` for any mismatch and
    never repairs the response.
    """

    try:
        expected_keys = {
            "schemaVersion", "profile", "policyId", "messageType", "requestId", "operationId", "requestHash",
            "status", "primaryReasonCode", "reasonCodes", "gateDecision", "orderPlan", "executionEvent",
            "auditEvents", "headHash", "responseHash",
        }
        if type(response) is not dict or set(response) != expected_keys:
            return False
        if response["schemaVersion"] != 1 or response["profile"] != PROFILE or response["policyId"] != POLICY_ID or response["messageType"] != "FIXTURE_PAPER_INTENT_RESULT":
            return False
        if not _ID_RE.fullmatch(response["requestId"]) or not response["requestId"].startswith("req_"):
            return False
        if not _ID_RE.fullmatch(response["operationId"]) or not response["operationId"].startswith("op_"):
            return False
        if not _HASH_RE.fullmatch(response["requestHash"]):
            return False
        if response["responseHash"] != compute_hash(response, "response", "responseHash"):
            return False
        if response["status"] not in {"ACCEPTED", "REJECTED"}:
            return False
        if response["status"] == "ACCEPTED":
            if response["primaryReasonCode"] != "ACCEPTED" or response["reasonCodes"] != ["ACCEPTED"] or response["orderPlan"] is None or response["executionEvent"] is None:
                return False
        else:
            positions = {code: index for index, code in enumerate(_DOMAIN_CODES)}
            codes = response["reasonCodes"]
            if response["primaryReasonCode"] == "ACCEPTED" or not codes or codes[0] != response["primaryReasonCode"] or len(codes) != len(set(codes)) or any(code not in positions for code in codes) or codes != sorted(codes, key=positions.__getitem__) or response["orderPlan"] is not None or response["executionEvent"] is not None:
                return False
        gate = response["gateDecision"]
        gate_keys = {
            "schemaVersion", "profile", "policyId", "artifactType", "decisionId", "decisionHash", "producer", "operationId",
            "requestHash", "decidedAt", "decision", "primaryReasonCode", "reasonCodes", "inputRefs",
        }
        if type(gate) is not dict or set(gate) != gate_keys or gate["decisionHash"] != compute_hash(gate, "gate-decision", "decisionHash"):
            return False
        if gate["requestHash"] != response["requestHash"] or gate["operationId"] != response["operationId"]:
            return False
        if response["primaryReasonCode"] != gate["primaryReasonCode"] or response["reasonCodes"] != gate["reasonCodes"]:
            return False
        if response["status"] == "ACCEPTED" and gate["decision"] != "ACCEPT":
            return False
        if response["status"] == "REJECTED" and gate["decision"] != "REJECT":
            return False
        plan = response["orderPlan"]
        execution = response["executionEvent"]
        if plan is not None and plan.get("planHash") != compute_hash(plan, "order-plan", "planHash"):
            return False
        if execution is not None and execution.get("executionHash") != compute_hash(execution, "execution-event", "executionHash"):
            return False
        if plan is not None:
            if plan.get("operationId") != response["operationId"] or plan.get("decisionId") != gate["decisionId"] or plan.get("decisionHash") != gate["decisionHash"]:
                return False
            if plan.get("candidateId") != gate["inputRefs"]["candidateId"] or plan.get("candidateHash") != gate["inputRefs"]["candidateHash"] or plan.get("intentId") != gate["inputRefs"]["intentId"] or plan.get("intentHash") != gate["inputRefs"]["intentHash"]:
                return False
        if execution is not None:
            if plan is None or execution.get("operationId") != response["operationId"] or execution.get("planId") != plan.get("planId") or execution.get("planHash") != plan.get("planHash"):
                return False
        if not isinstance(response["auditEvents"], list) or not response["auditEvents"]:
            return False
        previous = hashlib.sha256((PROFILE + "/audit-genesis").encode("ascii") + b"\0" + response["requestHash"].encode("ascii")).hexdigest()
        subjects: list[tuple[str, str, str, str]] = []
        refs = gate["inputRefs"]
        if (refs["verdictId"] is None) != (refs["verdictHash"] is None):
            return False
        subjects.extend([
            ("INPUT_RESEARCH_RECORDED", "ResearchEvent", refs["eventId"], refs["eventHash"]),
            ("INPUT_CANDIDATE_RECORDED", "CandidateManifest", refs["candidateId"], refs["candidateHash"]),
            ("INPUT_INTENT_RECORDED", "TradeIntent", refs["intentId"], refs["intentHash"]),
        ])
        if refs["verdictId"] is not None:
            subjects.append(("INPUT_CRITIC_RECORDED", "CriticVerdict", refs["verdictId"], refs["verdictHash"]))
        subjects.append(("GATE_DECIDED", "GateDecision", gate["decisionId"], gate["decisionHash"]))
        if plan is not None and execution is not None:
            subjects.extend([
                ("ORDER_PLANNED", "OrderPlan", plan["planId"], plan["planHash"]),
                ("EXECUTION_SIMULATED", "ExecutionEvent", execution["executionId"], execution["executionHash"]),
            ])
        if len(response["auditEvents"]) != len(subjects):
            return False
        for sequence, (audit, subject) in enumerate(zip(response["auditEvents"], subjects), 1):
            if type(audit) is not dict or set(audit) != {
                "schemaVersion", "profile", "policyId", "artifactType", "auditId", "auditEventId", "sequence", "occurredAt",
                "eventType", "subjectType", "subjectId", "subjectHash", "previousEventHash", "eventHash",
            }:
                return False
            if audit["sequence"] != sequence or audit["previousEventHash"] != previous or audit["eventHash"] != compute_hash(audit, "audit-event", "eventHash"):
                return False
            if (audit["eventType"], audit["subjectType"], audit["subjectId"], audit["subjectHash"]) != subject:
                return False
            previous = audit["eventHash"]
        if response["headHash"] != previous:
            return False
        if request is not None:
            if compute_hash(request, "request") != response["requestHash"] or request.get("requestId") != response["requestId"] or request.get("operationId") != response["operationId"]:
                return False
            bundle = request["bundle"]
            expected_research = bundle["researchEvent"]
            expected_candidate = bundle["candidateManifest"]
            expected_intent = bundle["tradeIntent"]
            if refs["eventId"] != expected_research["eventId"] or refs["eventHash"] != expected_research["eventHash"] or refs["candidateId"] != expected_candidate["candidateId"] or refs["candidateHash"] != expected_candidate["candidateHash"] or refs["intentId"] != expected_intent["intentId"] or refs["intentHash"] != expected_intent["intentHash"]:
                return False
            expected_critic = bundle.get("criticVerdict")
            if (expected_critic is None) != (refs["verdictId"] is None):
                return False
            if expected_critic is not None and (refs["verdictId"] != expected_critic["verdictId"] or refs["verdictHash"] != expected_critic["verdictHash"]):
                return False
        return True
    except (KeyError, TypeError, ValueError, InvalidOperation):
        return False


def _safe_request_id(value: Any) -> str | None:
    if isinstance(value, str) and _ID_RE.fullmatch(value) and value.startswith("req_") and unicodedata.normalize("NFC", value) == value:
        return value
    return None


def protocol_error(code: str, request_id: str | None = None, *, internal: bool = False) -> dict[str, Any]:
    message_type = "FIXTURE_AUTHORITY_INTERNAL_ERROR" if internal else "FIXTURE_AUTHORITY_PROTOCOL_ERROR"
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
    return error


def _process(raw: bytes) -> tuple[int, dict[str, Any]]:
    if len(raw) > PROTOCOL_MAX_BYTES:
        return 2, protocol_error("INPUT_LIMIT_EXCEEDED")
    body = raw[:-1] if raw.endswith(b"\n") else b""
    if not raw.endswith(b"\n") or raw.count(b"\n") != 1 or b"\r" in raw or raw.startswith(b"\xef\xbb\xbf") or b"\x00" in raw or not (body.startswith(b"{") and body.endswith(b"}")):
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
        try:
            rough = json.loads(raw[:-1])
            request_id = _safe_request_id(rough.get("requestId")) if isinstance(rough, dict) else None
        except Exception:
            pass
        return 2, protocol_error(exc.code, request_id)
    try:
        response = evaluate_request(value)
    except InputContractError as exc:
        return 2, protocol_error(exc.code, _safe_request_id(value.get("requestId")) if isinstance(value, dict) else None)
    except Exception:
        return 1, protocol_error("INTERNAL_ERROR", _safe_request_id(value.get("requestId")) if isinstance(value, dict) else None, internal=True)
    return 0, response


def main() -> int:
    raw = sys.stdin.buffer.read(PROTOCOL_MAX_BYTES + 1)
    code, response = _process(raw)
    sys.stdout.buffer.write(canonical_json_bytes(response) + b"\n")
    sys.stdout.buffer.flush()
    return code


if __name__ == "__main__":  # pragma: no cover - exercised by subprocess tests
    raise SystemExit(main())
