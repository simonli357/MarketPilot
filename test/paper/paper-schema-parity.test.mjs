// @ts-check

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PAPER_REGISTRY } from "../../src/paper-fixture/registry.mjs";
import {
  acceptedFixtureRequest,
  rejectedFixtureRequest,
} from "../../src/paper-fixture/fixtures.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const LOCAL_META_ID = "urn:marketpilot:paper-intent-fixture:v1:meta";
const EXPECTED_SCHEMA_NAMES = Object.freeze([
  "Primitives",
  "Producer",
  "Fact",
  "Provenance",
  "Policy",
  "ResearchEvent",
  "CandidateManifest",
  "ManagerSemanticDraft",
  "TradeIntent",
  "CriticSemanticDraft",
  "CriticVerdict",
  "GateDecision",
  "OrderPlan",
  "ExecutionEvent",
  "AuditEvent",
  "AppIncidentEvent",
  "FixtureAuthorityRequest",
  "FixtureAuthorityResponse",
  "ProtocolError",
]);

const DOMAIN_REASON_CODES = Object.freeze([
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
]);

/** @typedef {{id:string, schemaName:string, instance:unknown, expected:boolean}} ParityVector */

function clone(value) {
  return structuredClone(value);
}

function changed(base, mutate) {
  const value = clone(base);
  mutate(value);
  return value;
}

function pointerLabel(pathItems) {
  return pathItems.length === 0
    ? "root"
    : pathItems.map(item => String(item).replaceAll(/[^a-zA-Z0-9]+/g, "-")).join("-");
}

function atPath(rootValue, pathItems) {
  let value = rootValue;
  for (const item of pathItems) value = value[item];
  return value;
}

function changedAt(base, pathItems, replacement) {
  return changed(base, rootValue => {
    const parent = atPath(rootValue, pathItems.slice(0, -1));
    parent[pathItems.at(-1)] = replacement;
  });
}

/**
 * Every object field in a valid branch is required and every object is closed.
 * Generate deletion, wrong-type, and unexpected-field mutations from the
 * actual instance tree so nested reusable components cannot escape parity.
 *
 * @param {string} schemaName
 * @param {string} label
 * @param {unknown} base
 * @param {{maxDepth?: number}} [options]
 * @returns {ParityVector[]}
 */
function fieldMutationVectors(schemaName, label, base, { maxDepth = 32 } = {}) {
  /** @type {ParityVector[]} */
  const vectors = [];
  const visit = (value, pathItems, depth) => {
    if (depth > maxDepth) return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, [...pathItems, index], depth + 1));
      return;
    }
    if (value === null || typeof value !== "object") return;
    const location = pointerLabel(pathItems);
    vectors.push({
      id: `field-${label}-${location}-unexpected`,
      schemaName,
      instance: changed(base, rootValue => { atPath(rootValue, pathItems).unexpected = true; }),
      expected: false,
    });
    for (const [key, item] of Object.entries(value)) {
      const fieldPath = [...pathItems, key];
      const field = pointerLabel(fieldPath);
      vectors.push({
        id: `field-${label}-${field}-missing`,
        schemaName,
        instance: changed(base, rootValue => { delete atPath(rootValue, pathItems)[key]; }),
        expected: false,
      });
      vectors.push({
        id: `field-${label}-${field}-wrong-type`,
        schemaName,
        instance: changed(base, rootValue => { atPath(rootValue, pathItems)[key] = Array.isArray(item) ? {} : []; }),
        expected: false,
      });
      visit(item, fieldPath, depth + 1);
    }
  };
  visit(base, [], 0);
  return vectors;
}

function validManagerDraft(request) {
  const intent = request.bundle.tradeIntent;
  return {
    disposition: intent.disposition,
    proposal: clone(intent.proposal),
    abstainReasonCode: intent.abstainReasonCode,
    thesis: intent.thesis,
    evidenceFactIds: clone(intent.evidenceRefs[0].factIds),
  };
}

function validCriticDraft(request) {
  const critic = request.bundle.criticVerdict;
  assert.notEqual(critic, null);
  return {
    verdict: critic.verdict,
    reasonCode: critic.reasonCode,
    counterargument: critic.counterargument,
    evidenceFactIds: clone(critic.evidenceFactIds),
  };
}

function validGateDecision(request) {
  return {
    schemaVersion: 1,
    profile: request.profile,
    policyId: request.policyId,
    artifactType: "GateDecision",
    decisionId: "gd_fixture_schema_v1",
    decisionHash: "0".repeat(64),
    producer: { kind: "PYTHON_AUTHORITY", runId: "run_fixture_authority_v1" },
    operationId: request.operationId,
    requestHash: "1".repeat(64),
    decidedAt: request.decisionAt,
    decision: "REJECT",
    primaryReasonCode: DOMAIN_REASON_CODES[0],
    reasonCodes: [...DOMAIN_REASON_CODES],
    inputRefs: {
      eventId: request.bundle.researchEvent.eventId,
      eventHash: request.bundle.researchEvent.eventHash,
      candidateId: request.bundle.candidateManifest.candidateId,
      candidateHash: request.bundle.candidateManifest.candidateHash,
      intentId: request.bundle.tradeIntent.intentId,
      intentHash: request.bundle.tradeIntent.intentHash,
      verdictId: request.bundle.criticVerdict?.verdictId ?? null,
      verdictHash: request.bundle.criticVerdict?.verdictHash ?? null,
    },
  };
}

function validIncident(request) {
  return {
    schemaVersion: 1,
    profile: request.profile,
    artifactType: "AppIncidentEvent",
    incidentId: "inc_fixture_schema_v1",
    incidentHash: "0".repeat(64),
    scopeType: "OPERATION",
    scopeId: request.operationId,
    sequence: 1,
    occurredAt: request.decisionAt,
    boundary: "AUTHENTICATION",
    code: "AUTH_REQUIRED",
    exposureEffect: "NONE",
    subjectHash: null,
    previousIncidentHash: null,
  };
}

function buildVectors(acceptedResponse, rejectedResponse) {
  const request = acceptedFixtureRequest();
  const research = request.bundle.researchEvent;
  const candidate = request.bundle.candidateManifest;
  const intent = request.bundle.tradeIntent;
  const critic = request.bundle.criticVerdict;
  assert.notEqual(critic, null);
  const noticeIndex = research.facts.findIndex(fact => fact.kind === "NOTICE_TEXT");
  const referenceIndex = research.facts.findIndex(fact => fact.kind === "REFERENCE_PRICE_USD");
  const askIndex = research.facts.findIndex(fact => fact.kind === "ASK_PRICE_USD");
  assert.notEqual(noticeIndex, -1);
  assert.notEqual(referenceIndex, -1);
  assert.notEqual(askIndex, -1);
  const managerDraft = validManagerDraft(request);
  const criticDraft = validCriticDraft(request);
  const gate = validGateDecision(request);
  const incident = validIncident(request);
  const protocolError = {
    schemaVersion: 1,
    profile: request.profile,
    policyId: request.policyId,
    messageType: "FIXTURE_AUTHORITY_PROTOCOL_ERROR",
    requestId: request.requestId,
    status: "ERROR",
    errorCode: "INPUT_SCHEMA_INVALID",
    responseHash: "0".repeat(64),
  };
  const orderPlan = acceptedResponse.orderPlan;
  const executionEvent = acceptedResponse.executionEvent;
  assert.notEqual(orderPlan, null);
  assert.notEqual(executionEvent, null);
  const auditEvent = acceptedResponse.auditEvents[0];

  /** @type {ParityVector[]} */
  const vectors = [
    { id: "request-golden", schemaName: "FixtureAuthorityRequest", instance: request, expected: true },
    { id: "producer-golden", schemaName: "Producer", instance: research.producer, expected: true },
    { id: "fact-golden", schemaName: "Fact", instance: research.facts[0], expected: true },
    { id: "provenance-golden", schemaName: "Provenance", instance: research.provenance[0], expected: true },
    { id: "policy-golden", schemaName: "Policy", instance: candidate.policy, expected: true },
    { id: "research-golden", schemaName: "ResearchEvent", instance: research, expected: true },
    { id: "candidate-golden", schemaName: "CandidateManifest", instance: candidate, expected: true },
    { id: "intent-golden", schemaName: "TradeIntent", instance: intent, expected: true },
    { id: "critic-golden", schemaName: "CriticVerdict", instance: critic, expected: true },
    { id: "manager-draft-golden", schemaName: "ManagerSemanticDraft", instance: managerDraft, expected: true },
    { id: "critic-draft-golden", schemaName: "CriticSemanticDraft", instance: criticDraft, expected: true },
    { id: "gate-all-26-reasons", schemaName: "GateDecision", instance: gate, expected: true },
    { id: "order-plan-golden", schemaName: "OrderPlan", instance: orderPlan, expected: true },
    { id: "execution-event-golden", schemaName: "ExecutionEvent", instance: executionEvent, expected: true },
    { id: "audit-event-golden", schemaName: "AuditEvent", instance: auditEvent, expected: true },
    { id: "accepted-response-golden", schemaName: "FixtureAuthorityResponse", instance: acceptedResponse, expected: true },
    { id: "rejected-response-golden", schemaName: "FixtureAuthorityResponse", instance: rejectedResponse, expected: true },
    { id: "incident-golden", schemaName: "AppIncidentEvent", instance: incident, expected: true },
    { id: "protocol-error-golden", schemaName: "ProtocolError", instance: protocolError, expected: true },
    { id: "research-producer-kind", schemaName: "ResearchEvent", instance: changed(research, value => { value.producer.kind = "MANAGER"; }), expected: false },
    { id: "candidate-producer-kind", schemaName: "CandidateManifest", instance: changed(candidate, value => { value.producer.kind = "FIXTURE_SOURCE"; }), expected: false },
    { id: "intent-producer-kind", schemaName: "TradeIntent", instance: changed(intent, value => { value.producer.kind = "CRITIC"; }), expected: false },
    { id: "critic-producer-kind", schemaName: "CriticVerdict", instance: changed(critic, value => { value.producer.kind = "MANAGER"; }), expected: false },
    { id: "gate-producer-kind", schemaName: "GateDecision", instance: changed(gate, value => { value.producer.kind = "MANAGER"; }), expected: false },
    { id: "order-plan-producer-kind", schemaName: "OrderPlan", instance: changed(orderPlan, value => { value.producer.kind = "MANAGER"; }), expected: false },
    { id: "execution-event-producer-kind", schemaName: "ExecutionEvent", instance: changed(executionEvent, value => { value.producer.kind = "MANAGER"; }), expected: false },
    { id: "audit-event-producer-forbidden", schemaName: "AuditEvent", instance: changed(auditEvent, value => { value.producer = { kind: "PYTHON_AUTHORITY", runId: "run_fixture_authority_v1" }; }), expected: false },

    // mpNfc and mpScalarLength use Unicode scalar values, not UTF-16 units.
    { id: "nfc-composed", schemaName: "ResearchEvent", instance: changed(research, value => { value.facts[noticeIndex].value = "é"; }), expected: true },
    { id: "nfc-decomposed", schemaName: "ResearchEvent", instance: changed(research, value => { value.facts[noticeIndex].value = "e\u0301"; }), expected: false },
    { id: "scalar-1024-emoji", schemaName: "ResearchEvent", instance: changed(research, value => { value.facts[noticeIndex].value = "😀".repeat(1024); }), expected: true },
    { id: "scalar-1025-emoji", schemaName: "ResearchEvent", instance: changed(research, value => { value.facts[noticeIndex].value = "😀".repeat(1025); }), expected: false },
    { id: "scalar-empty-text", schemaName: "ResearchEvent", instance: changed(research, value => { value.facts[noticeIndex].value = ""; }), expected: false },
    { id: "scalar-unpaired-surrogate", schemaName: "ResearchEvent", instance: changed(research, value => { value.facts[noticeIndex].value = "\ud800"; }), expected: false },

    // mpSortedUniqueBy applies to every identifier-keyed collection.
    { id: "facts-reversed", schemaName: "ResearchEvent", instance: changed(research, value => { value.facts.reverse(); }), expected: false },
    { id: "facts-duplicate-id", schemaName: "ResearchEvent", instance: changed(research, value => { value.facts[1].factId = value.facts[0].factId; }), expected: false },
    { id: "provenance-reversed", schemaName: "ResearchEvent", instance: changed(research, value => {
      const second = clone(value.provenance[0]);
      second.provenanceId = "prov_zzzz_schema_v1";
      value.provenance.push(second);
      value.provenance.reverse();
    }), expected: false },
    { id: "intent-fact-ids-reversed", schemaName: "TradeIntent", instance: changed(intent, value => { value.evidenceRefs[0].factIds.reverse(); }), expected: false },
    { id: "intent-fact-ids-duplicate", schemaName: "TradeIntent", instance: changed(intent, value => { value.evidenceRefs[0].factIds[1] = value.evidenceRefs[0].factIds[0]; }), expected: false },
    { id: "intent-propose-empty-evidence", schemaName: "TradeIntent", instance: changed(intent, value => { value.evidenceRefs = []; }), expected: false },
    { id: "intent-propose-empty-facts", schemaName: "TradeIntent", instance: changed(intent, value => { value.evidenceRefs[0].factIds = []; }), expected: false },
    { id: "manager-draft-fact-ids-reversed", schemaName: "ManagerSemanticDraft", instance: changed(managerDraft, value => { value.evidenceFactIds.reverse(); }), expected: false },
    { id: "critic-draft-fact-ids-duplicate", schemaName: "CriticSemanticDraft", instance: changed(criticDraft, value => { value.evidenceFactIds[1] = value.evidenceFactIds[0]; }), expected: false },
    { id: "critic-fact-ids-reversed", schemaName: "CriticVerdict", instance: changed(critic, value => { value.evidenceFactIds.reverse(); }), expected: false },

    // Known cross-runtime regressions and exact lexical edges.
    { id: "strategy-kind-lowercase", schemaName: "CandidateManifest", instance: changed(candidate, value => { value.strategyKind = "fixture_long_us_equity"; }), expected: false },
    { id: "source-revision-128", schemaName: "Provenance", instance: changed(research.provenance[0], value => { value.sourceRevision = "x".repeat(128); }), expected: true },
    { id: "source-revision-129", schemaName: "Provenance", instance: changed(research.provenance[0], value => { value.sourceRevision = "x".repeat(129); }), expected: false },
    { id: "source-revision-space", schemaName: "Provenance", instance: changed(research.provenance[0], value => { value.sourceRevision = "contains space"; }), expected: false },
    { id: "invalid-calendar-date", schemaName: "CandidateManifest", instance: changed(candidate, value => { value.createdAt = "2026-02-30T00:00:00.000Z"; }), expected: false },
    { id: "opaque-id-total-64", schemaName: "FixtureAuthorityRequest", instance: changed(request, value => { value.requestId = `req_${"a".repeat(60)}`; }), expected: true },
    { id: "opaque-id-total-65", schemaName: "FixtureAuthorityRequest", instance: changed(request, value => { value.requestId = `req_${"a".repeat(61)}`; }), expected: false },
    { id: "json-financial-number", schemaName: "TradeIntent", instance: changed(intent, value => { value.proposal.quantity = 1; }), expected: false },
    { id: "financial-exponent", schemaName: "TradeIntent", instance: changed(intent, value => { value.proposal.quantity = "1e0"; }), expected: false },
    { id: "nested-extra-field", schemaName: "TradeIntent", instance: changed(intent, value => { value.proposal.unexpected = true; }), expected: false },
    { id: "collar-price-upper-bound", schemaName: "OrderPlan", instance: changed(orderPlan, value => { value.priceCollar.maximumLimitPrice = "1004999.9998"; }), expected: true },
    { id: "collar-price-above-bound", schemaName: "OrderPlan", instance: changed(orderPlan, value => { value.priceCollar.maximumLimitPrice = "1004999.9999"; }), expected: false },
    { id: "order-plan-extra-field", schemaName: "OrderPlan", instance: changed(orderPlan, value => { value.unexpected = true; }), expected: false },
    { id: "execution-event-extra-field", schemaName: "ExecutionEvent", instance: changed(executionEvent, value => { value.unexpected = true; }), expected: false },
    { id: "execution-event-nonzero-commission", schemaName: "ExecutionEvent", instance: changed(executionEvent, value => { value.commissionUsd = "0.01"; }), expected: false },
    { id: "audit-event-sequence-zero", schemaName: "AuditEvent", instance: changed(auditEvent, value => { value.sequence = 0; }), expected: false },
    { id: "accepted-response-null-plan", schemaName: "FixtureAuthorityResponse", instance: changed(acceptedResponse, value => { value.orderPlan = null; }), expected: false },
    { id: "rejected-response-with-plan", schemaName: "FixtureAuthorityResponse", instance: changed(rejectedResponse, value => { value.orderPlan = clone(orderPlan); }), expected: false },

    // The structural contract admits safe negatives for Python policy evaluation.
    { id: "policy-action-close-long", schemaName: "Policy", instance: changed(candidate.policy, value => { value.allowedAction = "CLOSE_LONG"; }), expected: true },
    { id: "policy-action-hold", schemaName: "Policy", instance: changed(candidate.policy, value => { value.allowedAction = "HOLD"; }), expected: true },
    { id: "policy-side-sell", schemaName: "Policy", instance: changed(candidate.policy, value => { value.side = "SELL"; }), expected: true },
    { id: "policy-session-extended", schemaName: "Policy", instance: changed(candidate.policy, value => { value.session = "EXTENDED"; }), expected: true },
    { id: "candidate-live", schemaName: "CandidateManifest", instance: changed(candidate, value => { value.mode = "LIVE"; }), expected: true },
    { id: "candidate-etf", schemaName: "CandidateManifest", instance: changed(candidate, value => { value.assetClass = "PLAIN_UNLEVERED_ETF"; }), expected: true },
    { id: "proposal-sell", schemaName: "TradeIntent", instance: changed(intent, value => { value.proposal.side = "SELL"; }), expected: true },
    { id: "proposal-extended", schemaName: "TradeIntent", instance: changed(intent, value => { value.proposal.session = "EXTENDED"; }), expected: true },
    { id: "research-local-rights", schemaName: "ResearchEvent", instance: changed(research, value => { value.rightsClass = "LOCAL_RESTRICTED"; }), expected: true },
    { id: "provenance-local", schemaName: "Provenance", instance: changed(research.provenance[0], value => { value.sourceClass = "LOCAL"; }), expected: true },

    // Closed conditional branches and reason collection boundaries.
    { id: "manager-propose-missing-evidence", schemaName: "ManagerSemanticDraft", instance: changed(managerDraft, value => { value.evidenceFactIds = []; }), expected: false },
    { id: "manager-abstain", schemaName: "ManagerSemanticDraft", instance: changed(managerDraft, value => {
      value.disposition = "ABSTAIN";
      value.proposal = null;
      value.abstainReasonCode = "INSUFFICIENT_EVIDENCE";
      value.evidenceFactIds = [];
    }), expected: true },
    { id: "manager-propose-with-reason", schemaName: "ManagerSemanticDraft", instance: changed(managerDraft, value => { value.abstainReasonCode = "UNSAFE_CONTEXT"; }), expected: false },
    { id: "critic-approve-wrong-reason", schemaName: "CriticSemanticDraft", instance: changed(criticDraft, value => { value.reasonCode = "EVIDENCE_GAP"; }), expected: false },
    { id: "critic-reject-evidence-gap", schemaName: "CriticSemanticDraft", instance: changed(criticDraft, value => { value.verdict = "REJECT"; value.reasonCode = "EVIDENCE_GAP"; }), expected: true },
    { id: "gate-27-reasons", schemaName: "GateDecision", instance: changed(gate, value => { value.reasonCodes.push(DOMAIN_REASON_CODES[0]); }), expected: false },
    { id: "gate-unknown-reason", schemaName: "GateDecision", instance: changed(gate, value => { value.reasonCodes[0] = "UNKNOWN_REASON"; value.primaryReasonCode = "UNKNOWN_REASON"; }), expected: false },
    { id: "incident-wrong-boundary-code", schemaName: "AppIncidentEvent", instance: changed(incident, value => { value.code = "RATE_LIMITED"; }), expected: false },
    { id: "incident-job-scope-operation-id", schemaName: "AppIncidentEvent", instance: changed(incident, value => { value.scopeType = "JOB"; }), expected: false },
    { id: "protocol-internal-message-input-code", schemaName: "ProtocolError", instance: changed(protocolError, value => { value.messageType = "FIXTURE_AUTHORITY_INTERNAL_ERROR"; }), expected: false },
    { id: "protocol-internal-error", schemaName: "ProtocolError", instance: changed(protocolError, value => { value.messageType = "FIXTURE_AUTHORITY_INTERNAL_ERROR"; value.errorCode = "INTERNAL_ERROR"; }), expected: true },
  ];

  const managerAbstain = changed(managerDraft, value => {
    value.disposition = "ABSTAIN";
    value.proposal = null;
    value.abstainReasonCode = "INSUFFICIENT_EVIDENCE";
    value.evidenceFactIds = [];
  });
  const intentAbstain = changed(intent, value => {
    value.disposition = "ABSTAIN";
    value.proposal = null;
    value.abstainReasonCode = "INSUFFICIENT_EVIDENCE";
    value.evidenceRefs = [];
  });
  const criticReject = changed(critic, value => {
    value.verdict = "REJECT";
    value.reasonCode = "EVIDENCE_GAP";
  });
  const criticAbstain = changed(critic, value => {
    value.verdict = "ABSTAIN";
    value.reasonCode = "INSUFFICIENT_EVIDENCE";
  });
  const criticDraftReject = changed(criticDraft, value => {
    value.verdict = "REJECT";
    value.reasonCode = "EVIDENCE_GAP";
  });
  const criticDraftAbstain = changed(criticDraft, value => {
    value.verdict = "ABSTAIN";
    value.reasonCode = "INSUFFICIENT_EVIDENCE";
  });
  const protocolInternal = changed(protocolError, value => {
    value.messageType = "FIXTURE_AUTHORITY_INTERNAL_ERROR";
    value.errorCode = "INTERNAL_ERROR";
  });

  const branchControls = [
    ["manager-abstain-control", "ManagerSemanticDraft", managerAbstain],
    ["intent-abstain-control", "TradeIntent", intentAbstain],
    ["critic-draft-reject-control", "CriticSemanticDraft", criticDraftReject],
    ["critic-draft-abstain-control", "CriticSemanticDraft", criticDraftAbstain],
    ["critic-reject-control", "CriticVerdict", criticReject],
    ["critic-abstain-control", "CriticVerdict", criticAbstain],
  ];
  for (const [id, schemaName, instance] of branchControls) {
    vectors.push({ id, schemaName, instance, expected: true });
  }

  const incidentCodes = Object.freeze({
    AUTHENTICATION: ["AUTH_REQUIRED"],
    HOSTED_SERVICE: ["RATE_LIMITED", "SOL_ULTRA_UNAVAILABLE", "MODEL_REROUTED", "TURN_TIMEOUT", "TURN_PROTOCOL_FAILED", "TURN_SCHEMA_INVALID"],
    RUNTIME_POLICY: ["THREAD_POLICY_INVALID", "MCP_TOOL_FORBIDDEN", "CRITIC_NOT_DISTINCT", "RUNTIME_NOT_QUALIFIED"],
    MCP: ["MCP_CONTRACT_INVALID"],
    MANAGER_OUTPUT: ["MANAGER_OUTPUT_INVALID", "MANAGER_ABSTAINED"],
    CRITIC_OUTPUT: ["CRITIC_OUTPUT_INVALID"],
    AUTHORITY_TRANSPORT: ["AUTHORITY_INPUT_ERROR", "AUTHORITY_TIMEOUT", "AUTHORITY_PROCESS_FAILED", "AUTHORITY_OUTPUT_INVALID", "AUTHORITY_RESPONSE_MISMATCH"],
    CLEANUP: ["CLIENT_CLEANUP_FAILED"],
    FIXTURE_STORE: ["NON_PUBLIC_DATA_REJECTED", "OPERATION_IN_PROGRESS", "IDEMPOTENCY_CONFLICT"],
    SIMULATOR: ["PARTIAL_FILL_UNSUPPORTED"],
    CORRECTION: ["CORRECTION_REQUIRES_NEW_OPERATION"],
    RECOVERY: ["RECOVERY_INCOMPLETE"],
    SCHEDULER: ["SCHEDULER_CIRCUIT_OPEN", "SCHEDULER_RESULT_INVALID", "SCHEDULER_RECOVERY_ABSTAINED", "SCHEDULER_LEASE_UNCERTAIN", "SCHEDULER_STATE_INVALID"],
  });
  for (const [boundary, codes] of Object.entries(incidentCodes)) {
    for (const code of codes) {
      vectors.push({
        id: `incident-branch-${boundary.toLowerCase()}-${code.toLowerCase()}`,
        schemaName: "AppIncidentEvent",
        instance: changed(incident, value => { value.boundary = boundary; value.code = code; }),
        expected: true,
      });
    }
  }
  const incidentBoundaries = Object.keys(incidentCodes);
  incidentBoundaries.forEach((boundary, index) => {
    const wrongBoundary = incidentBoundaries[(index + 1) % incidentBoundaries.length];
    vectors.push({
      id: `incident-branch-negative-${boundary.toLowerCase()}`,
      schemaName: "AppIncidentEvent",
      instance: changed(incident, value => { value.boundary = boundary; value.code = incidentCodes[wrongBoundary][0]; }),
      expected: false,
    });
  });
  const jobIncident = changed(incident, value => {
    value.scopeType = "JOB";
    value.scopeId = "job_fixture_schema_v1";
  });
  vectors.push({
    id: "incident-job-scope-control",
    schemaName: "AppIncidentEvent",
    instance: jobIncident,
    expected: true,
  });
  acceptedResponse.auditEvents.forEach(event => {
    vectors.push({
      id: `audit-branch-${event.eventType.toLowerCase()}`,
      schemaName: "AuditEvent",
      instance: event,
      expected: true,
    });
    vectors.push({
      id: `audit-branch-negative-${event.eventType.toLowerCase()}`,
      schemaName: "AuditEvent",
      instance: changed(event, value => { value.subjectType = event.subjectType === "ExecutionEvent" ? "ResearchEvent" : "ExecutionEvent"; }),
      expected: false,
    });
  });

  for (const kind of ["FIXTURE_SOURCE", "FIXTURE_REGISTRY", "MANAGER", "CRITIC", "PYTHON_AUTHORITY"]) {
    vectors.push({ id: `enum-producer-${kind.toLowerCase()}`, schemaName: "Producer", instance: changed(research.producer, value => { value.kind = kind; }), expected: true });
  }
  research.facts.forEach(fact => vectors.push({ id: `enum-fact-${fact.kind.toLowerCase()}`, schemaName: "Fact", instance: fact, expected: true }));
  for (const rightsClass of ["PUBLIC_OFFICIAL", "LICENSED_MODEL_OK", "LOCAL_RESTRICTED"]) {
    vectors.push({ id: `enum-rights-${rightsClass.toLowerCase()}`, schemaName: "ResearchEvent", instance: changed(research, value => { value.rightsClass = rightsClass; }), expected: true });
  }
  for (const sourceClass of ["PUBLIC_OFFICIAL", "LICENSED_VENDOR", "LOCAL"]) {
    vectors.push({ id: `enum-source-${sourceClass.toLowerCase()}`, schemaName: "Provenance", instance: changed(research.provenance[0], value => { value.sourceClass = sourceClass; }), expected: true });
  }
  for (const mode of ["PAPER", "LIVE"]) {
    vectors.push({ id: `enum-mode-${mode.toLowerCase()}`, schemaName: "CandidateManifest", instance: changed(candidate, value => { value.mode = mode; }), expected: true });
  }
  for (const assetClass of ["US_PRIMARY_LISTED_COMMON_STOCK", "PLAIN_UNLEVERED_ETF"]) {
    vectors.push({ id: `enum-asset-${assetClass.toLowerCase()}`, schemaName: "CandidateManifest", instance: changed(candidate, value => { value.assetClass = assetClass; }), expected: true });
  }
  for (const action of ["OPEN_LONG", "CLOSE_LONG", "HOLD"]) {
    vectors.push({ id: `enum-action-${action.toLowerCase()}`, schemaName: "Policy", instance: changed(candidate.policy, value => { value.allowedAction = action; }), expected: true });
  }
  for (const side of ["BUY", "SELL"]) {
    vectors.push({ id: `enum-side-${side.toLowerCase()}`, schemaName: "Policy", instance: changed(candidate.policy, value => { value.side = side; }), expected: true });
  }
  for (const session of ["REGULAR", "EXTENDED"]) {
    vectors.push({ id: `enum-session-${session.toLowerCase()}`, schemaName: "Policy", instance: changed(candidate.policy, value => { value.session = session; }), expected: true });
  }
  for (const abstainReasonCode of ["INSUFFICIENT_EVIDENCE", "NO_SUPPORTED_ACTION", "UNSAFE_CONTEXT"]) {
    vectors.push(
      { id: `enum-manager-abstain-${abstainReasonCode.toLowerCase()}`, schemaName: "ManagerSemanticDraft", instance: changed(managerAbstain, value => { value.abstainReasonCode = abstainReasonCode; }), expected: true },
      { id: `enum-intent-abstain-${abstainReasonCode.toLowerCase()}`, schemaName: "TradeIntent", instance: changed(intentAbstain, value => { value.abstainReasonCode = abstainReasonCode; }), expected: true },
    );
  }
  for (const reasonCode of ["EVIDENCE_GAP", "THESIS_CONTRADICTION", "FIXTURE_POLICY_CONCERN"]) {
    vectors.push(
      { id: `enum-critic-draft-reject-${reasonCode.toLowerCase()}`, schemaName: "CriticSemanticDraft", instance: changed(criticDraftReject, value => { value.reasonCode = reasonCode; }), expected: true },
      { id: `enum-critic-reject-${reasonCode.toLowerCase()}`, schemaName: "CriticVerdict", instance: changed(criticReject, value => { value.reasonCode = reasonCode; }), expected: true },
    );
  }
  for (const errorCode of ["INPUT_LIMIT_EXCEEDED", "INPUT_ENCODING_INVALID", "INPUT_FRAMING_INVALID", "INPUT_JSON_INVALID", "INPUT_DUPLICATE_KEY", "PROFILE_UNSUPPORTED", "SCHEMA_UNSUPPORTED", "INPUT_SCHEMA_INVALID", "INPUT_ARTIFACT_HASH_INVALID"]) {
    vectors.push({ id: `enum-protocol-${errorCode.toLowerCase()}`, schemaName: "ProtocolError", instance: changed(protocolError, value => { value.errorCode = errorCode; }), expected: true });
  }

  const fieldBases = [
    ["producer", "Producer", research.producer, 32],
    ...research.facts.map((fact, index) => [`fact-${index}`, "Fact", fact, 32]),
    ["provenance", "Provenance", research.provenance[0], 32],
    ["policy", "Policy", candidate.policy, 32],
    ["research", "ResearchEvent", research, 32],
    ["candidate", "CandidateManifest", candidate, 32],
    ["manager-propose", "ManagerSemanticDraft", managerDraft, 32],
    ["manager-abstain", "ManagerSemanticDraft", managerAbstain, 32],
    ["intent-propose", "TradeIntent", intent, 32],
    ["intent-abstain", "TradeIntent", intentAbstain, 32],
    ["critic-draft-approve", "CriticSemanticDraft", criticDraft, 32],
    ["critic-draft-reject", "CriticSemanticDraft", criticDraftReject, 32],
    ["critic-draft-abstain", "CriticSemanticDraft", criticDraftAbstain, 32],
    ["critic-approve", "CriticVerdict", critic, 32],
    ["critic-reject", "CriticVerdict", criticReject, 32],
    ["critic-abstain", "CriticVerdict", criticAbstain, 32],
    ["gate-accept", "GateDecision", acceptedResponse.gateDecision, 32],
    ["gate-reject", "GateDecision", rejectedResponse.gateDecision, 32],
    ["order-plan", "OrderPlan", orderPlan, 32],
    ["execution", "ExecutionEvent", executionEvent, 32],
    ...acceptedResponse.auditEvents.map((event, index) => [`audit-${index}`, "AuditEvent", event, 32]),
    ["incident", "AppIncidentEvent", incident, 32],
    ["request", "FixtureAuthorityRequest", request, 1],
    ["response-accept", "FixtureAuthorityResponse", acceptedResponse, 0],
    ["response-reject", "FixtureAuthorityResponse", rejectedResponse, 0],
    ["protocol-input", "ProtocolError", protocolError, 32],
    ["protocol-internal", "ProtocolError", protocolInternal, 32],
  ];
  for (const [label, schemaName, instance, maxDepth] of fieldBases) {
    vectors.push(...fieldMutationVectors(schemaName, label, instance, { maxDepth }));
  }

  const typedIds = [
    ["request", "FixtureAuthorityRequest", request, ["requestId"], "req_"],
    ["operation", "FixtureAuthorityRequest", request, ["operationId"], "op_"],
    ["job", "AppIncidentEvent", jobIncident, ["scopeId"], "job_"],
    ["research", "ResearchEvent", research, ["eventId"], "re_"],
    ["revision", "ResearchEvent", research, ["revisionId"], "rev_"],
    ["fact", "Fact", research.facts[0], ["factId"], "fact_"],
    ["provenance", "Provenance", research.provenance[0], ["provenanceId"], "prov_"],
    ["candidate", "CandidateManifest", candidate, ["candidateId"], "cand_"],
    ["intent", "TradeIntent", intent, ["intentId"], "ti_"],
    ["critic", "CriticVerdict", critic, ["verdictId"], "cv_"],
    ["gate", "GateDecision", acceptedResponse.gateDecision, ["decisionId"], "gd_"],
    ["plan", "OrderPlan", orderPlan, ["planId"], "plan_"],
    ["execution", "ExecutionEvent", executionEvent, ["executionId"], "exec_"],
    ["audit", "AuditEvent", auditEvent, ["auditId"], "audit_"],
    ["audit-event", "AuditEvent", auditEvent, ["auditEventId"], "ae_"],
    ["incident", "AppIncidentEvent", incident, ["incidentId"], "inc_"],
    ["run", "Producer", research.producer, ["runId"], "run_"],
  ];
  for (const [label, schemaName, base, pathItems, prefix] of typedIds) {
    for (const [edge, value, expected] of [
      ["prefix-min", prefix, true],
      ["total-64", `${prefix}${"a".repeat(64 - prefix.length)}`, true],
      ["total-65", `${prefix}${"a".repeat(65 - prefix.length)}`, false],
      ["wrong-prefix", `x_${"a".repeat(Math.max(1, prefix.length - 2))}`, false],
      ["trailing-lf", `${prefix}a\n`, false],
    ]) {
      vectors.push({
        id: `typed-id-${label}-${edge}`,
        schemaName,
        instance: changedAt(base, pathItems, value),
        expected,
      });
    }
  }

  const lexicalBoundaries = [
    ["timestamp", "CandidateManifest", candidate, ["createdAt"], ["0001-01-01T00:00:00.000Z", "2024-02-29T23:59:59.999Z"], ["2023-02-29T00:00:00.000Z", "2026-01-01T00:00:60.000Z", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00.000+00:00", "2026-01-01T00:00:00.000Z\n", "２０２６-01-01T00:00:00.000Z", "٢٠٢٦-01-01T00:00:00.000Z"]],
    ["usd-price", "Fact", research.facts[referenceIndex], ["value"], ["0.0001", "999999.9999"], ["0.0000", "1000000.0000", "01.0000", "1.000", "1e0", "1.0000\n"]],
    ["usd-collar", "OrderPlan", orderPlan, ["priceCollar", "maximumLimitPrice"], ["0.0001", "1004999.9998"], ["0.0000", "1004999.9999", "1005000.0000", "1.0000\n"]],
    ["share-quantity", "Policy", candidate.policy, ["maxQuantity"], ["0.000001", "1000000.000000"], ["0.000000", "1000000.000001", "1.00000", "1.000000\n"]],
    ["unsigned-usd", "Policy", candidate.policy, ["maxGrossNotionalUsd"], ["0.00", "999999999.99"], ["1000000000.00", "0.0", "-0.01", "1.00\n"]],
    ["ratio", "Policy", candidate.policy, ["buyCollarRatio"], ["0.000000", "1.000000"], ["1.000001", "0.00000", "-0.000001", "0.005000\n"]],
    ["text", "Fact", research.facts[noticeIndex], ["value"], ["x", "😀".repeat(1024)], ["", "x".repeat(1025), "line\nfeed", "e\u0301", "text\n", `${String.fromCodePoint(0x105d2)}\u0307`]],
    ["hash", "ResearchEvent", research, ["eventHash"], ["a".repeat(64)], ["A".repeat(64), "a".repeat(63), "a".repeat(65), `${"a".repeat(64)}\n`]],
    ["instrument", "CandidateManifest", candidate, ["instrumentId"], ["A", "BRK.B", "A123456789"], ["", "mp", "A1234567890", "MPTEST\n"]],
    ["currency", "CandidateManifest", candidate, ["currency"], ["USD", "CAD"], ["usd", "US", "USDD", "USD\n"]],
    ["source-id", "Provenance", research.provenance[0], ["sourceId"], ["abc", `a${"b".repeat(63)}`], ["ab", `a${"b".repeat(64)}`, "Aaa", "abc\n"]],
    ["source-revision", "Provenance", research.provenance[0], ["sourceRevision"], ["!", "x".repeat(128)], ["", "x".repeat(129), "contains space", "é", "abc\n"]],
    ["strategy", "CandidateManifest", candidate, ["strategyKind"], ["ABC", `A${"B".repeat(63)}`], ["AB", `A${"B".repeat(64)}`, "fixture_long_us_equity", "ABC\n"]],
  ];
  for (const [label, schemaName, base, pathItems, validValues, invalidValues] of lexicalBoundaries) {
    validValues.forEach((value, index) => vectors.push({
      id: `lexical-${label}-valid-${index}`,
      schemaName,
      instance: changedAt(base, pathItems, value),
      expected: true,
    }));
    invalidValues.forEach((value, index) => vectors.push({
      id: `lexical-${label}-invalid-${index}`,
      schemaName,
      instance: changedAt(base, pathItems, value),
      expected: false,
    }));
  }

  const sixteenProvenance = Array.from({ length: 16 }, (_, index) => changed(research.provenance[0], value => {
    value.provenanceId = `prov_${String(index).padStart(2, "0")}_schema_v1`;
  }));
  vectors.push(
    { id: "provenance-array-max-16", schemaName: "ResearchEvent", instance: changed(research, value => { value.provenance = sixteenProvenance; }), expected: true },
    { id: "provenance-array-over-17", schemaName: "ResearchEvent", instance: changed(research, value => { value.provenance = [...sixteenProvenance, changed(sixteenProvenance[15], item => { item.provenanceId = "prov_16_schema_v1"; })]; }), expected: false },
    { id: "research-facts-below-three", schemaName: "ResearchEvent", instance: changed(research, value => { value.facts.pop(); }), expected: false },
    { id: "research-facts-above-three", schemaName: "ResearchEvent", instance: changed(research, value => { value.facts.push(changed(value.facts.at(-1), item => { item.factId = "fact_zz_schema_v1"; })); }), expected: false },
  );
  const sixteenFactIds = Array.from({ length: 16 }, (_, index) => `fact_${String(index).padStart(2, "0")}_schema_v1`);
  const seventeenFactIds = [...sixteenFactIds, "fact_16_schema_v1"];
  const evidenceRef = {
    eventId: research.eventId,
    eventHash: research.eventHash,
    factIds: [sixteenFactIds[0]],
  };
  const sixteenEvidenceRefs = Array.from({ length: 16 }, (_, index) => ({
    ...evidenceRef,
    eventId: `re_${String(index).padStart(2, "0")}_schema_v1`,
  }));
  vectors.push(
    { id: "manager-evidence-max-16", schemaName: "ManagerSemanticDraft", instance: changed(managerDraft, value => { value.evidenceFactIds = sixteenFactIds; }), expected: true },
    { id: "manager-evidence-over-17", schemaName: "ManagerSemanticDraft", instance: changed(managerDraft, value => { value.evidenceFactIds = seventeenFactIds; }), expected: false },
    { id: "critic-draft-evidence-max-16", schemaName: "CriticSemanticDraft", instance: changed(criticDraft, value => { value.evidenceFactIds = sixteenFactIds; }), expected: true },
    { id: "critic-draft-evidence-over-17", schemaName: "CriticSemanticDraft", instance: changed(criticDraft, value => { value.evidenceFactIds = seventeenFactIds; }), expected: false },
    { id: "critic-draft-evidence-empty", schemaName: "CriticSemanticDraft", instance: changed(criticDraft, value => { value.evidenceFactIds = []; }), expected: false },
    { id: "critic-evidence-max-16", schemaName: "CriticVerdict", instance: changed(critic, value => { value.evidenceFactIds = sixteenFactIds; }), expected: true },
    { id: "critic-evidence-over-17", schemaName: "CriticVerdict", instance: changed(critic, value => { value.evidenceFactIds = seventeenFactIds; }), expected: false },
    { id: "intent-evidence-facts-max-16", schemaName: "TradeIntent", instance: changed(intent, value => { value.evidenceRefs[0].factIds = sixteenFactIds; }), expected: true },
    { id: "intent-evidence-facts-over-17", schemaName: "TradeIntent", instance: changed(intent, value => { value.evidenceRefs[0].factIds = seventeenFactIds; }), expected: false },
    { id: "intent-abstain-evidence-max-16", schemaName: "TradeIntent", instance: changed(intentAbstain, value => { value.evidenceRefs = sixteenEvidenceRefs; }), expected: true },
    { id: "intent-abstain-evidence-over-17", schemaName: "TradeIntent", instance: changed(intentAbstain, value => { value.evidenceRefs = [...sixteenEvidenceRefs, { ...evidenceRef, eventId: "re_16_schema_v1" }]; }), expected: false },
    { id: "intent-propose-evidence-over-one", schemaName: "TradeIntent", instance: changed(intent, value => { value.evidenceRefs.push({ ...evidenceRef, eventId: "re_zz_schema_v1" }); }), expected: false },
    { id: "response-accepted-audit-below-seven", schemaName: "FixtureAuthorityResponse", instance: changed(acceptedResponse, value => { value.auditEvents.pop(); }), expected: false },
    { id: "response-accepted-audit-above-seven", schemaName: "FixtureAuthorityResponse", instance: changed(acceptedResponse, value => { value.auditEvents.push(clone(value.auditEvents.at(-1))); }), expected: false },
    { id: "response-rejected-audit-min-four", schemaName: "FixtureAuthorityResponse", instance: changed(rejectedResponse, value => { value.auditEvents = value.auditEvents.slice(0, 4); }), expected: true },
    { id: "response-rejected-audit-over-six", schemaName: "FixtureAuthorityResponse", instance: changed(rejectedResponse, value => { value.auditEvents.push(clone(value.auditEvents.at(-1))); }), expected: false },
    { id: "audit-sequence-max-16", schemaName: "AuditEvent", instance: changed(auditEvent, value => { value.sequence = 16; }), expected: true },
    { id: "audit-sequence-over-17", schemaName: "AuditEvent", instance: changed(auditEvent, value => { value.sequence = 17; }), expected: false },
    { id: "incident-sequence-max-16", schemaName: "AppIncidentEvent", instance: changed(incident, value => { value.sequence = 16; }), expected: true },
    { id: "incident-sequence-over-17", schemaName: "AppIncidentEvent", instance: changed(incident, value => { value.sequence = 17; }), expected: false },
    { id: "gate-duplicate-within-26", schemaName: "GateDecision", instance: changed(gate, value => { value.reasonCodes[25] = value.reasonCodes[0]; }), expected: false },
    { id: "research-facts-missing-kind", schemaName: "ResearchEvent", instance: changed(research, value => { value.facts[referenceIndex].kind = value.facts[askIndex].kind; }), expected: false },
  );
  return vectors;
}

function nodeValidity(vector) {
  try {
    PAPER_REGISTRY.validate(vector.schemaName, clone(vector.instance));
    return true;
  } catch {
    return false;
  }
}

async function pythonValidity(vectors) {
  const python = process.env.MARKETPILOT_PYTHON ?? path.join(root, ".venv-paper", "bin", "python");
  const allResults = [];
  for (let offset = 0; offset < vectors.length; offset += 128) {
    const batch = vectors.slice(offset, offset + 128);
    const payload = batch.map(({ schemaName, instance }) => ({ schemaName, instance }));
    const encoded = `${JSON.stringify(payload)}\n`;
    assert.ok(Buffer.byteLength(encoded) < 4_000_000, "schema parity probe batch must remain below its transport bound");
    const child = spawn(python, ["-m", "marketpilot.paper_contract_schema", "--probe"], {
      cwd: root,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        PYTHONPATH: path.join(root, "src"),
        PYTHONNOUSERSITE: "1",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let stdinError = null;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.stdin.on("error", error => { stdinError = error; });
    child.stdin.end(encoded);
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.equal(stdinError, null, `Python schema probe stdin failed: ${stdinError?.message ?? "unknown"}`);
    assert.equal(code, 0, `Python schema probe failed (${code}): ${stderr || stdout}`);
    assert.equal(stderr, "", "Python schema probe must keep stderr empty on a valid probe request");
    const entries = JSON.parse(stdout);
    assert.ok(Array.isArray(entries), "Python schema probe must return the exact result array");
    assert.equal(entries.length, batch.length, "Python schema probe result count must match request order");
    entries.forEach((entry, index) => {
      assert.deepEqual(Object.keys(entry).toSorted(), ["schemaName", "valid"]);
      assert.equal(entry.schemaName, batch[index].schemaName, `Python probe result ${offset + index} schema order`);
      assert.equal(typeof entry.valid, "boolean", `Python probe result ${offset + index} must contain boolean valid`);
      allResults.push(entry.valid);
    });
  }
  return allResults;
}

async function pythonAuthorityResponses(requests) {
  const python = process.env.MARKETPILOT_PYTHON ?? path.join(root, ".venv-paper", "bin", "python");
  const script = [
    "import json,sys",
    "from marketpilot.paper_fixture_authority import evaluate_request",
    "items=json.load(sys.stdin)",
    "json.dump([evaluate_request(item) for item in items],sys.stdout,separators=(',',':'))",
  ].join(";");
  const child = spawn(python, ["-c", script], {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      PYTHONPATH: path.join(root, "src"),
      PYTHONNOUSERSITE: "1",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.stdin.end(JSON.stringify(requests));
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(code, 0, `Python authority fixture generation failed (${code}): ${stderr || stdout}`);
  assert.equal(stderr, "", "Python authority fixture generation must keep stderr empty");
  const responses = JSON.parse(stdout);
  assert.equal(responses.length, requests.length);
  return responses;
}

test("paper schema registry freezes the exact executable profile inventory", () => {
  assert.equal(process.versions.unicode, "17.0", "the frozen NFC profile requires Node Unicode 17.0 data");
  assert.equal(PAPER_REGISTRY.registry.rules.unicodeVersion, "17.0");
  assert.deepEqual(Object.keys(PAPER_REGISTRY.registry.schemas), [...EXPECTED_SCHEMA_NAMES]);
  assert.deepEqual([...PAPER_REGISTRY.schemas.keys()], [...EXPECTED_SCHEMA_NAMES]);
  assert(Object.isFrozen(PAPER_REGISTRY.schemas));
  assert.equal(PAPER_REGISTRY.schemas.delete, undefined);
  assert.equal(PAPER_REGISTRY.schemas.set, undefined);
  assert.equal(typeof PAPER_REGISTRY.validate, "function");
  for (const [name, schema] of PAPER_REGISTRY.schemas) {
    assert.equal(schema.$schema, LOCAL_META_ID, `${name} must use the local profile meta-schema`);
    assert.match(schema.$id, /^urn:marketpilot:paper-intent-fixture:v1:[a-z-]+$/, `${name} must have a local stable id`);
  }
});

test("Node and Python agree on custom vocabulary, known regressions, safe negatives, and closed branches", async t => {
  const acceptedRequest = acceptedFixtureRequest();
  const rejectedRequest = rejectedFixtureRequest();
  const [acceptedResponse, rejectedResponse] = await pythonAuthorityResponses([acceptedRequest, rejectedRequest]);
  const vectors = buildVectors(acceptedResponse, rejectedResponse);
  t.diagnostic(`differential vectors: ${vectors.length}; registered schemas: ${EXPECTED_SCHEMA_NAMES.length}; custom vocabulary vectors: ${PAPER_REGISTRY.vocabularyVectors.length}`);
  assert.equal(new Set(vectors.map(vector => vector.id)).size, vectors.length, "parity vector ids must be unique");
  const exercisedSchemas = new Set(vectors.map(vector => vector.schemaName));
  assert.deepEqual(
    [...EXPECTED_SCHEMA_NAMES].filter(name => name !== "Primitives" && !exercisedSchemas.has(name)),
    [],
    "every instance schema must have a direct differential vector",
  );
  for (const schemaName of EXPECTED_SCHEMA_NAMES.filter(name => name !== "Primitives")) {
    const schemaVectors = vectors.filter(vector => vector.schemaName === schemaName);
    assert.ok(schemaVectors.some(vector => vector.id.startsWith("field-") && vector.id.endsWith("-missing")), `${schemaName}: required-field deletion coverage`);
    assert.ok(schemaVectors.some(vector => vector.id.startsWith("field-") && vector.id.endsWith("-wrong-type")), `${schemaName}: wrong-type coverage`);
    assert.ok(schemaVectors.some(vector => vector.id.startsWith("field-") && vector.id.endsWith("-unexpected")), `${schemaName}: closed-object coverage`);
  }
  for (const label of ["timestamp", "usd-price", "usd-collar", "share-quantity", "unsigned-usd", "ratio", "text", "hash", "instrument", "currency", "source-id", "source-revision", "strategy"]) {
    assert.ok(vectors.some(vector => vector.id.startsWith(`lexical-${label}-valid-`)), `${label}: positive boundary coverage`);
    assert.ok(vectors.some(vector => vector.id.startsWith(`lexical-${label}-invalid-`)), `${label}: negative boundary coverage`);
  }
  assert.equal(vectors.filter(vector => vector.id.startsWith("typed-id-") && vector.id.endsWith("-total-64")).length, 17, "every typed ID family needs a 64-scalar control");
  assert.equal(vectors.filter(vector => vector.id.startsWith("typed-id-") && vector.id.endsWith("-total-65")).length, 17, "every typed ID family needs a 65-scalar rejection");
  assert.equal(vectors.filter(vector => vector.id.startsWith("typed-id-") && vector.id.endsWith("-trailing-lf")).length, 17, "every typed ID family needs an absolute-end rejection");
  assert.deepEqual(
    new Set(vectors.filter(vector => vector.id.startsWith("audit-branch-")).map(vector => vector.instance.eventType)),
    new Set(["INPUT_RESEARCH_RECORDED", "INPUT_CANDIDATE_RECORDED", "INPUT_INTENT_RECORDED", "INPUT_CRITIC_RECORDED", "GATE_DECIDED", "ORDER_PLANNED", "EXECUTION_SIMULATED"]),
    "every AuditEvent branch needs a positive control",
  );
  assert.equal(vectors.filter(vector => vector.id.startsWith("audit-branch-negative-")).length, 7, "every AuditEvent conditional needs a cross-pair rejection");
  assert.equal(vectors.filter(vector => vector.id.startsWith("incident-branch-") && !vector.id.startsWith("incident-branch-negative-")).length, 32, "every AppIncident boundary/code pairing needs a positive control");
  assert.equal(vectors.filter(vector => vector.id.startsWith("incident-branch-negative-")).length, 13, "every AppIncident boundary conditional needs a cross-pair rejection");
  for (const id of ["accepted-response-golden", "rejected-response-golden", "accepted-response-null-plan", "rejected-response-with-plan", "gate-all-26-reasons", "gate-27-reasons", "provenance-array-max-16", "provenance-array-over-17", "research-facts-below-three", "research-facts-above-three"]) {
    assert.ok(vectors.some(vector => vector.id === id), `${id}: conditional or collection boundary coverage`);
  }
  const node = vectors.map(nodeValidity);
  const python = await pythonValidity(vectors);
  for (const [index, vector] of vectors.entries()) {
    assert.equal(node[index], vector.expected, `${vector.id}: Node validity`);
    assert.equal(python[index], vector.expected, `${vector.id}: Python validity`);
    assert.equal(node[index], python[index], `${vector.id}: cross-runtime parity`);
  }
});
