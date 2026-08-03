// @ts-check
import assert from "node:assert/strict";
import test from "node:test";
import { acceptedFixtureRequest, fixtureRequestBytes } from "../../src/paper-fixture/fixtures.mjs";
import { invokePaperAuthority, AuthorityAdapterError } from "../../src/paper-fixture/authority-client.mjs";
import { artifactHash, canonicalJson, parseJsonNoDuplicates, validateRequestContract, validateResponseContract, PaperContractError } from "../../src/paper-fixture/contract-validation.mjs";

test("accepted fixture crosses Node/Python authority and produces a verifiable result", async () => {
  const request = acceptedFixtureRequest();
  const before = canonicalJson(request);
  const response = await invokePaperAuthority({ requestBytes: fixtureRequestBytes(request) });
  assert.equal(canonicalJson(request), before);
  validateResponseContract(response);
  assert.equal(response.status, "ACCEPTED");
  assert.equal(response.gateDecision.producer.kind, "PYTHON_AUTHORITY");
  assert.equal(response.orderPlan.simulationOnly, true);
  assert.equal(response.executionEvent.simulationOnly, true);
});

test("input hash mutation fails before Python and cannot create artifacts", async () => {
  const request = acceptedFixtureRequest();
  request.bundle.tradeIntent.intentHash = "0".repeat(64);
  assert.throws(() => validateRequestContract(request), error => error instanceof PaperContractError && error.code === "INPUT_ARTIFACT_HASH_INVALID");
  await assert.rejects(invokePaperAuthority({ requestBytes: Buffer.from(`${JSON.stringify(request)}\n`) }), error => error instanceof AuthorityAdapterError && error.code === "AUTHORITY_INPUT_ERROR");
});

test("identifier arrays cannot pass Node regex coercion", () => {
  const request = acceptedFixtureRequest();
  request.bundle.researchEvent.eventId = ["re_fixture_notice_v1"];
  assert.throws(() => validateRequestContract(request), /identifier|valid string/);
});

test("duplicate keys and noncanonical financial strings fail closed", async () => {
  assert.throws(() => parseJsonNoDuplicates('{"a":1,"a":2}'), error => error instanceof PaperContractError && error.code === "INPUT_DUPLICATE_KEY");
  const request = acceptedFixtureRequest();
  request.bundle.tradeIntent.proposal.maximumEntryPrice = "9.9e1";
  request.bundle.tradeIntent.intentHash = artifactHash(request.bundle.tradeIntent, "TradeIntent");
  assert.throws(() => validateRequestContract(request), /lexical/);
});

test("fixed-scale ratio bounds and early-year timestamps remain cross-runtime safe", () => {
  const request = acceptedFixtureRequest();
  request.bundle.candidateManifest.policy.buyCollarRatio = "1.999999";
  request.bundle.candidateManifest.candidateHash = artifactHash(request.bundle.candidateManifest, "CandidateManifest");
  assert.throws(() => validateRequestContract(request), /range/);
  const timestampRequest = acceptedFixtureRequest();
  timestampRequest.bundle.candidateManifest.createdAt = "0001-01-01T00:00:00.000Z";
  timestampRequest.bundle.candidateManifest.candidateHash = artifactHash(timestampRequest.bundle.candidateManifest, "CandidateManifest");
  assert.doesNotThrow(() => validateRequestContract(timestampRequest));
});

test("NFC text limits use Unicode code points consistently", () => {
  const request = acceptedFixtureRequest();
  const notice = request.bundle.researchEvent.facts.find(fact => fact.kind === "NOTICE_TEXT");
  notice.value = "😀".repeat(1024);
  request.bundle.researchEvent.eventHash = artifactHash(request.bundle.researchEvent, "ResearchEvent");
  request.bundle.tradeIntent.evidenceRefs[0].eventHash = request.bundle.researchEvent.eventHash;
  request.bundle.tradeIntent.intentHash = artifactHash(request.bundle.tradeIntent, "TradeIntent");
  request.bundle.criticVerdict.eventHash = request.bundle.researchEvent.eventHash;
  request.bundle.criticVerdict.intentHash = request.bundle.tradeIntent.intentHash;
  request.bundle.criticVerdict.verdictHash = artifactHash(request.bundle.criticVerdict, "CriticVerdict");
  assert.doesNotThrow(() => validateRequestContract(request));
});

test("deterministic authority artifacts and audit chain remain stable", async () => {
  const request = acceptedFixtureRequest();
  const bytes = fixtureRequestBytes(request);
  const first = await invokePaperAuthority({ requestBytes: bytes });
  const second = await invokePaperAuthority({ requestBytes: bytes });
  assert.deepEqual(second, first);
  const tampered = structuredClone(first);
  tampered.auditEvents.splice(1, 0, structuredClone(tampered.auditEvents[0]));
  assert.throws(() => validateResponseContract(tampered), /mismatch/);
});

test("Node does not make the Python-only rights decision", async () => {
  const request = acceptedFixtureRequest();
  const research = request.bundle.researchEvent;
  research.rightsClass = "LOCAL_RESTRICTED";
  for (const fact of research.facts) fact.rightsClass = "LOCAL_RESTRICTED";
  research.provenance[0].sourceClass = "LOCAL";
  research.eventHash = artifactHash(research, "ResearchEvent");
  const intent = request.bundle.tradeIntent;
  intent.evidenceRefs[0].eventHash = research.eventHash;
  intent.intentHash = artifactHash(intent, "TradeIntent");
  const critic = request.bundle.criticVerdict;
  critic.eventHash = research.eventHash;
  critic.intentHash = intent.intentHash;
  critic.verdictHash = artifactHash(critic, "CriticVerdict");
  const response = await invokePaperAuthority({ requestBytes: fixtureRequestBytes(request) });
  assert.equal(response.status, "REJECTED");
  assert.equal(response.primaryReasonCode, "RIGHTS_NOT_PUBLIC");
});

test("response input substitution is rejected against the originating request", async () => {
  const request = acceptedFixtureRequest();
  const response = await invokePaperAuthority({ requestBytes: fixtureRequestBytes(request) });
  const forged = structuredClone(response);
  forged.gateDecision.inputRefs.eventId = "re_fake_substitution_v1";
  assert.throws(() => validateResponseContract(forged, { request }), /mismatch/);
});

test("response critic references require a nullable pair", async () => {
  const response = await invokePaperAuthority({ requestBytes: fixtureRequestBytes(acceptedFixtureRequest()) });
  response.gateDecision.inputRefs.verdictId = null;
  assert.throws(() => validateResponseContract(response), /both null or both present/);
});

test("response reason codes remain exact and deterministically ordered", async () => {
  const response = await invokePaperAuthority({ requestBytes: fixtureRequestBytes(acceptedFixtureRequest()) });
  response.reasonCodes = ["WRONG_REASON"];
  assert.throws(() => validateResponseContract(response), /only ACCEPTED/);
});

test("early authority process exit is typed and cannot surface EPIPE", async () => {
  await assert.rejects(
    invokePaperAuthority({ requestBytes: fixtureRequestBytes(acceptedFixtureRequest()), python: "/bin/false" }),
    error => error instanceof AuthorityAdapterError && error.code === "AUTHORITY_PROCESS_FAILED",
  );
});
