// @ts-check

import { createHash } from "node:crypto";
import { PAPER_REGISTRY } from "./registry.mjs";

export const PAPER_PROFILE = "marketpilot.paper-intent-fixture.v1";
export const PAPER_POLICY_ID = "FIXTURE_LONG_US_EQUITY_100_V1";
export const PAPER_SCHEMA_VERSION = 1;
export const MAX_MESSAGE_BYTES = 131_072;
// Loading the committed registry is an executable local-only boundary. The
// custom validators below enforce the profile's semantic branches; they never
// fetch or widen schemas at runtime.
void PAPER_REGISTRY;

const ID_PATTERNS = Object.freeze({
  requestId: /^req_[a-z0-9_]{2,63}$/,
  operationId: /^op_[a-z0-9_]{2,63}$/,
  eventId: /^re_[a-z0-9_]{2,63}$/,
  revisionId: /^rev_[a-z0-9_]{2,63}$/,
  factId: /^fact_[a-z0-9_]{2,63}$/,
  provenanceId: /^prov_[a-z0-9_]{2,63}$/,
  candidateId: /^cand_[a-z0-9_]{2,63}$/,
  intentId: /^ti_[a-z0-9_]{2,63}$/,
  verdictId: /^cv_[a-z0-9_]{2,63}$/,
  decisionId: /^gd_[a-z0-9_]{2,63}$/,
  planId: /^plan_[a-z0-9_]{2,63}$/,
  executionId: /^exec_[a-z0-9_]{2,63}$/,
  auditId: /^audit_[a-z0-9_]{2,63}$/,
  auditEventId: /^ae_[a-z0-9_]{2,63}$/,
  runId: /^run_[a-z0-9_]{2,63}$/,
});
const HASH = /^[0-9a-f]{64}$/;
const INSTRUMENT = /^[A-Z][A-Z0-9.]{0,9}$/;
const CURRENCY = /^[A-Z]{3}$/;
const SOURCE_ID = /^[a-z][a-z0-9.-]{2,63}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const PRICE = /^(0|[1-9][0-9]*)\.[0-9]{4}$/;
const QUANTITY = /^(0|[1-9][0-9]*)\.[0-9]{6}$/;
const USD_AMOUNT = /^(0|[1-9][0-9]*)\.[0-9]{2}$/;
const RATIO = /^(0|1)\.[0-9]{6}$/;
const TEXT = /^(?![\s\S]*[\u0000-\u001f\u007f-\u009f])[\s\S]{1,1024}$/u;

const ARTIFACT_HASH = Object.freeze({
  ResearchEvent: ["eventHash", "research-event"],
  CandidateManifest: ["candidateHash", "candidate"],
  TradeIntent: ["intentHash", "trade-intent"],
  CriticVerdict: ["verdictHash", "critic-verdict"],
  GateDecision: ["decisionHash", "gate-decision"],
  OrderPlan: ["planHash", "order-plan"],
  ExecutionEvent: ["executionHash", "execution-event"],
  AuditEvent: ["eventHash", "audit-event"],
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

function fail(message, details = {}) {
  throw new PaperContractError("INPUT_SCHEMA_INVALID", message, details);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys, label) {
  if (!isRecord(value)) fail(`${label} must be an object`);
  const expected = new Set(keys);
  const actual = Object.keys(value);
  if (actual.length !== expected.size || actual.some(key => !expected.has(key))) {
    fail(`${label} has additional or missing fields`);
  }
}

function requiredKeys(value, keys, label) {
  if (!isRecord(value)) fail(`${label} must be an object`);
  for (const key of keys) if (!Object.hasOwn(value, key)) fail(`${label}.${key} is required`);
}

function string(value, label, pattern = null, max = 1024) {
  if (typeof value !== "string" || [...value].length < 1 || [...value].length > max || value !== value.normalize("NFC") || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) fail(`${label} is not a valid string`);
  if ([...value].some(character => { const code = character.codePointAt(0); return code >= 0xd800 && code <= 0xdfff; })) fail(`${label} contains an unpaired surrogate`);
  if (pattern && !pattern.test(value)) fail(`${label} has an invalid lexical form`);
  return value;
}

function enumValue(value, choices, label) {
  if (!choices.includes(value)) fail(`${label} has an unsupported value`);
  return value;
}

function nullableString(value, label, pattern = null, max = 1024) {
  if (value === null) return value;
  return string(value, label, pattern, max);
}

function timestamp(value, label) {
  string(value, label, TIMESTAMP, 24);
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const hour = Number(value.slice(11, 13));
  const minute = Number(value.slice(14, 16));
  const second = Number(value.slice(17, 19));
  const millis = Number(value.slice(20, 23));
  if (year < 1 || year > 9999) fail(`${label} is not a valid UTC date`);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, millis);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || date.getUTCHours() !== hour || date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second || date.getUTCMilliseconds() !== millis) fail(`${label} is not a valid UTC date`);
  return value;
}

function id(value, kind, label = kind) {
  return string(value, label, ID_PATTERNS[kind] ?? /^[a-z][a-z0-9_]{2,63}$/, 64);
}

function hash(value, label) {
  if (typeof value !== "string" || !HASH.test(value)) fail(`${label} is not a lowercase SHA-256 hash`);
  return value;
}

function price(value, label) { string(value, label, PRICE, 32); if (Number(value) < 0.0001 || Number(value) > 999999.9999) fail(`${label} is out of range`); return value; }
function quantity(value, label) { string(value, label, QUANTITY, 32); if (Number(value) < 0.000001 || Number(value) > 1000000) fail(`${label} is out of range`); return value; }
function usdAmount(value, label) { string(value, label, USD_AMOUNT, 32); if (Number(value) > 999999999.99) fail(`${label} is out of range`); return value; }
function ratio(value, label) { string(value, label, RATIO, 16); if (Number(value) > 1) fail(`${label} is out of range`); return value; }
function sortIds(values, label) {
  if (!Array.isArray(values) || values.length > 16) fail(`${label} must be a bounded array`);
  const ids = values.map(value => string(value, `${label}[]`, /^[a-z][a-z0-9_]{2,63}$/, 64));
  const sorted = [...ids].sort();
  if (new Set(ids).size !== ids.length || ids.some((value, index) => value !== sorted[index])) fail(`${label} must be unique and lexicographically sorted`);
  return ids;
}

function producer(value, label = "producer") {
  exactKeys(value, ["kind", "runId"], label);
  enumValue(value.kind, ["FIXTURE_SOURCE", "FIXTURE_REGISTRY", "MANAGER", "CRITIC", "PYTHON_AUTHORITY"], `${label}.kind`);
  id(value.runId, "runId", `${label}.runId`);
}

function reasonCodes(value, primaryReasonCode, decision, label) {
  if (!Array.isArray(value) || value.length < 1 || value.length > DOMAIN_REASON_CODES.length) fail(`${label} must be a bounded ordered array`);
  value.forEach((code, index) => string(code, `${label}[${index}]`, /^[A-Z][A-Z0-9_]{2,63}$/, 64));
  if (decision === "ACCEPT") {
    if (primaryReasonCode !== "ACCEPTED" || value.length !== 1 || value[0] !== "ACCEPTED") fail(`${label} must contain only ACCEPTED for an accepted decision`);
    return value;
  }
  if (!DOMAIN_REASON_ORDER.has(primaryReasonCode) || value[0] !== primaryReasonCode || new Set(value).size !== value.length || value.some((code, index) => !DOMAIN_REASON_ORDER.has(code) || (index > 0 && DOMAIN_REASON_ORDER.get(value[index - 1]) >= DOMAIN_REASON_ORDER.get(code)))) fail(`${label} has invalid domain-code ordering`);
  return value;
}

function fact(value, label) {
  exactKeys(value, ["factId", "kind", "value", "rightsClass", "provenanceId"], label);
  id(value.factId, "factId", `${label}.factId`);
  enumValue(value.kind, ["NOTICE_TEXT", "REFERENCE_PRICE_USD", "ASK_PRICE_USD"], `${label}.kind`);
  if (value.kind === "NOTICE_TEXT") string(value.value, `${label}.value`);
  else price(value.value, `${label}.value`);
  enumValue(value.rightsClass, ["PUBLIC_OFFICIAL", "LICENSED_MODEL_OK", "LOCAL_RESTRICTED"], `${label}.rightsClass`);
  id(value.provenanceId, "provenanceId", `${label}.provenanceId`);
}

function provenance(value, label) {
  exactKeys(value, ["provenanceId", "sourceId", "sourceClass", "sourceRef", "sourceRevision", "publishedAt", "retrievedAt", "contentHash"], label);
  id(value.provenanceId, "provenanceId", `${label}.provenanceId`);
  string(value.sourceId, `${label}.sourceId`, SOURCE_ID, 64);
  enumValue(value.sourceClass, ["PUBLIC_OFFICIAL", "LICENSED_VENDOR", "LOCAL"], `${label}.sourceClass`);
  string(value.sourceRef, `${label}.sourceRef`); string(value.sourceRevision, `${label}.sourceRevision`, /^[\x21-\x7e]{1,128}$/, 128);
  timestamp(value.publishedAt, `${label}.publishedAt`); timestamp(value.retrievedAt, `${label}.retrievedAt`); hash(value.contentHash, `${label}.contentHash`);
}

function policy(value, label = "policy") {
  exactKeys(value, ["policyId", "allowedAction", "side", "session", "maxQuantity", "maxGrossNotionalUsd", "buyCollarRatio"], label);
  enumValue(value.policyId, [PAPER_POLICY_ID], `${label}.policyId`); enumValue(value.allowedAction, ["OPEN_LONG", "CLOSE_LONG", "HOLD"], `${label}.allowedAction`); enumValue(value.side, ["BUY", "SELL"], `${label}.side`); enumValue(value.session, ["REGULAR", "EXTENDED"], `${label}.session`);
  quantity(value.maxQuantity, `${label}.maxQuantity`); usdAmount(value.maxGrossNotionalUsd, `${label}.maxGrossNotionalUsd`); ratio(value.buyCollarRatio, `${label}.buyCollarRatio`);
}

function base(value, artifactType, fields, label = artifactType) {
  exactKeys(value, fields, label);
  if (value.schemaVersion !== 1) fail(`${label}.schemaVersion must be 1`);
  if (value.profile !== PAPER_PROFILE) fail(`${label}.profile is unsupported`);
  if (fields.includes("artifactType") && value.artifactType !== artifactType) fail(`${label}.artifactType is invalid`);
}

export function validateResearchEvent(value) {
  base(value, "ResearchEvent", ["schemaVersion", "profile", "artifactType", "eventId", "eventHash", "producer", "instrumentId", "assetClass", "currency", "eventKind", "revisionId", "supersedesEventId", "rightsClass", "publishedAt", "observedAt", "facts", "provenance"]);
  id(value.eventId, "eventId"); hash(value.eventHash, "eventHash"); producer(value.producer); string(value.instrumentId, "instrumentId", INSTRUMENT, 10); enumValue(value.assetClass, ["US_PRIMARY_LISTED_COMMON_STOCK", "PLAIN_UNLEVERED_ETF"], "assetClass"); string(value.currency, "currency", CURRENCY, 3); enumValue(value.eventKind, ["FIXTURE_ISSUER_NOTICE"], "eventKind"); id(value.revisionId, "revisionId"); nullableString(value.supersedesEventId, "supersedesEventId", ID_PATTERNS.eventId, 64); enumValue(value.rightsClass, ["PUBLIC_OFFICIAL", "LICENSED_MODEL_OK", "LOCAL_RESTRICTED"], "rightsClass"); timestamp(value.publishedAt, "publishedAt"); timestamp(value.observedAt, "observedAt");
  if (!Array.isArray(value.facts) || value.facts.length < 1 || value.facts.length > 16) fail("facts must be a bounded array"); value.facts.forEach((item, index) => fact(item, `facts[${index}]`)); sortIds(value.facts.map(item => item.factId), "facts");
  const factKinds = value.facts.map(item => item.kind);
  if (factKinds.length !== 3 || new Set(factKinds).size !== 3 || !["NOTICE_TEXT", "REFERENCE_PRICE_USD", "ASK_PRICE_USD"].every(kind => factKinds.includes(kind))) fail("facts must contain one of each fixture fact kind");
  if (!Array.isArray(value.provenance) || value.provenance.length < 1 || value.provenance.length > 16) fail("provenance must be a bounded array"); value.provenance.forEach((item, index) => provenance(item, `provenance[${index}]`)); sortIds(value.provenance.map(item => item.provenanceId), "provenance");
  return value;
}

export function validateCandidateManifest(value) {
  base(value, "CandidateManifest", ["schemaVersion", "profile", "artifactType", "candidateId", "candidateHash", "producer", "createdAt", "validFrom", "validUntil", "mode", "liveEligible", "strategyKind", "instrumentId", "assetClass", "currency", "policy"]);
  id(value.candidateId, "candidateId"); hash(value.candidateHash, "candidateHash"); producer(value.producer); timestamp(value.createdAt, "createdAt"); timestamp(value.validFrom, "validFrom"); timestamp(value.validUntil, "validUntil"); enumValue(value.mode, ["PAPER", "LIVE"], "mode"); if (typeof value.liveEligible !== "boolean") fail("liveEligible must be boolean"); string(value.strategyKind, "strategyKind", /^[A-Z][A-Z0-9_]{2,63}$/, 64); string(value.instrumentId, "instrumentId", INSTRUMENT, 10); enumValue(value.assetClass, ["US_PRIMARY_LISTED_COMMON_STOCK", "PLAIN_UNLEVERED_ETF"], "assetClass"); string(value.currency, "currency", CURRENCY, 3); policy(value.policy); return value;
}

export function validateTradeIntent(value) {
  base(value, "TradeIntent", ["schemaVersion", "profile", "artifactType", "intentId", "intentHash", "producer", "operationId", "createdAt", "expiresAt", "candidateId", "candidateHash", "disposition", "proposal", "abstainReasonCode", "thesis", "evidenceRefs"]);
  id(value.intentId, "intentId"); hash(value.intentHash, "intentHash"); producer(value.producer); id(value.operationId, "operationId"); timestamp(value.createdAt, "createdAt"); timestamp(value.expiresAt, "expiresAt"); id(value.candidateId, "candidateId"); hash(value.candidateHash, "candidateHash"); enumValue(value.disposition, ["PROPOSE", "ABSTAIN"], "disposition"); nullableString(value.abstainReasonCode, "abstainReasonCode", /^[A-Z][A-Z0-9_]{2,63}$/, 64); string(value.thesis, "thesis");
  if (value.proposal === null) {
    if (value.disposition === "PROPOSE") fail("PROPOSE requires proposal");
    if (!(["INSUFFICIENT_EVIDENCE", "NO_SUPPORTED_ACTION", "UNSAFE_CONTEXT"].includes(value.abstainReasonCode))) fail("ABSTAIN requires a supported abstain reason");
  } else {
    exactKeys(value.proposal, ["action", "instrumentId", "assetClass", "currency", "side", "session", "quantity", "maximumEntryPrice"], "proposal"); enumValue(value.proposal.action, ["OPEN_LONG", "CLOSE_LONG", "HOLD"], "proposal.action"); string(value.proposal.instrumentId, "proposal.instrumentId", INSTRUMENT, 10); enumValue(value.proposal.assetClass, ["US_PRIMARY_LISTED_COMMON_STOCK", "PLAIN_UNLEVERED_ETF"], "proposal.assetClass"); string(value.proposal.currency, "proposal.currency", CURRENCY, 3); enumValue(value.proposal.side, ["BUY", "SELL"], "proposal.side"); enumValue(value.proposal.session, ["REGULAR", "EXTENDED"], "proposal.session"); quantity(value.proposal.quantity, "proposal.quantity"); price(value.proposal.maximumEntryPrice, "proposal.maximumEntryPrice"); if (value.disposition !== "PROPOSE" || value.abstainReasonCode !== null) fail("proposal branch has invalid disposition/reason");
  }
  if (!Array.isArray(value.evidenceRefs) || value.evidenceRefs.length > 16) fail("evidenceRefs must be a bounded array");
  let prior = ""; for (const [index, ref] of value.evidenceRefs.entries()) { exactKeys(ref, ["eventId", "eventHash", "factIds"], `evidenceRefs[${index}]`); id(ref.eventId, "eventId"); hash(ref.eventHash, "eventHash"); sortIds(ref.factIds, `evidenceRefs[${index}].factIds`); if (ref.eventId <= prior) fail("evidenceRefs must be sorted"); prior = ref.eventId; }
  return value;
}

export function validateCriticVerdict(value) {
  base(value, "CriticVerdict", ["schemaVersion", "profile", "artifactType", "verdictId", "verdictHash", "producer", "operationId", "createdAt", "expiresAt", "candidateId", "candidateHash", "intentId", "intentHash", "eventId", "eventHash", "verdict", "reasonCode", "counterargument", "evidenceFactIds"]);
  id(value.verdictId, "verdictId"); hash(value.verdictHash, "verdictHash"); producer(value.producer); id(value.operationId, "operationId"); timestamp(value.createdAt, "createdAt"); timestamp(value.expiresAt, "expiresAt"); id(value.candidateId, "candidateId"); hash(value.candidateHash, "candidateHash"); id(value.intentId, "intentId"); hash(value.intentHash, "intentHash"); id(value.eventId, "eventId"); hash(value.eventHash, "eventHash"); const verdict = enumValue(value.verdict, ["APPROVE", "REJECT", "ABSTAIN"], "verdict"); const reason = enumValue(value.reasonCode, ["NO_BLOCKING_ISSUE", "EVIDENCE_GAP", "THESIS_CONTRADICTION", "FIXTURE_POLICY_CONCERN", "INSUFFICIENT_EVIDENCE"], "reasonCode"); const allowed = { APPROVE: ["NO_BLOCKING_ISSUE"], REJECT: ["EVIDENCE_GAP", "THESIS_CONTRADICTION", "FIXTURE_POLICY_CONCERN"], ABSTAIN: ["INSUFFICIENT_EVIDENCE"] }; if (!allowed[verdict].includes(reason)) fail("critic verdict and reasonCode branch mismatch"); string(value.counterargument, "counterargument"); sortIds(value.evidenceFactIds, "evidenceFactIds"); return value;
}

function validateInputRefs(value, label = "inputRefs") { exactKeys(value, ["eventId", "eventHash", "candidateId", "candidateHash", "intentId", "intentHash", "verdictId", "verdictHash"], label); id(value.eventId, "eventId"); hash(value.eventHash, `${label}.eventHash`); id(value.candidateId, "candidateId"); hash(value.candidateHash, `${label}.candidateHash`); id(value.intentId, "intentId"); hash(value.intentHash, `${label}.intentHash`); nullableString(value.verdictId, `${label}.verdictId`, ID_PATTERNS.verdictId, 64); if (value.verdictHash !== null) hash(value.verdictHash, `${label}.verdictHash`); if ((value.verdictId === null) !== (value.verdictHash === null)) fail(`${label}.verdictId and verdictHash must be both null or both present`); }

export function validateGateDecision(value) { base(value, "GateDecision", ["schemaVersion", "profile", "policyId", "artifactType", "decisionId", "decisionHash", "producer", "operationId", "requestHash", "decidedAt", "decision", "primaryReasonCode", "reasonCodes", "inputRefs"]); enumValue(value.policyId, [PAPER_POLICY_ID], "policyId"); id(value.decisionId, "decisionId"); hash(value.decisionHash, "decisionHash"); producer(value.producer); id(value.operationId, "operationId"); hash(value.requestHash, "requestHash"); timestamp(value.decidedAt, "decidedAt"); enumValue(value.decision, ["ACCEPT", "REJECT"], "decision"); string(value.primaryReasonCode, "primaryReasonCode", /^[A-Z][A-Z0-9_]{2,63}$/, 64); reasonCodes(value.reasonCodes, value.primaryReasonCode, value.decision, "reasonCodes"); validateInputRefs(value.inputRefs); return value; }

export function validateOrderPlan(value) { base(value, "OrderPlan", ["schemaVersion", "profile", "policyId", "artifactType", "planId", "planHash", "producer", "operationId", "decisionId", "decisionHash", "candidateId", "candidateHash", "intentId", "intentHash", "createdAt", "instrumentId", "assetClass", "currency", "side", "quantity", "orderType", "limitPrice", "routing", "timeInForce", "session", "simulationOnly", "priceCollar"]); enumValue(value.policyId, [PAPER_POLICY_ID], "policyId"); id(value.planId, "planId"); hash(value.planHash, "planHash"); producer(value.producer); id(value.operationId, "operationId"); id(value.decisionId, "decisionId"); hash(value.decisionHash, "decisionHash"); id(value.candidateId, "candidateId"); hash(value.candidateHash, "candidateHash"); id(value.intentId, "intentId"); hash(value.intentHash, "intentHash"); timestamp(value.createdAt, "createdAt"); string(value.instrumentId, "instrumentId", INSTRUMENT, 10); enumValue(value.assetClass, ["US_PRIMARY_LISTED_COMMON_STOCK", "PLAIN_UNLEVERED_ETF"], "assetClass"); string(value.currency, "currency", CURRENCY, 3); enumValue(value.side, ["BUY"], "side"); quantity(value.quantity, "quantity"); enumValue(value.orderType, ["LIMIT"], "orderType"); price(value.limitPrice, "limitPrice"); enumValue(value.routing, ["SMART"], "routing"); enumValue(value.timeInForce, ["DAY"], "timeInForce"); enumValue(value.session, ["REGULAR"], "session"); if (value.simulationOnly !== true) fail("simulationOnly must be true"); exactKeys(value.priceCollar, ["referencePrice", "maximumLimitPrice", "ratio"], "priceCollar"); price(value.priceCollar.referencePrice, "priceCollar.referencePrice"); price(value.priceCollar.maximumLimitPrice, "priceCollar.maximumLimitPrice"); ratio(value.priceCollar.ratio, "priceCollar.ratio"); return value; }

export function validateExecutionEvent(value) { base(value, "ExecutionEvent", ["schemaVersion", "profile", "policyId", "artifactType", "executionId", "executionHash", "producer", "operationId", "planId", "planHash", "occurredAt", "status", "instrumentId", "assetClass", "currency", "side", "quantity", "fillPrice", "fillNotionalUsd", "commissionUsd", "simulationOnly"]); enumValue(value.policyId, [PAPER_POLICY_ID], "policyId"); id(value.executionId, "executionId"); hash(value.executionHash, "executionHash"); producer(value.producer); id(value.operationId, "operationId"); id(value.planId, "planId"); hash(value.planHash, "planHash"); timestamp(value.occurredAt, "occurredAt"); enumValue(value.status, ["FILLED"], "status"); string(value.instrumentId, "instrumentId", INSTRUMENT, 10); enumValue(value.assetClass, ["US_PRIMARY_LISTED_COMMON_STOCK", "PLAIN_UNLEVERED_ETF"], "assetClass"); string(value.currency, "currency", CURRENCY, 3); enumValue(value.side, ["BUY"], "side"); quantity(value.quantity, "quantity"); price(value.fillPrice, "fillPrice"); usdAmount(value.fillNotionalUsd, "fillNotionalUsd"); usdAmount(value.commissionUsd, "commissionUsd"); if (value.simulationOnly !== true) fail("simulationOnly must be true"); return value; }

export function validateAuditEvent(value) { base(value, "AuditEvent", ["schemaVersion", "profile", "policyId", "artifactType", "auditId", "auditEventId", "sequence", "occurredAt", "eventType", "subjectType", "subjectId", "subjectHash", "previousEventHash", "eventHash"]); enumValue(value.policyId, [PAPER_POLICY_ID], "policyId"); id(value.auditId, "auditId"); id(value.auditEventId, "auditEventId"); if (!Number.isSafeInteger(value.sequence) || value.sequence < 1 || value.sequence > 64) fail("sequence must be a positive integer"); timestamp(value.occurredAt, "occurredAt"); const eventType = enumValue(value.eventType, ["INPUT_RESEARCH_RECORDED", "INPUT_CANDIDATE_RECORDED", "INPUT_INTENT_RECORDED", "INPUT_CRITIC_RECORDED", "GATE_DECIDED", "ORDER_PLANNED", "EXECUTION_SIMULATED"], "eventType"); const subjectType = enumValue(value.subjectType, ["ResearchEvent", "CandidateManifest", "TradeIntent", "CriticVerdict", "GateDecision", "OrderPlan", "ExecutionEvent"], "subjectType"); const expectedSubject = { INPUT_RESEARCH_RECORDED: "ResearchEvent", INPUT_CANDIDATE_RECORDED: "CandidateManifest", INPUT_INTENT_RECORDED: "TradeIntent", INPUT_CRITIC_RECORDED: "CriticVerdict", GATE_DECIDED: "GateDecision", ORDER_PLANNED: "OrderPlan", EXECUTION_SIMULATED: "ExecutionEvent" }[eventType]; if (subjectType !== expectedSubject) fail("audit event type and subject type mismatch"); id(value.subjectId, "id", "subjectId"); hash(value.subjectHash, "subjectHash"); hash(value.previousEventHash, "previousEventHash"); hash(value.eventHash, "eventHash"); return value; }

export function validateRequest(value) {
  base(value, "FixtureAuthorityRequest", ["schemaVersion", "profile", "policyId", "messageType", "requestId", "operationId", "decisionAt", "bundle"], "FixtureAuthorityRequest"); enumValue(value.policyId, [PAPER_POLICY_ID], "policyId"); enumValue(value.messageType, ["EVALUATE_FIXTURE_PAPER_INTENT"], "messageType"); id(value.requestId, "requestId"); id(value.operationId, "operationId"); timestamp(value.decisionAt, "decisionAt"); exactKeys(value.bundle, ["researchEvent", "candidateManifest", "tradeIntent", "criticVerdict"], "bundle"); validateResearchEvent(value.bundle.researchEvent); validateCandidateManifest(value.bundle.candidateManifest); validateTradeIntent(value.bundle.tradeIntent); if (value.bundle.criticVerdict !== null) validateCriticVerdict(value.bundle.criticVerdict); return value;
}

export function validateResponse(value) {
  base(value, "FixtureAuthorityResponse", ["schemaVersion", "profile", "policyId", "messageType", "requestId", "operationId", "requestHash", "status", "primaryReasonCode", "reasonCodes", "gateDecision", "orderPlan", "executionEvent", "auditEvents", "headHash", "responseHash"], "FixtureAuthorityResponse"); enumValue(value.policyId, [PAPER_POLICY_ID], "policyId"); enumValue(value.messageType, ["FIXTURE_PAPER_INTENT_RESULT"], "messageType"); id(value.requestId, "requestId"); id(value.operationId, "operationId"); hash(value.requestHash, "requestHash"); enumValue(value.status, ["ACCEPTED", "REJECTED"], "status"); string(value.primaryReasonCode, "primaryReasonCode", /^[A-Z][A-Z0-9_]{2,63}$/, 64); reasonCodes(value.reasonCodes, value.primaryReasonCode, value.status === "ACCEPTED" ? "ACCEPT" : "REJECT", "reasonCodes"); validateGateDecision(value.gateDecision); if (value.primaryReasonCode !== value.gateDecision.primaryReasonCode || JSON.stringify(value.reasonCodes) !== JSON.stringify(value.gateDecision.reasonCodes)) fail("response and gate reasons mismatch"); if (value.orderPlan !== null) validateOrderPlan(value.orderPlan); if (value.executionEvent !== null) validateExecutionEvent(value.executionEvent); if (!Array.isArray(value.auditEvents) || value.auditEvents.length > 16) fail("auditEvents must be bounded"); value.auditEvents.forEach((item, index) => validateAuditEvent(item)); hash(value.headHash, "headHash"); hash(value.responseHash, "responseHash"); if (value.status === "ACCEPTED" && (value.gateDecision.decision !== "ACCEPT" || value.orderPlan === null || value.executionEvent === null)) fail("accepted response has inconsistent artifacts"); if (value.status === "REJECTED" && (value.gateDecision.decision !== "REJECT" || value.orderPlan !== null || value.executionEvent !== null)) fail("rejected response has inconsistent artifacts"); return value;
}

export function validateProtocolError(value) {
  exactKeys(value, ["schemaVersion", "profile", "policyId", "messageType", "requestId", "status", "errorCode", "responseHash"], "ProtocolError"); if (value.schemaVersion !== 1 || value.profile !== PAPER_PROFILE || value.policyId !== PAPER_POLICY_ID) fail("protocol envelope identity mismatch"); enumValue(value.messageType, ["FIXTURE_AUTHORITY_PROTOCOL_ERROR", "FIXTURE_AUTHORITY_INTERNAL_ERROR"], "messageType"); nullableString(value.requestId, "requestId", ID_PATTERNS.requestId, 64); enumValue(value.status, ["ERROR"], "status"); enumValue(value.errorCode, ["INPUT_LIMIT_EXCEEDED", "INPUT_ENCODING_INVALID", "INPUT_FRAMING_INVALID", "INPUT_JSON_INVALID", "INPUT_DUPLICATE_KEY", "PROFILE_UNSUPPORTED", "SCHEMA_UNSUPPORTED", "INPUT_SCHEMA_INVALID", "INPUT_ARTIFACT_HASH_INVALID", "INTERNAL_ERROR"], "errorCode"); hash(value.responseHash, "responseHash"); return value;
}

export function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") { if (!Number.isSafeInteger(value)) throw new TypeError("Only safe integer JSON numbers are permitted"); return String(value); }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  throw new TypeError("Unsupported JSON value");
}

export function artifactHash(value, artifactType) {
  const descriptor = ARTIFACT_HASH[artifactType];
  if (!descriptor) throw new TypeError(`Unknown artifact type ${artifactType}`);
  const [ownField, suffix] = descriptor;
  const view = { ...value }; delete view[ownField];
  return createHash("sha256").update(`${PAPER_PROFILE}/${suffix}`, "ascii").update(Buffer.from([0])).update(Buffer.from(canonicalJson(view), "utf8")).digest("hex");
}

export function requestHash(request) { return createHash("sha256").update(`${PAPER_PROFILE}/request`, "ascii").update(Buffer.from([0])).update(Buffer.from(canonicalJson(request), "utf8")).digest("hex"); }
export function responseHash(response) { const view = { ...response }; delete view.responseHash; return createHash("sha256").update(`${PAPER_PROFILE}/response`, "ascii").update(Buffer.from([0])).update(Buffer.from(canonicalJson(view), "utf8")).digest("hex"); }
export function deterministicId(prefix, operationId, artifactType, sequence = null) { const suffix = sequence === null ? "" : `\u0000${sequence}`; const digest = createHash("sha256").update(`${PAPER_PROFILE}\u0000${operationId}\u0000${artifactType}${suffix}`, "utf8").digest("hex"); return `${prefix}${digest.slice(0, 32)}`; }

export function parseJsonNoDuplicates(text) {
  let index = 0;
  const peek = () => text[index];
  const ws = () => { while (/[ \t\n\r]/.test(peek() ?? "")) index += 1; };
  const parseString = () => { if (peek() !== '"') throw new PaperContractError("INPUT_JSON_INVALID", "JSON string expected"); const start = index; index += 1; while (index < text.length) { const ch = text[index++]; if (ch === "\\") index += 1; else if (ch === '"') return JSON.parse(text.slice(start, index)); } throw new PaperContractError("INPUT_JSON_INVALID", "Unterminated JSON string"); };
  const value = () => { ws(); const ch = peek(); if (ch === '"') return parseString(); if (ch === "{") { index += 1; const out = {}; const keys = new Set(); ws(); if (peek() === "}") { index += 1; return out; } while (true) { ws(); const key = parseString(); if (keys.has(key)) throw new PaperContractError("INPUT_DUPLICATE_KEY", "Duplicate JSON key"); keys.add(key); ws(); if (peek() !== ":") throw new PaperContractError("INPUT_JSON_INVALID", "JSON colon expected"); index += 1; out[key] = value(); ws(); if (peek() === "}") { index += 1; break; } if (peek() !== ",") throw new PaperContractError("INPUT_JSON_INVALID", "JSON comma expected"); index += 1; } return out; } if (ch === "[") { index += 1; const out = []; ws(); if (peek() === "]") { index += 1; return out; } while (true) { out.push(value()); ws(); if (peek() === "]") { index += 1; break; } if (peek() !== ",") throw new PaperContractError("INPUT_JSON_INVALID", "JSON comma expected"); index += 1; } return out; } const remaining = text.slice(index); const match = remaining.match(/^(true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/); if (!match) throw new PaperContractError("INPUT_JSON_INVALID", "JSON value expected"); if (/^-?\d/.test(match[0]) && (match[0].includes(".") || /[eE]/.test(match[0]))) throw new PaperContractError("INPUT_JSON_INVALID", "Only integer JSON numbers are permitted"); index += match[0].length; return JSON.parse(match[0]); };
  const result = value(); ws(); if (index !== text.length) throw new PaperContractError("INPUT_JSON_INVALID", "Trailing JSON content"); return result;
}

export function validateRequestHashes(request) {
  const bundle = request.bundle;
  for (const [type, artifact] of [["ResearchEvent", bundle.researchEvent], ["CandidateManifest", bundle.candidateManifest], ["TradeIntent", bundle.tradeIntent], ...(bundle.criticVerdict ? [["CriticVerdict", bundle.criticVerdict]] : [])]) {
    if (artifactHash(artifact, type) !== artifact[ARTIFACT_HASH[type][0]]) throw new PaperContractError("INPUT_ARTIFACT_HASH_INVALID", `${type} hash mismatch`);
  }
  return requestHash(request);
}

export function validateResponseHashes(response) {
  for (const [type, artifact] of [["GateDecision", response.gateDecision], ["OrderPlan", response.orderPlan], ["ExecutionEvent", response.executionEvent], ...response.auditEvents.map(event => ["AuditEvent", event])]) {
    if (artifact !== null && artifactHash(artifact, type) !== artifact[ARTIFACT_HASH[type][0]]) throw new PaperContractError("AUTHORITY_RESPONSE_MISMATCH", `${type} hash mismatch`);
  }
  if (responseHash(response) !== response.responseHash) throw new PaperContractError("AUTHORITY_RESPONSE_MISMATCH", "response hash mismatch");
  const refs = response.gateDecision.inputRefs;
  const expected = [
    ["INPUT_RESEARCH_RECORDED", "ResearchEvent", refs.eventId, refs.eventHash],
    ["INPUT_CANDIDATE_RECORDED", "CandidateManifest", refs.candidateId, refs.candidateHash],
    ["INPUT_INTENT_RECORDED", "TradeIntent", refs.intentId, refs.intentHash],
  ];
  if (refs.verdictId !== null) expected.push(["INPUT_CRITIC_RECORDED", "CriticVerdict", refs.verdictId, refs.verdictHash]);
  expected.push(["GATE_DECIDED", "GateDecision", response.gateDecision.decisionId, response.gateDecision.decisionHash]);
  if (response.orderPlan !== null && response.executionEvent !== null) {
    expected.push(["ORDER_PLANNED", "OrderPlan", response.orderPlan.planId, response.orderPlan.planHash]);
    expected.push(["EXECUTION_SIMULATED", "ExecutionEvent", response.executionEvent.executionId, response.executionEvent.executionHash]);
  }
  if (response.auditEvents.length !== expected.length) throw new PaperContractError("AUTHORITY_RESPONSE_MISMATCH", "audit sequence length mismatch");
  let previous = createHash("sha256").update(`${PAPER_PROFILE}/audit-genesis`, "ascii").update(Buffer.from([0])).update(Buffer.from(response.requestHash, "ascii")).digest("hex");
  response.auditEvents.forEach((event, index) => {
    const [eventType, subjectType, subjectId, subjectHash] = expected[index];
    if (event.sequence !== index + 1 || event.occurredAt !== response.gateDecision.decidedAt || event.previousEventHash !== previous || event.eventType !== eventType || event.subjectType !== subjectType || event.subjectId !== subjectId || event.subjectHash !== subjectHash) throw new PaperContractError("AUTHORITY_RESPONSE_MISMATCH", "audit chain mismatch");
    previous = event.eventHash;
  });
  if (response.headHash !== previous) throw new PaperContractError("AUTHORITY_RESPONSE_MISMATCH", "audit head mismatch");
  return response;
}

/** Validate only the contract, never cross-artifact policy/domain truth. */
export function validateRequestContract(request) { validateRequest(request); validateRequestHashes(request); return request; }
/**
 * Validate an untrusted Python response. When the originating request is
 * supplied, all input references and operation/linkage fields are compared to
 * that immutable request; a forged but internally rehashed bundle is rejected.
 */
export function validateResponseContract(response, { request = null } = {}) {
  validateResponse(response); validateResponseHashes(response);
  if (request !== null) {
    validateRequestContract(request);
    if (response.requestId !== request.requestId || response.operationId !== request.operationId || response.requestHash !== requestHash(request)) throw new PaperContractError("AUTHORITY_RESPONSE_MISMATCH", "response identity does not match request");
    const refs = response.gateDecision.inputRefs;
    const expected = request.bundle;
    const same = (a, b) => a === b;
    if (!same(refs.eventId, expected.researchEvent.eventId) || !same(refs.eventHash, expected.researchEvent.eventHash) || !same(refs.candidateId, expected.candidateManifest.candidateId) || !same(refs.candidateHash, expected.candidateManifest.candidateHash) || !same(refs.intentId, expected.tradeIntent.intentId) || !same(refs.intentHash, expected.tradeIntent.intentHash)) throw new PaperContractError("AUTHORITY_RESPONSE_MISMATCH", "response input references do not match request");
    const critic = expected.criticVerdict;
    if ((critic === null) !== (refs.verdictId === null)) throw new PaperContractError("AUTHORITY_RESPONSE_MISMATCH", "response critic presence does not match request");
    if (critic !== null && (refs.verdictId !== critic.verdictId || refs.verdictHash !== critic.verdictHash)) throw new PaperContractError("AUTHORITY_RESPONSE_MISMATCH", "response critic reference does not match request");
    if (response.gateDecision.operationId !== request.operationId) throw new PaperContractError("AUTHORITY_RESPONSE_MISMATCH", "gate operation does not match request");
    if (response.orderPlan !== null && (response.orderPlan.operationId !== request.operationId || response.orderPlan.decisionId !== response.gateDecision.decisionId || response.orderPlan.decisionHash !== response.gateDecision.decisionHash || response.orderPlan.candidateId !== expected.candidateManifest.candidateId || response.orderPlan.candidateHash !== expected.candidateManifest.candidateHash || response.orderPlan.intentId !== expected.tradeIntent.intentId || response.orderPlan.intentHash !== expected.tradeIntent.intentHash)) throw new PaperContractError("AUTHORITY_RESPONSE_MISMATCH", "order plan linkage does not match request");
    if (response.executionEvent !== null && (response.orderPlan === null || response.executionEvent.operationId !== request.operationId || response.executionEvent.planId !== response.orderPlan.planId || response.executionEvent.planHash !== response.orderPlan.planHash)) throw new PaperContractError("AUTHORITY_RESPONSE_MISMATCH", "execution linkage does not match request");
  }
  return response;
}
