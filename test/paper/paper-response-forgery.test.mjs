// @ts-check

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { before, test } from "node:test";

import { invokePaperAuthority } from "../../src/paper-fixture/authority-client.mjs";
import {
  PAPER_PROFILE,
  PaperContractError,
  artifactHash,
  responseHash,
  validateResponseContract,
} from "../../src/paper-fixture/contract-validation.mjs";
import { acceptedFixtureRequest, fixtureRequestBytes } from "../../src/paper-fixture/fixtures.mjs";

const NON_AUTHORITY_PRODUCERS = Object.freeze([
  "FIXTURE_SOURCE",
  "FIXTURE_REGISTRY",
  "MANAGER",
  "CRITIC",
]);

let request;
let acceptedResponse;

before(async () => {
  request = acceptedFixtureRequest();
  acceptedResponse = await invokePaperAuthority({ requestBytes: fixtureRequestBytes(request) });
  assert.equal(acceptedResponse.status, "ACCEPTED");
  assert.doesNotThrow(() => validateResponseContract(acceptedResponse, { request }));
});

function clone(value) {
  return structuredClone(value);
}

function auditGenesis(requestHash) {
  return createHash("sha256")
    .update(`${PAPER_PROFILE}/audit-genesis`, "ascii")
    .update(Buffer.from([0]))
    .update(Buffer.from(requestHash, "ascii"))
    .digest("hex");
}

/**
 * Recompute every transitive integrity field after an adversarial output
 * mutation. The validator must reject these bundles for the frozen ownership
 * contract, not merely because the attacker left a stale hash behind.
 */
function coherentlyRehash(response) {
  const gate = response.gateDecision;
  gate.decisionHash = artifactHash(gate, "GateDecision");

  const plan = response.orderPlan;
  if (plan !== null) {
    plan.decisionId = gate.decisionId;
    plan.decisionHash = gate.decisionHash;
    plan.planHash = artifactHash(plan, "OrderPlan");
  }

  const execution = response.executionEvent;
  if (execution !== null) {
    assert.notEqual(plan, null);
    execution.planId = plan.planId;
    execution.planHash = plan.planHash;
    execution.executionHash = artifactHash(execution, "ExecutionEvent");
  }

  const refs = gate.inputRefs;
  const subjects = [
    ["INPUT_RESEARCH_RECORDED", "ResearchEvent", refs.eventId, refs.eventHash],
    ["INPUT_CANDIDATE_RECORDED", "CandidateManifest", refs.candidateId, refs.candidateHash],
    ["INPUT_INTENT_RECORDED", "TradeIntent", refs.intentId, refs.intentHash],
  ];
  if (refs.verdictId !== null) {
    subjects.push(["INPUT_CRITIC_RECORDED", "CriticVerdict", refs.verdictId, refs.verdictHash]);
  }
  subjects.push(["GATE_DECIDED", "GateDecision", gate.decisionId, gate.decisionHash]);
  if (plan !== null && execution !== null) {
    subjects.push(["ORDER_PLANNED", "OrderPlan", plan.planId, plan.planHash]);
    subjects.push(["EXECUTION_SIMULATED", "ExecutionEvent", execution.executionId, execution.executionHash]);
  }
  assert.equal(response.auditEvents.length, subjects.length);

  let previous = auditGenesis(response.requestHash);
  for (const [index, event] of response.auditEvents.entries()) {
    const [eventType, subjectType, subjectId, subjectHash] = subjects[index];
    event.sequence = index + 1;
    event.occurredAt = gate.decidedAt;
    event.eventType = eventType;
    event.subjectType = subjectType;
    event.subjectId = subjectId;
    event.subjectHash = subjectHash;
    event.previousEventHash = previous;
    event.eventHash = artifactHash(event, "AuditEvent");
    previous = event.eventHash;
  }
  response.headHash = previous;
  response.responseHash = responseHash(response);
  return response;
}

function assertRejected(forged, label) {
  assert.throws(
    () => validateResponseContract(forged, { request }),
    error => error instanceof PaperContractError && ["INPUT_SCHEMA_INVALID", "AUTHORITY_RESPONSE_MISMATCH"].includes(error.code),
    `${label} must reject the entire coherently rehashed authority response`,
  );
}

test("coherently rehashed non-authority producers are rejected on every money-authority artifact", async t => {
  for (const artifactKey of ["gateDecision", "orderPlan", "executionEvent"]) {
    for (const producerKind of NON_AUTHORITY_PRODUCERS) {
      await t.test(`${artifactKey}:${producerKind}`, () => {
        const forged = clone(acceptedResponse);
        assert.notEqual(forged[artifactKey], null);
        forged[artifactKey].producer.kind = producerKind;
        coherentlyRehash(forged);
        assertRejected(forged, `${artifactKey} producer ${producerKind}`);
      });
    }
  }
});

test("a syntactically valid but nondeterministic authority run id is rejected after coherent rehash", () => {
  const forged = clone(acceptedResponse);
  for (const artifact of [forged.gateDecision, forged.orderPlan, forged.executionEvent]) {
    assert.notEqual(artifact, null);
    artifact.producer.runId = "run_forged_authority_v1";
  }
  coherentlyRehash(forged);
  assertRejected(forged, "forged authority run id");
});

test("mixed authority run identities cannot jointly own one accepted response", () => {
  const forged = clone(acceptedResponse);
  assert.notEqual(forged.orderPlan, null);
  forged.orderPlan.producer.runId = "run_forged_plan_owner_v1";
  coherentlyRehash(forged);
  assertRejected(forged, "mixed authority run ids");
});

test("producer-less audit ownership cannot be forged by adding an explicit producer", () => {
  const forged = clone(acceptedResponse);
  forged.auditEvents[0].producer = {
    kind: "PYTHON_AUTHORITY",
    runId: forged.gateDecision.producer.runId,
  };
  coherentlyRehash(forged);
  assertRejected(forged, "explicit audit producer");
});

test("coherently rehashed plans cannot enlarge or detach from the originating intent", async t => {
  const cases = [
    ["quantity", forged => {
      forged.orderPlan.quantity = "2.000000";
      forged.executionEvent.quantity = "2.000000";
    }],
    ["instrument", forged => {
      forged.orderPlan.instrumentId = "OTHER";
      forged.executionEvent.instrumentId = "OTHER";
    }],
    ["asset-class", forged => {
      forged.orderPlan.assetClass = "PLAIN_UNLEVERED_ETF";
      forged.executionEvent.assetClass = "PLAIN_UNLEVERED_ETF";
    }],
    ["currency", forged => {
      forged.orderPlan.currency = "CAD";
      forged.executionEvent.currency = "CAD";
    }],
    ["side", forged => {
      forged.orderPlan.side = "SELL";
      forged.executionEvent.side = "SELL";
    }],
    ["session", forged => { forged.orderPlan.session = "EXTENDED"; }],
    ["maximum-entry", forged => { forged.orderPlan.limitPrice = "100.0000"; }],
    ["claimed-collar", forged => {
      forged.orderPlan.limitPrice = "99.4950";
      forged.orderPlan.priceCollar.maximumLimitPrice = "99.4949";
    }],
    ["reference-price", forged => { forged.orderPlan.priceCollar.referencePrice = "98.0000"; }],
    ["collar-ratio", forged => { forged.orderPlan.priceCollar.ratio = "0.004000"; }],
    ["collar-calculation", forged => {
      forged.orderPlan.priceCollar.maximumLimitPrice = "99.4000";
      forged.orderPlan.limitPrice = "99.3000";
    }],
    ["fill-above-limit", forged => { forged.orderPlan.limitPrice = "90.0000"; }],
  ];
  for (const [label, mutate] of cases) {
    await t.test(label, () => {
      const forged = clone(acceptedResponse);
      assert.notEqual(forged.orderPlan, null);
      assert.notEqual(forged.executionEvent, null);
      mutate(forged);
      coherentlyRehash(forged);
      assertRejected(forged, `detached or enlarged plan ${label}`);
    });
  }
});

test("coherently rehashed executions remain bound to the plan and originating ask", async t => {
  const cases = [
    ["quantity", forged => { forged.executionEvent.quantity = "0.500000"; }],
    ["instrument", forged => { forged.executionEvent.instrumentId = "OTHER"; }],
    ["asset-class", forged => { forged.executionEvent.assetClass = "PLAIN_UNLEVERED_ETF"; }],
    ["currency", forged => { forged.executionEvent.currency = "CAD"; }],
    ["side", forged => { forged.executionEvent.side = "SELL"; }],
    ["fill-price", forged => { forged.executionEvent.fillPrice = "99.2400"; }],
    ["commission", forged => { forged.executionEvent.commissionUsd = "0.01"; }],
    ["fill-notional", forged => { forged.executionEvent.fillNotionalUsd = "99.24"; }],
  ];
  for (const [label, mutate] of cases) {
    await t.test(label, () => {
      const forged = clone(acceptedResponse);
      assert.notEqual(forged.orderPlan, null);
      assert.notEqual(forged.executionEvent, null);
      mutate(forged);
      coherentlyRehash(forged);
      assertRejected(forged, `detached execution ${label}`);
    });
  }
});
