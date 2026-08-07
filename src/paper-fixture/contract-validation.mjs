// @ts-check

import { createHash } from "node:crypto";
import { PAPER_REGISTRY } from "./registry.mjs";

export const PAPER_PROFILE = "marketpilot.paper-intent-fixture.v1";
export const PAPER_POLICY_ID = "FIXTURE_LONG_US_EQUITY_100_V1";
export const PAPER_SCHEMA_VERSION = 1;
export const MAX_MESSAGE_BYTES = 131_072;

const ARTIFACT_HASH = Object.freeze({
  ResearchEvent: ["eventHash", "research-event"],
  CandidateManifest: ["candidateHash", "candidate"],
  TradeIntent: ["intentHash", "trade-intent"],
  CriticVerdict: ["verdictHash", "critic-verdict"],
  GateDecision: ["decisionHash", "gate-decision"],
  OrderPlan: ["planHash", "order-plan"],
  ExecutionEvent: ["executionHash", "execution-event"],
  AuditEvent: ["eventHash", "audit-event"],
  AppIncidentEvent: ["incidentHash", "app-incident"],
});

export const DOMAIN_REASON_CODES = Object.freeze([
  "INTENT_CANDIDATE_MISMATCH", "INTENT_EVIDENCE_MISMATCH", "CRITIC_INTENT_MISMATCH",
  "CRITIC_CANDIDATE_MISMATCH", "CRITIC_NOT_DISTINCT", "TIME_ORDER_INVALID",
  "CANDIDATE_INACTIVE", "RIGHTS_NOT_PUBLIC", "EVIDENCE_STALE", "INTENT_STALE",
  "CRITIC_STALE", "INTENT_ABSTAINED", "CRITIC_MISSING", "CRITIC_REJECTED",
  "CRITIC_ABSTAINED", "FIXTURE_POLICY_MISMATCH", "CANDIDATE_NOT_PAPER",
  "CANDIDATE_LIVE_ELIGIBLE", "INSTRUMENT_NOT_ALLOWED", "CURRENCY_NOT_USD",
  "ACTION_NOT_ALLOWED", "SIDE_NOT_ALLOWED", "SESSION_NOT_REGULAR",
  "QUANTITY_LIMIT_EXCEEDED", "NOTIONAL_LIMIT_EXCEEDED", "PRICE_NOT_MARKETABLE",
]);

const DOMAIN_REASON_ORDER = new Map(DOMAIN_REASON_CODES.map((code, index) => [code, index]));

export class PaperContractError extends Error {
  /** @param {string} code @param {string} message @param {Record<string, unknown>} [details] */
  constructor(code, message, details = {}) {
    super(message);
    this.name = "PaperContractError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function schemaError(name, error) {
  const detail = error && typeof error === "object" && "message" in error ? String(error.message) : "schema assertion failed";
  return new PaperContractError("INPUT_SCHEMA_INVALID", `${name} failed the frozen schema`, { schemaName: name, detail });
}

/** Execute the one committed structural/lexical authority. */
export function validateSchema(name, value) {
  try {
    const result = PAPER_REGISTRY.validate(name, value);
    if (result === false) throw new Error("schema assertion failed");
  } catch (error) {
    throw schemaError(name, error);
  }
  return value;
}

export const validateResearchEvent = value => validateSchema("ResearchEvent", value);
export const validateCandidateManifest = value => validateSchema("CandidateManifest", value);
export const validateManagerSemanticDraft = value => validateSchema("ManagerSemanticDraft", value);
export const validateTradeIntent = value => validateSchema("TradeIntent", value);
export const validateCriticSemanticDraft = value => validateSchema("CriticSemanticDraft", value);
export const validateCriticVerdict = value => validateSchema("CriticVerdict", value);
export const validateGateDecision = value => validateSchema("GateDecision", value);
export const validateOrderPlan = value => validateSchema("OrderPlan", value);
export const validateExecutionEvent = value => validateSchema("ExecutionEvent", value);
export const validateAuditEvent = value => validateSchema("AuditEvent", value);
export const validateAppIncidentEvent = value => validateSchema("AppIncidentEvent", value);
export const validateRequest = value => validateSchema("FixtureAuthorityRequest", value);
export const validateResponse = value => validateSchema("FixtureAuthorityResponse", value);

export function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("Only safe integer JSON numbers are permitted");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  throw new TypeError("Unsupported JSON value");
}

function domainHash(domainSuffix, value) {
  return createHash("sha256")
    .update(`${PAPER_PROFILE}/${domainSuffix}`, "ascii")
    .update(Buffer.from([0]))
    .update(Buffer.from(canonicalJson(value), "utf8"))
    .digest("hex");
}

export function artifactHash(value, artifactType) {
  const descriptor = ARTIFACT_HASH[artifactType];
  if (!descriptor) throw new TypeError(`Unknown artifact type ${artifactType}`);
  const [ownField, suffix] = descriptor;
  const view = { ...value };
  delete view[ownField];
  return domainHash(suffix, view);
}

export function requestHash(request) {
  return domainHash("request", request);
}

export function responseHash(response) {
  const view = { ...response };
  delete view.responseHash;
  return domainHash("response", view);
}

export function deterministicId(prefix, operationId, artifactType, sequence = null) {
  const suffix = sequence === null ? "" : `\u0000${sequence}`;
  const digest = createHash("sha256")
    .update(`${PAPER_PROFILE}\u0000${operationId}\u0000${artifactType}${suffix}`, "utf8")
    .digest("hex");
  return `${prefix}${digest.slice(0, 32)}`;
}

/** Parse the bounded profile JSON subset without accepting duplicate keys or financial JSON numbers. */
export function parseJsonNoDuplicates(text) {
  let index = 0;
  const peek = () => text[index];
  const whitespace = () => { while (/[ \t\n\r]/.test(peek() ?? "")) index += 1; };
  const parseString = () => {
    if (peek() !== '"') throw new PaperContractError("INPUT_JSON_INVALID", "JSON string expected");
    const start = index;
    index += 1;
    while (index < text.length) {
      const character = text[index++];
      if (character === "\\") {
        if (index >= text.length) throw new PaperContractError("INPUT_JSON_INVALID", "Unterminated JSON escape");
        if (text[index] === "u") index += 5;
        else index += 1;
      } else if (character === '"') {
        try { return JSON.parse(text.slice(start, index)); } catch { throw new PaperContractError("INPUT_JSON_INVALID", "Invalid JSON string"); }
      }
    }
    throw new PaperContractError("INPUT_JSON_INVALID", "Unterminated JSON string");
  };
  const parseValue = () => {
    whitespace();
    const character = peek();
    if (character === '"') return parseString();
    if (character === "{") {
      index += 1;
      const object = {};
      const keys = new Set();
      whitespace();
      if (peek() === "}") { index += 1; return object; }
      while (true) {
        whitespace();
        const key = parseString();
        if (keys.has(key)) throw new PaperContractError("INPUT_DUPLICATE_KEY", "Duplicate JSON key");
        keys.add(key);
        whitespace();
        if (peek() !== ":") throw new PaperContractError("INPUT_JSON_INVALID", "JSON colon expected");
        index += 1;
        object[key] = parseValue();
        whitespace();
        if (peek() === "}") { index += 1; break; }
        if (peek() !== ",") throw new PaperContractError("INPUT_JSON_INVALID", "JSON comma expected");
        index += 1;
      }
      return object;
    }
    if (character === "[") {
      index += 1;
      const array = [];
      whitespace();
      if (peek() === "]") { index += 1; return array; }
      while (true) {
        array.push(parseValue());
        whitespace();
        if (peek() === "]") { index += 1; break; }
        if (peek() !== ",") throw new PaperContractError("INPUT_JSON_INVALID", "JSON comma expected");
        index += 1;
      }
      return array;
    }
    const match = text.slice(index).match(/^(true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/);
    if (!match) throw new PaperContractError("INPUT_JSON_INVALID", "JSON value expected");
    if (/^-?\d/.test(match[0]) && (match[0].includes(".") || /[eE]/.test(match[0]))) throw new PaperContractError("INPUT_JSON_INVALID", "Only integer JSON numbers are permitted");
    index += match[0].length;
    const parsed = JSON.parse(match[0]);
    if (typeof parsed === "number" && !Number.isSafeInteger(parsed)) throw new PaperContractError("INPUT_JSON_INVALID", "JSON integer is outside the safe profile range");
    return parsed;
  };
  const result = parseValue();
  whitespace();
  if (index !== text.length) throw new PaperContractError("INPUT_JSON_INVALID", "Trailing JSON content");
  return result;
}

export function validateRequestHashes(request) {
  const bundle = request.bundle;
  const artifacts = [
    ["ResearchEvent", bundle.researchEvent],
    ["CandidateManifest", bundle.candidateManifest],
    ["TradeIntent", bundle.tradeIntent],
    ...(bundle.criticVerdict === null ? [] : [["CriticVerdict", bundle.criticVerdict]]),
  ];
  for (const [type, artifact] of artifacts) {
    if (artifactHash(artifact, type) !== artifact[ARTIFACT_HASH[type][0]]) {
      throw new PaperContractError("INPUT_ARTIFACT_HASH_INVALID", `${type} hash mismatch`);
    }
  }
  return requestHash(request);
}

function assertAuthority(condition, message) {
  if (!condition) throw new PaperContractError("AUTHORITY_RESPONSE_MISMATCH", message);
}

function fixedDecimalUnits(value, scale) {
  const [whole, fraction] = value.split(".");
  assertAuthority(fraction?.length === scale, "authority decimal scale is invalid after schema validation");
  return BigInt(whole) * (10n ** BigInt(scale)) + BigInt(fraction);
}

function formatFixedUnits(units, scale) {
  const divisor = 10n ** BigInt(scale);
  return `${units / divisor}.${(units % divisor).toString().padStart(scale, "0")}`;
}

function roundHalfEven(units, discardedScale) {
  const divisor = 10n ** BigInt(discardedScale);
  const quotient = units / divisor;
  const remainder = units % divisor;
  const halfway = divisor / 2n;
  return quotient + (remainder > halfway || (remainder === halfway && quotient % 2n === 1n) ? 1n : 0n);
}

function assertReasons(response) {
  const gate = response.gateDecision;
  assertAuthority(response.primaryReasonCode === gate.primaryReasonCode && canonicalJson(response.reasonCodes) === canonicalJson(gate.reasonCodes), "response and gate reasons differ");
  if (response.status === "ACCEPTED") {
    assertAuthority(gate.decision === "ACCEPT" && response.primaryReasonCode === "ACCEPTED" && response.reasonCodes.length === 1 && response.reasonCodes[0] === "ACCEPTED", "accepted reason branch is inconsistent");
    return;
  }
  const codes = response.reasonCodes;
  assertAuthority(gate.decision === "REJECT" && codes.length >= 1 && codes.length <= DOMAIN_REASON_CODES.length && codes[0] === response.primaryReasonCode, "rejected reason branch is inconsistent");
  assertAuthority(new Set(codes).size === codes.length && codes.every(code => DOMAIN_REASON_ORDER.has(code)), "rejected reasons are not in the frozen set");
  assertAuthority(codes.every((code, index) => index === 0 || DOMAIN_REASON_ORDER.get(codes[index - 1]) < DOMAIN_REASON_ORDER.get(code)), "rejected reasons are out of precedence order");
}

/** Verify hashes, deterministic ownership and the exact authority audit chain. */
export function validateResponseHashes(response, { request = null } = {}) {
  const artifacts = [
    ["GateDecision", response.gateDecision],
    ["OrderPlan", response.orderPlan],
    ["ExecutionEvent", response.executionEvent],
    ...response.auditEvents.map(event => ["AuditEvent", event]),
  ];
  for (const [type, artifact] of artifacts) {
    if (artifact !== null) assertAuthority(artifactHash(artifact, type) === artifact[ARTIFACT_HASH[type][0]], `${type} hash mismatch`);
  }
  assertAuthority(responseHash(response) === response.responseHash, "response hash mismatch");

  const operationId = response.operationId;
  const gate = response.gateDecision;
  const authorityRunId = deterministicId("run_", operationId, "PYTHON_AUTHORITY");
  assertAuthority(gate.decisionId === deterministicId("gd_", operationId, "GateDecision"), "gate identity is not deterministic");
  assertAuthority(gate.producer.kind === "PYTHON_AUTHORITY" && gate.producer.runId === authorityRunId, "gate ownership is invalid");
  assertAuthority(gate.operationId === operationId && gate.requestHash === response.requestHash, "gate envelope linkage is invalid");
  if (response.orderPlan !== null) {
    assertAuthority(response.orderPlan.planId === deterministicId("plan_", operationId, "OrderPlan"), "plan identity is not deterministic");
    assertAuthority(response.orderPlan.producer.kind === "PYTHON_AUTHORITY" && response.orderPlan.producer.runId === authorityRunId, "plan ownership is invalid");
  }
  if (response.executionEvent !== null) {
    assertAuthority(response.executionEvent.executionId === deterministicId("exec_", operationId, "ExecutionEvent"), "execution identity is not deterministic");
    assertAuthority(response.executionEvent.producer.kind === "PYTHON_AUTHORITY" && response.executionEvent.producer.runId === authorityRunId, "execution ownership is invalid");
  }

  const refs = gate.inputRefs;
  const expected = [
    ["INPUT_RESEARCH_RECORDED", "ResearchEvent", refs.eventId, refs.eventHash],
    ["INPUT_CANDIDATE_RECORDED", "CandidateManifest", refs.candidateId, refs.candidateHash],
    ["INPUT_INTENT_RECORDED", "TradeIntent", refs.intentId, refs.intentHash],
  ];
  if (refs.verdictId !== null) expected.push(["INPUT_CRITIC_RECORDED", "CriticVerdict", refs.verdictId, refs.verdictHash]);
  expected.push(["GATE_DECIDED", "GateDecision", gate.decisionId, gate.decisionHash]);
  if (response.orderPlan !== null && response.executionEvent !== null) {
    expected.push(["ORDER_PLANNED", "OrderPlan", response.orderPlan.planId, response.orderPlan.planHash]);
    expected.push(["EXECUTION_SIMULATED", "ExecutionEvent", response.executionEvent.executionId, response.executionEvent.executionHash]);
  }
  assertAuthority(response.auditEvents.length === expected.length, "audit sequence length mismatch");
  let previous = createHash("sha256")
    .update(`${PAPER_PROFILE}/audit-genesis`, "ascii")
    .update(Buffer.from([0]))
    .update(Buffer.from(response.requestHash, "ascii"))
    .digest("hex");
  response.auditEvents.forEach((event, index) => {
    const [eventType, subjectType, subjectId, subjectHash] = expected[index];
    const sequence = index + 1;
    assertAuthority(event.auditId === deterministicId("audit_", operationId, "AuditEvent", sequence) && event.auditEventId === deterministicId("ae_", operationId, "AuditEvent", sequence), "audit identity is not deterministic");
    assertAuthority(event.sequence === sequence && event.occurredAt === gate.decidedAt && event.previousEventHash === previous, "audit chain linkage mismatch");
    assertAuthority(event.eventType === eventType && event.subjectType === subjectType && event.subjectId === subjectId && event.subjectHash === subjectHash, "audit subject mismatch");
    previous = event.eventHash;
  });
  assertAuthority(response.headHash === previous, "audit head mismatch");

  if (request !== null) {
    assertAuthority(gate.decidedAt === request.decisionAt, "gate timestamp differs from the request clock");
    if (response.orderPlan !== null) assertAuthority(response.orderPlan.createdAt === request.decisionAt, "plan timestamp differs from the request clock");
    if (response.executionEvent !== null) assertAuthority(response.executionEvent.occurredAt === request.decisionAt, "execution timestamp differs from the request clock");
  }
  return response;
}

/** Validate schema and supplied artifact hashes, but never input domain/policy truth. */
export function validateRequestContract(request) {
  if (isRecord(request) && Object.hasOwn(request, "schemaVersion") && request.schemaVersion !== PAPER_SCHEMA_VERSION) throw new PaperContractError("SCHEMA_UNSUPPORTED", "request schemaVersion is unsupported");
  if (isRecord(request) && Object.hasOwn(request, "profile") && request.profile !== PAPER_PROFILE) throw new PaperContractError("PROFILE_UNSUPPORTED", "request profile is unsupported");
  validateRequest(request);
  validateRequestHashes(request);
  return request;
}

/** Validate a Python response only against its immutable originating request. */
export function validateResponseContract(response, { request } = {}) {
  if (request === undefined || request === null) throw new TypeError("originating request is required for authority response verification");
  validateResponse(response);
  validateRequestContract(request);
  validateResponseHashes(response, { request });
  assertReasons(response);
  assertAuthority(response.requestId === request.requestId && response.operationId === request.operationId && response.requestHash === requestHash(request), "response identity does not match request");
  const refs = response.gateDecision.inputRefs;
  const bundle = request.bundle;
  assertAuthority(refs.eventId === bundle.researchEvent.eventId && refs.eventHash === bundle.researchEvent.eventHash, "response research reference does not match request");
  assertAuthority(refs.candidateId === bundle.candidateManifest.candidateId && refs.candidateHash === bundle.candidateManifest.candidateHash, "response candidate reference does not match request");
  assertAuthority(refs.intentId === bundle.tradeIntent.intentId && refs.intentHash === bundle.tradeIntent.intentHash, "response intent reference does not match request");
  const critic = bundle.criticVerdict;
  assertAuthority((critic === null) === (refs.verdictId === null), "response critic presence does not match request");
  if (critic !== null) assertAuthority(refs.verdictId === critic.verdictId && refs.verdictHash === critic.verdictHash, "response critic reference does not match request");
  if (response.orderPlan !== null) {
    const plan = response.orderPlan;
    const proposal = bundle.tradeIntent.proposal;
    assertAuthority(proposal !== null, "order plan cannot exist without a proposed intent");
    assertAuthority(plan.operationId === request.operationId && plan.decisionId === response.gateDecision.decisionId && plan.decisionHash === response.gateDecision.decisionHash, "order plan gate linkage does not match request");
    assertAuthority(plan.candidateId === bundle.candidateManifest.candidateId && plan.candidateHash === bundle.candidateManifest.candidateHash && plan.intentId === bundle.tradeIntent.intentId && plan.intentHash === bundle.tradeIntent.intentHash, "order plan input linkage does not match request");
    assertAuthority(
      plan.instrumentId === proposal.instrumentId
        && plan.assetClass === proposal.assetClass
        && plan.currency === proposal.currency
        && plan.side === proposal.side
        && plan.session === proposal.session,
      "order plan market fields do not match the originating intent",
    );
    assertAuthority(fixedDecimalUnits(plan.quantity, 6) <= fixedDecimalUnits(proposal.quantity, 6), "order plan quantity enlarges the originating intent");
    assertAuthority(fixedDecimalUnits(plan.limitPrice, 4) <= fixedDecimalUnits(proposal.maximumEntryPrice, 4), "order plan price enlarges the originating intent");
    assertAuthority(fixedDecimalUnits(plan.limitPrice, 4) <= fixedDecimalUnits(plan.priceCollar.maximumLimitPrice, 4), "order plan price exceeds its claimed collar");
    const referenceFact = bundle.researchEvent.facts.find(fact => fact.kind === "REFERENCE_PRICE_USD");
    assertAuthority(referenceFact !== undefined && plan.priceCollar.referencePrice === referenceFact.value, "order plan collar does not reference the originating research price");
    assertAuthority(plan.priceCollar.ratio === bundle.candidateManifest.policy.buyCollarRatio, "order plan collar ratio does not match the originating candidate policy");
    const referenceUnits = fixedDecimalUnits(plan.priceCollar.referencePrice, 4);
    const ratioUnits = fixedDecimalUnits(plan.priceCollar.ratio, 6);
    const expectedCollarUnits = referenceUnits * (1_000_000n + ratioUnits) / 1_000_000n;
    assertAuthority(plan.priceCollar.maximumLimitPrice === formatFixedUnits(expectedCollarUnits, 4), "order plan collar calculation is invalid");
    const maximumEntryUnits = fixedDecimalUnits(proposal.maximumEntryPrice, 4);
    const expectedLimitUnits = expectedCollarUnits < maximumEntryUnits ? expectedCollarUnits : maximumEntryUnits;
    assertAuthority(plan.limitPrice === formatFixedUnits(expectedLimitUnits, 4), "order plan limit is not the exact tightened price");
  }
  if (response.executionEvent !== null) {
    const execution = response.executionEvent;
    assertAuthority(response.orderPlan !== null && execution.operationId === request.operationId && execution.planId === response.orderPlan.planId && execution.planHash === response.orderPlan.planHash, "execution linkage does not match request");
    const plan = response.orderPlan;
    assertAuthority(
      execution.instrumentId === plan.instrumentId
        && execution.assetClass === plan.assetClass
        && execution.currency === plan.currency
        && execution.side === plan.side
        && execution.quantity === plan.quantity,
      "execution market fields do not match the order plan",
    );
    const askFact = bundle.researchEvent.facts.find(fact => fact.kind === "ASK_PRICE_USD");
    assertAuthority(askFact !== undefined && execution.fillPrice === askFact.value, "execution fill price does not match the originating research ask");
    assertAuthority(fixedDecimalUnits(execution.fillPrice, 4) <= fixedDecimalUnits(plan.limitPrice, 4), "execution fill exceeds the order plan limit");
    const fillProduct = fixedDecimalUnits(execution.quantity, 6) * fixedDecimalUnits(execution.fillPrice, 4);
    assertAuthority(execution.fillNotionalUsd === formatFixedUnits(roundHalfEven(fillProduct, 8), 2), "execution fill notional report is invalid");
  }
  return response;
}

export function validateProtocolError(value) {
  validateSchema("ProtocolError", value);
  if (responseHash(value) !== value.responseHash) throw new PaperContractError("AUTHORITY_RESPONSE_MISMATCH", "protocol response hash mismatch");
  return value;
}
