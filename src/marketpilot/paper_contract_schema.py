"""Executable JSON Schemas for the fixture-only paper authority.

The committed contract directory is the structural and lexical authority for
the ``marketpilot.paper-intent-fixture.v1`` profile.  This module loads that
directory without a retrieval fallback, verifies its raw-byte inventory, and
executes its Draft 2020-12 schemas with the profile's three custom assertion
keywords.

Cross-artifact linkage, rights, time, policy, hashing, and money decisions do
not belong here.  They remain Python authority semantics in
``paper_fixture_authority``.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import hashlib
import json
import re
import stat
import sys
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path, PurePosixPath
from typing import Any

from jsonschema import (
    Draft202012Validator,
    FormatChecker,
    ValidationError,
    validators,
)
from jsonschema.exceptions import SchemaError
from referencing import Registry, Resource
from referencing.exceptions import Unresolvable
from referencing.jsonschema import DRAFT202012
import unicodedata2 as unicodedata

PROFILE = "marketpilot.paper-intent-fixture.v1"
META_SCHEMA_ID = "urn:marketpilot:paper-intent-fixture:v1:meta"
VOCABULARY_ID = "urn:marketpilot:paper-intent-fixture:v1:vocabulary"
CONTRACT_DIRECTORY = (
    Path(__file__).resolve().parents[2]
    / "contracts"
    / "paper-intent"
    / "fixture-l1"
    / "v1"
)

_MAX_CONTRACT_FILE_BYTES = 1_048_576
_MAX_PROBE_BYTES = 4_194_304
_MAX_PROBE_ITEMS = 4_096
_HASH_RE = re.compile(r"^[0-9a-f]{64}$")
_UTC_MILLISECONDS_RE = re.compile(
    r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z(?![\s\S])"
)

_SCHEMA_FILES: dict[str, str] = {
    "Primitives": "primitives.schema.json",
    "Producer": "producer.schema.json",
    "Fact": "fact.schema.json",
    "Provenance": "provenance.schema.json",
    "Policy": "policy.schema.json",
    "ResearchEvent": "research-event.schema.json",
    "CandidateManifest": "candidate-manifest.schema.json",
    "ManagerSemanticDraft": "manager-semantic-draft.schema.json",
    "TradeIntent": "trade-intent.schema.json",
    "CriticSemanticDraft": "critic-semantic-draft.schema.json",
    "CriticVerdict": "critic-verdict.schema.json",
    "GateDecision": "gate-decision.schema.json",
    "OrderPlan": "order-plan.schema.json",
    "ExecutionEvent": "execution-event.schema.json",
    "AuditEvent": "audit-event.schema.json",
    "AppIncidentEvent": "app-incident-event.schema.json",
    "FixtureAuthorityRequest": "authority-request.schema.json",
    "FixtureAuthorityResponse": "authority-response.schema.json",
    "ProtocolError": "protocol-error.schema.json",
}

_SCHEMA_IDS: dict[str, str] = {
    name: f"urn:marketpilot:paper-intent-fixture:v1:{suffix}"
    for name, suffix in {
        "Primitives": "primitives",
        "Producer": "producer",
        "Fact": "fact",
        "Provenance": "provenance",
        "Policy": "policy",
        "ResearchEvent": "research-event",
        "CandidateManifest": "candidate-manifest",
        "ManagerSemanticDraft": "manager-semantic-draft",
        "TradeIntent": "trade-intent",
        "CriticSemanticDraft": "critic-semantic-draft",
        "CriticVerdict": "critic-verdict",
        "GateDecision": "gate-decision",
        "OrderPlan": "order-plan",
        "ExecutionEvent": "execution-event",
        "AuditEvent": "audit-event",
        "AppIncidentEvent": "app-incident-event",
        "FixtureAuthorityRequest": "authority-request",
        "FixtureAuthorityResponse": "authority-response",
        "ProtocolError": "protocol-error",
    }.items()
}

_CUSTOM_KEYWORDS = frozenset({"mpNfc", "mpScalarLength", "mpSortedUniqueBy"})
_EXPECTED_RULES: dict[str, Any] = {
    "maxObjectBytes": 131_072,
    "maxCollectionItems": 16,
    "maxReasonCodes": 26,
    "maxTextScalars": 1_024,
    "unicodeVersion": "17.0",
    "timestamp": "YYYY-MM-DDTHH:MM:SS.mmmZ",
}
_REQUIRED_VOCABULARIES = frozenset(
    {
        "https://json-schema.org/draft/2020-12/vocab/core",
        "https://json-schema.org/draft/2020-12/vocab/applicator",
        "https://json-schema.org/draft/2020-12/vocab/validation",
        "https://json-schema.org/draft/2020-12/vocab/format-assertion",
        VOCABULARY_ID,
    }
)
_SUPPORTED_VOCABULARIES = frozenset(
    {
        "https://json-schema.org/draft/2020-12/vocab/core",
        "https://json-schema.org/draft/2020-12/vocab/applicator",
        "https://json-schema.org/draft/2020-12/vocab/unevaluated",
        "https://json-schema.org/draft/2020-12/vocab/validation",
        "https://json-schema.org/draft/2020-12/vocab/meta-data",
        "https://json-schema.org/draft/2020-12/vocab/format-annotation",
        "https://json-schema.org/draft/2020-12/vocab/format-assertion",
        "https://json-schema.org/draft/2020-12/vocab/content",
        VOCABULARY_ID,
    }
)
_OFFICIAL_META_REFERENCES = frozenset(
    {
        "https://json-schema.org/draft/2020-12/meta/core",
        "https://json-schema.org/draft/2020-12/meta/applicator",
        "https://json-schema.org/draft/2020-12/meta/unevaluated",
        "https://json-schema.org/draft/2020-12/meta/validation",
        "https://json-schema.org/draft/2020-12/meta/meta-data",
        "https://json-schema.org/draft/2020-12/meta/format-annotation",
        "https://json-schema.org/draft/2020-12/meta/format-assertion",
        "https://json-schema.org/draft/2020-12/meta/content",
    }
)


class PaperSchemaConfigurationError(RuntimeError):
    """The committed schema registry is missing, inconsistent, or unsupported."""


class PaperSchemaValidationError(ValueError):
    """An instance did not satisfy one committed structural schema."""

    def __init__(self, schema_name: str) -> None:
        super().__init__(f"instance failed {schema_name} contract validation")
        self.schema_name = schema_name


class _DuplicateJsonKey(ValueError):
    pass


def _object_from_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise _DuplicateJsonKey(key)
        value[key] = item
    return value


def _reject_json_constant(value: str) -> Any:
    raise ValueError(f"non-standard JSON constant: {value}")


def _strict_json_bytes(raw: bytes, label: str) -> Any:
    try:
        text = raw.decode("utf-8", errors="strict")
        if text.startswith("\ufeff"):
            raise ValueError("BOM is not permitted")
        return json.loads(
            text,
            object_pairs_hook=_object_from_pairs,
            parse_constant=_reject_json_constant,
        )
    except (UnicodeDecodeError, ValueError, json.JSONDecodeError) as exc:
        raise PaperSchemaConfigurationError(f"{label} is not strict JSON") from exc


def _read_contract_file(directory: Path, relative: str) -> bytes:
    path_value = PurePosixPath(relative)
    if path_value.is_absolute() or not path_value.parts or ".." in path_value.parts:
        raise PaperSchemaConfigurationError(f"unsafe contract path: {relative}")
    path = directory.joinpath(*path_value.parts)
    try:
        file_stat = path.lstat()
    except OSError as exc:
        raise PaperSchemaConfigurationError(
            f"missing contract file: {relative}"
        ) from exc
    if stat.S_ISLNK(file_stat.st_mode) or not stat.S_ISREG(file_stat.st_mode):
        raise PaperSchemaConfigurationError(
            f"contract file is not a regular file: {relative}"
        )
    if file_stat.st_size > _MAX_CONTRACT_FILE_BYTES:
        raise PaperSchemaConfigurationError(f"contract file is too large: {relative}")
    try:
        return path.read_bytes()
    except OSError as exc:
        raise PaperSchemaConfigurationError(
            f"contract file is unreadable: {relative}"
        ) from exc


def _require_object(value: Any, label: str) -> dict[str, Any]:
    if type(value) is not dict:
        raise PaperSchemaConfigurationError(f"{label} must be an object")
    return value


def _load_inventory(directory: Path) -> dict[str, bytes]:
    inventory_raw = _read_contract_file(directory, "inventory.json")
    inventory = _require_object(
        _strict_json_bytes(inventory_raw, "inventory.json"), "inventory.json"
    )
    if set(inventory) != {"schemaVersion", "algorithm", "files"}:
        raise PaperSchemaConfigurationError("inventory.json has an unexpected shape")
    if inventory.get("schemaVersion") != 1 or inventory.get("algorithm") != "sha256":
        raise PaperSchemaConfigurationError("inventory.json identity is unsupported")
    files = _require_object(inventory.get("files"), "inventory.json.files")
    expected_files = {
        "registry.json",
        "fixture-meta.schema.json",
        "custom-vocabulary-vectors.json",
        *_SCHEMA_FILES.values(),
    }
    if set(files) != expected_files:
        raise PaperSchemaConfigurationError("inventory.json file set is not exact")

    result: dict[str, bytes] = {}
    for relative in sorted(expected_files):
        expected_hash = files[relative]
        if (
            not isinstance(expected_hash, str)
            or _HASH_RE.fullmatch(expected_hash) is None
        ):
            raise PaperSchemaConfigurationError(
                f"inventory hash is invalid for {relative}"
            )
        raw = _read_contract_file(directory, relative)
        if hashlib.sha256(raw).hexdigest() != expected_hash:
            raise PaperSchemaConfigurationError(
                f"inventory hash mismatch for {relative}"
            )
        result[relative] = raw
    return result


def _iter_keyword_values(value: Any, keyword: str) -> Iterable[Any]:
    if isinstance(value, Mapping):
        for key, item in value.items():
            if key == keyword:
                yield item
            yield from _iter_keyword_values(item, keyword)
    elif isinstance(value, list):
        for item in value:
            yield from _iter_keyword_values(item, keyword)


def _iter_references(value: Any) -> Iterable[str]:
    if isinstance(value, Mapping):
        for key, item in value.items():
            if key in {"$ref", "$dynamicRef"} and isinstance(item, str):
                yield item
            yield from _iter_references(item)
    elif isinstance(value, list):
        for item in value:
            yield from _iter_references(item)


def _iter_schema_objects(value: Any) -> Iterable[Mapping[str, Any]]:
    if isinstance(value, Mapping):
        yield value
        for item in value.values():
            yield from _iter_schema_objects(item)
    elif isinstance(value, list):
        for item in value:
            yield from _iter_schema_objects(item)


def _has_surrogate(value: str) -> bool:
    return any(0xD800 <= ord(character) <= 0xDFFF for character in value)


def _validate_mp_nfc(
    validator: Any, enabled: Any, instance: Any, schema: Mapping[str, Any]
) -> Iterable[ValidationError]:
    del validator, schema
    if (
        enabled is True
        and isinstance(instance, str)
        and (
            _has_surrogate(instance)
            or unicodedata.normalize("NFC", instance) != instance
        )
    ):
        yield ValidationError("string is not valid NFC Unicode")


def _validate_mp_scalar_length(
    validator: Any, bounds: Any, instance: Any, schema: Mapping[str, Any]
) -> Iterable[ValidationError]:
    del validator, schema
    if not isinstance(instance, str) or type(bounds) is not dict:
        return
    if _has_surrogate(instance):
        yield ValidationError("string contains a non-scalar surrogate")
        return
    scalar_length = len(instance)
    minimum = bounds.get("min")
    maximum = bounds.get("max")
    if (
        type(minimum) is int
        and type(maximum) is int
        and not minimum <= scalar_length <= maximum
    ):
        yield ValidationError("string scalar length is outside the closed bounds")


def _validate_mp_sorted_unique_by(
    validator: Any, selector: Any, instance: Any, schema: Mapping[str, Any]
) -> Iterable[ValidationError]:
    del validator, schema
    if not isinstance(instance, list) or not isinstance(selector, str):
        return
    if selector == "$value":
        values = list(instance)
    else:
        values = []
        for item in instance:
            if type(item) is not dict or selector not in item:
                yield ValidationError("sorted-key field is absent")
                return
            values.append(item[selector])
    if any(not isinstance(item, str) or _has_surrogate(item) for item in values):
        yield ValidationError("sorted keys must be Unicode scalar strings")
        return
    if len(values) != len(set(values)) or values != sorted(values):
        yield ValidationError("array keys are not lexicographically sorted and unique")


_FORMAT_CHECKER = FormatChecker()


@_FORMAT_CHECKER.checks("date-time", raises=(TypeError, ValueError))
def _valid_profile_date_time(value: Any) -> bool:
    """Assert the profile's exact UTC-millisecond subset of RFC 3339."""

    if not isinstance(value, str):
        return True
    if _UTC_MILLISECONDS_RE.fullmatch(value) is None:
        return False
    _parsed = _dt.datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ").replace(
        tzinfo=_dt.UTC
    )
    return True


_CUSTOM_VALIDATORS = {
    "mpNfc": _validate_mp_nfc,
    "mpScalarLength": _validate_mp_scalar_length,
    "mpSortedUniqueBy": _validate_mp_sorted_unique_by,
}


@dataclass(frozen=True)
class _SchemaRuntime:
    validators: Mapping[str, Any]


def _check_custom_schema_usage(schema: Mapping[str, Any], label: str) -> None:
    for node in _iter_schema_objects(schema):
        unknown_custom = {
            key for key in node if key.startswith("mp") and key not in _CUSTOM_KEYWORDS
        }
        if unknown_custom:
            raise PaperSchemaConfigurationError(
                f"{label} uses an unknown custom vocabulary keyword"
            )
        if "format" in node and node["format"] != "date-time":
            raise PaperSchemaConfigurationError(
                f"{label} uses an unsupported asserted format"
            )
    for bounds in _iter_keyword_values(schema, "mpScalarLength"):
        if (
            type(bounds) is not dict
            or set(bounds) != {"min", "max"}
            or type(bounds.get("min")) is not int
            or type(bounds.get("max")) is not int
            or bounds["min"] < 0
            or bounds["max"] < bounds["min"]
        ):
            raise PaperSchemaConfigurationError(
                f"{label} has an invalid mpScalarLength declaration"
            )
    for enabled in _iter_keyword_values(schema, "mpNfc"):
        if type(enabled) is not bool:
            raise PaperSchemaConfigurationError(
                f"{label} has an invalid mpNfc declaration"
            )
    for selector in _iter_keyword_values(schema, "mpSortedUniqueBy"):
        if not isinstance(selector, str) or not selector:
            raise PaperSchemaConfigurationError(
                f"{label} has an invalid mpSortedUniqueBy declaration"
            )


def _validate_meta_schema(meta_schema: dict[str, Any]) -> None:
    if meta_schema.get("$schema") != "https://json-schema.org/draft/2020-12/schema":
        raise PaperSchemaConfigurationError("fixture meta-schema draft is unsupported")
    if meta_schema.get("$id") != META_SCHEMA_ID:
        raise PaperSchemaConfigurationError("fixture meta-schema id is unsupported")
    vocabularies = _require_object(
        meta_schema.get("$vocabulary"), "fixture meta-schema $vocabulary"
    )
    if any(type(required) is not bool for required in vocabularies.values()):
        raise PaperSchemaConfigurationError("fixture vocabulary flags must be booleans")
    if any(vocabularies.get(uri) is not True for uri in _REQUIRED_VOCABULARIES):
        raise PaperSchemaConfigurationError(
            "fixture meta-schema omits a required vocabulary"
        )
    unsupported = {
        uri
        for uri, required in vocabularies.items()
        if required is True and uri not in _SUPPORTED_VOCABULARIES
    }
    if unsupported:
        raise PaperSchemaConfigurationError(
            "fixture meta-schema requires an unsupported vocabulary"
        )
    custom_names = {
        key
        for key in _require_object(
            meta_schema.get("properties"), "fixture meta-schema properties"
        )
        if key.startswith("mp")
    }
    if custom_names != _CUSTOM_KEYWORDS or set(_CUSTOM_VALIDATORS) != _CUSTOM_KEYWORDS:
        raise PaperSchemaConfigurationError(
            "custom vocabulary implementation is not exact"
        )
    meta_references = set(_iter_references(meta_schema))
    if not meta_references or not meta_references <= _OFFICIAL_META_REFERENCES:
        raise PaperSchemaConfigurationError(
            "fixture meta-schema references are not the closed official set"
        )
    try:
        Draft202012Validator.check_schema(meta_schema)
    except (SchemaError, Unresolvable) as exc:
        raise PaperSchemaConfigurationError("fixture meta-schema is invalid") from exc


def _check_fixture_schema(meta_validator: Any, schema: Mapping[str, Any]) -> None:
    """Validate one schema with the already-compiled fixture meta-schema."""

    error = next(meta_validator.iter_errors(schema), None)
    if error is not None:
        raise SchemaError.create_from(error)


def _validate_registry(registry: dict[str, Any]) -> None:
    expected_keys = {
        "$schema",
        "$id",
        "schemaVersion",
        "profile",
        "policyId",
        "localOnly",
        "formatAssertion",
        "schemas",
        "rules",
    }
    if set(registry) != expected_keys:
        raise PaperSchemaConfigurationError("registry.json has an unexpected shape")
    if (
        registry.get("$schema") != "https://json-schema.org/draft/2020-12/schema"
        or registry.get("$id") != "urn:marketpilot:paper-intent-fixture:v1:registry"
        or registry.get("schemaVersion") != 1
        or registry.get("profile") != PROFILE
        or registry.get("policyId") != "FIXTURE_LONG_US_EQUITY_100_V1"
        or registry.get("localOnly") is not True
        or registry.get("formatAssertion") is not True
        or registry.get("schemas") != _SCHEMA_FILES
        or registry.get("rules") != _EXPECTED_RULES
    ):
        raise PaperSchemaConfigurationError(
            "registry.json identity or schema map is invalid"
        )


def _validate_local_references(
    schemas: Mapping[str, dict[str, Any]], registry: Registry[Any]
) -> None:
    local_ids = frozenset(_SCHEMA_IDS.values())
    for name, schema in schemas.items():
        base_uri = _SCHEMA_IDS[name]
        resolver = registry.resolver(base_uri=base_uri)
        for reference in _iter_references(schema):
            if reference.startswith("#"):
                target_uri = base_uri
            else:
                target_uri = reference.split("#", 1)[0]
            if target_uri not in local_ids:
                raise PaperSchemaConfigurationError(
                    f"{name} contains a non-local schema reference"
                )
            try:
                resolver.lookup(reference)
            except Exception as exc:
                raise PaperSchemaConfigurationError(
                    f"{name} contains an unresolved schema reference"
                ) from exc


def _validate_vocabulary_vectors(
    vectors_document: dict[str, Any],
    validator_class: Any,
    meta_validator: Any,
    registry: Registry[Any],
) -> None:
    if set(vectors_document) != {"schemaVersion", "vocabulary", "vectors"}:
        raise PaperSchemaConfigurationError(
            "custom vocabulary vectors have an unexpected shape"
        )
    if (
        vectors_document.get("schemaVersion") != 1
        or vectors_document.get("vocabulary") != VOCABULARY_ID
        or type(vectors_document.get("vectors")) is not list
    ):
        raise PaperSchemaConfigurationError(
            "custom vocabulary vector identity is invalid"
        )
    vectors = vectors_document["vectors"]
    if not vectors:
        raise PaperSchemaConfigurationError("custom vocabulary vector set is empty")
    seen_ids: set[str] = set()
    covered_keywords: set[str] = set()
    vector_validators: dict[str, Any] = {}
    for vector in vectors:
        item = _require_object(vector, "custom vocabulary vector")
        if set(item) != {"id", "keyword", "schema", "value", "valid"}:
            raise PaperSchemaConfigurationError(
                "custom vocabulary vector shape is invalid"
            )
        vector_id = item.get("id")
        keyword = item.get("keyword")
        vector_schema = item.get("schema")
        expected = item.get("valid")
        if (
            not isinstance(vector_id, str)
            or not vector_id
            or vector_id in seen_ids
            or keyword not in _CUSTOM_KEYWORDS
            or type(vector_schema) is not dict
            or type(expected) is not bool
        ):
            raise PaperSchemaConfigurationError(
                "custom vocabulary vector value is invalid"
            )
        if not list(_iter_keyword_values(vector_schema, keyword)):
            raise PaperSchemaConfigurationError(
                "custom vocabulary vector omits its keyword"
            )
        if any(
            list(_iter_keyword_values(vector_schema, other))
            for other in _CUSTOM_KEYWORDS - {keyword}
        ):
            raise PaperSchemaConfigurationError(
                "custom vocabulary vector mixes keywords"
            )
        _check_custom_schema_usage(vector_schema, f"vocabulary vector {vector_id}")
        schema_key = json.dumps(
            vector_schema,
            ensure_ascii=True,
            sort_keys=True,
            separators=(",", ":"),
        )
        try:
            vector_validator = vector_validators.get(schema_key)
            if vector_validator is None:
                _check_fixture_schema(meta_validator, vector_schema)
                vector_validator = validator_class(
                    vector_schema,
                    registry=registry,
                    format_checker=_FORMAT_CHECKER,
                )
                vector_validators[schema_key] = vector_validator
            actual = vector_validator.is_valid(item["value"])
        except (SchemaError, Unresolvable) as exc:
            raise PaperSchemaConfigurationError(
                f"custom vocabulary vector schema is invalid: {vector_id}"
            ) from exc
        if actual is not expected:
            raise PaperSchemaConfigurationError(
                f"custom vocabulary vector failed: {vector_id}"
            )
        seen_ids.add(vector_id)
        covered_keywords.add(keyword)
    if covered_keywords != _CUSTOM_KEYWORDS:
        raise PaperSchemaConfigurationError(
            "custom vocabulary vectors lack keyword coverage"
        )


def _build_runtime(directory: Path) -> _SchemaRuntime:
    if unicodedata.unidata_version != "17.0.0":
        raise PaperSchemaConfigurationError(
            "Python Unicode normalization data must be exactly 17.0.0"
        )
    raw_files = _load_inventory(directory)
    registry_document = _require_object(
        _strict_json_bytes(raw_files["registry.json"], "registry.json"),
        "registry.json",
    )
    _validate_registry(registry_document)
    meta_schema = _require_object(
        _strict_json_bytes(
            raw_files["fixture-meta.schema.json"], "fixture-meta.schema.json"
        ),
        "fixture-meta.schema.json",
    )
    _validate_meta_schema(meta_schema)

    schemas: dict[str, dict[str, Any]] = {}
    resources: list[tuple[str, Resource[Any]]] = [
        (
            META_SCHEMA_ID,
            Resource(contents=meta_schema, specification=DRAFT202012),
        )
    ]
    for name, relative in _SCHEMA_FILES.items():
        schema = _require_object(
            _strict_json_bytes(raw_files[relative], relative), relative
        )
        if (
            schema.get("$schema") != META_SCHEMA_ID
            or schema.get("$id") != _SCHEMA_IDS[name]
        ):
            raise PaperSchemaConfigurationError(
                f"{relative} has an invalid schema identity"
            )
        _check_custom_schema_usage(schema, relative)
        schemas[name] = schema
        resources.append(
            (
                _SCHEMA_IDS[name],
                Resource(contents=schema, specification=DRAFT202012),
            )
        )

    local_registry: Registry[Any] = Registry().with_resources(resources)
    _validate_local_references(schemas, local_registry)

    validator_class = validators.extend(Draft202012Validator, _CUSTOM_VALIDATORS)
    validator_class.META_SCHEMA = meta_schema
    meta_validator = Draft202012Validator(
        meta_schema,
        registry=validators.SPECIFICATIONS.crawl(),
        format_checker=Draft202012Validator.FORMAT_CHECKER,
    )
    compiled: dict[str, Any] = {}
    for name, schema in schemas.items():
        try:
            _check_fixture_schema(meta_validator, schema)
        except (SchemaError, Unresolvable) as exc:
            raise PaperSchemaConfigurationError(f"{name} schema is invalid") from exc
        compiled[name] = validator_class(
            schema,
            registry=local_registry,
            format_checker=_FORMAT_CHECKER,
        )

    vectors_document = _require_object(
        _strict_json_bytes(
            raw_files["custom-vocabulary-vectors.json"],
            "custom-vocabulary-vectors.json",
        ),
        "custom-vocabulary-vectors.json",
    )
    _validate_vocabulary_vectors(
        vectors_document,
        validator_class,
        meta_validator,
        local_registry,
    )
    return _SchemaRuntime(validators=compiled)


@lru_cache(maxsize=1)
def _runtime() -> _SchemaRuntime:
    return _build_runtime(CONTRACT_DIRECTORY)


def schema_names() -> tuple[str, ...]:
    """Return the frozen registered schema names in registry order."""

    return tuple(_SCHEMA_FILES)


def validate_instance(schema_name: str, instance: Any) -> None:
    """Validate one instance or raise a redaction-safe validation error."""

    validator = _runtime().validators.get(schema_name)
    if validator is None:
        raise PaperSchemaConfigurationError(f"unknown schema name: {schema_name}")
    try:
        error = next(validator.iter_errors(instance), None)
    except Exception as exc:
        raise PaperSchemaConfigurationError("schema evaluation failed closed") from exc
    if error is not None:
        raise PaperSchemaValidationError(schema_name)


def is_valid_instance(schema_name: str, instance: Any) -> bool:
    """Return whether an instance satisfies a registered schema."""

    try:
        validate_instance(schema_name, instance)
    except PaperSchemaValidationError:
        return False
    return True


def _probe(raw: bytes) -> tuple[int, Any]:
    if len(raw) > _MAX_PROBE_BYTES:
        return 2, {"error": "PROBE_INPUT_INVALID"}
    try:
        value = json.loads(
            raw.decode("utf-8", errors="strict"),
            object_pairs_hook=_object_from_pairs,
            parse_constant=_reject_json_constant,
        )
        if type(value) is not list or len(value) > _MAX_PROBE_ITEMS:
            raise ValueError("probe input must be a bounded array")
        results: list[dict[str, Any]] = []
        for item in value:
            if type(item) is not dict or set(item) != {"schemaName", "instance"}:
                raise ValueError("probe item shape is invalid")
            schema_name = item["schemaName"]
            if not isinstance(schema_name, str) or schema_name not in _SCHEMA_FILES:
                raise ValueError("probe schema name is invalid")
            results.append(
                {
                    "schemaName": schema_name,
                    "valid": is_valid_instance(schema_name, item["instance"]),
                }
            )
        return 0, results
    except (
        UnicodeDecodeError,
        ValueError,
        json.JSONDecodeError,
        _DuplicateJsonKey,
        RecursionError,
    ):
        return 2, {"error": "PROBE_INPUT_INVALID"}


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Validate fixture paper-contract instances without domain evaluation."
    )
    parser.add_argument(
        "--probe",
        action="store_true",
        help="read a batch of {schemaName, instance} objects from standard input",
    )
    arguments = parser.parse_args(argv)
    if not arguments.probe:
        parser.error("--probe is required")
    raw = sys.stdin.buffer.read(_MAX_PROBE_BYTES + 1)
    code, result = _probe(raw)
    sys.stdout.write(
        json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n"
    )
    return code


if __name__ == "__main__":  # pragma: no cover - exercised through the probe process
    raise SystemExit(main())
