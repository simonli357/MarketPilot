"""Focused stdlib tests for the WI-005 Python authority."""

from __future__ import annotations

import copy
import json
import subprocess
import sys
import unittest
from collections.abc import Callable
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "src"))

import marketpilot.paper_fixture_authority as authority  # noqa: E402
from marketpilot.paper_fixture_authority import (  # noqa: E402
    InputContractError,
    canonical_json_bytes,
    compute_hash,
    evaluate_request,
    verify_response,
)
from marketpilot.paper_fixtures import accepted_request, rejected_quantity_request  # noqa: E402


Mutation = Callable[[dict[str, Any]], None]

EXPECTED_DOMAIN_REASON_CODES = (
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


def _set_path(value: dict[str, Any], path: tuple[str, ...], replacement: Any) -> None:
    target = value
    for key in path[:-1]:
        target = target[key]
    target[path[-1]] = copy.deepcopy(replacement)


def _set_fields(*changes: tuple[tuple[str, ...], Any]) -> Mutation:
    def mutate(request: dict[str, Any]) -> None:
        for path, replacement in changes:
            _set_path(request, path, replacement)

    return mutate


def _fact(request: dict[str, Any], kind: str) -> dict[str, Any]:
    return next(
        item
        for item in request["bundle"]["researchEvent"]["facts"]
        if item["kind"] == kind
    )


def _rehash_linked(request: dict[str, Any]) -> None:
    """Re-hash the mutated fixture without repairing deliberately changed IDs."""

    bundle = request["bundle"]
    research = bundle["researchEvent"]
    candidate = bundle["candidateManifest"]
    intent = bundle["tradeIntent"]
    critic = bundle["criticVerdict"]

    research["eventHash"] = compute_hash(research, "research-event", "eventHash")
    candidate["candidateHash"] = compute_hash(candidate, "candidate", "candidateHash")
    intent["candidateHash"] = candidate["candidateHash"]
    for evidence in intent["evidenceRefs"]:
        evidence["eventHash"] = research["eventHash"]
    intent["intentHash"] = compute_hash(intent, "trade-intent", "intentHash")
    if critic is not None:
        critic["candidateHash"] = candidate["candidateHash"]
        critic["intentHash"] = intent["intentHash"]
        critic["eventHash"] = research["eventHash"]
        critic["verdictHash"] = compute_hash(critic, "critic-verdict", "verdictHash")


def _partial_evidence(request: dict[str, Any]) -> None:
    fact_ids = request["bundle"]["tradeIntent"]["evidenceRefs"][0]["factIds"]
    request["bundle"]["tradeIntent"]["evidenceRefs"][0]["factIds"] = fact_ids[:-1]


def _consistent_instrument(request: dict[str, Any]) -> None:
    bundle = request["bundle"]
    bundle["researchEvent"]["instrumentId"] = "OTHER"
    bundle["candidateManifest"]["instrumentId"] = "OTHER"
    bundle["tradeIntent"]["proposal"]["instrumentId"] = "OTHER"


def _consistent_currency(request: dict[str, Any]) -> None:
    bundle = request["bundle"]
    bundle["researchEvent"]["currency"] = "CAD"
    bundle["candidateManifest"]["currency"] = "CAD"
    bundle["tradeIntent"]["proposal"]["currency"] = "CAD"


def _notional_only(request: dict[str, Any]) -> None:
    _fact(request, "REFERENCE_PRICE_USD")["value"] = "100.0000"


def _price_only(request: dict[str, Any]) -> None:
    _fact(request, "ASK_PRICE_USD")["value"] = "99.4951"


def _add_secondary_provenance(
    request: dict[str, Any], *, source_class: str, referenced: bool
) -> None:
    research = request["bundle"]["researchEvent"]
    secondary = copy.deepcopy(research["provenance"][0])
    secondary.update(
        {
            "provenanceId": "prov_fixture_secondary_v1",
            "sourceClass": source_class,
            "sourceRevision": "fixture-secondary-v1",
            "contentHash": "1" * 64,
        }
    )
    research["provenance"].append(secondary)
    if referenced:
        _fact(request, "REFERENCE_PRICE_USD")["provenanceId"] = secondary[
            "provenanceId"
        ]


def _complete_multi_failure(request: dict[str, Any]) -> None:
    bundle = request["bundle"]
    research = bundle["researchEvent"]
    candidate = bundle["candidateManifest"]
    intent = bundle["tradeIntent"]
    critic = bundle["criticVerdict"]

    intent["candidateId"] = "cand_other_intent_v1"
    _partial_evidence(request)
    critic["intentId"] = "ti_other_critic_v1"
    critic["candidateId"] = "cand_other_critic_v1"
    critic["producer"]["runId"] = intent["producer"]["runId"]

    candidate["createdAt"] = "2026-08-03T14:27:30.000Z"
    candidate["validUntil"] = "2026-08-03T14:29:59.999Z"
    research["publishedAt"] = "2026-08-03T14:26:00.000Z"
    research["observedAt"] = "2026-08-03T14:26:59.999Z"
    research["rightsClass"] = "LOCAL_RESTRICTED"
    intent["createdAt"] = "2026-08-03T14:28:59.999Z"
    critic["createdAt"] = "2026-08-03T14:29:29.999Z"

    critic["verdict"] = "REJECT"
    critic["reasonCode"] = "EVIDENCE_GAP"
    candidate["policy"]["allowedAction"] = "HOLD"
    candidate["mode"] = "LIVE"
    candidate["liveEligible"] = True
    _consistent_instrument(request)
    _consistent_currency(request)
    intent["proposal"]["action"] = "CLOSE_LONG"
    intent["proposal"]["side"] = "SELL"
    intent["proposal"]["session"] = "EXTENDED"
    intent["proposal"]["quantity"] = "1.000001"
    _fact(request, "REFERENCE_PRICE_USD")["value"] = "100.0000"
    _fact(request, "ASK_PRICE_USD")["value"] = "100.0001"


ISOLATED_DOMAIN_CASES: tuple[tuple[str, Mutation], ...] = (
    (
        "INTENT_CANDIDATE_MISMATCH",
        _set_fields(
            (("bundle", "tradeIntent", "candidateId"), "cand_other_fixture_v1")
        ),
    ),
    ("INTENT_EVIDENCE_MISMATCH", _partial_evidence),
    (
        "CRITIC_INTENT_MISMATCH",
        _set_fields((("bundle", "criticVerdict", "intentId"), "ti_other_fixture_v1")),
    ),
    (
        "CRITIC_CANDIDATE_MISMATCH",
        _set_fields(
            (("bundle", "criticVerdict", "candidateId"), "cand_other_fixture_v1")
        ),
    ),
    (
        "CRITIC_NOT_DISTINCT",
        _set_fields(
            (
                ("bundle", "criticVerdict", "producer", "runId"),
                "run_fixture_manager_v1",
            )
        ),
    ),
    (
        "TIME_ORDER_INVALID",
        _set_fields(
            (
                ("bundle", "researchEvent", "publishedAt"),
                "2026-08-03T14:28:00.000Z",
            )
        ),
    ),
    (
        "CANDIDATE_INACTIVE",
        _set_fields(
            (
                ("bundle", "candidateManifest", "validUntil"),
                "2026-08-03T14:29:59.999Z",
            )
        ),
    ),
    (
        "RIGHTS_NOT_PUBLIC",
        _set_fields(
            (
                ("bundle", "researchEvent", "rightsClass"),
                "LOCAL_RESTRICTED",
            )
        ),
    ),
    (
        "EVIDENCE_STALE",
        _set_fields(
            (
                ("bundle", "researchEvent", "publishedAt"),
                "2026-08-03T14:26:59.999Z",
            ),
            (
                ("bundle", "researchEvent", "observedAt"),
                "2026-08-03T14:26:59.999Z",
            ),
        ),
    ),
    (
        "INTENT_STALE",
        _set_fields(
            (
                ("bundle", "tradeIntent", "createdAt"),
                "2026-08-03T14:28:59.999Z",
            )
        ),
    ),
    (
        "CRITIC_STALE",
        _set_fields(
            (
                ("bundle", "criticVerdict", "createdAt"),
                "2026-08-03T14:29:29.999Z",
            )
        ),
    ),
    (
        "INTENT_ABSTAINED",
        _set_fields(
            (("bundle", "tradeIntent", "disposition"), "ABSTAIN"),
            (("bundle", "tradeIntent", "proposal"), None),
            (("bundle", "tradeIntent", "evidenceRefs"), []),
            (
                ("bundle", "tradeIntent", "abstainReasonCode"),
                "INSUFFICIENT_EVIDENCE",
            ),
        ),
    ),
    (
        "CRITIC_MISSING",
        _set_fields((("bundle", "criticVerdict"), None)),
    ),
    (
        "CRITIC_REJECTED",
        _set_fields(
            (("bundle", "criticVerdict", "verdict"), "REJECT"),
            (("bundle", "criticVerdict", "reasonCode"), "EVIDENCE_GAP"),
        ),
    ),
    (
        "CRITIC_ABSTAINED",
        _set_fields(
            (("bundle", "criticVerdict", "verdict"), "ABSTAIN"),
            (
                ("bundle", "criticVerdict", "reasonCode"),
                "INSUFFICIENT_EVIDENCE",
            ),
        ),
    ),
    (
        "FIXTURE_POLICY_MISMATCH",
        _set_fields(
            (("bundle", "candidateManifest", "policy", "allowedAction"), "HOLD")
        ),
    ),
    (
        "CANDIDATE_NOT_PAPER",
        _set_fields((("bundle", "candidateManifest", "mode"), "LIVE")),
    ),
    (
        "CANDIDATE_LIVE_ELIGIBLE",
        _set_fields((("bundle", "candidateManifest", "liveEligible"), True)),
    ),
    ("INSTRUMENT_NOT_ALLOWED", _consistent_instrument),
    ("CURRENCY_NOT_USD", _consistent_currency),
    (
        "ACTION_NOT_ALLOWED",
        _set_fields((("bundle", "tradeIntent", "proposal", "action"), "CLOSE_LONG")),
    ),
    (
        "SIDE_NOT_ALLOWED",
        _set_fields((("bundle", "tradeIntent", "proposal", "side"), "SELL")),
    ),
    (
        "SESSION_NOT_REGULAR",
        _set_fields((("bundle", "tradeIntent", "proposal", "session"), "EXTENDED")),
    ),
    (
        "QUANTITY_LIMIT_EXCEEDED",
        _set_fields((("bundle", "tradeIntent", "proposal", "quantity"), "1.000001")),
    ),
    ("NOTIONAL_LIMIT_EXCEEDED", _notional_only),
    ("PRICE_NOT_MARKETABLE", _price_only),
)


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
        self.assertEqual(
            response["reasonCodes"],
            ["QUANTITY_LIMIT_EXCEEDED", "NOTIONAL_LIMIT_EXCEEDED"],
        )
        self.assertIsNone(response["orderPlan"])
        self.assertIsNone(response["executionEvent"])
        self.assertEqual(len(response["auditEvents"]), 5)
        self.assertTrue(verify_response(response, request))

    def test_isolated_domain_matrix_covers_all_frozen_reason_codes(self):
        self.assertEqual(
            tuple(code for code, _mutation in ISOLATED_DOMAIN_CASES),
            EXPECTED_DOMAIN_REASON_CODES,
        )
        self.assertEqual(len(ISOLATED_DOMAIN_CASES), 26)
        for expected_code, mutate in ISOLATED_DOMAIN_CASES:
            with self.subTest(reasonCode=expected_code):
                request = accepted_request()
                mutate(request)
                _rehash_linked(request)
                response = evaluate_request(request)
                self.assertEqual(response["status"], "REJECTED")
                self.assertEqual(response["primaryReasonCode"], expected_code)
                self.assertEqual(response["reasonCodes"], [expected_code])
                self.assertIsNone(response["orderPlan"])
                self.assertIsNone(response["executionEvent"])
                self.assertTrue(verify_response(response, request))

    def test_staleness_thresholds_accept_the_limit_and_reject_one_ms_later(self):
        cases: tuple[tuple[str, Mutation, list[str]], ...] = (
            (
                "evidence-at-180-seconds",
                _set_fields(
                    (
                        ("bundle", "researchEvent", "publishedAt"),
                        "2026-08-03T14:27:00.000Z",
                    ),
                    (
                        ("bundle", "researchEvent", "observedAt"),
                        "2026-08-03T14:27:00.000Z",
                    ),
                ),
                ["ACCEPTED"],
            ),
            (
                "evidence-at-180-seconds-plus-1ms",
                _set_fields(
                    (
                        ("bundle", "researchEvent", "publishedAt"),
                        "2026-08-03T14:26:59.999Z",
                    ),
                    (
                        ("bundle", "researchEvent", "observedAt"),
                        "2026-08-03T14:26:59.999Z",
                    ),
                ),
                ["EVIDENCE_STALE"],
            ),
            (
                "intent-at-60-seconds",
                _set_fields(
                    (
                        ("bundle", "tradeIntent", "createdAt"),
                        "2026-08-03T14:29:00.000Z",
                    )
                ),
                ["ACCEPTED"],
            ),
            (
                "intent-at-60-seconds-plus-1ms",
                _set_fields(
                    (
                        ("bundle", "tradeIntent", "createdAt"),
                        "2026-08-03T14:28:59.999Z",
                    )
                ),
                ["INTENT_STALE"],
            ),
            (
                "critic-at-30-seconds",
                _set_fields(
                    (
                        ("bundle", "criticVerdict", "createdAt"),
                        "2026-08-03T14:29:30.000Z",
                    )
                ),
                ["ACCEPTED"],
            ),
            (
                "critic-at-30-seconds-plus-1ms",
                _set_fields(
                    (
                        ("bundle", "criticVerdict", "createdAt"),
                        "2026-08-03T14:29:29.999Z",
                    )
                ),
                ["CRITIC_STALE"],
            ),
        )
        for name, mutate, expected_reasons in cases:
            with self.subTest(boundary=name):
                request = accepted_request()
                mutate(request)
                _rehash_linked(request)
                response = evaluate_request(request)
                self.assertEqual(response["reasonCodes"], expected_reasons)
                self.assertTrue(verify_response(response, request))

    def test_expiry_and_candidate_windows_are_inclusive_at_each_edge(self):
        cases: tuple[tuple[str, Mutation, list[str]], ...] = (
            (
                "intent-expires-at-decision",
                _set_fields(
                    (
                        ("bundle", "tradeIntent", "expiresAt"),
                        "2026-08-03T14:30:00.000Z",
                    )
                ),
                ["ACCEPTED"],
            ),
            (
                "intent-expires-1ms-before-decision",
                _set_fields(
                    (
                        ("bundle", "tradeIntent", "expiresAt"),
                        "2026-08-03T14:29:59.999Z",
                    )
                ),
                ["INTENT_STALE"],
            ),
            (
                "critic-expires-at-decision",
                _set_fields(
                    (
                        ("bundle", "criticVerdict", "expiresAt"),
                        "2026-08-03T14:30:00.000Z",
                    )
                ),
                ["ACCEPTED"],
            ),
            (
                "critic-expires-1ms-before-decision",
                _set_fields(
                    (
                        ("bundle", "criticVerdict", "expiresAt"),
                        "2026-08-03T14:29:59.999Z",
                    )
                ),
                ["CRITIC_STALE"],
            ),
            (
                "decision-at-valid-from",
                _set_fields(
                    (
                        ("bundle", "candidateManifest", "validFrom"),
                        "2026-08-03T14:30:00.000Z",
                    )
                ),
                ["ACCEPTED"],
            ),
            (
                "decision-1ms-before-valid-from",
                _set_fields(
                    (
                        ("bundle", "candidateManifest", "validFrom"),
                        "2026-08-03T14:30:00.001Z",
                    )
                ),
                ["CANDIDATE_INACTIVE"],
            ),
            (
                "decision-at-valid-until",
                _set_fields(
                    (
                        ("bundle", "candidateManifest", "validUntil"),
                        "2026-08-03T14:30:00.000Z",
                    )
                ),
                ["ACCEPTED"],
            ),
            (
                "decision-1ms-after-valid-until",
                _set_fields(
                    (
                        ("bundle", "candidateManifest", "validUntil"),
                        "2026-08-03T14:29:59.999Z",
                    )
                ),
                ["CANDIDATE_INACTIVE"],
            ),
        )
        for name, mutate, expected_reasons in cases:
            with self.subTest(boundary=name):
                request = accepted_request()
                mutate(request)
                _rehash_linked(request)
                response = evaluate_request(request)
                self.assertEqual(response["reasonCodes"], expected_reasons)
                self.assertTrue(verify_response(response, request))

    def test_partial_evidence_is_structurally_valid_but_rejected_exactly(self):
        request = accepted_request()
        _partial_evidence(request)
        _rehash_linked(request)
        response = evaluate_request(request)
        self.assertEqual(response["reasonCodes"], ["INTENT_EVIDENCE_MISMATCH"])
        self.assertTrue(verify_response(response, request))

    def test_provenance_is_complete_and_uses_strictest_rights_aggregation(self):
        cases: tuple[tuple[str, Mutation, list[str]], ...] = (
            (
                "two-referenced-public-records",
                lambda request: _add_secondary_provenance(
                    request, source_class="PUBLIC_OFFICIAL", referenced=True
                ),
                ["ACCEPTED"],
            ),
            (
                "referenced-local-source",
                lambda request: _add_secondary_provenance(
                    request, source_class="LOCAL", referenced=True
                ),
                ["RIGHTS_NOT_PUBLIC"],
            ),
            (
                "unreferenced-public-record",
                lambda request: _add_secondary_provenance(
                    request, source_class="PUBLIC_OFFICIAL", referenced=False
                ),
                ["RIGHTS_NOT_PUBLIC"],
            ),
            (
                "licensed-fact",
                lambda request: _fact(request, "NOTICE_TEXT").__setitem__(
                    "rightsClass", "LICENSED_MODEL_OK"
                ),
                ["RIGHTS_NOT_PUBLIC"],
            ),
        )
        for name, mutate, expected_reasons in cases:
            with self.subTest(provenance=name):
                request = accepted_request()
                mutate(request)
                _rehash_linked(request)
                response = evaluate_request(request)
                self.assertEqual(response["reasonCodes"], expected_reasons)
                self.assertTrue(verify_response(response, request))

    def test_null_critic_branches_are_explicit_and_exact(self):
        cases: tuple[tuple[str, Mutation, list[str]], ...] = (
            (
                "proposed-intent",
                _set_fields((("bundle", "criticVerdict"), None)),
                ["CRITIC_MISSING"],
            ),
            (
                "abstained-intent",
                _set_fields(
                    (("bundle", "criticVerdict"), None),
                    (("bundle", "tradeIntent", "disposition"), "ABSTAIN"),
                    (("bundle", "tradeIntent", "proposal"), None),
                    (("bundle", "tradeIntent", "evidenceRefs"), []),
                    (
                        ("bundle", "tradeIntent", "abstainReasonCode"),
                        "INSUFFICIENT_EVIDENCE",
                    ),
                ),
                ["INTENT_ABSTAINED", "CRITIC_MISSING"],
            ),
        )
        for name, mutate, expected_reasons in cases:
            with self.subTest(branch=name):
                request = accepted_request()
                mutate(request)
                _rehash_linked(request)
                response = evaluate_request(request)
                self.assertEqual(response["reasonCodes"], expected_reasons)
                self.assertIsNone(response["gateDecision"]["inputRefs"]["verdictId"])
                self.assertIsNone(response["gateDecision"]["inputRefs"]["verdictHash"])
                self.assertEqual(len(response["auditEvents"]), 4)
                self.assertTrue(verify_response(response, request))

    def test_empty_evidence_abstain_is_audited_with_and_without_a_critic(self):
        abstain = _set_fields(
            (("bundle", "tradeIntent", "disposition"), "ABSTAIN"),
            (("bundle", "tradeIntent", "proposal"), None),
            (("bundle", "tradeIntent", "evidenceRefs"), []),
            (
                ("bundle", "tradeIntent", "abstainReasonCode"),
                "INSUFFICIENT_EVIDENCE",
            ),
        )
        for critic_missing, expected_reasons, expected_audits in (
            (False, ["INTENT_ABSTAINED"], 5),
            (True, ["INTENT_ABSTAINED", "CRITIC_MISSING"], 4),
        ):
            with self.subTest(criticMissing=critic_missing):
                request = accepted_request()
                abstain(request)
                if critic_missing:
                    request["bundle"]["criticVerdict"] = None
                _rehash_linked(request)
                response = evaluate_request(request)
                self.assertEqual(response["reasonCodes"], expected_reasons)
                self.assertEqual(len(response["auditEvents"]), expected_audits)
                self.assertTrue(verify_response(response, request))

    def test_policy_negatives_are_typed_at_the_correct_boundary(self):
        domain_cases: tuple[tuple[str, str], ...] = (
            ("allowedAction", "HOLD"),
            ("side", "SELL"),
            ("session", "EXTENDED"),
            ("maxQuantity", "2.000000"),
            ("maxGrossNotionalUsd", "101.00"),
            ("buyCollarRatio", "0.004000"),
        )
        for field, replacement in domain_cases:
            with self.subTest(validPolicyField=field):
                request = accepted_request()
                request["bundle"]["candidateManifest"]["policy"][field] = replacement
                _rehash_linked(request)
                response = evaluate_request(request)
                self.assertEqual(response["reasonCodes"], ["FIXTURE_POLICY_MISMATCH"])

        structural_cases: tuple[tuple[str, Any], ...] = (
            ("policyId", "OTHER_POLICY"),
            ("allowedAction", "SHORT"),
            ("session", "PREMARKET"),
            ("maxQuantity", "0.000000"),
            ("maxGrossNotionalUsd", "-1.00"),
            ("buyCollarRatio", "1.000001"),
        )
        for field, replacement in structural_cases:
            with self.subTest(invalidPolicyField=field):
                request = accepted_request()
                request["bundle"]["candidateManifest"]["policy"][field] = replacement
                _rehash_linked(request)
                with self.assertRaises(InputContractError) as raised:
                    evaluate_request(request)
                self.assertEqual(raised.exception.code, "INPUT_SCHEMA_INVALID")

    def test_candidate_policy_cannot_widen_the_frozen_risk_limits(self):
        request = rejected_quantity_request()
        policy = request["bundle"]["candidateManifest"]["policy"]
        policy.update(
            {
                "maxQuantity": "100.000000",
                "maxGrossNotionalUsd": "999999999.99",
                "buyCollarRatio": "0.000000",
            }
        )
        _rehash_linked(request)
        response = evaluate_request(request)
        self.assertEqual(
            response["reasonCodes"],
            [
                "FIXTURE_POLICY_MISMATCH",
                "QUANTITY_LIMIT_EXCEEDED",
                "NOTIONAL_LIMIT_EXCEEDED",
            ],
        )
        self.assertTrue(verify_response(response, request))

    def test_maximum_input_price_emits_the_exact_output_only_collar_bound(self):
        request = accepted_request()
        _fact(request, "REFERENCE_PRICE_USD")["value"] = "999999.9999"
        _fact(request, "ASK_PRICE_USD")["value"] = "999999.9999"
        proposal = request["bundle"]["tradeIntent"]["proposal"]
        proposal["quantity"] = "0.000001"
        proposal["maximumEntryPrice"] = "999999.9999"
        _rehash_linked(request)

        response = evaluate_request(request)
        self.assertEqual(response["status"], "ACCEPTED")
        self.assertEqual(response["reasonCodes"], ["ACCEPTED"])
        plan = response["orderPlan"]
        execution = response["executionEvent"]
        self.assertIsNotNone(plan)
        self.assertIsNotNone(execution)
        self.assertEqual(plan["limitPrice"], "999999.9999")
        self.assertEqual(plan["priceCollar"]["referencePrice"], "999999.9999")
        self.assertEqual(plan["priceCollar"]["maximumLimitPrice"], "1004999.9998")
        self.assertEqual(execution["fillPrice"], "999999.9999")
        self.assertEqual(execution["fillNotionalUsd"], "1.00")
        self.assertTrue(verify_response(response, request))

        outside_input_domain = copy.deepcopy(request)
        _fact(outside_input_domain, "REFERENCE_PRICE_USD")["value"] = "1000000.0000"
        _rehash_linked(outside_input_domain)
        with self.assertRaises(InputContractError) as raised:
            evaluate_request(outside_input_domain)
        self.assertEqual(raised.exception.code, "INPUT_SCHEMA_INVALID")

    def test_intent_maximum_entry_tightens_limit_without_changing_the_collar(self):
        request = accepted_request()
        request["bundle"]["tradeIntent"]["proposal"]["maximumEntryPrice"] = "99.3000"
        _rehash_linked(request)
        response = evaluate_request(request)
        self.assertEqual(response["status"], "ACCEPTED")
        self.assertEqual(response["orderPlan"]["limitPrice"], "99.3000")
        self.assertEqual(
            response["orderPlan"]["priceCollar"]["maximumLimitPrice"],
            "99.4950",
        )
        self.assertEqual(response["executionEvent"]["fillPrice"], "99.2500")
        self.assertTrue(verify_response(response, request))

    def test_fill_notional_half_even_ties_round_in_both_directions(self):
        for ask_price, expected_notional in (
            ("99.2450", "99.24"),
            ("99.2550", "99.26"),
        ):
            with self.subTest(askPrice=ask_price):
                request = accepted_request()
                _fact(request, "ASK_PRICE_USD")["value"] = ask_price
                _rehash_linked(request)
                response = evaluate_request(request)
                self.assertEqual(response["status"], "ACCEPTED")
                self.assertEqual(
                    response["executionEvent"]["fillNotionalUsd"],
                    expected_notional,
                )
                self.assertTrue(verify_response(response, request))

    def test_risk_uses_the_unrounded_collar_before_reporting_quantization(self):
        request = accepted_request()
        _fact(request, "REFERENCE_PRICE_USD")["value"] = "99.5025"
        request["bundle"]["tradeIntent"]["proposal"]["maximumEntryPrice"] = "100.0000"
        _rehash_linked(request)
        response = evaluate_request(request)
        self.assertEqual(response["status"], "REJECTED")
        self.assertEqual(response["reasonCodes"], ["NOTIONAL_LIMIT_EXCEEDED"])
        self.assertIsNone(response["orderPlan"])
        self.assertIsNone(response["executionEvent"])
        self.assertTrue(verify_response(response, request))

    def test_complete_multi_failure_oracle_preserves_global_precedence(self):
        expected = [
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
            "CRITIC_REJECTED",
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
        ]
        request = accepted_request()
        _complete_multi_failure(request)
        _rehash_linked(request)
        response = evaluate_request(request)
        self.assertEqual(response["status"], "REJECTED")
        self.assertEqual(response["primaryReasonCode"], expected[0])
        self.assertEqual(response["reasonCodes"], expected)
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
        self.assertIsNone(error["requestId"])
        self.assertNotIn("operationId", error)

    def test_duplicate_request_id_is_never_echoed(self):
        exit_code, error = authority._process(
            b'{"requestId":"req_first","requestId":"req_second"}\n'
        )
        self.assertEqual(exit_code, 2)
        self.assertEqual(error["errorCode"], "INPUT_DUPLICATE_KEY")
        self.assertIsNone(error["requestId"])

    def test_json_integer_outside_shared_safe_range_is_rejected(self):
        exit_code, error = authority._process(b'{"schemaVersion":9007199254740992}\n')
        self.assertEqual(exit_code, 2)
        self.assertEqual(error["errorCode"], "INPUT_JSON_INVALID")

    def test_deep_json_is_a_redacted_protocol_error(self):
        payload = b'{"x":' + b"[" * 20000 + b"]" * 20000 + b"}\n"
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
        request["bundle"]["tradeIntent"]["intentHash"] = compute_hash(
            request["bundle"]["tradeIntent"], "trade-intent", "intentHash"
        )
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
        request["bundle"]["criticVerdict"]["verdictHash"] = compute_hash(
            request["bundle"]["criticVerdict"], "critic-verdict", "verdictHash"
        )
        response = evaluate_request(request)
        self.assertEqual(response["status"], "REJECTED")
        self.assertEqual(response["primaryReasonCode"], "CRITIC_INTENT_MISMATCH")

    def test_evidence_instrument_linkage_is_required(self):
        request = accepted_request()
        research = request["bundle"]["researchEvent"]
        research["instrumentId"] = "OTHER"
        research["eventHash"] = compute_hash(research, "research-event", "eventHash")
        request["bundle"]["tradeIntent"]["evidenceRefs"][0]["eventHash"] = research[
            "eventHash"
        ]
        request["bundle"]["tradeIntent"]["intentHash"] = compute_hash(
            request["bundle"]["tradeIntent"], "trade-intent", "intentHash"
        )
        request["bundle"]["criticVerdict"]["eventHash"] = research["eventHash"]
        request["bundle"]["criticVerdict"]["intentHash"] = request["bundle"][
            "tradeIntent"
        ]["intentHash"]
        request["bundle"]["criticVerdict"]["verdictHash"] = compute_hash(
            request["bundle"]["criticVerdict"], "critic-verdict", "verdictHash"
        )
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
