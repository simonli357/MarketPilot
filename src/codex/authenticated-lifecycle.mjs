// @ts-check

import { isAbsolute, relative, sep } from "node:path";

import {
  assertAllowedItem,
  assertOutboundMethod,
  classifyNotification,
  ProtocolPolicyError,
  rejectServerRequest,
} from "./protocol-policy.mjs";
import {
  FIXTURE_MCP_NAME,
  FIXTURE_MCP_READ_TOOL,
  PUBLIC_FIXTURE_ID,
  REQUIRED_CODEX_MODEL,
  REQUIRED_REASONING_EFFORT,
} from "./runtime-policy.mjs";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_INTERRUPT_TIMEOUT_MS = 30_000;
const MAX_INTERRUPT_NOTIFICATIONS = 256;
const MAX_BUFFERED_INTERRUPT_NOTIFICATIONS = 64;
const MAX_BUFFERED_INTERRUPT_BYTES = 512 * 1024;
const MAX_DELEGATION_ITEMS = 128;
const MAX_FOREIGN_TURN_NOTIFICATIONS = 128;
const MAX_FOREIGN_TURN_BYTES = 512 * 1024;
const MAX_GENERATION_NOTIFICATIONS = 2_048;
const MAX_GENERATION_NOTIFICATION_BYTES = 2 * 1024 * 1024;
const MAX_DELEGATED_AGENTS = 1;
const MAX_AGENT_PATH_BYTES = 512;
const REQUIRED_DELEGATED_AGENT_PATH = "/root/auth_probe";
const MATERIALIZED_HISTORY_ITEM_TYPES = new Set([
  "agentMessage",
  "contextCompaction",
  "mcpToolCall",
  "reasoning",
  "userMessage",
]);
const DELEGATED_HISTORY_ITEM_TYPES = new Set([
  "agentMessage",
  "contextCompaction",
  "reasoning",
  "userMessage",
]);
const INTERRUPT_ITEM_TYPES = new Set([
  "agentMessage",
  "contextCompaction",
  "reasoning",
  "userMessage",
]);
const INTERRUPT_NOTIFICATION_METHODS = new Set([
  "item/completed",
  "item/started",
  "model/rerouted",
  "turn/completed",
  "turn/started",
]);
const FOREIGN_TURN_NOTIFICATION_METHODS = new Set([
  "item/completed",
  "item/started",
  "turn/completed",
  "turn/started",
]);
const CLAIMED_LIFECYCLE_NOTIFICATION_METHODS = new Set([
  "item/completed",
  "item/started",
  "turn/completed",
  "turn/started",
]);
/** @type {WeakMap<LifecycleClient, ReturnType<typeof createGenerationGuard>>} */
const GENERATION_GUARDS = new WeakMap();

/**
 * A redaction-safe authenticated lifecycle failure. Messages and details are
 * fixed locally and never contain prompts, model output, account data, or
 * app-server identifiers.
 */
export class AuthenticatedLifecycleError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{kind?: string, details?: Readonly<Record<string, unknown>>}} [options]
   */
  constructor(code, message, { kind = "lifecycle", details = {} } = {}) {
    super(message);
    this.name = "AuthenticatedLifecycleError";
    this.code = code;
    this.kind = kind;
    this.details = Object.freeze({ ...details });
  }
}

/**
 * Prove the stable authenticated app-server lifecycle using public fixture
 * input only. The caller supplies immutable turn specifications and a
 * structured-turn runner; this module owns process generations, stable
 * thread/turn methods, identity/order validation, and cleanup.
 *
 * Generation 1 creates a qualification-only durable thread and accepts its
 * first materializing turn. Generation 2 must be a fresh process, resumes that
 * thread by ID, validates persisted history and logical continuity, and proves
 * one V2 delegate and validates that child's multiplexed original turn.
 * Generation 3 independently resumes and inspects the child, unsubscribes it,
 * then creates an ephemeral thread, interrupts an active turn, and accepts a
 * recovery turn on that same physical process.
 *
 * @template MaterializedArtifact, ResumedArtifact, RecoveryArtifact
 * @param {object} options
 * @param {(context: Readonly<{generation: 1 | 2 | 3, purpose: "materialize" | "resume" | "interrupt-recovery"}>) => LifecycleClient | Promise<LifecycleClient>} options.createClient
 * @param {(options: StructuredTurnInvocation) => Promise<StructuredTurnResult>} options.runTurn
 * @param {Readonly<{name: string, version: string, title?: string}>} options.clientInfo
 * @param {string} options.cwd
 * @param {string} options.codexHome Private stable CODEX_HOME used by every generation.
 * @param {string} options.developerInstructions Fixed public-fixture instructions; not a security boundary.
 * @param {TurnSpecification} options.materializationTurn
 * @param {TurnSpecification} options.resumedTurn
 * @param {TurnSpecification} options.interruptTurn
 * @param {TurnSpecification} options.recoveryTurn
 * @param {(context: Readonly<{materializedArtifact: MaterializedArtifact, resumedArtifact: ResumedArtifact}>) => boolean | void} options.validateContinuity Synchronous local validator.
 * @param {number} [options.requestTimeoutMs]
 * @param {number} [options.interruptTimeoutMs]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<Readonly<{
 *   schemaVersion: 1,
 *   materializationPassed: true,
 *   restartResumePassed: true,
 *   interruptRecoveryPassed: true,
 *   delegationPassed: true,
 *   delegatedAgentCount: number,
 * }>>}
 */
export async function runAuthenticatedLifecycleProof({
  createClient,
  runTurn,
  clientInfo,
  cwd,
  codexHome,
  developerInstructions,
  materializationTurn,
  resumedTurn,
  interruptTurn,
  recoveryTurn,
  validateContinuity,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  interruptTimeoutMs = DEFAULT_INTERRUPT_TIMEOUT_MS,
  signal,
}) {
  assertFunction(createClient, "createClient");
  assertFunction(runTurn, "runTurn");
  const safeClientInfo = snapshotClientInfo(clientInfo);
  const safeCwd = requireAbsolutePath(cwd, "cwd");
  const safeCodexHome = requireAbsolutePath(codexHome, "codexHome");
  const safeDeveloperInstructions = requireBoundedText(
    developerInstructions,
    "developerInstructions",
    16 * 1024,
  );
  const materializationSpec = snapshotTurnSpecification(
    materializationTurn,
    "materializationTurn",
  );
  const resumedSpec = snapshotTurnSpecification(resumedTurn, "resumedTurn");
  const interruptSpec = snapshotTurnSpecification(interruptTurn, "interruptTurn");
  const recoverySpec = snapshotTurnSpecification(recoveryTurn, "recoveryTurn");
  assertFunction(validateContinuity, "validateContinuity");
  assertPositiveInteger(requestTimeoutMs, "requestTimeoutMs");
  assertPositiveInteger(interruptTimeoutMs, "interruptTimeoutMs");
  assertAbortSignal(signal);
  throwIfAborted(signal);

  /** @type {Set<LifecycleClient>} */
  const ownedClients = new Set();
  /** @type {LifecycleClient[]} */
  const clientOrder = [];
  /** @type {ReturnType<typeof createGenerationGuard>[]} */
  const guardOrder = [];

  try {
    const materializationClient = await createFreshInitializedClient({
      createClient,
      generation: 1,
      purpose: "materialize",
      clientInfo: safeClientInfo,
      requestTimeoutMs,
      signal,
      ownedClients,
      clientOrder,
      guardOrder,
    });
    const durableThread = await startQualifiedThread({
      client: materializationClient,
      cwd: safeCwd,
      codexHome: safeCodexHome,
      developerInstructions: safeDeveloperInstructions,
      ephemeral: false,
      requestTimeoutMs,
      signal,
    });
    const materialized = await invokeStructuredTurn({
      runTurn,
      client: materializationClient,
      threadId: durableThread.threadId,
      specification: materializationSpec,
      signal,
    });
    assertTurnResult(materialized, durableThread.threadId, "materialization turn");
    assertRetiredClient(materializationClient, "materialization turn");
    const proof = await continueAuthenticatedLifecycleProof({
      createClient,
      runTurn,
      clientInfo: safeClientInfo,
      cwd: safeCwd,
      codexHome: safeCodexHome,
      developerInstructions: safeDeveloperInstructions,
      materialized: Object.freeze({
        ...materialized,
        threadPath: durableThread.threadPath,
      }),
      materializedClient: materializationClient,
      resumedTurn: resumedSpec,
      interruptTurn: interruptSpec,
      recoveryTurn: recoverySpec,
      validateContinuity,
      requestTimeoutMs,
      interruptTimeoutMs,
      signal,
    });
    assertGenerationHealthy(materializationClient);
    return proof;
  } catch (error) {
    throw normalizeLifecycleFailure(error);
  } finally {
    disposeGenerationGuards(guardOrder);
    await stopClients(clientOrder);
  }
}

/**
 * Continue from an already accepted durable public-fixture turn. This is the
 * integration entry point for an authenticated smoke that has already used
 * its required MCP turn as the materializing bootstrap. It avoids another
 * hosted turn while retaining fresh-process resume, delegation, interrupt,
 * and recovery proof.
 *
 * @template MaterializedArtifact, ResumedArtifact, RecoveryArtifact
 * @param {object} options
 * @param {(context: Readonly<{generation: 2 | 3, purpose: "resume" | "interrupt-recovery"}>) => LifecycleClient | Promise<LifecycleClient>} options.createClient
 * @param {(options: StructuredTurnInvocation) => Promise<StructuredTurnResult>} options.runTurn
 * @param {Readonly<{name: string, version: string, title?: string}>} options.clientInfo
 * @param {string} options.cwd
 * @param {string} options.codexHome Private stable CODEX_HOME used by every generation.
 * @param {string} options.developerInstructions
 * @param {Readonly<{threadId: string, threadPath: string, turnId: string, finalMessageId: string, artifact: MaterializedArtifact, status?: "completed"}>} options.materialized
 * @param {LifecycleClient} options.materializedClient Already-retired client that accepted the bootstrap.
 * @param {TurnSpecification} options.resumedTurn
 * @param {TurnSpecification} options.interruptTurn
 * @param {TurnSpecification} options.recoveryTurn
 * @param {(context: Readonly<{materializedArtifact: MaterializedArtifact, resumedArtifact: ResumedArtifact}>) => boolean | void} options.validateContinuity
 * @param {number} [options.requestTimeoutMs]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<Readonly<{
 *   schemaVersion: 1,
 *   materializationPassed: true,
 *   restartResumePassed: true,
 *   interruptRecoveryPassed: true,
 *   delegationPassed: true,
 *   delegatedAgentCount: number,
 * }>>}
 */
export async function continueAuthenticatedLifecycleProof({
  createClient,
  runTurn,
  clientInfo,
  cwd,
  codexHome,
  developerInstructions,
  materialized,
  materializedClient,
  resumedTurn,
  interruptTurn,
  recoveryTurn,
  validateContinuity,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  interruptTimeoutMs = DEFAULT_INTERRUPT_TIMEOUT_MS,
  signal,
}) {
  assertFunction(createClient, "createClient");
  assertFunction(runTurn, "runTurn");
  const safeClientInfo = snapshotClientInfo(clientInfo);
  const safeCwd = requireAbsolutePath(cwd, "cwd");
  const safeCodexHome = requireAbsolutePath(codexHome, "codexHome");
  const safeDeveloperInstructions = requireBoundedText(
    developerInstructions,
    "developerInstructions",
    16 * 1024,
  );
  const acceptedMaterialization = snapshotMaterializedProof(materialized, safeCodexHome);
  assertClient(materializedClient);
  if (materializedClient.state !== "stopped") {
    throw new AuthenticatedLifecycleError(
      "MATERIALIZATION_CLIENT_NOT_RETIRED",
      "Lifecycle continuation requires the materializing client to be retired",
      { kind: "recovery" },
    );
  }
  const resumedSpec = snapshotTurnSpecification(resumedTurn, "resumedTurn");
  const interruptSpec = snapshotTurnSpecification(interruptTurn, "interruptTurn");
  const recoverySpec = snapshotTurnSpecification(recoveryTurn, "recoveryTurn");
  assertFunction(validateContinuity, "validateContinuity");
  assertPositiveInteger(requestTimeoutMs, "requestTimeoutMs");
  assertPositiveInteger(interruptTimeoutMs, "interruptTimeoutMs");
  assertAbortSignal(signal);
  throwIfAborted(signal);

  /** @type {Set<LifecycleClient>} */
  const ownedClients = new Set([materializedClient]);
  /** @type {LifecycleClient[]} */
  const clientOrder = [];
  /** @type {ReturnType<typeof createGenerationGuard>[]} */
  const guardOrder = [];

  try {
    const resumeClient = await createFreshInitializedClient({
      createClient,
      generation: 2,
      purpose: "resume",
      clientInfo: safeClientInfo,
      requestTimeoutMs,
      signal,
      ownedClients,
      clientOrder,
      guardOrder,
    });
    const resumedThread = await resumeQualifiedThread({
      client: resumeClient,
      cwd: safeCwd,
      threadId: acceptedMaterialization.threadId,
      materializedTurnId: acceptedMaterialization.turnId,
      materializedThreadPath: acceptedMaterialization.threadPath,
      codexHome: safeCodexHome,
      requestTimeoutMs,
      signal,
    });

    const delegation = observeBoundedDelegation(resumeClient, resumedThread.threadId);
    let resumed;
    let delegatedAgent;
    try {
      resumed = await invokeStructuredTurn({
        runTurn,
        client: resumeClient,
        threadId: resumedThread.threadId,
        specification: resumedSpec,
        validateForeignTurnNotification:
          delegation.validateForeignTurnNotification,
        awaitAdditionalEvidence: delegation.awaitEvidence,
        signal,
      });
      assertTurnResult(resumed, resumedThread.threadId, "resumed turn");
      assertLifecycleIdNotReused(
        resumed.turnId,
        [acceptedMaterialization.turnId],
        "resume-turn",
      );
      delegation.assertCompleted(resumed.turnId);
      const observedAgent = delegation.agents[0];
      if (observedAgent === undefined) {
        throw new AuthenticatedLifecycleError(
          "DELEGATION_COUNT_INVALID",
          "Delegation qualification requires exactly one V2 receiver",
        );
      }
      delegatedAgent = Object.freeze({
        ...observedAgent,
        originalTurnId: requireNonEmptyText(
          observedAgent.originalTurnId,
          "delegated original turn id",
        ),
      });
      assertLifecycleIdNotReused(
        delegatedAgent.originalTurnId,
        [acceptedMaterialization.turnId, resumed.turnId],
        "delegated-turn",
      );
    } finally {
      delegation.dispose();
    }
    assertGenerationHealthy(resumeClient);
    assertRetiredClient(resumeClient, "resumed turn");
    validateContinuitySafely(
      validateContinuity,
      acceptedMaterialization.artifact,
      resumed.artifact,
    );

    const interruptClient = await createFreshInitializedClient({
      createClient,
      generation: 3,
      purpose: "interrupt-recovery",
      clientInfo: safeClientInfo,
      requestTimeoutMs,
      signal,
      ownedClients,
      clientOrder,
      guardOrder,
    });
    await resumeAndVerifyDelegatedAgent({
      client: interruptClient,
      cwd: safeCwd,
      codexHome: safeCodexHome,
      parentThreadId: resumedThread.threadId,
      agent: delegatedAgent,
      requestTimeoutMs,
      signal,
    });
    const ephemeralThread = await startQualifiedThread({
      client: interruptClient,
      cwd: safeCwd,
      codexHome: safeCodexHome,
      developerInstructions: safeDeveloperInstructions,
      ephemeral: true,
      requestTimeoutMs,
      signal,
    });
    assertLifecycleIdNotReused(
      ephemeralThread.threadId,
      [resumedThread.threadId, delegatedAgent.threadId],
      "interrupt-thread",
    );
    const interruptedTurnId = await runInterruptProof({
      client: interruptClient,
      threadId: ephemeralThread.threadId,
      specification: interruptSpec,
      deadlineMs: interruptTimeoutMs,
      signal,
    });
    assertLifecycleIdNotReused(
      interruptedTurnId,
      [
        acceptedMaterialization.turnId,
        resumed.turnId,
        delegatedAgent.originalTurnId,
      ],
      "interrupt-turn",
    );
    const recovered = await invokeStructuredTurn({
      runTurn,
      client: interruptClient,
      threadId: ephemeralThread.threadId,
      specification: recoverySpec,
      signal,
    });
    assertTurnResult(recovered, ephemeralThread.threadId, "interrupt recovery turn");
    assertLifecycleIdNotReused(
      recovered.turnId,
      [
        acceptedMaterialization.turnId,
        resumed.turnId,
        delegatedAgent.originalTurnId,
        interruptedTurnId,
      ],
      "recovery-turn",
    );
    assertRetiredClient(interruptClient, "interrupt recovery turn");
    assertGenerationHealthy(resumeClient);
    assertGenerationHealthy(interruptClient);

    return Object.freeze({
      schemaVersion: 1,
      materializationPassed: true,
      restartResumePassed: true,
      interruptRecoveryPassed: true,
      delegationPassed: true,
      delegatedAgentCount: delegation.agentCount,
    });
  } catch (error) {
    throw normalizeLifecycleFailure(error);
  } finally {
    disposeGenerationGuards(guardOrder);
    await stopClients(clientOrder);
  }
}

/**
 * @param {object} options
 * @param {(context: Readonly<{generation: 1 | 2 | 3, purpose: "materialize" | "resume" | "interrupt-recovery"}>) => LifecycleClient | Promise<LifecycleClient>} options.createClient
 * @param {1 | 2 | 3} options.generation
 * @param {"materialize" | "resume" | "interrupt-recovery"} options.purpose
 * @param {Readonly<{name: string, version: string, title?: string}>} options.clientInfo
 * @param {number} options.requestTimeoutMs
 * @param {AbortSignal | undefined} options.signal
 * @param {Set<LifecycleClient>} options.ownedClients
 * @param {LifecycleClient[]} options.clientOrder
 * @param {ReturnType<typeof createGenerationGuard>[]} options.guardOrder
 */
async function createFreshInitializedClient({
  createClient,
  generation,
  purpose,
  clientInfo,
  requestTimeoutMs,
  signal,
  ownedClients,
  clientOrder,
  guardOrder,
}) {
  throwIfAborted(signal);
  let client;
  try {
    client = await createClient(Object.freeze({ generation, purpose }));
  } catch {
    throw new AuthenticatedLifecycleError(
      "CLIENT_CREATION_FAILED",
      "A fresh app-server client could not be created",
      { kind: "process", details: { generation } },
    );
  }
  const alreadyOwned = ownedClients.has(/** @type {LifecycleClient} */ (client));
  let cleanupOwned = false;
  if (!alreadyOwned && isStoppableClientCandidate(client)) {
    const candidate = /** @type {LifecycleClient} */ (client);
    ownedClients.add(candidate);
    clientOrder.push(candidate);
    cleanupOwned = true;
  }
  assertClient(client);
  if (alreadyOwned) {
    throw new AuthenticatedLifecycleError(
      "FRESH_CLIENT_REQUIRED",
      "Each lifecycle generation requires a distinct app-server client",
      { kind: "recovery", details: { generation } },
    );
  }
  if (client.state !== "idle") {
    throw new AuthenticatedLifecycleError(
      "FRESH_CLIENT_NOT_IDLE",
      "A lifecycle factory returned a client that was not fresh and idle",
      { kind: "process", details: { generation } },
    );
  }
  if (!cleanupOwned) {
    ownedClients.add(client);
    clientOrder.push(client);
  }
  const guard = createGenerationGuard(client);
  GENERATION_GUARDS.set(client, guard);
  guardOrder.push(guard);
  guard.assertHealthy();
  await client.start();
  guard.assertHealthy();
  assertOutboundMethod("initialize");
  const initialized = await client.request("initialize", { clientInfo }, {
    timeoutMs: requestTimeoutMs,
    signal,
  });
  guard.assertHealthy();
  requireRecord(initialized, "initialize response");
  assertOutboundMethod("initialized");
  await client.notify("initialized", {});
  guard.assertHealthy();
  if (client.state !== "running") {
    throw new AuthenticatedLifecycleError(
      "CLIENT_NOT_RUNNING",
      "App-server client was not running after initialization",
      { kind: "process", details: { generation } },
    );
  }
  return client;
}

/**
 * Latch generation-wide protocol and process failures even when no turn-level
 * observer is installed. Listener callbacks never throw into EventEmitter;
 * callers sample the latch after every awaited boundary.
 * @param {LifecycleClient} client
 */
function createGenerationGuard(client) {
  /** @type {AuthenticatedLifecycleError | null} */
  let failure = null;
  let disposed = false;
  let notificationCount = 0;
  let notificationBytes = 0;
  /** @type {Readonly<Record<string, never>> | null} */
  let lifecycleClaim = null;
  /** @param {AuthenticatedLifecycleError} error */
  const fail = (error) => {
    failure ??= error;
  };
  /** @param {unknown} value */
  const onNotification = (value) => {
    if (failure !== null) return;
    let notification;
    let method;
    let params;
    try {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError();
      }
      notification = /** @type {Readonly<Record<string, unknown>>} */ (value);
      method = notification.method;
      params = notification.params;
      if (
        !isBoundedNonEmptyText(method, 240) ||
        !params ||
        typeof params !== "object" ||
        Array.isArray(params)
      ) {
        throw new TypeError();
      }
      notificationCount += 1;
      notificationBytes += boundedSerializedBytes(
        { method, params },
        "generation notification",
      );
      if (
        notificationCount > MAX_GENERATION_NOTIFICATIONS ||
        notificationBytes > MAX_GENERATION_NOTIFICATION_BYTES
      ) {
        fail(new AuthenticatedLifecycleError(
          "GENERATION_NOTIFICATION_LIMIT_EXCEEDED",
          "App-server exceeded the generation-wide notification budget",
          { kind: "protocol" },
        ));
        return;
      }
    } catch {
      fail(new AuthenticatedLifecycleError(
        "RUNTIME_NOTIFICATION_MALFORMED",
        "App-server emitted a malformed generation notification",
        { kind: "protocol" },
      ));
      return;
    }
    try {
      const disposition = classifyNotification(method);
      if (disposition === "fail-closed") {
        fail(new AuthenticatedLifecycleError(
          method === "model/rerouted" ? "MODEL_REROUTED" : "RUNTIME_INVENTORY_CHANGED",
          "App-server emitted a generation-wide fail-closed notification",
          { kind: "policy" },
        ));
        return;
      }
      if (
        CLAIMED_LIFECYCLE_NOTIFICATION_METHODS.has(method) &&
        lifecycleClaim === null
      ) {
        fail(new AuthenticatedLifecycleError(
          "UNCLAIMED_LIFECYCLE_NOTIFICATION",
          "App-server emitted turn lifecycle data outside an active stage",
          { kind: "protocol" },
        ));
      }
    } catch {
      fail(new AuthenticatedLifecycleError(
        "RUNTIME_NOTIFICATION_FORBIDDEN",
        "App-server emitted an unknown generation notification",
        { kind: "policy" },
      ));
    }
  };
  const onServerRequest = () => fail(new AuthenticatedLifecycleError(
    "SERVER_REQUEST_FORBIDDEN",
    "App-server emitted a forbidden server-initiated request",
    { kind: "policy" },
  ));
  const onIncident = () => fail(new AuthenticatedLifecycleError(
    "APP_SERVER_INCIDENT",
    "App-server reported an incident during lifecycle qualification",
    { kind: "process" },
  ));
  /** @param {unknown} value */
  const onExit = (value) => {
    try {
      const event = requireRecord(value, "app-server exit event");
      if (event.expected === true && (event.error === null || event.error === undefined)) {
        return;
      }
    } catch {
      // Malformed exit events fail through the fixed error below.
    }
    fail(new AuthenticatedLifecycleError(
      "APP_SERVER_EXIT",
      "App-server exited unexpectedly during lifecycle qualification",
      { kind: "process" },
    ));
  };
  client.on("notification", onNotification);
  client.on("serverRequest", onServerRequest);
  client.on("incident", onIncident);
  client.on("exit", onExit);
  return Object.freeze({
    assertHealthy() {
      if (failure !== null) throw failure;
    },
    claimLifecycle() {
      if (disposed || lifecycleClaim !== null) {
        throw new AuthenticatedLifecycleError(
          "GENERATION_STAGE_CONFLICT",
          "Lifecycle generation attempted overlapping stage observers",
          { kind: "policy" },
        );
      }
      if (failure !== null) throw failure;
      const claim = Object.freeze({});
      lifecycleClaim = claim;
      return claim;
    },
    /** @param {Readonly<Record<string, never>>} claim */
    releaseLifecycle(claim) {
      if (lifecycleClaim !== claim) {
        fail(new AuthenticatedLifecycleError(
          "GENERATION_STAGE_CONFLICT",
          "Lifecycle generation released an unknown stage observer",
          { kind: "policy" },
        ));
        return;
      }
      lifecycleClaim = null;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      client.off("notification", onNotification);
      client.off("serverRequest", onServerRequest);
      client.off("incident", onIncident);
      client.off("exit", onExit);
      GENERATION_GUARDS.delete(client);
    },
  });
}

/** @param {LifecycleClient} client */
function assertGenerationHealthy(client) {
  const guard = requireGenerationGuard(client);
  guard.assertHealthy();
}

/** @param {LifecycleClient} client */
function requireGenerationGuard(client) {
  const guard = GENERATION_GUARDS.get(client);
  if (guard !== undefined) return guard;
  throw new AuthenticatedLifecycleError(
    "GENERATION_GUARD_MISSING",
    "Lifecycle operation did not have a generation-wide guard",
    { kind: "policy" },
  );
}

/** @param {readonly ReturnType<typeof createGenerationGuard>[]} guards */
function disposeGenerationGuards(guards) {
  for (const guard of guards.toReversed()) guard.dispose();
}

/**
 * @param {object} options
 * @param {LifecycleClient} options.client
 * @param {string} options.cwd
 * @param {string} options.codexHome
 * @param {string} options.developerInstructions
 * @param {boolean} options.ephemeral
 * @param {number} options.requestTimeoutMs
 * @param {AbortSignal | undefined} options.signal
 */
async function startQualifiedThread({
  client,
  cwd,
  codexHome,
  developerInstructions,
  ephemeral,
  requestTimeoutMs,
  signal,
}) {
  assertGenerationHealthy(client);
  assertOutboundMethod("thread/start");
  const response = await client.request("thread/start", {
    model: REQUIRED_CODEX_MODEL,
    approvalPolicy: "never",
    sandbox: "read-only",
    cwd,
    ephemeral,
    config: { model_reasoning_effort: REQUIRED_REASONING_EFFORT },
    developerInstructions,
  }, { timeoutMs: requestTimeoutMs, signal });
  assertGenerationHealthy(client);
  return validateQualifiedThreadResponse(response, {
    cwd,
    codexHome,
    ephemeral,
    method: "thread/start",
  });
}

/**
 * @param {object} options
 * @param {LifecycleClient} options.client
 * @param {string} options.cwd
 * @param {string} options.threadId
 * @param {string} options.materializedTurnId
 * @param {string} options.materializedThreadPath
 * @param {string} options.codexHome
 * @param {number} options.requestTimeoutMs
 * @param {AbortSignal | undefined} options.signal
 */
async function resumeQualifiedThread({
  client,
  cwd,
  threadId,
  materializedTurnId,
  materializedThreadPath,
  codexHome,
  requestTimeoutMs,
  signal,
}) {
  assertGenerationHealthy(client);
  assertOutboundMethod("thread/resume");
  const response = await client.request(
    "thread/resume",
    { threadId },
    { timeoutMs: requestTimeoutMs, signal },
  );
  assertGenerationHealthy(client);
  const qualified = validateQualifiedThreadResponse(response, {
    cwd,
    codexHome,
    ephemeral: false,
    method: "thread/resume",
    expectedThreadId: threadId,
    expectedThreadPath: materializedThreadPath,
  });
  validateMaterializedHistory(
    qualified.thread,
    materializedTurnId,
  );
  return qualified;
}

/**
 * @param {unknown} value
 * @param {{cwd: string, codexHome: string, ephemeral: boolean, method: string, expectedThreadId?: string, expectedThreadPath?: string}} expectation
 */
function validateQualifiedThreadResponse(value, expectation) {
  const response = requireRecord(value, `${expectation.method} response`);
  const thread = requireRecord(response.thread, `${expectation.method} response thread`);
  const sandbox = requireRecord(response.sandbox, `${expectation.method} response sandbox`);
  const threadId = requireNonEmptyText(thread.id, `${expectation.method} thread id`);
  const validThreadPath = expectation.ephemeral
    ? thread.path === null
    : typeof thread.path === "string" &&
      Buffer.byteLength(thread.path, "utf8") <= 4 * 1024 &&
      !thread.path.includes("\0") &&
      isAbsolute(thread.path) &&
      isLexicallyBeneath(expectation.codexHome, thread.path) &&
      (expectation.expectedThreadPath === undefined ||
        thread.path === expectation.expectedThreadPath);
  if (
    (expectation.expectedThreadId !== undefined && threadId !== expectation.expectedThreadId) ||
    response.model !== REQUIRED_CODEX_MODEL ||
    response.modelProvider !== "openai" ||
    response.reasoningEffort !== REQUIRED_REASONING_EFFORT ||
    response.approvalPolicy !== "never" ||
    response.cwd !== expectation.cwd ||
    thread.ephemeral !== expectation.ephemeral ||
    thread.cwd !== expectation.cwd ||
    thread.modelProvider !== "openai" ||
    sandbox.type !== "readOnly" ||
    sandbox.networkAccess !== false ||
    !validThreadPath
  ) {
    throw new AuthenticatedLifecycleError(
      "THREAD_POLICY_INVALID",
      "App-server thread settings did not preserve the qualified lifecycle policy",
      { kind: "policy" },
    );
  }
  return Object.freeze({
    threadId,
    threadPath: /** @type {string | null} */ (thread.path),
    thread,
  });
}

/**
 * @param {Readonly<Record<string, unknown>>} thread
 * @param {string} materializedTurnId
 */
function validateMaterializedHistory(thread, materializedTurnId) {
  if (!Array.isArray(thread.turns) || thread.turns.length !== 1) {
    throw new AuthenticatedLifecycleError(
      "RESUME_HISTORY_INVALID",
      "Resumed public thread did not contain exactly its materializing turn",
      { kind: "recovery" },
    );
  }
  const turn = requireRecord(thread.turns[0], "resumed materializing turn");
  if (
    turn.id !== materializedTurnId ||
    turn.status !== "completed" ||
    turn.error !== null ||
    turn.itemsView !== "full" ||
    !Array.isArray(turn.items)
  ) {
    throw new AuthenticatedLifecycleError(
      "RESUME_HISTORY_INVALID",
      "Resumed public thread history did not match the accepted materializing turn",
      { kind: "recovery" },
    );
  }
  const itemIds = new Set();
  /** @type {Readonly<Record<string, unknown>>[]} */
  const finalMessages = [];
  let fixtureMcpCount = 0;
  for (const rawItem of turn.items) {
    const item = validateMaterializedHistoryItem(rawItem);
    if (itemIds.has(/** @type {string} */ (item.id))) {
      throw lifecycleProtocolError(
        "RESUME_HISTORY_ITEM_DUPLICATED",
        "Resumed public thread history repeated an item identity",
      );
    }
    itemIds.add(/** @type {string} */ (item.id));
    if (item.type === "agentMessage" && item.phase === "final_answer") {
      finalMessages.push(item);
    }
    if (item.type === "mcpToolCall") fixtureMcpCount += 1;
  }
  if (
    fixtureMcpCount !== 1 ||
    finalMessages.length !== 1
  ) {
    throw new AuthenticatedLifecycleError(
      "RESUME_HISTORY_INVALID",
      "Resumed public thread history did not match the accepted materializing turn",
      { kind: "recovery" },
    );
  }
  // Pinned Legacy history preserves the canonical turn ID but synthesizes
  // item IDs while rebuilding history. The live final-message ID therefore
  // cannot be used as a restart-continuity identity fence.
}

/** @param {unknown} value */
function validateMaterializedHistoryItem(value) {
  const item = requireRecord(value, "resumed materialization history item");
  if (
    typeof item.type !== "string" ||
    !MATERIALIZED_HISTORY_ITEM_TYPES.has(item.type)
  ) {
    throw new AuthenticatedLifecycleError(
      "RESUME_HISTORY_ITEM_FORBIDDEN",
      "Resumed materialization history contained a forbidden capability item",
      { kind: "policy" },
    );
  }
  if (
    !isBoundedNonEmptyText(item.id, 240) ||
    !isBoundedJsonValue(item, 256 * 1024)
  ) {
    throw lifecycleProtocolError(
      "RESUME_HISTORY_ITEM_INVALID",
      "Resumed materialization history contained an invalid or oversized item",
    );
  }
  if (item.type === "agentMessage" && !isBoundedAgentMessage(item)) {
    throw lifecycleProtocolError(
      "RESUME_HISTORY_ITEM_INVALID",
      "Resumed materialization history contained an invalid agent message",
    );
  }
  if (item.type === "userMessage" && !isValidUserMessage(item)) {
    throw lifecycleProtocolError(
      "RESUME_HISTORY_ITEM_INVALID",
      "Resumed materialization history contained an invalid user message",
    );
  }
  if (item.type === "reasoning" && !isValidReasoningItem(item)) {
    throw lifecycleProtocolError(
      "RESUME_HISTORY_ITEM_INVALID",
      "Resumed materialization history contained invalid reasoning metadata",
    );
  }
  if (item.type === "mcpToolCall") {
    const args = item.arguments;
    if (
      item.server !== FIXTURE_MCP_NAME ||
      item.tool !== FIXTURE_MCP_READ_TOOL ||
      item.status !== "completed" ||
      !args ||
      typeof args !== "object" ||
      Array.isArray(args) ||
      Object.keys(args).length !== 1 ||
      Reflect.get(args, "fixtureId") !== PUBLIC_FIXTURE_ID
    ) {
      throw new AuthenticatedLifecycleError(
        "RESUME_HISTORY_MCP_INVALID",
        "Resumed materialization history did not preserve the fixed public MCP call",
        { kind: "policy" },
      );
    }
  }
  return item;
}

/**
 * Resume the one V2 receiver from a fresh physical process, reconcile its
 * persisted original turn with the multiplexed evidence observed by the
 * parent, then release the automatic child subscription.
 *
 * @param {object} options
 * @param {LifecycleClient} options.client
 * @param {string} options.cwd
 * @param {string} options.codexHome
 * @param {string} options.parentThreadId
 * @param {Readonly<{threadId: string, agentPath: string, originalTurnId: string}>} options.agent
 * @param {number} options.requestTimeoutMs
 * @param {AbortSignal | undefined} options.signal
 */
async function resumeAndVerifyDelegatedAgent({
  client,
  cwd,
  codexHome,
  parentThreadId,
  agent,
  requestTimeoutMs,
  signal,
}) {
  const deadlineAt = performance.now() + requestTimeoutMs;
  const remainingVerificationMs = () => {
    const remaining = deadlineAt - performance.now();
    if (remaining <= 0) {
      throw new AuthenticatedLifecycleError(
        "DELEGATION_VERIFICATION_TIMEOUT",
        "Delegated-thread verification exceeded its shared deadline",
        { kind: "timeout", details: { deadlineMs: requestTimeoutMs } },
      );
    }
    return Math.max(1, Math.ceil(remaining));
  };
  throwIfAborted(signal);
  assertGenerationHealthy(client);
  assertOutboundMethod("thread/resume");
  const response = await client.request(
    "thread/resume",
    { threadId: agent.threadId },
    { timeoutMs: remainingVerificationMs(), signal },
  );
  assertGenerationHealthy(client);
  remainingVerificationMs();
  const qualified = validateQualifiedThreadResponse(response, {
    cwd,
    codexHome,
    ephemeral: false,
    method: "thread/resume",
    expectedThreadId: agent.threadId,
  });
  validateDelegatedThread(
    qualified.thread,
    parentThreadId,
    agent.agentPath,
    agent.originalTurnId,
  );
  remainingVerificationMs();
  assertOutboundMethod("thread/unsubscribe");
  const unsubscribeResponse = await client.request(
    "thread/unsubscribe",
    { threadId: agent.threadId },
    { timeoutMs: remainingVerificationMs(), signal },
  );
  assertGenerationHealthy(client);
  remainingVerificationMs();
  const unsubscribe = requireRecord(
    unsubscribeResponse,
    "thread/unsubscribe response",
  );
  if (unsubscribe.status !== "unsubscribed") {
    throw new AuthenticatedLifecycleError(
      "DELEGATION_UNSUBSCRIBE_INVALID",
      "Delegated child subscription was not released exactly once",
      { kind: "recovery" },
    );
  }
  return qualified;
}

/**
 * @param {Readonly<Record<string, unknown>>} thread
 * @param {string} parentThreadId
 * @param {string} agentPath
 * @param {string} originalTurnId
 */
function validateDelegatedThread(
  thread,
  parentThreadId,
  agentPath,
  originalTurnId,
) {
  const status = requireRecord(thread.status, "delegated thread status");
  const source = requireRecord(thread.source, "delegated thread source");
  const subAgent = requireRecord(source.subAgent, "delegated sub-agent source");
  const spawn = requireRecord(
    subAgent.thread_spawn,
    "delegated thread-spawn source",
  );
  if (
    thread.parentThreadId !== parentThreadId ||
    thread.forkedFromId !== null ||
    thread.threadSource !== "subagent" ||
    status.type !== "idle" ||
    spawn.parent_thread_id !== parentThreadId ||
    spawn.depth !== 1 ||
    spawn.agent_path !== agentPath
  ) {
    throw new AuthenticatedLifecycleError(
      "DELEGATION_PROVENANCE_INVALID",
      "Delegated thread did not preserve its V2 parent and agent-path provenance",
      { kind: "recovery" },
    );
  }
  if (!Array.isArray(thread.turns) || thread.turns.length !== 1) {
    throw new AuthenticatedLifecycleError(
      "DELEGATION_COMPLETION_MISSING",
      "Delegated thread did not contain completed turn history",
      { kind: "recovery" },
    );
  }
  const turn = requireRecord(thread.turns[0], "delegated turn");
  if (
    turn.status !== "completed" ||
    turn.error !== null ||
    turn.itemsView !== "full" ||
    !Array.isArray(turn.items) ||
    turn.id !== originalTurnId
  ) {
    throw new AuthenticatedLifecycleError(
      "DELEGATION_COMPLETION_MISSING",
      "Delegated thread retained non-completed turn history",
      { kind: "recovery" },
    );
  }
  /** @type {Readonly<Record<string, unknown>>[]} */
  const finalMessages = [];
  const itemIds = new Set();
  for (const rawItem of turn.items) {
    const item = validateDelegatedHistoryItem(rawItem);
    if (itemIds.has(/** @type {string} */ (item.id))) {
      throw lifecycleProtocolError(
        "DELEGATION_HISTORY_ITEM_DUPLICATED",
        "Delegated fixed-task history repeated an item identity",
      );
    }
    itemIds.add(/** @type {string} */ (item.id));
    if (item.type === "agentMessage" && item.phase === "final_answer") {
      finalMessages.push(item);
    }
  }
  const finalMessage = finalMessages.length === 1 ? finalMessages[0] : null;
  // As above, Legacy history may synthesize this item's ID. Reconcile the
  // canonical turn plus exact phase/count/text, never the transient item ID.
  if (
    finalMessage === null ||
    finalMessage.text !== "DELEGATE_OK"
  ) {
    throw new AuthenticatedLifecycleError(
      "DELEGATION_FINAL_ANSWER_INVALID",
      "Delegated history did not contain exactly one explicit final answer",
      { kind: "recovery" },
    );
  }
}

/** @param {unknown} value */
function validateDelegatedHistoryItem(value) {
  const item = requireRecord(value, "delegated history item");
  if (
    typeof item.type !== "string" ||
    !DELEGATED_HISTORY_ITEM_TYPES.has(item.type)
  ) {
    throw new AuthenticatedLifecycleError(
      "DELEGATION_HISTORY_ITEM_FORBIDDEN",
      "Delegated fixed-task history contained a tool or nested delegation item",
      { kind: "policy" },
    );
  }
  if (
    !isBoundedNonEmptyText(item.id, 240) ||
    !isBoundedJsonValue(item, 256 * 1024)
  ) {
    throw lifecycleProtocolError(
      "DELEGATION_HISTORY_ITEM_INVALID",
      "Delegated fixed-task history contained an invalid or oversized item",
    );
  }
  if (item.type === "agentMessage") {
    if (!isBoundedAgentMessage(item)) {
      throw lifecycleProtocolError(
        "DELEGATION_HISTORY_ITEM_INVALID",
        "Delegated history contained an invalid agent message",
      );
    }
  } else if (item.type === "userMessage") {
    if (!isValidUserMessage(item)) {
      throw lifecycleProtocolError(
        "DELEGATION_HISTORY_ITEM_INVALID",
        "Delegated history contained an invalid user message",
      );
    }
  } else if (item.type === "reasoning") {
    if (!isValidReasoningItem(item)) {
      throw lifecycleProtocolError(
        "DELEGATION_HISTORY_ITEM_INVALID",
        "Delegated history contained invalid reasoning metadata",
      );
    }
  }
  return item;
}

/** @param {Readonly<Record<string, unknown>>} item */
function isValidUserMessage(item) {
  return Boolean(
    Array.isArray(item.content) &&
    item.content.length > 0 &&
    item.content.every((entry) =>
      entry &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      Reflect.get(entry, "type") === "text" &&
      isBoundedNonEmptyText(Reflect.get(entry, "text"), 64 * 1024)
    ),
  );
}

/** @param {Readonly<Record<string, unknown>>} item */
function isValidReasoningItem(item) {
  return Boolean(
    Array.isArray(item.summary) &&
    Array.isArray(item.content) &&
    [...item.summary, ...item.content].every((entry) =>
      typeof entry === "string" && Buffer.byteLength(entry, "utf8") <= 64 * 1024
    ),
  );
}

/** @param {unknown} value */
function isBoundedAgentMessage(value) {
  const phase = value && typeof value === "object" && !Array.isArray(value)
    ? Reflect.get(value, "phase")
    : undefined;
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    isBoundedNonEmptyText(Reflect.get(value, "id"), 240) &&
    isBoundedNonEmptyText(Reflect.get(value, "text"), 256 * 1024) &&
    (phase === null || phase === undefined || ["commentary", "final_answer"].includes(phase)),
  );
}

/** @param {unknown} value @param {number} maxBytes */
function isBoundedJsonValue(value, maxBytes) {
  try {
    const serialized = JSON.stringify(value);
    return (
      typeof serialized === "string" &&
      Buffer.byteLength(serialized, "utf8") <= maxBytes
    );
  } catch {
    return false;
  }
}

/** @param {unknown} value @param {string} label */
function boundedSerializedBytes(value, label) {
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== "string") throw new TypeError();
    return Buffer.byteLength(serialized, "utf8");
  } catch {
    throw lifecycleProtocolError(
      "INVALID_RESPONSE",
      `${label} was not bounded JSON data`,
    );
  }
}

/**
 * @param {object} options
 * @param {(options: StructuredTurnInvocation) => Promise<StructuredTurnResult>} options.runTurn
 * @param {LifecycleClient} options.client
 * @param {string} options.threadId
 * @param {TurnSpecification} options.specification
 * @param {(notification: Readonly<{method: string, params: Readonly<Record<string, unknown>>}>) => boolean | void} [options.validateForeignTurnNotification]
 * @param {() => Promise<void>} [options.awaitAdditionalEvidence]
 * @param {AbortSignal | undefined} options.signal
 */
async function invokeStructuredTurn({
  runTurn,
  client,
  threadId,
  specification,
  validateForeignTurnNotification,
  awaitAdditionalEvidence,
  signal,
}) {
  const guard = requireGenerationGuard(client);
  guard.assertHealthy();
  const claim = guard.claimLifecycle();
  /** @type {StructuredTurnResult | undefined} */
  let result;
  /** @type {AuthenticatedLifecycleError | null} */
  let dependencyFailure = null;
  try {
    result = await runTurn({
      client,
      threadId,
      input: specification.input,
      outputSchema: specification.outputSchema,
      parseFinal: specification.parseFinal,
      deadlineMs: specification.deadlineMs,
      signal,
      allowedMcpTools: specification.allowedMcpTools,
      requiredMcpTools: specification.requiredMcpTools,
      ...(specification.validateMcpCompletion === undefined
        ? {}
        : { validateMcpCompletion: specification.validateMcpCompletion }),
      ...(validateForeignTurnNotification === undefined
        ? {}
        : { validateForeignTurnNotification }),
      ...(awaitAdditionalEvidence === undefined
        ? {}
        : { awaitAdditionalEvidence }),
    });
  } catch (error) {
    dependencyFailure = normalizeLifecycleFailure(error);
  } finally {
    guard.releaseLifecycle(claim);
  }
  guard.assertHealthy();
  if (dependencyFailure !== null) throw dependencyFailure;
  return /** @type {StructuredTurnResult} */ (result);
}

/**
 * @param {object} options
 * @param {LifecycleClient} options.client
 * @param {string} options.threadId
 * @param {TurnSpecification} options.specification
 * @param {number} options.deadlineMs
 * @param {AbortSignal | undefined} options.signal
 */
async function runInterruptProof({ client, threadId, specification, deadlineMs, signal }) {
  if (client.serverRequestsForbidden !== true) {
    throw new AuthenticatedLifecycleError(
      "SERVER_REQUEST_POLICY_UNSAFE",
      "Interrupt proof requires an exact empty server-request allowlist",
      { kind: "policy" },
    );
  }
  throwIfAborted(signal);
  const guard = requireGenerationGuard(client);
  guard.assertHealthy();
  const lifecycleClaim = guard.claimLifecycle();
  /** @type {AuthenticatedLifecycleError | null} */
  let proofFailure = null;
  const deadlineAt = performance.now() + deadlineMs;
  const requestAbort = new AbortController();
  /** @type {string | null} */
  let turnId = null;
  /** @type {"awaitingTurnStarted" | "active" | "terminal"} */
  let state = "awaitingTurnStarted";
  let interruptIssued = false;
  let terminalObserved = false;
  let notificationCount = 0;
  let bufferedBytes = 0;
  const startedItemIds = new Set();
  const activeStartedItems = new Map();
  const completedItemIds = new Set();
  /** @type {{method: string, params: Readonly<Record<string, unknown>>}[]} */
  const buffered = [];
  /** @type {AuthenticatedLifecycleError | null} */
  let failure = null;
  /** @type {NodeJS.Timeout | null} */
  let timer = null;

  /** @type {(value?: void | PromiseLike<void>) => void} */
  let resolveStarted;
  /** @type {(reason?: unknown) => void} */
  let rejectStarted;
  const startedPromise = new Promise((resolve, reject) => {
    resolveStarted = resolve;
    rejectStarted = reject;
  });
  void startedPromise.catch(() => {});

  /** @type {(value: Readonly<Record<string, unknown>>) => void} */
  let resolveTerminal;
  /** @type {(reason?: unknown) => void} */
  let rejectTerminal;
  const terminalPromise = new Promise((resolve, reject) => {
    resolveTerminal = resolve;
    rejectTerminal = reject;
  });
  void terminalPromise.catch(() => {});

  /** @type {(reason?: unknown) => void} */
  let rejectFailure;
  const failurePromise = new Promise((_, reject) => {
    rejectFailure = reject;
  });
  void failurePromise.catch(() => {});

  /** @param {unknown} error */
  const fail = (error) => {
    if (failure !== null) return;
    failure = normalizeLifecycleFailure(error);
    rejectStarted(failure);
    rejectTerminal(failure);
    rejectFailure(failure);
    requestAbort.abort(failure);
  };

  /** @param {string} method @param {Readonly<Record<string, unknown>>} params */
  const consume = (method, params) => {
    assertLifecycleIdentity(params, threadId, /** @type {string} */ (turnId), method);
    if (method === "turn/started") {
      if (state !== "awaitingTurnStarted") {
        throw lifecycleProtocolError(
          state === "active" ? "DUPLICATE_TURN_STARTED" : "EVENT_AFTER_TERMINAL",
          "Interrupt turn emitted an invalid turn/started sequence",
        );
      }
      const turn = requireRecord(params.turn, "interrupt turn/started turn");
      if (
        turn.id !== turnId ||
        turn.status !== "inProgress" ||
        turn.error !== null ||
        turn.itemsView !== "notLoaded" ||
        !Array.isArray(turn.items) ||
        turn.items.length !== 0
      ) {
        throw lifecycleProtocolError(
          "INTERRUPT_START_INVALID",
          "Interrupt turn did not enter the required in-progress state",
        );
      }
      state = "active";
      resolveStarted();
      return;
    }
    if (method === "item/started" || method === "item/completed") {
      if (state !== "active") {
        throw lifecycleProtocolError(
          state === "terminal" ? "EVENT_AFTER_TERMINAL" : "ITEM_BEFORE_TURN_STARTED",
          "Interrupt turn emitted an item outside its active lifecycle",
        );
      }
      const item = requireRecord(params.item, "interrupt turn item");
      try {
        assertAllowedItem(item);
      } catch {
        throw lifecycleProtocolError(
          "INTERRUPT_ITEM_FORBIDDEN",
          "Interrupt turn emitted a forbidden item type",
        );
      }
      if (!INTERRUPT_ITEM_TYPES.has(/** @type {string} */ (item.type))) {
        throw new AuthenticatedLifecycleError(
          "INTERRUPT_TOOL_FORBIDDEN",
          "Interrupt proof attempted a tool or delegated operation",
          { kind: "policy" },
        );
      }
      const itemId = requireNonEmptyText(item.id, "interrupt item id");
      if (method === "item/started") {
        if (startedItemIds.has(itemId)) {
          throw lifecycleProtocolError(
            "DUPLICATE_ITEM_STARTED",
            "Interrupt turn started the same item more than once",
          );
        }
        startedItemIds.add(itemId);
        activeStartedItems.set(itemId, interruptItemSignature(item));
        return;
      }
      if (completedItemIds.has(itemId)) {
        throw lifecycleProtocolError(
          "DUPLICATE_ITEM",
          "Interrupt turn completed the same item more than once",
        );
      }
      const startedSignature = activeStartedItems.get(itemId);
      if (startedSignature === undefined) {
        throw lifecycleProtocolError(
          "ITEM_STARTED_MISSING",
          "Interrupt turn completed an item without item/started",
        );
      }
      if (startedSignature !== interruptItemSignature(item)) {
        throw lifecycleProtocolError(
          "ITEM_LIFECYCLE_MISMATCH",
          "Interrupt item changed stable identity before completion",
        );
      }
      activeStartedItems.delete(itemId);
      completedItemIds.add(itemId);
      return;
    }
    if (method === "model/rerouted") {
      throw new AuthenticatedLifecycleError(
        "MODEL_REROUTED",
        "Interrupt proof observed a model reroute",
        { kind: "policy" },
      );
    }
    if (method === "turn/completed") {
      if (state !== "active" || terminalObserved) {
        throw lifecycleProtocolError(
          terminalObserved ? "DUPLICATE_TERMINAL" : "TERMINAL_BEFORE_TURN_STARTED",
          "Interrupt turn emitted an invalid terminal sequence",
        );
      }
      if (!interruptIssued) {
        throw new AuthenticatedLifecycleError(
          "INTERRUPT_RACE_LOST",
          "Turn completed before the stable interrupt request was issued",
          { kind: "lifecycle" },
        );
      }
      const turn = requireRecord(params.turn, "interrupt terminal turn");
      if (
        turn.id !== turnId ||
        turn.status !== "interrupted" ||
        turn.error !== null ||
        turn.itemsView !== "notLoaded"
      ) {
        throw lifecycleProtocolError(
          "INTERRUPT_TERMINAL_INVALID",
          "Interrupt terminal did not report the required interrupted status",
        );
      }
      if (!Array.isArray(turn.items)) {
        throw lifecycleProtocolError(
          "TERMINAL_ITEMS_INVALID",
          "Interrupt terminal did not contain an item array",
        );
      }
      if (turn.items.length !== 0) {
        throw lifecycleProtocolError(
          "TERMINAL_ITEMS_NOT_EMPTY",
          "Interrupt terminal did not use the exact empty item snapshot",
        );
      }
      terminalObserved = true;
      state = "terminal";
      resolveTerminal(turn);
    }
  };

  /** @param {{method: string, params?: unknown}} notification */
  const onNotification = (notification) => {
    try {
      notificationCount += 1;
      if (notificationCount > MAX_INTERRUPT_NOTIFICATIONS) {
        throw lifecycleProtocolError(
          "INTERRUPT_NOTIFICATION_LIMIT_EXCEEDED",
          "Interrupt proof exceeded its notification limit",
        );
      }
      const disposition = classifyNotification(notification.method);
      if (disposition === "fail-closed") {
        throw new AuthenticatedLifecycleError(
          notification.method === "model/rerouted"
            ? "MODEL_REROUTED"
            : "RUNTIME_INVENTORY_CHANGED",
          "Interrupt proof observed a fail-closed runtime notification",
          { kind: "policy" },
        );
      }
      if (!INTERRUPT_NOTIFICATION_METHODS.has(notification.method)) return;
      const params = requireRecord(notification.params, "interrupt notification params");
      if (turnId === null) {
        if (buffered.length >= MAX_BUFFERED_INTERRUPT_NOTIFICATIONS) {
          throw lifecycleProtocolError(
            "INTERRUPT_PRESTART_BUFFER_EXCEEDED",
            "Interrupt proof exceeded its pre-response notification limit",
          );
        }
        bufferedBytes += Buffer.byteLength(
          JSON.stringify({ method: notification.method, params }),
          "utf8",
        );
        if (bufferedBytes > MAX_BUFFERED_INTERRUPT_BYTES) {
          throw lifecycleProtocolError(
            "INTERRUPT_PRESTART_BUFFER_EXCEEDED",
            "Interrupt proof exceeded its pre-response byte limit",
          );
        }
        buffered.push({ method: notification.method, params });
        return;
      }
      consume(notification.method, params);
    } catch (error) {
      fail(error);
    }
  };
  const onServerRequest = (request) => {
    try {
      rejectServerRequest(request?.method);
    } catch {
      fail(new AuthenticatedLifecycleError(
        "SERVER_REQUEST_FORBIDDEN",
        "Interrupt proof received a forbidden server-initiated request",
        { kind: "policy" },
      ));
    }
  };
  const onIncident = (error) => fail(error);
  const onExit = (event) => {
    if (event?.error || !event?.expected) {
      fail(new AuthenticatedLifecycleError(
        "APP_SERVER_EXIT",
        "App-server exited during interrupt proof",
        { kind: "process" },
      ));
    }
  };
  const onAbort = () => fail(new AuthenticatedLifecycleError(
    "LIFECYCLE_ABORTED",
    "Authenticated lifecycle proof was aborted",
    { kind: "aborted" },
  ));

  try {
    client.on("notification", onNotification);
    client.on("serverRequest", onServerRequest);
    client.on("incident", onIncident);
    client.on("exit", onExit);
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => fail(new AuthenticatedLifecycleError(
      "INTERRUPT_TIMEOUT",
      "Interrupt proof did not reach a terminal state before its deadline",
      { kind: "timeout", details: { deadlineMs } },
    )), Math.max(1, Math.ceil(deadlineAt - performance.now())));

    assertOutboundMethod("turn/start");
    const startResult = await Promise.race([
      client.request("turn/start", {
        threadId,
        input: specification.input,
        outputSchema: specification.outputSchema,
      }, {
        timeoutMs: remainingDeadline(deadlineAt),
        signal: requestAbort.signal,
      }),
      failurePromise,
    ]);
    guard.assertHealthy();
    const start = requireRecord(startResult, "interrupt turn/start response");
    const turn = requireRecord(start.turn, "interrupt turn/start response turn");
    turnId = requireNonEmptyText(turn.id, "interrupt turn id");
    if (
      turn.status !== "inProgress" ||
      turn.error !== null ||
      turn.itemsView !== "notLoaded" ||
      !Array.isArray(turn.items) ||
      turn.items.length !== 0
    ) {
      throw lifecycleProtocolError(
        "INTERRUPT_START_INVALID",
        "Interrupt turn/start response did not report in-progress status",
      );
    }
    for (const entry of buffered) consume(entry.method, entry.params);
    buffered.length = 0;

    await Promise.race([startedPromise, failurePromise]);
    guard.assertHealthy();
    if (state !== "active") {
      throw lifecycleProtocolError(
        "INTERRUPT_START_INVALID",
        "Interrupt turn never entered the active state",
      );
    }
    interruptIssued = true;
    assertOutboundMethod("turn/interrupt");
    const interruptRequest = client.request(
      "turn/interrupt",
      { threadId, turnId },
      { timeoutMs: remainingDeadline(deadlineAt), signal: requestAbort.signal },
    );
    void interruptRequest.catch(() => {});
    const [interruptResponse] = await Promise.race([
      Promise.all([interruptRequest, terminalPromise]),
      failurePromise,
    ]);
    guard.assertHealthy();
    requireRecord(interruptResponse, "turn/interrupt response");
    await new Promise((resolve) => setImmediate(resolve));
    guard.assertHealthy();
    if (failure !== null) throw failure;
    remainingDeadline(deadlineAt);
    if (!terminalObserved || state !== "terminal") {
      throw lifecycleProtocolError(
        "INTERRUPT_TERMINAL_MISSING",
        "Interrupt proof did not observe its terminal event",
      );
    }
  } catch (error) {
    proofFailure = normalizeLifecycleFailure(error);
  } finally {
    if (timer !== null) clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    client.off("notification", onNotification);
    client.off("serverRequest", onServerRequest);
    client.off("incident", onIncident);
    client.off("exit", onExit);
    guard.releaseLifecycle(lifecycleClaim);
  }
  guard.assertHealthy();
  if (proofFailure !== null) throw proofFailure;
  return requireNonEmptyText(turnId, "accepted interrupt turn id");
}

/** @param {LifecycleClient} client @param {string} threadId */
function observeBoundedDelegation(client, threadId) {
  /** @type {Map<string, Readonly<{threadId: string, agentPath: string, originalTurnId?: string}>>} */
  const agents = new Map();
  const activityItemIds = new Set();
  const nonActivityItemIds = new Set();
  const agentPaths = new Set();
  const turnIds = new Set();
  let itemCount = 0;
  let foreignNotificationCount = 0;
  let foreignNotificationBytes = 0;
  /** @type {string | null} */
  let foreignThreadId = null;
  /** @type {string | null} */
  let foreignTurnId = null;
  /** @type {"awaitingTurnStarted" | "active" | "terminal"} */
  let foreignState = "awaitingTurnStarted";
  const foreignStartedItemIds = new Set();
  const foreignActiveItems = new Map();
  const foreignCompletedItemIds = new Set();
  /** @type {Readonly<Record<string, unknown>>[]} */
  const foreignFinalMessages = [];
  /** @type {AuthenticatedLifecycleError | null} */
  let failure = null;
  let evidenceSettled = false;
  /** @type {() => void} */
  let resolveEvidence;
  /** @type {(reason?: unknown) => void} */
  let rejectEvidence;
  const evidencePromise = new Promise((resolve, reject) => {
    resolveEvidence = resolve;
    rejectEvidence = reject;
  });
  void evidencePromise.catch(() => {});

  const maybeResolveEvidence = () => {
    if (
      evidenceSettled ||
      failure !== null ||
      agents.size !== 1 ||
      foreignThreadId === null ||
      foreignTurnId === null ||
      foreignState !== "terminal" ||
      foreignFinalMessages.length !== 1 ||
      !agents.has(foreignThreadId)
    ) return;
    evidenceSettled = true;
    resolveEvidence();
  };

  /** @param {unknown} error */
  const fail = (error) => {
    if (failure !== null) return;
    failure = normalizeLifecycleFailure(error);
    if (!evidenceSettled) {
      evidenceSettled = true;
      rejectEvidence(failure);
    }
  };

  /**
   * This hook is called synchronously by runStructuredTurn only after its
   * global notification policy has accepted the method. It intentionally
   * latches local failures and returns true so assertCompleted can surface the
   * lifecycle-specific fixed code rather than a generic hook wrapper.
   * @param {Readonly<{method: string, params: Readonly<Record<string, unknown>>}>} notification
   */
  const validateForeignTurnNotification = (notification) => {
    if (failure !== null) return true;
    try {
      const event = requireRecord(notification, "foreign turn notification");
      const method = requireAllowedText(
        event.method,
        FOREIGN_TURN_NOTIFICATION_METHODS,
        "foreign turn notification method",
      );
      const params = requireRecord(event.params, "foreign turn notification params");
      foreignNotificationCount += 1;
      foreignNotificationBytes += boundedSerializedBytes(
        { method, params },
        "foreign turn notification",
      );
      if (
        foreignNotificationCount > MAX_FOREIGN_TURN_NOTIFICATIONS ||
        foreignNotificationBytes > MAX_FOREIGN_TURN_BYTES
      ) {
        throw lifecycleProtocolError(
          "DELEGATION_FOREIGN_BUFFER_EXCEEDED",
          "Delegated child lifecycle exceeded its bounded observation budget",
        );
      }
      const observedThreadId = requireNonEmptyText(
        params.threadId,
        "foreign lifecycle thread id",
      );
      if (observedThreadId === threadId) {
        throw lifecycleProtocolError(
          "DELEGATION_CHILD_IDENTITY_INVALID",
          "Delegated child lifecycle reused the parent thread identity",
        );
      }
      if (foreignThreadId === null) foreignThreadId = observedThreadId;
      if (observedThreadId !== foreignThreadId) {
        throw new AuthenticatedLifecycleError(
          "DELEGATION_LIMIT_EXCEEDED",
          "Delegation emitted lifecycle evidence for more than one child",
          { kind: "policy", details: { maxDelegatedAgents: 1 } },
        );
      }

      if (method === "turn/started") {
        if (foreignState !== "awaitingTurnStarted") {
          throw lifecycleProtocolError(
            foreignState === "terminal" ? "DELEGATION_EVENT_AFTER_TERMINAL" : "DELEGATION_DUPLICATE_TURN_STARTED",
            "Delegated child emitted an invalid turn/started sequence",
          );
        }
        const turn = requireRecord(params.turn, "delegated child turn/started turn");
        const observedTurnId = requireNonEmptyText(turn.id, "delegated child turn id");
        if (
          (params.turnId !== undefined && params.turnId !== observedTurnId) ||
          turn.status !== "inProgress" ||
          turn.error !== null ||
          turn.itemsView !== "notLoaded" ||
          !Array.isArray(turn.items) ||
          turn.items.length !== 0
        ) {
          throw lifecycleProtocolError(
            "DELEGATION_CHILD_START_INVALID",
            "Delegated child did not enter the exact in-progress state",
          );
        }
        foreignTurnId = observedTurnId;
        foreignState = "active";
        return true;
      }

      if (foreignState !== "active" || foreignTurnId === null) {
        throw lifecycleProtocolError(
          foreignState === "terminal"
            ? "DELEGATION_EVENT_AFTER_TERMINAL"
            : "DELEGATION_EVENT_BEFORE_TURN_STARTED",
          "Delegated child emitted lifecycle evidence outside its active turn",
        );
      }
      assertLifecycleIdentity(params, observedThreadId, foreignTurnId, method);
      if (method === "item/started" || method === "item/completed") {
        const item = requireRecord(params.item, "delegated child item");
        if (
          typeof item.type !== "string" ||
          !DELEGATED_HISTORY_ITEM_TYPES.has(item.type)
        ) {
          throw new AuthenticatedLifecycleError(
            "DELEGATION_CHILD_CAPABILITY_FORBIDDEN",
            "Delegated child attempted a tool or nested delegation",
            { kind: "policy" },
          );
        }
        if (
          !isBoundedNonEmptyText(item.id, 240) ||
          !isBoundedJsonValue(item, 256 * 1024)
        ) {
          throw lifecycleProtocolError(
            "DELEGATION_CHILD_ITEM_INVALID",
            "Delegated child emitted an invalid or oversized item",
          );
        }
        const itemId = /** @type {string} */ (item.id);
        if (method === "item/started") {
          if (foreignStartedItemIds.has(itemId)) {
            throw lifecycleProtocolError(
              "DELEGATION_CHILD_DUPLICATE_ITEM_STARTED",
              "Delegated child started the same item more than once",
            );
          }
          foreignStartedItemIds.add(itemId);
          foreignActiveItems.set(itemId, JSON.stringify([item.type]));
          return true;
        }
        if (foreignCompletedItemIds.has(itemId)) {
          throw lifecycleProtocolError(
            "DELEGATION_CHILD_DUPLICATE_ITEM",
            "Delegated child completed the same item more than once",
          );
        }
        const startedSignature = foreignActiveItems.get(itemId);
        if (startedSignature === undefined) {
          throw lifecycleProtocolError(
            "DELEGATION_CHILD_ITEM_STARTED_MISSING",
            "Delegated child completed an item without item/started",
          );
        }
        if (startedSignature !== JSON.stringify([item.type])) {
          throw lifecycleProtocolError(
            "DELEGATION_CHILD_ITEM_LIFECYCLE_MISMATCH",
            "Delegated child changed an item's stable type before completion",
          );
        }
        const completedItem = validateDelegatedHistoryItem(item);
        foreignActiveItems.delete(itemId);
        foreignCompletedItemIds.add(itemId);
        if (
          completedItem.type === "agentMessage" &&
          completedItem.phase === "final_answer"
        ) {
          foreignFinalMessages.push(completedItem);
        }
        return true;
      }

      if (method === "turn/completed") {
        const turn = requireRecord(params.turn, "delegated child terminal turn");
        if (
          turn.id !== foreignTurnId ||
          turn.status !== "completed" ||
          turn.error !== null ||
          turn.itemsView !== "notLoaded" ||
          !Array.isArray(turn.items) ||
          turn.items.length !== 0 ||
          foreignActiveItems.size !== 0
        ) {
          throw lifecycleProtocolError(
            "DELEGATION_CHILD_TERMINAL_INVALID",
            "Delegated child did not complete with an exact terminal envelope",
          );
        }
        if (
          foreignFinalMessages.length !== 1 ||
          foreignFinalMessages[0].text !== "DELEGATE_OK"
        ) {
          throw new AuthenticatedLifecycleError(
            "DELEGATION_FINAL_ANSWER_INVALID",
            "Delegated child did not return the exact fixed-task final answer",
            { kind: "lifecycle" },
          );
        }
        foreignState = "terminal";
        maybeResolveEvidence();
        return true;
      }
      throw lifecycleProtocolError(
        "DELEGATION_CHILD_NOTIFICATION_FORBIDDEN",
        "Delegated child emitted an unsupported lifecycle notification",
      );
    } catch (error) {
      fail(error);
      return true;
    }
  };

  /** @param {{method: string, params?: unknown}} notification */
  const onNotification = (notification) => {
    if (failure !== null || (notification.method !== "item/started" && notification.method !== "item/completed")) {
      return;
    }
    try {
      const params = requireRecord(notification.params, "delegation item params");
      if (params.threadId !== threadId) return;
      itemCount += 1;
      if (itemCount > MAX_DELEGATION_ITEMS) {
        throw lifecycleProtocolError(
          "DELEGATION_ITEM_LIMIT_EXCEEDED",
          "Delegation proof exceeded its item limit",
        );
      }
      turnIds.add(requireNonEmptyText(params.turnId, "delegation turn id"));
      const item = requireRecord(params.item, "delegation item");
      try {
        assertAllowedItem(item);
      } catch {
        throw new AuthenticatedLifecycleError(
          "DELEGATION_ITEM_FORBIDDEN",
          "Delegation proof observed a forbidden item type",
          { kind: "policy" },
        );
      }
      const itemId = requireNonEmptyText(item.id, "delegation item id");
      if (item.type !== "subAgentActivity") {
        if (activityItemIds.has(itemId)) {
          throw lifecycleProtocolError(
            "DELEGATION_ITEM_ID_REUSED",
            "Delegation reused an activity item identifier",
          );
        }
        nonActivityItemIds.add(itemId);
        if (item.type === "collabAgentToolCall" && item.tool === "spawnAgent") {
          throw new AuthenticatedLifecycleError(
            "DELEGATION_V1_FORBIDDEN",
            "Delegation used the legacy spawn-item representation",
            { kind: "policy" },
          );
        }
        return;
      }
      if (notification.method !== "item/completed") {
        throw lifecycleProtocolError(
          "DELEGATION_ACTIVITY_NOT_ATOMIC",
          "V2 sub-agent activity must be emitted as an atomic completed item",
        );
      }
      if (activityItemIds.has(itemId) || nonActivityItemIds.has(itemId)) {
        throw lifecycleProtocolError(
          "DELEGATION_ITEM_ID_REUSED",
          "Delegation repeated an atomic activity item identifier",
        );
      }
      activityItemIds.add(itemId);
      if (item.kind !== "started") {
        throw lifecycleProtocolError(
          "DELEGATION_ACTIVITY_INVALID",
          "Delegation activity did not describe a started V2 receiver",
        );
      }
      const agentThreadId = requireNonEmptyText(
        item.agentThreadId,
        "sub-agent activity thread id",
      );
      const agentPath = requireCanonicalAgentPath(item.agentPath);
      if (
        agentThreadId === threadId ||
        agents.has(agentThreadId) ||
        agentPaths.has(agentPath)
      ) {
        throw lifecycleProtocolError(
          "DELEGATION_RECEIVER_DUPLICATED",
          "Delegation repeated a receiver identity or canonical path",
        );
      }
      if (agents.size >= MAX_DELEGATED_AGENTS) {
        throw new AuthenticatedLifecycleError(
          "DELEGATION_LIMIT_EXCEEDED",
          "Delegation exceeded the one-agent bound",
          { kind: "policy", details: { maxDelegatedAgents: MAX_DELEGATED_AGENTS } },
        );
      }
      if (agentPath !== REQUIRED_DELEGATED_AGENT_PATH) {
        throw new AuthenticatedLifecycleError(
          "DELEGATION_AGENT_PATH_INVALID",
          "Delegation activity did not identify the fixed auth_probe task",
          { kind: "policy" },
        );
      }
      agents.set(agentThreadId, Object.freeze({ threadId: agentThreadId, agentPath }));
      agentPaths.add(agentPath);
      maybeResolveEvidence();
    } catch (error) {
      fail(error);
    }
  };
  client.on("notification", onNotification);
  return Object.freeze({
    get agentCount() {
      return agents.size;
    },
    get agents() {
      return Object.freeze([...agents.values()]);
    },
    validateForeignTurnNotification,
    awaitEvidence() {
      return evidencePromise;
    },
    /** @param {string} expectedTurnId */
    assertCompleted(expectedTurnId) {
      if (failure !== null) throw failure;
      if (agents.size !== 1) {
        throw new AuthenticatedLifecycleError(
          "DELEGATION_COUNT_INVALID",
          "Accepted resumed turn did not complete exactly one delegate",
          { kind: "lifecycle", details: { expectedDelegatedAgents: 1 } },
        );
      }
      if (turnIds.size !== 1 || !turnIds.has(expectedTurnId)) {
        throw lifecycleProtocolError(
          "DELEGATION_TURN_ID_INVALID",
          "Delegation evidence did not belong to the accepted resumed turn",
        );
      }
      if (
        foreignThreadId === null ||
        foreignTurnId === null ||
        foreignState !== "terminal" ||
        foreignFinalMessages.length !== 1
      ) {
        throw new AuthenticatedLifecycleError(
          "DELEGATION_CHILD_LIFECYCLE_MISSING",
          "Accepted delegation did not include a completed child lifecycle",
          { kind: "lifecycle" },
        );
      }
      const agent = agents.get(foreignThreadId);
      if (agent === undefined) {
        throw lifecycleProtocolError(
          "DELEGATION_CHILD_IDENTITY_INVALID",
          "Delegated activity did not identify the observed child lifecycle",
        );
      }
      agents.set(foreignThreadId, Object.freeze({
        threadId: foreignThreadId,
        agentPath: agent.agentPath,
        originalTurnId: foreignTurnId,
      }));
    },
    dispose() {
      client.off("notification", onNotification);
    },
  });
}

/**
 * @param {(context: Readonly<{materializedArtifact: unknown, resumedArtifact: unknown}>) => boolean | void} validator
 * @param {unknown} materializedArtifact
 * @param {unknown} resumedArtifact
 */
function validateContinuitySafely(validator, materializedArtifact, resumedArtifact) {
  let accepted;
  try {
    accepted = validator(Object.freeze({ materializedArtifact, resumedArtifact }));
  } catch {
    throw new AuthenticatedLifecycleError(
      "CONTINUITY_NOT_PROVEN",
      "Resumed turn failed local continuity validation",
      { kind: "recovery" },
    );
  }
  if (isThenable(accepted)) {
    void Promise.resolve(accepted).catch(() => {});
    throw new TypeError("validateContinuity must return synchronously");
  }
  if (accepted !== undefined && accepted !== true) {
    throw new AuthenticatedLifecycleError(
      "CONTINUITY_NOT_PROVEN",
      "Resumed turn failed local continuity validation",
      { kind: "recovery" },
    );
  }
}

/** @param {StructuredTurnResult} result @param {string} threadId @param {string} label */
function assertTurnResult(result, threadId, label) {
  const record = requireRecord(result, `${label} result`);
  if (record.threadId !== threadId || record.status !== "completed") {
    throw new AuthenticatedLifecycleError(
      "STRUCTURED_TURN_IDENTITY_INVALID",
      "Structured turn result did not match its lifecycle thread",
      { kind: "protocol" },
    );
  }
  requireNonEmptyText(record.turnId, `${label} turn id`);
  requireNonEmptyText(record.finalMessageId, `${label} final message id`);
  if (!Object.hasOwn(record, "artifact")) {
    throw new AuthenticatedLifecycleError(
      "STRUCTURED_TURN_RESULT_INVALID",
      "Structured turn result omitted its validated artifact",
      { kind: "protocol" },
    );
  }
}

/** @param {LifecycleClient} client @param {string} label */
function assertRetiredClient(client, label) {
  if (client.state !== "stopped") {
    throw new AuthenticatedLifecycleError(
      "TURN_CLIENT_NOT_RETIRED",
      "Accepted structured turn did not retire its physical app-server client",
      { kind: "recovery", details: { stage: label } },
    );
  }
}

/** @param {LifecycleClient} client */
async function stopClient(client) {
  if (client.state === "stopped") return;
  await client.stop();
}

/** @param {readonly LifecycleClient[]} clients */
async function stopClients(clients) {
  let cleanupFailed = false;
  for (const client of clients.toReversed()) {
    try {
      await stopClient(client);
    } catch {
      cleanupFailed = true;
    }
  }
  if (cleanupFailed) {
    throw new AuthenticatedLifecycleError(
      "CLIENT_CLEANUP_FAILED",
      "One or more app-server clients could not be retired",
      { kind: "process" },
    );
  }
}

/** @param {Readonly<Record<string, unknown>>} params @param {string} threadId @param {string} turnId @param {string} method */
function assertLifecycleIdentity(params, threadId, turnId, method) {
  const observedTurnId = params.turnId ?? (
    params.turn && typeof params.turn === "object" && !Array.isArray(params.turn)
      ? Reflect.get(params.turn, "id")
      : undefined
  );
  if (params.threadId !== threadId) {
    throw lifecycleProtocolError("THREAD_ID_MISMATCH", `${method} did not match the lifecycle thread`);
  }
  if (observedTurnId !== turnId) {
    throw lifecycleProtocolError("TURN_ID_MISMATCH", `${method} did not match the lifecycle turn`);
  }
}

/** @param {string} candidate @param {readonly string[]} prior @param {string} stage */
function assertLifecycleIdNotReused(candidate, prior, stage) {
  if (!prior.includes(candidate)) return;
  throw new AuthenticatedLifecycleError(
    "LIFECYCLE_ID_REUSED",
    "Authenticated lifecycle reused an identity across independent stages",
    { kind: "protocol", details: { stage } },
  );
}

/**
 * Content fields legitimately evolve between started and completed events;
 * the stable interrupt identity is the item ID (map key) plus its item type.
 * @param {Readonly<Record<string, unknown>>} item
 */
function interruptItemSignature(item) {
  return JSON.stringify([item.type]);
}

/** @param {number} deadlineAt */
function remainingDeadline(deadlineAt) {
  const remaining = deadlineAt - performance.now();
  if (remaining <= 0) {
    throw new AuthenticatedLifecycleError(
      "INTERRUPT_TIMEOUT",
      "Interrupt proof did not reach acceptance before its absolute deadline",
      { kind: "timeout" },
    );
  }
  return Math.max(1, Math.ceil(remaining));
}

/** @param {string} code @param {string} message */
function lifecycleProtocolError(code, message) {
  return new AuthenticatedLifecycleError(code, message, { kind: "protocol" });
}

/** @param {unknown} error */
function normalizeLifecycleFailure(error) {
  if (error instanceof AuthenticatedLifecycleError) return error;
  if (error instanceof ProtocolPolicyError) {
    return new AuthenticatedLifecycleError(
      "PROTOCOL_POLICY_VIOLATION",
      "Authenticated lifecycle used or observed a forbidden protocol method",
      { kind: "policy" },
    );
  }
  if (error && typeof error === "object") {
    const candidate = Reflect.get(error, "code");
    if (typeof candidate === "string" && /^[A-Z0-9_]{1,80}$/u.test(candidate)) {
      return new AuthenticatedLifecycleError(
        candidate,
        "Authenticated lifecycle dependency failed closed",
        { kind: safeKind(Reflect.get(error, "kind")) },
      );
    }
  }
  return new AuthenticatedLifecycleError(
    "AUTHENTICATED_LIFECYCLE_FAILED",
    "Authenticated lifecycle proof failed closed",
  );
}

/** @param {unknown} value */
function safeKind(value) {
  return typeof value === "string" && /^[a-z][a-z-]{0,39}$/u.test(value)
    ? value
    : "lifecycle";
}

/** @param {unknown} value @param {string} codexHome */
function snapshotMaterializedProof(value, codexHome) {
  const record = requireRecord(value, "materialized proof");
  const supported = new Set([
    "artifact",
    "finalMessageId",
    "status",
    "threadId",
    "threadPath",
    "turnId",
  ]);
  if (Object.keys(record).some((key) => !supported.has(key))) {
    throw new TypeError("materialized proof contains unsupported fields");
  }
  if (record.status !== undefined && record.status !== "completed") {
    throw new AuthenticatedLifecycleError(
      "MATERIALIZATION_NOT_ACCEPTED",
      "Lifecycle continuation requires an accepted materializing turn",
      { kind: "recovery" },
    );
  }
  if (!Object.hasOwn(record, "artifact")) {
    throw new TypeError("materialized proof must include its locally validated artifact");
  }
  const threadPath = requireAbsolutePath(record.threadPath, "materialized thread path");
  if (!isLexicallyBeneath(codexHome, threadPath)) {
    throw new AuthenticatedLifecycleError(
      "THREAD_PATH_OUTSIDE_CODEX_HOME",
      "Materialized thread path was outside the private Codex home",
      { kind: "policy" },
    );
  }
  return Object.freeze({
    threadId: requireNonEmptyText(record.threadId, "materialized thread id"),
    threadPath,
    turnId: requireNonEmptyText(record.turnId, "materialized turn id"),
    finalMessageId: requireNonEmptyText(
      record.finalMessageId,
      "materialized final message id",
    ),
    artifact: record.artifact,
  });
}

/** @param {unknown} value @param {string} label */
function snapshotClientInfo(value, label = "clientInfo") {
  const record = requireRecord(value, label);
  const keys = Object.keys(record).sort();
  if (keys.some((key) => !["name", "title", "version"].includes(key))) {
    throw new TypeError(`${label} contains unsupported fields`);
  }
  const name = requireBoundedText(record.name, `${label}.name`, 120);
  const version = requireBoundedText(record.version, `${label}.version`, 80);
  const title = record.title === undefined
    ? undefined
    : requireBoundedText(record.title, `${label}.title`, 160);
  return Object.freeze({ name, version, ...(title === undefined ? {} : { title }) });
}

/** @param {unknown} value @param {string} label */
function snapshotTurnSpecification(value, label) {
  const record = requireRecord(value, label);
  const supported = new Set([
    "allowedMcpTools",
    "deadlineMs",
    "input",
    "outputSchema",
    "parseFinal",
    "requiredMcpTools",
    "validateMcpCompletion",
  ]);
  if (Object.keys(record).some((key) => !supported.has(key))) {
    throw new TypeError(`${label} contains unsupported fields`);
  }
  if (!Array.isArray(record.input) || record.input.length === 0) {
    throw new TypeError(`${label}.input must be a non-empty array`);
  }
  const input = record.input.map((item, index) => {
    const entry = requireRecord(item, `${label}.input[${index}]`);
    if (Object.keys(entry).sort().join(",") !== "text,type" || entry.type !== "text") {
      throw new TypeError(`${label}.input supports only exact text items`);
    }
    return Object.freeze({
      type: "text",
      text: requireBoundedText(entry.text, `${label}.input[${index}].text`, 64 * 1024),
    });
  });
  const outputSchema = snapshotJsonRecord(record.outputSchema, `${label}.outputSchema`);
  assertFunction(record.parseFinal, `${label}.parseFinal`);
  const deadlineMs = record.deadlineMs === undefined
    ? DEFAULT_REQUEST_TIMEOUT_MS
    : record.deadlineMs;
  assertPositiveInteger(deadlineMs, `${label}.deadlineMs`);
  const allowedMcpTools = snapshotToolSet(record.allowedMcpTools, `${label}.allowedMcpTools`);
  const requiredMcpTools = snapshotToolSet(record.requiredMcpTools, `${label}.requiredMcpTools`);
  for (const tool of requiredMcpTools) {
    if (!allowedMcpTools.has(tool)) {
      throw new TypeError(`${label}.requiredMcpTools must be a subset of allowedMcpTools`);
    }
  }
  if (
    record.validateMcpCompletion !== undefined &&
    typeof record.validateMcpCompletion !== "function"
  ) {
    throw new TypeError(`${label}.validateMcpCompletion must be a function`);
  }
  return Object.freeze({
    input: Object.freeze(input),
    outputSchema,
    parseFinal: record.parseFinal,
    deadlineMs,
    allowedMcpTools,
    requiredMcpTools,
    ...(record.validateMcpCompletion === undefined
      ? {}
      : { validateMcpCompletion: record.validateMcpCompletion }),
  });
}

/** @param {unknown} value @param {string} label */
function snapshotToolSet(value, label) {
  if (value === undefined) return new Set();
  if (!(value instanceof Set)) throw new TypeError(`${label} must be a Set`);
  const copy = new Set();
  for (const tool of value) {
    copy.add(requireBoundedText(tool, `${label} entry`, 240));
  }
  return copy;
}

/** @param {unknown} value @param {string} label */
function snapshotJsonRecord(value, label) {
  const record = requireRecord(value, label);
  let serialized;
  try {
    serialized = JSON.stringify(record);
  } catch {
    throw new TypeError(`${label} must be JSON serializable`);
  }
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > 256 * 1024) {
    throw new TypeError(`${label} exceeds its JSON byte limit`);
  }
  const parsed = JSON.parse(serialized);
  return deepFreeze(parsed);
}

/** @param {unknown} value @param {string} label */
function requireRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw lifecycleProtocolError("INVALID_RESPONSE", `${label} must be an object`);
  }
  return /** @type {Readonly<Record<string, unknown>>} */ (value);
}

/** @param {unknown} value @param {string} label */
function requireNonEmptyText(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw lifecycleProtocolError("INVALID_RESPONSE", `${label} must be non-empty text`);
  }
  return value;
}

/** @param {unknown} value @param {ReadonlySet<string>} allowed @param {string} label */
function requireAllowedText(value, allowed, label) {
  if (typeof value !== "string" || !allowed.has(value)) {
    throw lifecycleProtocolError("INVALID_RESPONSE", `${label} contained an unsupported value`);
  }
  return value;
}

/** @param {unknown} value @param {string} label @param {number} maxBytes */
function requireBoundedText(value, label, maxBytes) {
  if (!isBoundedNonEmptyText(value, maxBytes)) {
    throw new TypeError(`${label} must be bounded non-empty text`);
  }
  return /** @type {string} */ (value);
}

/** @param {unknown} value @param {number} maxBytes */
function isBoundedNonEmptyText(value, maxBytes) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= maxBytes &&
    !value.includes("\0")
  );
}

/** @param {unknown} value @param {string} label */
function requireAbsolutePath(value, label) {
  const text = requireBoundedText(value, label, 4 * 1024);
  if (!isAbsolute(text) || text.includes("\0")) {
    throw new TypeError(`${label} must be an absolute path`);
  }
  return text;
}

/** @param {string} root @param {string} candidate */
function isLexicallyBeneath(root, candidate) {
  const child = relative(root, candidate);
  return (
    child.length > 0 &&
    child !== ".." &&
    !child.startsWith(`..${sep}`) &&
    !isAbsolute(child)
  );
}

/** @param {unknown} value */
function requireCanonicalAgentPath(value) {
  const path = requireBoundedText(value, "sub-agent canonical path", MAX_AGENT_PATH_BYTES);
  const segments = path.startsWith("/root/")
    ? path.slice("/root/".length).split("/")
    : [];
  if (
    segments.length !== 1 ||
    segments.some((segment) =>
      segment.length === 0 ||
      segment === "root" ||
      !/^[a-z0-9_]+$/u.test(segment)
    )
  ) {
    throw new AuthenticatedLifecycleError(
      "DELEGATION_AGENT_PATH_INVALID",
      "Delegation activity contained a non-canonical agent path",
      { kind: "protocol" },
    );
  }
  return path;
}

/** @param {unknown} value @param {string} label */
function assertFunction(value, label) {
  if (typeof value !== "function") throw new TypeError(`${label} must be a function`);
}

/** @param {unknown} value @param {string} label */
function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || /** @type {number} */ (value) <= 0) {
    throw new TypeError(`${label} must be a positive integer`);
  }
}

/** @param {AbortSignal | undefined} signal */
function assertAbortSignal(signal) {
  if (
    signal !== undefined &&
    (!signal ||
      typeof signal !== "object" ||
      typeof signal.addEventListener !== "function" ||
      typeof signal.removeEventListener !== "function" ||
      typeof signal.aborted !== "boolean")
  ) {
    throw new TypeError("signal must be an AbortSignal");
  }
}

/** @param {AbortSignal | undefined} signal */
function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new AuthenticatedLifecycleError(
      "LIFECYCLE_ABORTED",
      "Authenticated lifecycle proof was aborted",
      { kind: "aborted" },
    );
  }
}

/** @param {unknown} value */
function isThenable(value) {
  return Boolean(
    value &&
      (typeof value === "object" || typeof value === "function") &&
      typeof Reflect.get(value, "then") === "function",
  );
}

/** @template T @param {T} value @returns {T} */
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

/**
 * @typedef {object} LifecycleClient
 * @property {string} state
 * @property {boolean} serverRequestsForbidden
 * @property {() => Promise<void>} start
 * @property {() => Promise<void>} stop
 * @property {(method: string, params: unknown, options?: {timeoutMs?: number, signal?: AbortSignal}) => Promise<unknown>} request
 * @property {(method: string, params: unknown) => Promise<void>} notify
 * @property {(event: string, listener: (...args: any[]) => void) => unknown} on
 * @property {(event: string, listener: (...args: any[]) => void) => unknown} off
 */

/** @param {unknown} value */
function assertClient(value) {
  if (!value || typeof value !== "object") throw new TypeError("client must be an object");
  for (const method of ["start", "stop", "request", "notify", "on", "off"]) {
    if (typeof Reflect.get(value, method) !== "function") {
      throw new TypeError(`client.${method} must be a function`);
    }
  }
  if (typeof Reflect.get(value, "state") !== "string") {
    throw new TypeError("client.state must be text");
  }
  if (Reflect.get(value, "serverRequestsForbidden") !== true) {
    throw new AuthenticatedLifecycleError(
      "SERVER_REQUEST_POLICY_UNSAFE",
      "Authenticated lifecycle requires an exact empty server-request allowlist",
      { kind: "policy" },
    );
  }
}

/** @param {unknown} value */
function isStoppableClientCandidate(value) {
  try {
    return Boolean(
      value &&
      typeof value === "object" &&
      typeof Reflect.get(value, "stop") === "function",
    );
  } catch {
    return false;
  }
}

/**
 * @typedef {Readonly<{
 *   input: readonly Readonly<{type: "text", text: string}>[],
 *   outputSchema: Readonly<Record<string, unknown>>,
 *   parseFinal: (text: string) => unknown,
 *   deadlineMs?: number,
 *   allowedMcpTools?: ReadonlySet<string>,
 *   requiredMcpTools?: ReadonlySet<string>,
 *   validateMcpCompletion?: (evidence: unknown) => boolean | void,
 * }>} TurnSpecification
 */

/**
 * @typedef {object} StructuredTurnInvocation
 * @property {LifecycleClient} client
 * @property {string} threadId
 * @property {readonly Readonly<{type: "text", text: string}>[]} input
 * @property {Readonly<Record<string, unknown>>} outputSchema
 * @property {(text: string) => unknown} parseFinal
 * @property {number} deadlineMs
 * @property {AbortSignal | undefined} signal
 * @property {ReadonlySet<string>} allowedMcpTools
 * @property {ReadonlySet<string>} requiredMcpTools
 * @property {(evidence: unknown) => boolean | void} [validateMcpCompletion]
 * @property {(notification: Readonly<{method: string, params: Readonly<Record<string, unknown>>}>) => boolean | void} [validateForeignTurnNotification]
 * @property {() => Promise<void>} [awaitAdditionalEvidence]
 */

/**
 * @typedef {Readonly<{
 *   threadId: string,
 *   turnId: string,
 *   status: "completed",
 *   finalMessageId: string,
 *   artifact: unknown,
 * }>} StructuredTurnResult
 */
