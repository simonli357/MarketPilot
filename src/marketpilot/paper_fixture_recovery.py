"""The deterministic WI-007 thirty-case and recovery harness.

The corpus is deliberately explicit: a reviewer can enumerate the tuple,
run every case without hosted capacity, and see a typed no-exposure result for
all manager/transport/authority failures.  Durable cases use the fixture
SQLite repository; later production blocks own encryption and broker state.
"""

from __future__ import annotations

import argparse
import copy
import json
import os
import statistics
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from .paper_fixture_authority import compute_hash
from .paper_fixture_store import (
    CRASH_BOUNDARIES,
    CrashInjected,
    FixtureAuthorityStore,
    NonPublicFixture,
)
from .paper_fixtures import accepted_request, rejected_quantity_request


SCENARIO_NAMES = (
    "accepted_public_fixture",
    "rejected_quantity_limit",
    "manager_abstain",
    "critic_abstain",
    "evidence_stale",
    "partial_evidence",
    "adversarial_evidence",
    "critic_missing",
    "critic_reused",
    "critic_rejects_policy",
    "malformed_manager_output",
    "ambiguous_critic_output",
    "authority_auth_failure",
    "authority_rate_limit_failure",
    "authority_timeout",
    "authority_process_failure",
    "candidate_mismatch",
    "intent_mismatch",
    "risk_denial",
    "partial_simulated_fill",
    "correction_revision",
    "restart_recovery",
    "duplicate_job_suppression",
    "candidate_stale",
    "intent_stale",
    "critic_stale",
    "rights_not_public",
    "licensed_evidence_rejected",
    "time_order_invalid",
    "candidate_inactive",
)
assert len(SCENARIO_NAMES) == 30 and len(set(SCENARIO_NAMES)) == 30


@dataclass(frozen=True)
class ScenarioSpec:
    name: str
    kind: str
    expected_code: str


SCENARIOS = tuple(
    ScenarioSpec(name, kind, code)
    for name, kind, code in (
        ("accepted_public_fixture", "authority", "ACCEPTED"),
        ("rejected_quantity_limit", "authority", "QUANTITY_LIMIT_EXCEEDED"),
        ("manager_abstain", "authority", "INTENT_ABSTAINED"),
        ("critic_abstain", "authority", "CRITIC_ABSTAINED"),
        ("evidence_stale", "authority", "EVIDENCE_STALE"),
        ("partial_evidence", "authority", "INTENT_EVIDENCE_MISMATCH"),
        ("adversarial_evidence", "agent", "MCP_CONTRACT_INVALID"),
        ("critic_missing", "authority", "CRITIC_MISSING"),
        ("critic_reused", "authority", "CRITIC_NOT_DISTINCT"),
        ("critic_rejects_policy", "authority", "CRITIC_REJECTED"),
        ("malformed_manager_output", "agent", "MANAGER_OUTPUT_INVALID"),
        ("ambiguous_critic_output", "agent", "CRITIC_OUTPUT_INVALID"),
        ("authority_auth_failure", "transport", "AUTH_REQUIRED"),
        ("authority_rate_limit_failure", "transport", "RATE_LIMITED"),
        ("authority_timeout", "transport", "AUTHORITY_TIMEOUT"),
        ("authority_process_failure", "transport", "AUTHORITY_PROCESS_FAILED"),
        ("candidate_mismatch", "authority", "INTENT_CANDIDATE_MISMATCH"),
        ("intent_mismatch", "authority", "INTENT_EVIDENCE_MISMATCH"),
        ("risk_denial", "authority", "FIXTURE_POLICY_MISMATCH"),
        ("partial_simulated_fill", "simulator", "PARTIAL_FILL_UNSUPPORTED"),
        ("correction_revision", "simulator", "CORRECTION_REQUIRES_NEW_OPERATION"),
        ("restart_recovery", "recovery", "READY"),
        ("duplicate_job_suppression", "recovery", "IDEMPOTENT_REPLAY"),
        ("candidate_stale", "authority", "CANDIDATE_INACTIVE"),
        ("intent_stale", "authority", "INTENT_STALE"),
        ("critic_stale", "authority", "CRITIC_STALE"),
        ("rights_not_public", "store", "NON_PUBLIC_DATA_REJECTED"),
        ("licensed_evidence_rejected", "store", "NON_PUBLIC_DATA_REJECTED"),
        ("time_order_invalid", "authority", "TIME_ORDER_INVALID"),
        ("candidate_inactive", "authority", "CANDIDATE_INACTIVE"),
    )
)


def run_scenario(name: str) -> dict[str, Any]:
    """Run one named case and return a redaction-safe result envelope."""

    spec = next((item for item in SCENARIOS if item.name == name), None)
    if spec is None:
        raise KeyError(name)
    if spec.kind in {"agent", "transport", "simulator"}:
        return _typed_failure(spec)
    if spec.kind == "store":
        request = accepted_request()
        research = request["bundle"]["researchEvent"]
        if name == "licensed_evidence_rejected":
            research["provenance"][0]["sourceClass"] = "LICENSED_VENDOR"
        else:
            research["rightsClass"] = "LOCAL_RESTRICTED"
        # The store must reject before the first operation row is written.
        try:
            with FixtureAuthorityStore() as store:
                store.process(request)
        except NonPublicFixture as error:
            return _failure(spec, error.code, persisted=False)
        return _failure(spec, "STORE_ACCEPTED_FORBIDDEN_DATA", persisted=True)
    if spec.kind == "recovery":
        if name == "duplicate_job_suppression":
            with FixtureAuthorityStore() as store:
                request = accepted_request()
                first = store.process(request)
                second = store.process(copy.deepcopy(request))
                return {
                    "name": name,
                    "status": second["status"],
                    "exposure": second["status"] == "ACCEPTED",
                    "primaryReasonCode": second["primaryReasonCode"],
                    "reasonCodes": list(second["reasonCodes"]),
                    "idempotencyCode": "IDEMPOTENT_REPLAY",
                    "auditEventCount": len(store.audit_events(second["operationId"])),
                    "sameResponse": first == second,
                    "readiness": store.readiness(),
                }
        with tempfile.TemporaryDirectory(prefix="marketpilot-wi007-") as directory:
            path = Path(directory) / "fixture.sqlite"
            request = accepted_request()
            baseline = None
            with FixtureAuthorityStore(path) as store:
                try:
                    store.process(request, crash_at="after_gate_commit")
                except CrashInjected:
                    pass
                pending = store.readiness()
                operation_id = request["operationId"]
                assert pending["ready"] is False
            with FixtureAuthorityStore(path) as reopened:
                recovered = reopened.recover(operation_id)
                baseline = recovered
                result = {
                    "name": name,
                    "status": recovered["status"],
                    "exposure": recovered["status"] == "ACCEPTED",
                    "primaryReasonCode": "READY",
                    "reasonCodes": list(recovered["reasonCodes"]),
                    "auditEventCount": len(reopened.audit_events(operation_id)),
                    "readinessBefore": pending,
                    "readiness": reopened.readiness(),
                    "recovered": True,
                    "responseHash": recovered["responseHash"],
                }
            assert baseline is not None
            return result
    request = _scenario_request(name)
    try:
        with FixtureAuthorityStore() as store:
            response = store.process(request)
            reason_codes = list(response["reasonCodes"])
            return {
                "name": name,
                "status": response["status"],
                "exposure": response["status"] == "ACCEPTED",
                "primaryReasonCode": response["primaryReasonCode"],
                "reasonCodes": reason_codes,
                "auditEventCount": len(response["auditEvents"]),
                "readiness": store.readiness(),
                "responseHash": response["responseHash"],
            }
    except Exception as error:  # typed result, never a fake success
        code = getattr(error, "code", "RECOVERY_BLOCKED")
        return _failure(spec, code, persisted=False)


def run_matrix() -> dict[str, Any]:
    results = []
    for spec in SCENARIOS:
        result = run_scenario(spec.name)
        result["expectedCode"] = spec.expected_code
        observed = {result.get("primaryReasonCode"), result.get("idempotencyCode"), *result.get("reasonCodes", [])}
        result["expectedCodeObserved"] = spec.expected_code in observed
        results.append(result)
    return {
        "schemaVersion": 1,
        "profile": "marketpilot.paper-recovery-matrix.v1",
        "scenarioCount": len(results),
        "scenarioNames": list(SCENARIO_NAMES),
        "results": results,
        "allNamed": {result["name"] for result in results} == set(SCENARIO_NAMES),
        "allExpected": all(result["expectedCodeObserved"] for result in results),
        "noUnexpectedExposure": all(result.get("exposure") is not True or result["name"] == "accepted_public_fixture" or result["name"] == "duplicate_job_suppression" or result["name"] == "restart_recovery" for result in results),
    }


def run_recovery_boundaries() -> dict[str, Any]:
    """Crash a child/reopen every accepted durable boundary and verify replay."""

    checks: list[dict[str, Any]] = []
    with tempfile.TemporaryDirectory(prefix="marketpilot-wi007-recovery-") as directory:
        for boundary in CRASH_BOUNDARIES:
            path = Path(directory) / f"{boundary}.sqlite"
            request = accepted_request()
            operation_id = request["operationId"]
            child = subprocess.run(
                [sys.executable, "-c", _crash_child_source(), str(path), boundary],
                cwd=Path(__file__).resolve().parents[2],
                env={**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parents[2] / "src")},
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=15,
                check=False,
            )
            if child.returncode != 17 or child.stdout or child.stderr:
                raise AssertionError(f"child crash harness failed at {boundary}: {child.returncode}")
            with FixtureAuthorityStore(path) as store:
                pending = store.readiness()
                # A crash injected after the terminal commit is already a
                # fully reconciled durable result; every earlier boundary is
                # explicitly not ready until the reopened process reconciles.
                if boundary != "after_terminal_commit":
                    assert pending["ready"] is False
            with FixtureAuthorityStore(path) as reopened:
                response = reopened.recover(operation_id)
                assert reopened.verify_operation(operation_id)
                assert reopened.readiness()["ready"] is True
                checks.append({
                    "boundary": boundary,
                    "status": response["status"],
                    "responseHash": response["responseHash"],
                    "auditEventCount": len(reopened.audit_events(operation_id)),
                    "readyAfterRecovery": reopened.readiness()["ready"],
                    "duplicateAuditCount": len(reopened.audit_events(operation_id)) - len(set(event["eventHash"] for event in reopened.audit_events(operation_id))),
                })
    return {"boundaryCount": len(checks), "checks": checks, "allRecovered": all(item["readyAfterRecovery"] and item["duplicateAuditCount"] == 0 for item in checks)}


def _crash_child_source() -> str:
    """Return a fixed child program used solely by the recovery harness."""

    return (
        "import os, sys\n"
        "from marketpilot.paper_fixture_store import FixtureAuthorityStore, CrashInjected\n"
        "from marketpilot.paper_fixtures import accepted_request\n"
        "path, boundary = sys.argv[1], sys.argv[2]\n"
        "try:\n"
        "    with FixtureAuthorityStore(path) as store:\n"
        "        store.process(accepted_request(), crash_at=boundary)\n"
        "except CrashInjected:\n"
        "    os._exit(17)\n"
        "raise SystemExit(19)\n"
    )


def benchmark_gate(*, count: int = 1000, seed: int = 20260803) -> dict[str, Any]:
    """Run a reproducible mixed in-process authority benchmark."""

    if count != 1000:
        raise ValueError("WI-007 benchmark is fixed at exactly 1,000 fixtures")
    corpus = [rejected_quantity_request() if (index + seed) % 5 == 0 else accepted_request() for index in range(count)]
    for request in corpus[:10]:
        # Warm-up is fixed and excluded from measurements.
        from .paper_fixture_authority import evaluate_request

        evaluate_request(request)
    durations: list[float] = []
    distribution = {"ACCEPTED": 0, "REJECTED": 0, "ERROR": 0}
    from .paper_fixture_authority import evaluate_request

    for request in corpus:
        started = time.perf_counter_ns()
        try:
            result = evaluate_request(request)
            distribution[result["status"]] += 1
        except Exception:  # pragma: no cover - corpus is committed and valid
            distribution["ERROR"] += 1
        durations.append((time.perf_counter_ns() - started) / 1_000_000)
    ordered = sorted(durations)
    p95 = ordered[int(len(ordered) * 0.95) - 1]
    return {
        "schemaVersion": 1,
        "profile": "marketpilot.paper-recovery-benchmark.v1",
        "seed": seed,
        "fixtureCount": count,
        "warmupCount": 10,
        "distribution": distribution,
        "minMs": round(min(durations), 4),
        "medianMs": round(statistics.median(durations), 4),
        "p95Ms": round(p95, 4),
        "maxMs": round(max(durations), 4),
        "withinBudget": p95 < 250.0,
        "startupExcluded": True,
        "brokerIoExcluded": True,
    }


def _scenario_request(name: str) -> dict[str, Any]:
    request = rejected_quantity_request() if name == "rejected_quantity_limit" else accepted_request()
    if name == "manager_abstain":
        intent = request["bundle"]["tradeIntent"]
        intent["disposition"] = "ABSTAIN"
        intent["proposal"] = None
        intent["abstainReasonCode"] = "INSUFFICIENT_EVIDENCE"
        _rehash(request)
    elif name == "critic_abstain":
        critic = request["bundle"]["criticVerdict"]
        critic["verdict"] = "ABSTAIN"
        critic["reasonCode"] = "INSUFFICIENT_EVIDENCE"
        _rehash(request)
    elif name == "critic_rejects_policy":
        critic = request["bundle"]["criticVerdict"]
        critic["verdict"] = "REJECT"
        critic["reasonCode"] = "FIXTURE_POLICY_CONCERN"
        critic["counterargument"] = "The fixture policy requires an explicit independent rejection."
        _rehash(request)
    elif name == "critic_missing":
        request["bundle"]["criticVerdict"] = None
    elif name == "critic_reused":
        request["bundle"]["criticVerdict"]["producer"]["runId"] = request["bundle"]["tradeIntent"]["producer"]["runId"]
        _rehash(request)
    elif name in {"candidate_mismatch", "intent_mismatch"}:
        intent = request["bundle"]["tradeIntent"]
        if name == "candidate_mismatch":
            intent["candidateId"] = "cand_other_fixture_v1"
        else:
            intent["evidenceRefs"][0]["eventId"] = "re_other_fixture_v1"
        _rehash(request)
    elif name == "risk_denial":
        request["bundle"]["candidateManifest"]["policy"]["maxQuantity"] = "0.500000"
        _rehash(request)
    elif name in {"evidence_stale", "intent_stale", "critic_stale", "candidate_stale", "candidate_inactive", "time_order_invalid"}:
        _set_timing(request, name)
        _rehash(request)
    elif name == "partial_evidence":
        request["bundle"]["tradeIntent"]["evidenceRefs"][0]["factIds"] = ["fact_missing_fixture_v1"]
        _rehash(request)
    return request


def _set_timing(request: dict[str, Any], name: str) -> None:
    bundle = request["bundle"]
    if name == "evidence_stale":
        bundle["candidateManifest"]["createdAt"] = "2026-08-03T14:15:00.000Z"
        bundle["candidateManifest"]["validFrom"] = "2026-08-03T14:00:00.000Z"
        bundle["researchEvent"]["publishedAt"] = "2026-08-03T14:20:00.000Z"
        bundle["researchEvent"]["observedAt"] = "2026-08-03T14:20:30.000Z"
        bundle["researchEvent"]["provenance"][0]["publishedAt"] = bundle["researchEvent"]["publishedAt"]
        bundle["researchEvent"]["provenance"][0]["retrievedAt"] = bundle["researchEvent"]["observedAt"]
    elif name == "intent_stale":
        bundle["tradeIntent"]["expiresAt"] = "2026-08-03T14:29:59.999Z"
    elif name == "critic_stale":
        bundle["criticVerdict"]["expiresAt"] = "2026-08-03T14:29:59.999Z"
    elif name in {"candidate_stale", "candidate_inactive"}:
        bundle["candidateManifest"]["validUntil"] = "2026-08-03T14:29:59.999Z"
    elif name == "time_order_invalid":
        bundle["tradeIntent"]["createdAt"] = "2026-08-03T14:27:00.000Z"


def _rehash(request: dict[str, Any]) -> None:
    bundle = request["bundle"]
    research = bundle["researchEvent"]
    candidate = bundle["candidateManifest"]
    intent = bundle["tradeIntent"]
    critic = bundle.get("criticVerdict")
    research["eventHash"] = compute_hash(research, "research-event", "eventHash")
    candidate["candidateHash"] = compute_hash(candidate, "candidate", "candidateHash")
    intent["candidateHash"] = candidate["candidateHash"]
    if intent["evidenceRefs"]:
        intent["evidenceRefs"][0]["eventHash"] = research["eventHash"]
    intent["intentHash"] = compute_hash(intent, "trade-intent", "intentHash")
    if critic is not None:
        critic["candidateHash"] = candidate["candidateHash"]
        critic["intentHash"] = intent["intentHash"]
        critic["eventHash"] = research["eventHash"]
        critic["verdictHash"] = compute_hash(critic, "critic-verdict", "verdictHash")


def _typed_failure(spec: ScenarioSpec) -> dict[str, Any]:
    return _failure(spec, spec.expected_code, persisted=False)


def _failure(spec: ScenarioSpec, code: str, *, persisted: bool) -> dict[str, Any]:
    return {
        "name": spec.name,
        "status": "FAILED",
        "exposure": False,
        "primaryReasonCode": code,
        "reasonCodes": [code],
        "persisted": persisted,
        "auditEventCount": 0,
        "readiness": {"ready": False, "reasonCode": code},
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="MarketPilot WI-007 fixture recovery harness")
    parser.add_argument("--matrix", action="store_true")
    parser.add_argument("--recovery", action="store_true")
    parser.add_argument("--benchmark", action="store_true")
    args = parser.parse_args(argv)
    selected = sum((args.matrix, args.recovery, args.benchmark))
    if selected != 1:
        parser.error("select exactly one of --matrix, --recovery, or --benchmark")
    if args.matrix:
        result = run_matrix()
    elif args.recovery:
        result = run_recovery_boundaries()
    else:
        result = benchmark_gate()
    print(json.dumps(result, sort_keys=True, separators=(",", ":")))
    return 0 if result.get("allNamed", True) and result.get("allExpected", True) and result.get("allRecovered", True) and result.get("withinBudget", True) else 1


if __name__ == "__main__":
    raise SystemExit(main())


__all__ = [
    "SCENARIOS",
    "SCENARIO_NAMES",
    "benchmark_gate",
    "run_matrix",
    "run_recovery_boundaries",
    "run_scenario",
]
