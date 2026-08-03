// @ts-check

import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import {
  assertNoApiTokenEnvironment,
  createAuthenticatedSmokeClient,
  prepareAuthenticatedSmokeRuntime,
  qualifyAuthenticatedSmokeRuntime,
} from "../codex/authenticated-smoke.mjs";
import { runStructuredTurn, StructuredTurnError } from "../codex/structured-turn.mjs";
import {
  REQUIRED_CODEX_MODEL,
  REQUIRED_REASONING_EFFORT,
} from "../codex/runtime-policy.mjs";
import {
  artifactHash,
  canonicalJson,
  parseJsonNoDuplicates,
  validateCriticVerdict,
  validateRequestContract,
  validateResponseContract,
  validateTradeIntent,
} from "./contract-validation.mjs";
import { PAPER_REGISTRY } from "./registry.mjs";
import { encodeAuthorityRequest, invokePaperAuthority } from "./authority-client.mjs";
import { acceptedFixtureRequest } from "./fixtures.mjs";
import { rejectedFixtureRequest } from "./fixtures.mjs";

export const PAPER_AGENT_PROFILE = "marketpilot.paper-intent-fixture.v1";
export const PAPER_FIXTURE_ID = "public-event-001";
export const PAPER_MCP_TOOL = "marketpilot_fixture.research_read";
export const PAPER_MANAGER_SKILL = "marketpilot-paper";
export const PAPER_MANAGER_ROLE = "manager";
export const PAPER_CRITIC_ROLE = "critic";
export const PAPER_SCENARIOS = Object.freeze(["accepted", "rejected"]);

const PAPER_CLIENT_INFO = Object.freeze({
  name: "marketpilot_paper_agent_runtime",
  title: "MarketPilot Paper Agent Runtime",
  version: "0.1.0",
});

const FIXTURE_RESULT = Object.freeze({
  fixtureId: PAPER_FIXTURE_ID,
  sourceClass: "PUBLIC_OFFICIAL",
  symbol: "MPTEST",
  headline: "Fixture issuer publishes a routine compatibility notice",
  publishedAt: "2026-07-27T14:00:00Z",
});

const ROLE_RUN_PREFIX = Object.freeze({ manager: "run_fixture_manager_v1", critic: "run_fixture_critic_v1" });

const FAILURE_CODES = new Set([
  "AUTH_REQUIRED",
  "RATE_LIMITED",
  "SOL_ULTRA_UNAVAILABLE",
  "MODEL_REROUTED",
  "THREAD_POLICY_INVALID",
  "MCP_CONTRACT_INVALID",
  "MCP_TOOL_FORBIDDEN",
  "MANAGER_OUTPUT_INVALID",
  "CRITIC_OUTPUT_INVALID",
  "MANAGER_ABSTAINED",
  "CRITIC_NOT_DISTINCT",
  "AUTHORITY_INPUT_ERROR",
  "AUTHORITY_TIMEOUT",
  "AUTHORITY_PROCESS_FAILED",
  "AUTHORITY_OUTPUT_INVALID",
  "AUTHORITY_RESPONSE_MISMATCH",
  "TURN_TIMEOUT",
  "TURN_PROTOCOL_FAILED",
  "TURN_SCHEMA_INVALID",
  "CLIENT_CLEANUP_FAILED",
  "RUNTIME_NOT_QUALIFIED",
]);

/**
 * A redaction-safe failure at the manager/critic boundary. No prompts,
 * transcripts, account fields, or model text are retained on this error.
 */
export class PaperAgentRuntimeError extends Error {
  /** @param {string} code @param {string} message @param {{role?: string, cause?: unknown}} [options] */
  constructor(code, message, { role, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "PaperAgentRuntimeError";
    this.code = FAILURE_CODES.has(code) ? code : "TURN_PROTOCOL_FAILED";
    this.role = role ?? null;
  }
}

/**
 * Run one accepted or rejected fixture operation. The only effectful seam is
 * `createSession`; tests inject it with a deterministic fake while the hosted
 * command supplies fresh qualified app-server connections. The authority is
 * always invoked after local artifact validation and remains Python-owned.
 *
 * @param {object} options
 * @param {Readonly<Record<string, unknown>>} options.request
 * @param {"accepted"|"rejected"} [options.scenario]
 * @param {(context: Readonly<{role: "manager"|"critic", runId: string, scenario: "accepted"|"rejected", instructions: string}>) => Promise<PaperAgentSession>|PaperAgentSession} options.createSession
 * @param {(options: Readonly<Record<string, unknown>>) => Promise<unknown>} [options.runTurn]
 * @param {(options: {requestBytes: Buffer, timeoutMs?: number}) => Promise<Readonly<Record<string, unknown>>>} [options.authority]
 * @param {number} [options.turnTimeoutMs]
 * @param {number} [options.authorityTimeoutMs]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<Readonly<Record<string, unknown>>>}
 */
export async function runPaperAgentSlice({
  request,
  scenario = "accepted",
  createSession,
  runTurn = runStructuredTurn,
  authority = invokePaperAuthority,
  turnTimeoutMs = 30_000,
  authorityTimeoutMs = 2_000,
  signal,
}) {
  if (!PAPER_SCENARIOS.includes(scenario)) throw new TypeError("scenario must be accepted or rejected");
  if (typeof createSession !== "function") throw new TypeError("createSession must be a function");
  if (typeof runTurn !== "function") throw new TypeError("runTurn must be a function");
  if (typeof authority !== "function") throw new TypeError("authority must be a function");
  if (!Number.isSafeInteger(turnTimeoutMs) || turnTimeoutMs < 1_000 || turnTimeoutMs > 300_000) throw new TypeError("turnTimeoutMs is outside its bound");
  if (!Number.isSafeInteger(authorityTimeoutMs) || authorityTimeoutMs < 1 || authorityTimeoutMs > 10_000) throw new TypeError("authorityTimeoutMs is outside its bound");
  if (signal !== undefined && (typeof signal !== "object" || signal === null || typeof signal.addEventListener !== "function" || typeof signal.aborted !== "boolean")) throw new TypeError("signal must be an AbortSignal");

  let normalizedRequest;
  try {
    normalizedRequest = structuredClone(request);
    validateRequestContract(normalizedRequest);
  } catch (error) {
    throw new PaperAgentRuntimeError("MANAGER_OUTPUT_INVALID", "Paper request failed the local contract", { cause: error });
  }

  const operationId = normalizedRequest.operationId;
  const research = normalizedRequest.bundle.researchEvent;
  const candidate = normalizedRequest.bundle.candidateManifest;
  const canonicalFixture = acceptedFixtureRequest().bundle;
  if (canonicalJson(research) !== canonicalJson(canonicalFixture.researchEvent) || canonicalJson(candidate) !== canonicalJson(canonicalFixture.candidateManifest)) {
    return Object.freeze({
      schemaVersion: 1,
      profile: PAPER_AGENT_PROFILE,
      scenario,
      status: "FAILED",
      exposure: false,
      failure: Object.freeze({ code: "MCP_CONTRACT_INVALID", role: PAPER_MANAGER_ROLE }),
      manager: Object.freeze({ status: "not_started", runId: managerRunIdFor(operationId) }),
      critic: Object.freeze({ status: "not_started", runId: criticRunIdFor(operationId) }),
      authority: null,
      response: null,
    });
  }
  const expectedFactIds = research.facts.map((fact) => fact.factId).toSorted();
  const managerRunId = managerRunIdFor(operationId);
  const criticRunId = criticRunIdFor(operationId);
  const roleTemplates = buildRoleTemplates({ request: normalizedRequest, scenario, managerRunId, criticRunId });
  const identities = new Set();
  /** @type {PaperAgentSession | null} */
  let managerSession = null;
  /** @type {PaperAgentSession | null} */
  let criticSession = null;
  const lifecycle = { manager: "not_started", critic: "not_started" };

  try {
    throwIfAborted(signal);
    managerSession = await createOwnedSession(createSession, {
      role: PAPER_MANAGER_ROLE,
      runId: managerRunId,
      scenario,
      instructions: managerInstructions({ scenario, operationId, runId: managerRunId, research, candidate, intentTemplate: roleTemplates.intent, decisionAt: normalizedRequest.decisionAt }),
    });
    identities.add(managerSession.connectionId);
    identities.add(managerSession.threadId);
    lifecycle.manager = "started";
    const managerEvidence = { count: 0, fixture: false };
    const managerResult = await invokeRoleTurn({
      role: PAPER_MANAGER_ROLE,
      session: managerSession,
      runTurn,
      input: [{ type: "text", text: managerInstructions({ scenario, operationId, runId: managerRunId, research, candidate, intentTemplate: roleTemplates.intent, decisionAt: normalizedRequest.decisionAt }) }],
      outputSchema: standaloneSchema("TradeIntent"),
      parseFinal: (text) => parseManagerFinal(text, { scenario, operationId, runId: managerRunId, candidate, research, expectedFactIds }),
      turnTimeoutMs,
      signal,
      allowedMcpTools: new Set([PAPER_MCP_TOOL]),
      requiredMcpTools: new Set([PAPER_MCP_TOOL]),
      validateMcpCompletion: (evidence) => {
        managerEvidence.count += 1;
        validateFixtureEvidence(evidence);
        managerEvidence.fixture = true;
      },
    });
    assertSessionHealthy(managerSession, PAPER_MANAGER_ROLE);
    if (managerEvidence.count !== 1 || !managerEvidence.fixture || managerResult.evidenceCount !== 1) {
      throw new PaperAgentRuntimeError("MCP_CONTRACT_INVALID", "Manager did not produce exactly one approved fixture read", { role: PAPER_MANAGER_ROLE });
    }
    const managerIntent = managerResult.artifact;
    lifecycle.manager = "completed";

    // Close the manager before creating the critic. The critic gets only these
    // three rights-filtered objects; no transcript, thread, or client object.
    await closeSession(managerSession, PAPER_MANAGER_ROLE);
    managerSession = null;

    throwIfAborted(signal);
    const rightsFilteredResearch = publicResearchView(research);
    criticSession = await createOwnedSession(createSession, {
      role: PAPER_CRITIC_ROLE,
      runId: criticRunId,
      scenario,
      instructions: criticInstructions({ scenario, operationId, runId: criticRunId, research: rightsFilteredResearch, candidate, intent: managerIntent, criticTemplate: roleTemplates.critic, decisionAt: normalizedRequest.decisionAt }),
    });
    if (identities.has(criticSession.connectionId) || identities.has(criticSession.threadId)) throw new PaperAgentRuntimeError("THREAD_POLICY_INVALID", "Manager and critic reused a physical identity", { role: PAPER_CRITIC_ROLE });
    identities.add(criticSession.connectionId);
    identities.add(criticSession.threadId);
    lifecycle.critic = "started";
    const criticResult = await invokeRoleTurn({
      role: PAPER_CRITIC_ROLE,
      session: criticSession,
      runTurn,
      input: [{ type: "text", text: criticInstructions({ scenario, operationId, runId: criticRunId, research: rightsFilteredResearch, candidate, intent: managerIntent, criticTemplate: roleTemplates.critic, decisionAt: normalizedRequest.decisionAt }) }],
      outputSchema: standaloneSchema("CriticVerdict"),
      parseFinal: (text) => parseCriticFinal(text, { scenario, operationId, runId: criticRunId, candidate, research, intent: managerIntent, expectedFactIds }),
      turnTimeoutMs,
      signal,
      allowedMcpTools: new Set(),
      requiredMcpTools: new Set(),
      validateMcpCompletion: () => {
        throw new PaperAgentRuntimeError("MCP_TOOL_FORBIDDEN", "Critic attempted to use a fixture tool", { role: PAPER_CRITIC_ROLE });
      },
    });
    assertSessionHealthy(criticSession, PAPER_CRITIC_ROLE);
    const criticVerdict = criticResult.artifact;
    lifecycle.critic = "completed";

    const authorityRequest = structuredClone(normalizedRequest);
    authorityRequest.bundle.tradeIntent = structuredClone(managerIntent);
    authorityRequest.bundle.criticVerdict = structuredClone(criticVerdict);
    let response;
    try {
      response = await withAuthorityDeadline(
        authority,
        { requestBytes: encodeAuthorityRequest(authorityRequest), timeoutMs: authorityTimeoutMs },
        authorityTimeoutMs,
      );
      validateResponseContract(response, { request: authorityRequest });
    } catch (error) {
      if (error instanceof PaperAgentRuntimeError) throw error;
      const code = error?.code === "AUTHORITY_RESPONSE_MISMATCH" ? "AUTHORITY_RESPONSE_MISMATCH" : error?.code === "AUTHORITY_TIMEOUT" ? "AUTHORITY_TIMEOUT" : error?.code === "AUTHORITY_PROCESS_FAILED" ? "AUTHORITY_PROCESS_FAILED" : error?.code === "AUTHORITY_INPUT_ERROR" ? "AUTHORITY_INPUT_ERROR" : "AUTHORITY_OUTPUT_INVALID";
      throw new PaperAgentRuntimeError(code, "Python authority response failed independent validation", { role: PAPER_CRITIC_ROLE, cause: error });
    }
    await closeSession(criticSession, PAPER_CRITIC_ROLE);
    criticSession = null;
    return Object.freeze({
      schemaVersion: 1,
      profile: PAPER_AGENT_PROFILE,
      scenario,
      status: response.status,
      exposure: response.status === "ACCEPTED",
      manager: Object.freeze({ status: "completed", runId: managerRunId, threadId: managerResult.threadId ?? null, artifactHash: managerIntent.intentHash }),
      critic: Object.freeze({ status: "completed", runId: criticRunId, threadId: criticResult.threadId ?? null, artifactHash: criticVerdict.verdictHash }),
      authority: Object.freeze({ status: response.status, primaryReasonCode: response.primaryReasonCode, reasonCodes: [...response.reasonCodes], responseHash: response.responseHash, planId: response.orderPlan?.planId ?? null, executionId: response.executionEvent?.executionId ?? null, auditEventCount: response.auditEvents.length }),
      response,
    });
  } catch (error) {
    const normalized = normalizeFailure(error, lifecycle.manager === "completed" ? PAPER_CRITIC_ROLE : PAPER_MANAGER_ROLE);
    return Object.freeze({
      schemaVersion: 1,
      profile: PAPER_AGENT_PROFILE,
      scenario,
      status: "FAILED",
      exposure: false,
      failure: Object.freeze({ code: normalized.code, role: normalized.role }),
      manager: Object.freeze({ status: lifecycle.manager, runId: managerRunId }),
      critic: Object.freeze({ status: lifecycle.critic, runId: criticRunId }),
      authority: null,
      response: null,
    });
  } finally {
    let cleanupError = null;
    for (const [session, role] of [[criticSession, PAPER_CRITIC_ROLE], [managerSession, PAPER_MANAGER_ROLE]]) {
      if (session === null) continue;
      try {
        await closeSession(session, role);
      } catch (error) {
        cleanupError ??= error;
      }
    }
    // An uncertain physical connection is never represented as an accepted
    // operation. The normal return path closes before returning; this branch is
    // intentionally observable to callers through a thrown typed error.
    if (cleanupError !== null) throw new PaperAgentRuntimeError("CLIENT_CLEANUP_FAILED", "Paper agent process cleanup failed", { cause: cleanupError });
  }
}

/**
 * Prepare the stable keyring-backed runtime with the app-owned paper skill.
 * The caller must release the returned runtime in a finally block.
 */
export async function preparePaperAgentRuntime({ projectRoot, sourceEnv = process.env }) {
  assertNoApiTokenEnvironment(sourceEnv);
  const prepared = await prepareAuthenticatedSmokeRuntime({ projectRoot, sourceEnv, skillName: PAPER_MANAGER_SKILL });
  // The stable WI-001 home may retain its prior compatibility skill directory;
  // explicitly disable that known alternate app skill so exactly one role
  // skill is enabled for this hosted slice.
  try {
    await prepared.reconfigure([
      path.join(prepared.runtime.codexHome, "skills", "marketpilot-compatibility", "SKILL.md"),
    ]);
  } catch (error) {
    try { await prepared.releaseRuntime(); } catch { /* preserve the original preparation failure */ }
    throw error;
  }
  return prepared;
}

/** @param {{projectRoot: string, prepared: Readonly<Record<string, unknown>>, requestTimeoutMs?: number}} options */
export async function qualifyPaperAgentRuntime({ projectRoot, prepared, requestTimeoutMs = 15_000 }) {
  return qualifyAuthenticatedSmokeRuntime({
    projectRoot,
    schemaDir: prepared.qualificationSchemaDir,
    runtime: prepared.runtime,
    environment: prepared.environment,
    requestTimeoutMs,
  });
}

/**
 * Create the default real-runtime fresh-session factory. A new call launches a
 * new app-server connection and ephemeral thread; no connection is reusable.
 */
export function createHostedPaperSessionFactory({ projectRoot, prepared, qualification, requestTimeoutMs = 30_000, signal }) {
  if (!prepared || !qualification) throw new TypeError("prepared runtime and qualification are required");
  let connectionSequence = 0;
  return async ({ role, runId, instructions }) => {
    connectionSequence += 1;
    const client = createAuthenticatedSmokeClient({
      installation: qualification.installation,
      qualification,
      runtime: prepared.runtime,
      environment: prepared.environment,
      requestTimeoutMs,
    });
    let fatal = null;
    const onNotification = (notification) => {
      if (notification?.method === "model/rerouted") fatal ??= new PaperAgentRuntimeError("MODEL_REROUTED", "Qualified model was rerouted", { role });
    };
    client.on("notification", onNotification);
    try {
      if (client.serverRequestsForbidden !== true || client.state !== "idle") throw new PaperAgentRuntimeError("THREAD_POLICY_INVALID", "Hosted paper session was not a fresh restricted client", { role });
      await client.start();
      await client.request("initialize", { clientInfo: PAPER_CLIENT_INFO }, { timeoutMs: requestTimeoutMs, signal });
      await client.notify("initialized", {});
      await assertPaperInventory(client, prepared.enabledSkillPath, prepared.runtime.workDir, requestTimeoutMs, signal, role);
      await assertEntitlement(client, requestTimeoutMs, signal, role);
      const response = await client.request("thread/start", {
        model: REQUIRED_CODEX_MODEL,
        approvalPolicy: "never",
        sandbox: "read-only",
        cwd: prepared.runtime.workDir,
        ephemeral: true,
        config: { model_reasoning_effort: REQUIRED_REASONING_EFFORT },
        developerInstructions: instructions,
      }, { timeoutMs: requestTimeoutMs, signal });
      const threadId = assertEphemeralThread(response, prepared.runtime.workDir, role);
      if (fatal !== null) throw fatal;
      return /** @type {PaperAgentSession} */ (Object.freeze({
        role,
        runId,
        client,
        threadId,
        connectionId: `paper-connection-${connectionSequence}-${randomUUID()}`,
        model: REQUIRED_CODEX_MODEL,
        reasoningEffort: REQUIRED_REASONING_EFFORT,
        ephemeral: true,
        assertHealthy: () => { if (fatal !== null) throw fatal; },
        close: async () => { client.off("notification", onNotification); await client.stop(); },
      }));
    } catch (error) {
      client.off("notification", onNotification);
      try { await client.stop(); } catch { /* original typed failure wins */ }
      if (error instanceof PaperAgentRuntimeError) throw error;
      throw new PaperAgentRuntimeError(classifyHostedFailure(error), "Hosted paper session failed closed", { role, cause: error });
    }
  };
}

/** @param {object} options */
async function invokeRoleTurn({ role, session, runTurn, input, outputSchema, parseFinal, turnTimeoutMs, signal, allowedMcpTools, requiredMcpTools, validateMcpCompletion }) {
  assertSession(session, role);
  const result = await runTurn({
    role,
    client: session.client,
    threadId: session.threadId,
    input,
    outputSchema,
    parseFinal,
    deadlineMs: turnTimeoutMs,
    signal,
    allowedMcpTools,
      requiredMcpTools,
      validateMcpCompletion,
    forbidDelegation: role === PAPER_CRITIC_ROLE,
    });
  assertSessionHealthy(session, role);
  const artifact = result && typeof result === "object" && Object.hasOwn(result, "artifact") ? result.artifact : result;
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) throw new PaperAgentRuntimeError(role === PAPER_MANAGER_ROLE ? "MANAGER_OUTPUT_INVALID" : "CRITIC_OUTPUT_INVALID", "Role turn omitted a structured artifact", { role });
  const evidenceCount = result && typeof result === "object" && Number.isSafeInteger(result.evidenceCount) ? result.evidenceCount : 1;
  return Object.freeze({ artifact, threadId: typeof result?.threadId === "string" ? result.threadId : session.threadId, evidenceCount });
}

/** @param {string} text @param {{operationId: string, runId: string, candidate: any, research: any, expectedFactIds: string[]}} context */
function parseManagerFinal(text, context) {
  try {
    const value = parseJsonNoDuplicates(text);
    validateTradeIntent(value);
    if (artifactHash(value, "TradeIntent") !== value.intentHash) throw new Error("intent hash mismatch");
    if (value.operationId !== context.operationId || value.producer?.kind !== "MANAGER" || value.producer?.runId !== context.runId || value.candidateId !== context.candidate.candidateId || value.candidateHash !== context.candidate.candidateHash) throw new Error("manager linkage mismatch");
    if (value.disposition !== "PROPOSE") throw new PaperAgentRuntimeError("MANAGER_ABSTAINED", "Manager abstained from the fixture operation", { role: PAPER_MANAGER_ROLE });
    const expectedQuantity = context.scenario === "rejected" ? "2.000000" : "1.000000";
    if (value.proposal.quantity !== expectedQuantity) throw new Error("manager scenario quantity mismatch");
    if (value.evidenceRefs.length !== 1 || value.evidenceRefs[0].eventId !== context.research.eventId || value.evidenceRefs[0].eventHash !== context.research.eventHash || JSON.stringify(value.evidenceRefs[0].factIds) !== JSON.stringify(context.expectedFactIds)) throw new Error("manager evidence linkage mismatch");
    return value;
  } catch (error) {
    if (error instanceof PaperAgentRuntimeError) throw error;
    throw new PaperAgentRuntimeError("MANAGER_OUTPUT_INVALID", "Manager output failed local contract validation", { role: PAPER_MANAGER_ROLE, cause: error });
  }
}

/** @param {string} text @param {{operationId: string, runId: string, candidate: any, research: any, intent: any, expectedFactIds: string[]}} context */
function parseCriticFinal(text, context) {
  try {
    const value = parseJsonNoDuplicates(text);
    validateCriticVerdict(value);
    if (artifactHash(value, "CriticVerdict") !== value.verdictHash) throw new Error("critic hash mismatch");
    if (value.operationId !== context.operationId || value.producer?.kind !== "CRITIC" || value.producer?.runId !== context.runId || value.candidateId !== context.candidate.candidateId || value.candidateHash !== context.candidate.candidateHash || value.intentId !== context.intent.intentId || value.intentHash !== context.intent.intentHash || value.eventId !== context.research.eventId || value.eventHash !== context.research.eventHash || JSON.stringify(value.evidenceFactIds) !== JSON.stringify(context.expectedFactIds)) throw new Error("critic linkage mismatch");
    if (context.scenario === "accepted" && (value.verdict !== "APPROVE" || value.reasonCode !== "NO_BLOCKING_ISSUE")) throw new Error("critic accepted scenario mismatch");
    if (context.scenario === "rejected" && (value.verdict !== "REJECT" || value.reasonCode !== "FIXTURE_POLICY_CONCERN")) throw new Error("critic rejected scenario mismatch");
    return value;
  } catch (error) {
    throw new PaperAgentRuntimeError("CRITIC_OUTPUT_INVALID", "Critic output failed local contract validation", { role: PAPER_CRITIC_ROLE, cause: error });
  }
}

/** @param {unknown} evidence */
function validateFixtureEvidence(evidence) {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence) || evidence.isError !== false || evidence.toolName !== PAPER_MCP_TOOL || JSON.stringify(evidence.arguments) !== JSON.stringify({ fixtureId: PAPER_FIXTURE_ID })) throw new PaperAgentRuntimeError("MCP_CONTRACT_INVALID", "Manager fixture evidence did not match the exact read contract", { role: PAPER_MANAGER_ROLE });
  const result = evidence.result;
  const content = result && typeof result === "object" && !Array.isArray(result) ? result.structuredContent : undefined;
  if (!content || typeof content !== "object" || Array.isArray(content) || canonicalJson(content) !== canonicalJson(FIXTURE_RESULT)) throw new PaperAgentRuntimeError("MCP_CONTRACT_INVALID", "Manager fixture evidence was not the immutable public fixture", { role: PAPER_MANAGER_ROLE });
}

/** @param {Readonly<Record<string, unknown>>} research */
function publicResearchView(research) {
  // This is a rights filter, not the Python acceptance decision: only the
  // committed PUBLIC_OFFICIAL fixture can cross the critic boundary.
  if (research.rightsClass !== "PUBLIC_OFFICIAL" || research.facts.some((fact) => fact.rightsClass !== "PUBLIC_OFFICIAL") || research.provenance.some((source) => source.sourceClass !== "PUBLIC_OFFICIAL")) throw new PaperAgentRuntimeError("MCP_CONTRACT_INVALID", "Non-public research cannot enter the critic context", { role: PAPER_CRITIC_ROLE });
  return structuredClone(research);
}

/** @param {{scenario: string, operationId: string, runId: string, research: any, candidate: any, intentTemplate: any, decisionAt: string}} context */
function managerInstructions({ scenario, operationId, runId, research, candidate, intentTemplate, decisionAt }) {
  return [
    "You are the MarketPilot paper manager.",
    `Scenario: ${scenario}. Operation: ${operationId}. Producer runId: ${runId}.`,
    "Read exactly one immutable public fixture with marketpilot_fixture.research_read using fixtureId public-event-001. This is your sole tool call; never call list_mcp_resources, list_mcp_resource_templates, resources/list, resource-template discovery, or any other Codex/MCP discovery tool.",
    "Produce only the TradeIntent JSON required by the output schema. Use the supplied candidate identity and policy; never invent another instrument, source, account, broker, order, or live action.",
    `Candidate manifest: ${canonicalJson(candidate)}`,
    `Canonical public research envelope (use only after verifying the one tool result): ${canonicalJson(research)}`,
    `Decision timestamp: ${decisionAt}. Return the following app-owned intent template verbatim (including its already-computed hash, IDs, operation, times, candidate linkage, and evidence references); do not recalculate or repair it: ${canonicalJson(intentTemplate)}`,
    scenario === "rejected" ? "For this deterministic rejection walkthrough, propose the same bounded paper action with quantity 2.000000 so Python records its risk denial." : "For this accepted walkthrough, propose the single-share bounded paper action supported by the fixture.",
  ].join("\n");
}

/** @param {{scenario: string, operationId: string, runId: string, research: any, candidate: any, intent: any, criticTemplate: any, decisionAt: string}} context */
function criticInstructions({ scenario, operationId, runId, research, candidate, intent, criticTemplate, decisionAt }) {
  return [
    "You are the independent MarketPilot paper critic in a fresh physical turn.",
    `Scenario: ${scenario}. Operation: ${operationId}. Producer runId: ${runId}.`,
    "You receive only the rights-filtered public event, frozen candidate, and proposed TradeIntent below. You have no manager transcript, thread history, account, broker, or production data.",
    `Research event: ${canonicalJson(research)}`,
    `Candidate manifest: ${canonicalJson(candidate)}`,
    `Proposed TradeIntent: ${canonicalJson(intent)}`,
    `Decision timestamp: ${decisionAt}. Return the following app-owned critic template verbatim (including its already-computed hash, IDs, times, candidate/intent/event linkage, and evidence references); do not recalculate or repair it: ${canonicalJson(criticTemplate)}`,
    scenario === "rejected" ? "Return a CriticVerdict with verdict REJECT and reasonCode FIXTURE_POLICY_CONCERN, explaining that the requested quantity exceeds the fixture policy." : "Return a CriticVerdict with verdict APPROVE and reasonCode NO_BLOCKING_ISSUE only when the evidence and bounded proposal are internally supported.",
    "Return only the CriticVerdict JSON required by the output schema. Do not call tools, including list_mcp_resources, list_mcp_resource_templates, resources/list, resource-template discovery, or any other Codex/MCP discovery.",
  ].join("\n");
}

/** Build exact app-owned outputs so the model copies canonical hashes rather than attempting cryptography. */
function buildRoleTemplates({ request, scenario, managerRunId, criticRunId }) {
  const fixture = scenario === "rejected" ? rejectedFixtureRequest() : acceptedFixtureRequest();
  const intent = structuredClone(fixture.bundle.tradeIntent);
  const critic = structuredClone(fixture.bundle.criticVerdict);
  if (scenario === "rejected") {
    critic.verdict = "REJECT";
    critic.reasonCode = "FIXTURE_POLICY_CONCERN";
    critic.counterargument = "The requested quantity exceeds the fixture policy.";
  }
  intent.operationId = request.operationId;
  intent.candidateId = request.bundle.candidateManifest.candidateId;
  intent.candidateHash = request.bundle.candidateManifest.candidateHash;
  intent.evidenceRefs[0].eventId = request.bundle.researchEvent.eventId;
  intent.evidenceRefs[0].eventHash = request.bundle.researchEvent.eventHash;
  intent.evidenceRefs[0].factIds = request.bundle.researchEvent.facts.map((fact) => fact.factId).toSorted();
  intent.producer.runId = managerRunId;
  intent.intentHash = artifactHash(intent, "TradeIntent");
  critic.operationId = request.operationId;
  critic.candidateId = request.bundle.candidateManifest.candidateId;
  critic.candidateHash = request.bundle.candidateManifest.candidateHash;
  critic.intentId = intent.intentId;
  critic.intentHash = intent.intentHash;
  critic.eventId = request.bundle.researchEvent.eventId;
  critic.eventHash = request.bundle.researchEvent.eventHash;
  critic.evidenceFactIds = request.bundle.researchEvent.facts.map((fact) => fact.factId).toSorted();
  critic.producer.runId = criticRunId;
  critic.verdictHash = artifactHash(critic, "CriticVerdict");
  return Object.freeze({ intent: Object.freeze(intent), critic: Object.freeze(critic) });
}

/** @param {string} name */
function standaloneSchema(name) {
  const schema = PAPER_REGISTRY.schemas.get(name);
  if (!schema) throw new Error(`Unknown paper schema ${name}`);
  return inlineRefs(structuredClone(schema), new Set());
}

/** @param {any} value @param {Set<string>} active */
function inlineRefs(value, active) {
  if (Array.isArray(value)) return value.map((item) => inlineRefs(item, active));
  if (!value || typeof value !== "object") return value;
  if (typeof value.$ref === "string") {
    const ref = value.$ref;
    if (active.has(ref)) throw new Error(`Cyclic paper schema reference ${ref}`);
    const resolved = [...PAPER_REGISTRY.schemas.values()].find((schema) => schema.$id === ref);
    if (!resolved) throw new Error(`Unknown paper schema reference ${ref}`);
    const next = new Set(active); next.add(ref);
    return inlineRefs(structuredClone(resolved), next);
  }
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    // Codex's response-format validator accepts the closed-object
    // `additionalProperties` form but rejects Draft-2020 `unevaluatedProperties`
    // and identity metadata in an inline turn schema. The committed registry
    // remains the canonical source; this is only a transport projection.
    if (key === "$schema" || key === "$id" || key === "unevaluatedProperties" || key === "allOf") continue;
    out[key] = inlineRefs(item, active);
  }
  if (!Object.hasOwn(out, "type") && Object.hasOwn(out, "const")) out.type = schemaTypeFor(out.const);
  if (!Object.hasOwn(out, "type") && Array.isArray(out.enum) && out.enum.length > 0) {
    const types = [...new Set(out.enum.map((entry) => schemaTypeFor(entry)))];
    out.type = types.length === 1 ? types[0] : types;
  }
  return out;
}

/** @param {unknown} value */
function schemaTypeFor(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (typeof value === "string") return "string";
  return "object";
}

/** @param {(context: any) => Promise<any>|any} factory @param {any} context */
async function createOwnedSession(factory, context) {
  let session;
  try { session = await factory(Object.freeze({ ...context })); } catch (error) { throw normalizeFailure(error, context.role); }
  assertSession(session, context.role);
  if (session.runId !== context.runId || session.role !== context.role || session.ephemeral !== true || !isSafeIdentity(session.connectionId) || !isSafeIdentity(session.threadId)) throw new PaperAgentRuntimeError("THREAD_POLICY_INVALID", "Role session did not prove a fresh ephemeral identity", { role: context.role });
  return session;
}

/** @param {PaperAgentSession} session @param {string} role */
function assertSession(session, role) {
  if (!session || typeof session !== "object" || session.role !== role || !isSafeIdentity(session.runId) || !isSafeIdentity(session.threadId) || !isSafeIdentity(session.connectionId) || session.ephemeral !== true || session.model !== REQUIRED_CODEX_MODEL || session.reasoningEffort !== REQUIRED_REASONING_EFFORT || typeof session.close !== "function") throw new PaperAgentRuntimeError("THREAD_POLICY_INVALID", "Role session is not a qualified fresh session", { role });
  if (session.client !== undefined && (!session.client || typeof session.client !== "object" || session.client.serverRequestsForbidden !== true)) throw new PaperAgentRuntimeError("THREAD_POLICY_INVALID", "Role session exposes an unsafe app-server client", { role });
}

/** @param {PaperAgentSession} session @param {string} role */
function assertSessionHealthy(session, role) {
  try { session.assertHealthy?.(); } catch (error) { throw normalizeFailure(error, role); }
}

/** @param {PaperAgentSession} session @param {string} role */
async function closeSession(session, role) {
  try { await session.close(); } catch (error) { throw new PaperAgentRuntimeError("CLIENT_CLEANUP_FAILED", "Role session could not be retired", { role, cause: error }); }
}

/**
 * Keep an injected or hosted authority adapter inside the same bounded seam.
 * A child process timeout is not sufficient when a test double or transport
 * wrapper itself never settles; the caller must receive a typed no-exposure
 * result at the declared boundary.
 */
async function withAuthorityDeadline(authority, options, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new PaperAgentRuntimeError("AUTHORITY_TIMEOUT", "Python authority exceeded its deadline", { role: PAPER_CRITIC_ROLE })), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([authority(options), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** @param {unknown} error @param {string} role */
function normalizeFailure(error, role) {
  if (error instanceof PaperAgentRuntimeError) return error;
  if (error instanceof StructuredTurnError) {
    const code = error.code.includes("TIMEOUT") ? "TURN_TIMEOUT" : error.code.includes("AUTH") ? "AUTH_REQUIRED" : error.code.includes("REROUT") ? "MODEL_REROUTED" : error.code.includes("RATE") || error.code.includes("LIMIT") ? "RATE_LIMITED" : error.code.includes("SCHEMA") || error.code.includes("FINAL") ? "TURN_SCHEMA_INVALID" : "TURN_PROTOCOL_FAILED";
    return new PaperAgentRuntimeError(code, "Paper role turn failed closed", { role, cause: error });
  }
  if (error && typeof error === "object" && typeof error.code === "string" && FAILURE_CODES.has(error.code)) return new PaperAgentRuntimeError(error.code, "Paper runtime operation failed closed", { role, cause: error });
  return new PaperAgentRuntimeError("TURN_PROTOCOL_FAILED", "Paper runtime operation failed closed", { role, cause: error });
}

/** @param {unknown} error */
function classifyHostedFailure(error) {
  if (error && typeof error === "object") {
    const code = error.code;
    if (code === "REQUEST_TIMEOUT" || code === "TIMEOUT") return "TURN_TIMEOUT";
    if (code === "REMOTE_ERROR" && (error.remoteCode === 401 || error.remoteCode === 403)) return "AUTH_REQUIRED";
    if (code === "REMOTE_ERROR" && (error.remoteCode === 429 || error.remoteCode === "rate_limit")) return "RATE_LIMITED";
    if (code === "MODEL_REROUTED") return "MODEL_REROUTED";
  }
  return "TURN_PROTOCOL_FAILED";
}

/** @param {any} client @param {number} timeoutMs @param {AbortSignal|undefined} signal @param {string} role */
async function assertEntitlement(client, timeoutMs, signal, role) {
  try {
    const models = await client.request("model/list", { includeHidden: false }, { timeoutMs, signal });
    const data = models && typeof models === "object" && Array.isArray(models.data) ? models.data : [];
    const model = data.find((entry) => entry && (entry.id === REQUIRED_CODEX_MODEL || entry.model === REQUIRED_CODEX_MODEL) && entry.hidden !== true);
    const efforts = model?.supportedReasoningEfforts;
    if (!model || !Array.isArray(efforts) || !efforts.some((entry) => entry?.reasoningEffort === REQUIRED_REASONING_EFFORT)) throw new PaperAgentRuntimeError("SOL_ULTRA_UNAVAILABLE", "Authenticated Sol Ultra entitlement was not advertised", { role });
    const account = await client.request("account/read", { refreshToken: false }, { timeoutMs, signal });
    if (account?.account?.type !== "chatgpt") throw new PaperAgentRuntimeError("AUTH_REQUIRED", "A ChatGPT keyring account is required", { role });
  } catch (error) {
    if (error instanceof PaperAgentRuntimeError) throw error;
    throw new PaperAgentRuntimeError(classifyHostedFailure(error), "Authenticated Sol Ultra readiness failed", { role, cause: error });
  }
}

/** @param {any} client @param {string} expectedSkillPath @param {number} timeoutMs @param {AbortSignal|undefined} signal @param {string} role */
async function assertPaperInventory(client, expectedSkillPath, workDir, timeoutMs, signal, role) {
  try {
    const skills = await client.request("skills/list", { cwds: [workDir], forceReload: true }, { timeoutMs, signal });
    const entries = Array.isArray(skills?.data) ? skills.data : [];
    if (entries.some((entry) => Array.isArray(entry?.errors) && entry.errors.length > 0)) throw new PaperAgentRuntimeError("THREAD_POLICY_INVALID", "Hosted paper skill inventory reported an error", { role });
    const enabled = entries.flatMap((entry) => Array.isArray(entry?.skills) ? entry.skills : []).filter((skill) => skill?.enabled === true);
    if (enabled.length !== 1 || enabled[0].name !== PAPER_MANAGER_SKILL || enabled[0].path !== expectedSkillPath) throw new PaperAgentRuntimeError("THREAD_POLICY_INVALID", "Hosted paper skill inventory was not exact", { role });
    const mcp = await client.request("mcpServerStatus/list", { detail: "full" }, { timeoutMs, signal });
    const servers = Array.isArray(mcp?.data) ? mcp.data : [];
    const fixture = servers.find((server) => server?.name === "marketpilot_fixture");
    const toolNames = fixture?.tools && typeof fixture.tools === "object" ? Object.keys(fixture.tools) : [];
    const readTool = fixture?.tools?.research_read;
    const annotations = readTool?.annotations;
    if (!fixture || toolNames.length !== 1 || toolNames[0] !== "research_read" || readTool.name !== "research_read" || readTool.inputSchema?.type !== "object" || readTool.inputSchema?.properties?.fixtureId?.type !== "string" || readTool.inputSchema?.properties?.fixtureId?.const !== PAPER_FIXTURE_ID || JSON.stringify(readTool.inputSchema?.required) !== JSON.stringify(["fixtureId"]) || readTool.inputSchema?.additionalProperties !== false || JSON.stringify(annotations) !== JSON.stringify({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false })) throw new PaperAgentRuntimeError("MCP_CONTRACT_INVALID", "Hosted paper MCP inventory was not exact", { role });
  } catch (error) {
    if (error instanceof PaperAgentRuntimeError) throw error;
    throw new PaperAgentRuntimeError(classifyHostedFailure(error), "Hosted paper runtime inventory failed closed", { role, cause: error });
  }
}

/** @param {any} response @param {string} cwd @param {string} role */
function assertEphemeralThread(response, cwd, role) {
  const thread = response?.thread;
  const sandbox = response?.sandbox;
  if (!thread || typeof thread.id !== "string" || thread.id.length < 3 || /[\u0000\r\n]/u.test(thread.id) || response.model !== REQUIRED_CODEX_MODEL || response.modelProvider !== "openai" || response.reasoningEffort !== REQUIRED_REASONING_EFFORT || response.approvalPolicy !== "never" || response.cwd !== cwd || thread.ephemeral !== true || thread.cwd !== cwd || thread.modelProvider !== "openai" || thread.path !== null || sandbox?.type !== "readOnly" || sandbox?.networkAccess !== false) throw new PaperAgentRuntimeError("THREAD_POLICY_INVALID", "Fresh role thread did not preserve the qualified policy", { role });
  return thread.id;
}

/** @param {AbortSignal|undefined} signal */
function throwIfAborted(signal) { if (signal?.aborted) throw new PaperAgentRuntimeError("TURN_PROTOCOL_FAILED", "Paper agent operation was aborted"); }

/** @param {unknown} value */
function isSafeIdentity(value) { return typeof value === "string" && value.length >= 3 && value.length <= 256 && !/[\u0000\r\n]/u.test(value); }

/** @param {string} operationId */
function managerRunIdFor(_operationId) { return ROLE_RUN_PREFIX.manager; }
/** @param {string} operationId */
function criticRunIdFor(_operationId) { return ROLE_RUN_PREFIX.critic; }

/** @typedef {Readonly<{
 * role: "manager"|"critic",
 * runId: string,
 * threadId: string,
 * connectionId: string,
 * ephemeral: true,
 * client?: any,
 * model?: string,
 * reasoningEffort?: string,
 * assertHealthy?: () => void,
 * close: () => Promise<void>|void,
 * }>} PaperAgentSession */
