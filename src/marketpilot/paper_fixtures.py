"""Committed synthetic WI-005 request builders.

The builders are intentionally boring and deterministic.  They are useful for
cross-runtime tests and the headless fixture CLI; they contain no market feed,
account, broker, or production state.
"""

from __future__ import annotations

from copy import deepcopy

from .paper_fixture_authority import PROFILE, POLICY_ID, canonical_json_bytes, compute_hash, evaluate_request


DECISION_AT = "2026-08-03T14:30:00.000Z"


def _hash(artifact: dict, field: str, domain: str) -> dict:
    artifact[field] = compute_hash(artifact, domain, field)
    return artifact


def accepted_request(*, quantity: str = "1.000000") -> dict:
    provenance = [
        {
            "provenanceId": "prov_fixture_public_v1",
            "sourceId": "fixture.public",
            "sourceClass": "PUBLIC_OFFICIAL",
            "sourceRef": "fixture://public-official/mptest/v1",
            "sourceRevision": "fixture-v1",
            "publishedAt": "2026-08-03T14:27:00.000Z",
            "retrievedAt": "2026-08-03T14:27:30.000Z",
            "contentHash": "0" * 64,
        }
    ]
    research = {
        "schemaVersion": 1,
        "profile": PROFILE,
        "artifactType": "ResearchEvent",
        "eventId": "re_fixture_notice_v1",
        "eventHash": "0" * 64,
        "producer": {"kind": "FIXTURE_SOURCE", "runId": "run_fixture_source_v1"},
        "instrumentId": "MPTEST",
        "assetClass": "US_PRIMARY_LISTED_COMMON_STOCK",
        "currency": "USD",
        "eventKind": "FIXTURE_ISSUER_NOTICE",
        "revisionId": "rev_fixture_notice_v1",
        "supersedesEventId": None,
        "rightsClass": "PUBLIC_OFFICIAL",
        "publishedAt": "2026-08-03T14:27:00.000Z",
        "observedAt": "2026-08-03T14:27:30.000Z",
        "facts": [
            {"factId": "fact_ask_price_v1", "kind": "ASK_PRICE_USD", "value": "99.2500", "rightsClass": "PUBLIC_OFFICIAL", "provenanceId": "prov_fixture_public_v1"},
            {"factId": "fact_notice_text_v1", "kind": "NOTICE_TEXT", "value": "Synthetic public issuer notice for MPTEST.", "rightsClass": "PUBLIC_OFFICIAL", "provenanceId": "prov_fixture_public_v1"},
            {"factId": "fact_reference_price_v1", "kind": "REFERENCE_PRICE_USD", "value": "99.0000", "rightsClass": "PUBLIC_OFFICIAL", "provenanceId": "prov_fixture_public_v1"},
        ],
        "provenance": provenance,
    }
    _hash(research, "eventHash", "research-event")
    candidate = {
        "schemaVersion": 1,
        "profile": PROFILE,
        "artifactType": "CandidateManifest",
        "candidateId": "cand_fixture_mptest_v1",
        "candidateHash": "0" * 64,
        "producer": {"kind": "FIXTURE_REGISTRY", "runId": "run_fixture_registry_v1"},
        "createdAt": "2026-08-03T14:25:00.000Z",
        "validFrom": "2026-08-03T14:00:00.000Z",
        "validUntil": "2026-08-03T15:00:00.000Z",
        "mode": "PAPER",
        "liveEligible": False,
        "strategyKind": "FIXTURE_LONG_US_EQUITY",
        "instrumentId": "MPTEST",
        "assetClass": "US_PRIMARY_LISTED_COMMON_STOCK",
        "currency": "USD",
        "policy": {
            "policyId": POLICY_ID,
            "allowedAction": "OPEN_LONG",
            "side": "BUY",
            "session": "REGULAR",
            "maxQuantity": "1.000000",
            "maxGrossNotionalUsd": "100.00",
            "buyCollarRatio": "0.005000",
        },
    }
    _hash(candidate, "candidateHash", "candidate")
    intent = {
        "schemaVersion": 1,
        "profile": PROFILE,
        "artifactType": "TradeIntent",
        "intentId": "ti_fixture_mptest_v1",
        "intentHash": "0" * 64,
        "producer": {"kind": "MANAGER", "runId": "run_fixture_manager_v1"},
        "operationId": "op_fixture_mptest_v1",
        "createdAt": "2026-08-03T14:29:15.000Z",
        "expiresAt": "2026-08-03T14:30:15.000Z",
        "candidateId": candidate["candidateId"],
        "candidateHash": candidate["candidateHash"],
        "disposition": "PROPOSE",
        "proposal": {
            "action": "OPEN_LONG",
            "instrumentId": "MPTEST",
            "assetClass": "US_PRIMARY_LISTED_COMMON_STOCK",
            "currency": "USD",
            "side": "BUY",
            "session": "REGULAR",
            "quantity": quantity,
            "maximumEntryPrice": "99.4950",
        },
        "abstainReasonCode": None,
        "thesis": "Synthetic fixture evidence supports a bounded paper entry.",
        "evidenceRefs": [
            {
                "eventId": research["eventId"],
                "eventHash": research["eventHash"],
                "factIds": [item["factId"] for item in research["facts"]],
            }
        ],
    }
    _hash(intent, "intentHash", "trade-intent")
    critic = {
        "schemaVersion": 1,
        "profile": PROFILE,
        "artifactType": "CriticVerdict",
        "verdictId": "cv_fixture_mptest_v1",
        "verdictHash": "0" * 64,
        "producer": {"kind": "CRITIC", "runId": "run_fixture_critic_v1"},
        "operationId": intent["operationId"],
        "createdAt": "2026-08-03T14:29:45.000Z",
        "expiresAt": "2026-08-03T14:30:15.000Z",
        "candidateId": candidate["candidateId"],
        "candidateHash": candidate["candidateHash"],
        "intentId": intent["intentId"],
        "intentHash": intent["intentHash"],
        "eventId": research["eventId"],
        "eventHash": research["eventHash"],
        "verdict": "APPROVE",
        "reasonCode": "NO_BLOCKING_ISSUE",
        "counterargument": "No blocking fixture-policy or evidence issue was found.",
        "evidenceFactIds": [item["factId"] for item in research["facts"]],
    }
    _hash(critic, "verdictHash", "critic-verdict")
    return {
        "schemaVersion": 1,
        "profile": PROFILE,
        "policyId": POLICY_ID,
        "messageType": "EVALUATE_FIXTURE_PAPER_INTENT",
        "requestId": "req_fixture_mptest_v1",
        "operationId": intent["operationId"],
        "decisionAt": DECISION_AT,
        "bundle": {
            "researchEvent": research,
            "candidateManifest": candidate,
            "tradeIntent": intent,
            "criticVerdict": critic,
        },
    }


def rejected_quantity_request() -> dict:
    return accepted_request(quantity="2.000000")


def fixture_report(quantity: str = "1.000000") -> dict:
    """Return a compact redaction-safe fixture report for a reviewer."""
    response = evaluate_request(accepted_request(quantity=quantity))
    return {
        "requestId": response["requestId"],
        "operationId": response["operationId"],
        "status": response["status"],
        "primaryReasonCode": response["primaryReasonCode"],
        "reasonCodes": response["reasonCodes"],
        "requestHash": response["requestHash"],
        "eventId": response["gateDecision"]["inputRefs"]["eventId"],
        "candidateId": response["gateDecision"]["inputRefs"]["candidateId"],
        "intentId": response["gateDecision"]["inputRefs"]["intentId"],
        "verdictId": response["gateDecision"]["inputRefs"]["verdictId"],
        "gateDecisionId": response["gateDecision"]["decisionId"],
        "orderPlanId": None if response["orderPlan"] is None else response["orderPlan"]["planId"],
        "executionId": None if response["executionEvent"] is None else response["executionEvent"]["executionId"],
        "auditHeadHash": response["headHash"],
    }


__all__ = ["DECISION_AT", "accepted_request", "rejected_quantity_request", "fixture_report"]
