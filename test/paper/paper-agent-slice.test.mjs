// @ts-check

import assert from "node:assert/strict";
import test from "node:test";

import { acceptedFixtureRequest } from "../../src/paper-fixture/fixtures.mjs";
import { artifactHash } from "../../src/paper-fixture/contract-validation.mjs";
import { runPaperAgentSlice, PAPER_MCP_TOOL, PAPER_FIXTURE_ID } from "../../src/paper-fixture/paper-agent-slice.mjs";

const FIXTURE_RESULT = {
  fixtureId: PAPER_FIXTURE_ID,
  sourceClass: "PUBLIC_OFFICIAL",
  symbol: "MPTEST",
  headline: "Fixture issuer publishes a routine compatibility notice",
  publishedAt: "2026-07-27T14:00:00Z",
};

test("fake manager and independent critic produce an accepted Python-authority result", async () => {
  const harness = fakeHarness();
  const result = await runPaperAgentSlice({ request: acceptedFixtureRequest(), createSession: harness.createSession, runTurn: harness.runTurn, authority: harness.authority });
  assert.equal(result.status, "ACCEPTED");
  assert.equal(result.exposure, true);
  assert.equal(result.authority.planId !== null, true);
  assert.equal(result.authority.executionId !== null, true);
  assert.equal(result.response.orderPlan.producer.kind, "PYTHON_AUTHORITY");
  assert.equal(harness.authorityCalls, 1);
});

test("fake rejected walkthrough records critic/gate denial without plan or execution", async () => {
  const harness = fakeHarness();
  const result = await runPaperAgentSlice({ request: acceptedFixtureRequest(), scenario: "rejected", createSession: harness.createSession, runTurn: harness.runTurn, authority: harness.authority });
  assert.equal(result.status, "REJECTED");
  assert.equal(result.exposure, false);
  assert.equal(result.authority.primaryReasonCode, "CRITIC_REJECTED");
  assert.equal(result.authority.planId, null);
  assert.equal(result.authority.executionId, null);
});

test("manager and critic use distinct fresh physical identities and critic receives no transcript", async () => {
  const harness = fakeHarness();
  const result = await runPaperAgentSlice({ request: acceptedFixtureRequest(), createSession: harness.createSession, runTurn: harness.runTurn, authority: harness.authority });
  assert.equal(result.status, "ACCEPTED");
  assert.equal(harness.sessions.length, 2);
  assert.notEqual(harness.sessions[0].connectionId, harness.sessions[1].connectionId);
  assert.notEqual(harness.sessions[0].threadId, harness.sessions[1].threadId);
  assert.notEqual(harness.turns[0].role, harness.turns[1].role);
  assert.equal(harness.turns[0].requiredMcpTools.has(PAPER_MCP_TOOL), true);
  assert.equal(harness.turns[1].requiredMcpTools.size, 0);
  assert.equal(harness.turns[0].forbidDelegation, false);
  assert.equal(harness.turns[1].forbidDelegation, true);
  assert.equal(harness.turns[1].input[0].text.includes("manager transcript"), true);
  assert.equal(harness.turns[1].input[0].text.includes("transcript text that must never cross"), false);
});

test("malformed manager output is typed no-exposure and never reaches Python", async () => {
  const harness = fakeHarness({ malformedManager: true });
  const result = await runPaperAgentSlice({ request: acceptedFixtureRequest(), createSession: harness.createSession, runTurn: harness.runTurn, authority: harness.authority });
  assert.equal(result.status, "FAILED");
  assert.equal(result.exposure, false);
  assert.equal(result.failure.code, "MANAGER_OUTPUT_INVALID");
  assert.equal(harness.authorityCalls, 0);
});

test("critic tool use is rejected closed before Python", async () => {
  const harness = fakeHarness({ criticUsesTool: true });
  const result = await runPaperAgentSlice({ request: acceptedFixtureRequest(), createSession: harness.createSession, runTurn: harness.runTurn, authority: harness.authority });
  assert.equal(result.status, "FAILED");
  assert.equal(result.failure.code, "MCP_TOOL_FORBIDDEN");
  assert.equal(harness.authorityCalls, 0);
});

test("forged authority output is independently rejected", async () => {
  const harness = fakeHarness();
  const result = await runPaperAgentSlice({ request: acceptedFixtureRequest(), createSession: harness.createSession, runTurn: harness.runTurn, authority: async () => ({ status: "ACCEPTED" }) });
  assert.equal(result.status, "FAILED");
  assert.equal(result.failure.code, "AUTHORITY_OUTPUT_INVALID");
});

test("scenario and hosted identity invariants fail closed", async () => {
  const wrongScenario = fakeHarness({ forceAcceptedArtifacts: true });
  const rejected = await runPaperAgentSlice({ request: acceptedFixtureRequest(), scenario: "rejected", createSession: wrongScenario.createSession, runTurn: wrongScenario.runTurn, authority: wrongScenario.authority });
  assert.equal(rejected.status, "FAILED");
  assert.equal(rejected.failure.code, "MANAGER_OUTPUT_INVALID");

  const wrongModel = fakeHarness({ wrongModel: true });
  const modelResult = await runPaperAgentSlice({ request: acceptedFixtureRequest(), createSession: wrongModel.createSession, runTurn: wrongModel.runTurn, authority: wrongModel.authority });
  assert.equal(modelResult.failure.code, "THREAD_POLICY_INVALID");

  const reused = fakeHarness({ reuseIdentity: true });
  const reusedResult = await runPaperAgentSlice({ request: acceptedFixtureRequest(), createSession: reused.createSession, runTurn: reused.runTurn, authority: reused.authority });
  assert.equal(reusedResult.failure.code, "THREAD_POLICY_INVALID");
});

test("canonical public fixture drift is rejected before any role starts", async () => {
  const request = acceptedFixtureRequest();
  request.bundle.researchEvent.facts.find((fact) => fact.kind === "NOTICE_TEXT").value = "Forged fixture text";
  request.bundle.researchEvent.eventHash = artifactHash(request.bundle.researchEvent, "ResearchEvent");
  request.bundle.tradeIntent.evidenceRefs[0].eventHash = request.bundle.researchEvent.eventHash;
  request.bundle.tradeIntent.intentHash = artifactHash(request.bundle.tradeIntent, "TradeIntent");
  request.bundle.criticVerdict.eventHash = request.bundle.researchEvent.eventHash;
  request.bundle.criticVerdict.intentHash = request.bundle.tradeIntent.intentHash;
  request.bundle.criticVerdict.verdictHash = artifactHash(request.bundle.criticVerdict, "CriticVerdict");
  const harness = fakeHarness();
  const result = await runPaperAgentSlice({ request, createSession: harness.createSession, runTurn: harness.runTurn, authority: harness.authority });
  assert.equal(result.failure.code, "MCP_CONTRACT_INVALID");
  assert.equal(harness.sessions.length, 0);
});

function fakeHarness({ malformedManager = false, criticUsesTool = false, forceAcceptedArtifacts = false, wrongModel = false, reuseIdentity = false } = {}) {
  const sessions = [];
  const turns = [];
  let authorityCalls = 0;
  const createSession = async ({ role, runId }) => {
    const session = {
      role,
      runId,
      threadId: reuseIdentity ? "thread_shared" : `thread_${role}_fresh`,
      connectionId: reuseIdentity ? "connection_shared" : `connection_${role}_${sessions.length + 1}`,
      ephemeral: true,
      model: wrongModel ? "gpt-5.5" : "gpt-5.6-sol",
      reasoningEffort: "ultra",
      client: { serverRequestsForbidden: true },
      assertHealthy() {},
      async close() {},
    };
    sessions.push(session);
    return session;
  };
  const runTurn = async (options) => {
    turns.push(options);
    if (options.role === "manager") {
      if (malformedManager) return options.parseFinal("{\"artifactType\":\"TradeIntent\"}");
      options.validateMcpCompletion({ toolName: PAPER_MCP_TOOL, arguments: { fixtureId: PAPER_FIXTURE_ID }, result: { structuredContent: FIXTURE_RESULT }, isError: false, item: {} });
      const request = acceptedFixtureRequest();
      const intent = structuredClone(request.bundle.tradeIntent);
      if (!forceAcceptedArtifacts && options.role === "manager" && options.input[0].text.includes("quantity 2.000000")) intent.proposal.quantity = "2.000000";
      intent.producer.runId = sessions[0].runId;
      intent.intentHash = artifactHash(intent, "TradeIntent");
      const artifact = options.parseFinal(JSON.stringify(intent));
      return { artifact, threadId: options.threadId, evidenceCount: 1 };
    }
    if (criticUsesTool) {
      options.validateMcpCompletion({ toolName: PAPER_MCP_TOOL, arguments: { fixtureId: PAPER_FIXTURE_ID }, result: { structuredContent: FIXTURE_RESULT }, isError: false, item: {} });
    }
    const request = acceptedFixtureRequest();
    const managerTurn = turns[0];
    const managerText = managerTurn.input[0].text;
    const intent = structuredClone(request.bundle.tradeIntent);
    if (!forceAcceptedArtifacts && managerText.includes("quantity 2.000000")) intent.proposal.quantity = "2.000000";
    intent.producer.runId = sessions[0].runId;
    intent.intentHash = artifactHash(intent, "TradeIntent");
    const critic = structuredClone(request.bundle.criticVerdict);
    critic.producer.runId = sessions[1].runId;
    critic.intentHash = intent.intentHash;
    if (!forceAcceptedArtifacts && managerText.includes("quantity 2.000000")) {
      critic.verdict = "REJECT";
      critic.reasonCode = "FIXTURE_POLICY_CONCERN";
      critic.counterargument = "The requested quantity exceeds the fixture policy.";
    }
    critic.verdictHash = artifactHash(critic, "CriticVerdict");
    const artifact = options.parseFinal(JSON.stringify(critic));
    return { artifact, threadId: options.threadId, evidenceCount: 1 };
  };
  const authority = async (options) => {
    authorityCalls += 1;
    const { invokePaperAuthority } = await import("../../src/paper-fixture/authority-client.mjs");
    return invokePaperAuthority(options);
  };
  return { createSession, runTurn, authority, sessions, turns, get authorityCalls() { return authorityCalls; } };
}
