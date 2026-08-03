// @ts-check

import {
  PAPER_PROFILE,
  PAPER_POLICY_ID,
  artifactHash,
  canonicalJson,
} from "./contract-validation.mjs";

const DECISION_AT = "2026-08-03T14:30:00.000Z";

function withHash(value, type) {
  const field = { ResearchEvent: "eventHash", CandidateManifest: "candidateHash", TradeIntent: "intentHash", CriticVerdict: "verdictHash" }[type];
  return { ...value, [field]: artifactHash(value, type) };
}

export function acceptedFixtureRequest({ quantity = "1.000000" } = {}) {
  const provenance = [{
    provenanceId: "prov_fixture_public_v1",
    sourceId: "fixture.public",
    sourceClass: "PUBLIC_OFFICIAL",
    sourceRef: "fixture://public-official/mptest/v1",
    sourceRevision: "fixture-v1",
    publishedAt: "2026-08-03T14:27:00.000Z",
    retrievedAt: "2026-08-03T14:27:30.000Z",
    contentHash: "0".repeat(64),
  }];
  const research = withHash({
    schemaVersion: 1, profile: PAPER_PROFILE, artifactType: "ResearchEvent", eventId: "re_fixture_notice_v1", eventHash: "0".repeat(64),
    producer: { kind: "FIXTURE_SOURCE", runId: "run_fixture_source_v1" }, instrumentId: "MPTEST", assetClass: "US_PRIMARY_LISTED_COMMON_STOCK", currency: "USD", eventKind: "FIXTURE_ISSUER_NOTICE", revisionId: "rev_fixture_notice_v1", supersedesEventId: null, rightsClass: "PUBLIC_OFFICIAL", publishedAt: "2026-08-03T14:27:00.000Z", observedAt: "2026-08-03T14:27:30.000Z",
    facts: [
      { factId: "fact_ask_price_v1", kind: "ASK_PRICE_USD", value: "99.2500", rightsClass: "PUBLIC_OFFICIAL", provenanceId: "prov_fixture_public_v1" },
      { factId: "fact_notice_text_v1", kind: "NOTICE_TEXT", value: "Synthetic public issuer notice for MPTEST.", rightsClass: "PUBLIC_OFFICIAL", provenanceId: "prov_fixture_public_v1" },
      { factId: "fact_reference_price_v1", kind: "REFERENCE_PRICE_USD", value: "99.0000", rightsClass: "PUBLIC_OFFICIAL", provenanceId: "prov_fixture_public_v1" },
    ], provenance,
  }, "ResearchEvent");
  const candidate = withHash({
    schemaVersion: 1, profile: PAPER_PROFILE, artifactType: "CandidateManifest", candidateId: "cand_fixture_mptest_v1", candidateHash: "0".repeat(64), producer: { kind: "FIXTURE_REGISTRY", runId: "run_fixture_registry_v1" }, createdAt: "2026-08-03T14:25:00.000Z", validFrom: "2026-08-03T14:00:00.000Z", validUntil: "2026-08-03T15:00:00.000Z", mode: "PAPER", liveEligible: false, strategyKind: "FIXTURE_LONG_US_EQUITY", instrumentId: "MPTEST", assetClass: "US_PRIMARY_LISTED_COMMON_STOCK", currency: "USD", policy: { policyId: PAPER_POLICY_ID, allowedAction: "OPEN_LONG", side: "BUY", session: "REGULAR", maxQuantity: "1.000000", maxGrossNotionalUsd: "100.00", buyCollarRatio: "0.005000" },
  }, "CandidateManifest");
  const intent = withHash({
    schemaVersion: 1, profile: PAPER_PROFILE, artifactType: "TradeIntent", intentId: "ti_fixture_mptest_v1", intentHash: "0".repeat(64), producer: { kind: "MANAGER", runId: "run_fixture_manager_v1" }, operationId: "op_fixture_mptest_v1", createdAt: "2026-08-03T14:29:15.000Z", expiresAt: "2026-08-03T14:30:15.000Z", candidateId: candidate.candidateId, candidateHash: candidate.candidateHash, disposition: "PROPOSE", proposal: { action: "OPEN_LONG", instrumentId: "MPTEST", assetClass: "US_PRIMARY_LISTED_COMMON_STOCK", currency: "USD", side: "BUY", session: "REGULAR", quantity, maximumEntryPrice: "99.4950" }, abstainReasonCode: null, thesis: "Synthetic fixture evidence supports a bounded paper entry.", evidenceRefs: [{ eventId: research.eventId, eventHash: research.eventHash, factIds: research.facts.map(fact => fact.factId) }],
  }, "TradeIntent");
  const critic = withHash({
    schemaVersion: 1, profile: PAPER_PROFILE, artifactType: "CriticVerdict", verdictId: "cv_fixture_mptest_v1", verdictHash: "0".repeat(64), producer: { kind: "CRITIC", runId: "run_fixture_critic_v1" }, operationId: intent.operationId, createdAt: "2026-08-03T14:29:45.000Z", expiresAt: "2026-08-03T14:30:15.000Z", candidateId: candidate.candidateId, candidateHash: candidate.candidateHash, intentId: intent.intentId, intentHash: intent.intentHash, eventId: research.eventId, eventHash: research.eventHash, verdict: "APPROVE", reasonCode: "NO_BLOCKING_ISSUE", counterargument: "No blocking fixture-policy or evidence issue was found.", evidenceFactIds: research.facts.map(fact => fact.factId),
  }, "CriticVerdict");
  return { schemaVersion: 1, profile: PAPER_PROFILE, policyId: PAPER_POLICY_ID, messageType: "EVALUATE_FIXTURE_PAPER_INTENT", requestId: "req_fixture_mptest_v1", operationId: intent.operationId, decisionAt: DECISION_AT, bundle: { researchEvent: research, candidateManifest: candidate, tradeIntent: intent, criticVerdict: critic } };
}

export function rejectedFixtureRequest() { return acceptedFixtureRequest({ quantity: "2.000000" }); }
export function fixtureRequestBytes(request) { return Buffer.from(`${canonicalJson(request)}\n`, "utf8"); }
