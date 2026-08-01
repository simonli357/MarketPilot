// @ts-check

import { createHash } from "node:crypto";

import {
  assertAllowedItem,
  assertOutboundMethod,
  classifyNotification,
  ProtocolPolicyError,
  rejectServerRequest,
} from "./protocol-policy.mjs";

const DEFAULT_DEADLINE_MS = 30_000;
const MAX_INPUT_TEXT_BYTES = 64 * 1024;
const MAX_NOTIFICATIONS_PER_TURN = 2_048;
const MAX_BUFFERED_NOTIFICATIONS = 128;
const MAX_BUFFERED_NOTIFICATION_BYTES = 1024 * 1024;
const MAX_COMPLETED_ITEMS = 256;
const MAX_DELEGATED_AGENTS = 2;
const ACTIVE_TURN_CLIENTS = new WeakSet();
const QUARANTINED_TURN_CLIENTS = new WeakSet();
const RETIRED_TURN_CLIENTS = new WeakSet();
const TERMINAL_TURN_STATUSES = new Set(["completed", "failed", "interrupted"]);
const COLLAB_TOOLS = new Set([
  "closeAgent",
  "resumeAgent",
  "sendInput",
  "spawnAgent",
  "wait",
]);
const COLLAB_STATUSES = new Set(["inProgress", "completed", "failed"]);
const COLLAB_AGENT_STATUSES = new Set([
  "completed",
  "errored",
  "interrupted",
  "notFound",
  "pendingInit",
  "running",
  "shutdown",
]);
const SUB_AGENT_ACTIVITY_KINDS = new Set(["interacted", "interrupted", "started"]);
const TURN_NOTIFICATION_METHODS = new Set([
  "item/completed",
  "item/started",
  "model/rerouted",
  "turn/completed",
  "turn/started",
]);

/**
 * A typed, content-free failure from the structured-turn boundary. Messages and
 * details deliberately exclude prompts and final assistant text.
 */
export class StructuredTurnError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{kind?: string, details?: Readonly<Record<string, unknown>>, cause?: unknown}} [options]
   */
  constructor(code, message, { kind = "turn", details = {}, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "StructuredTurnError";
    this.kind = kind;
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

/**
 * A quarantined client must be discarded rather than restarted or reused.
 * @param {object} client
 */
export function isStructuredTurnClientQuarantined(client) {
  return QUARANTINED_TURN_CLIENTS.has(client);
}

/**
 * Run one schema-constrained turn and return an artifact only after the stable
 * terminal lifecycle and local parser both agree. The caller owns process
 * startup, initialize/initialized, thread creation, and the parser for its
 * versioned artifact schema.
 *
 * @template Artifact
 * @param {object} options
 * @param {import("./app-server-client.mjs").AppServerClient} options.client
 * @param {string} options.threadId
 * @param {readonly {type: "text", text: string}[]} options.input
 * @param {Readonly<Record<string, unknown>>} options.outputSchema
 * @param {(text: string) => Artifact} options.parseFinal
 * @param {number} [options.deadlineMs]
 * @param {AbortSignal} [options.signal]
 * @param {ReadonlySet<string>} [options.allowedMcpTools] Entries use `server.tool`.
 * @param {ReadonlySet<string>} [options.requiredMcpTools] Exact required subset of allowed tools.
 * @param {(evidence: Readonly<{
 *   toolName: string,
 *   arguments: unknown,
 *   result: unknown,
 *   isError: boolean,
 *   item: Readonly<Record<string, unknown>>
 * }>) => boolean | void} [options.validateMcpCompletion] Synchronous, per-completed-call validator.
 * @param {(notification: Readonly<{method: string, params: Readonly<Record<string, unknown>>}>) => boolean | void} [options.validateForeignTurnNotification] Synchronous validator for multiplexed non-primary turn lifecycle.
 * @param {() => Promise<void>} [options.awaitAdditionalEvidence] Arms an
 * asynchronous acceptance gate before turn/start. The gate must settle before
 * the owned connection is stopped and shares this turn's absolute deadline.
 * @returns {Promise<Readonly<{
 *   threadId: string,
 *   turnId: string,
 *   status: "completed",
 *   finalMessageId: string,
 *   artifact: Artifact
 * }>>}
 */
export async function runStructuredTurn({
  client,
  threadId,
  input,
  outputSchema,
  parseFinal,
  deadlineMs = DEFAULT_DEADLINE_MS,
  signal,
  allowedMcpTools = new Set(),
  requiredMcpTools = new Set(),
  validateMcpCompletion,
  validateForeignTurnNotification,
  awaitAdditionalEvidence,
}) {
  assertClient(client);
  requireNonEmptyText(threadId, "threadId");
  assertInput(input);
  assertPlainRecord(outputSchema, "outputSchema");
  if (typeof parseFinal !== "function") {
    throw new TypeError("parseFinal must be a function");
  }
  assertPositiveInteger(deadlineMs, "deadlineMs");
  if (signal !== undefined && !isAbortSignal(signal)) {
    throw new TypeError("signal must be an AbortSignal");
  }
  if (validateMcpCompletion !== undefined && typeof validateMcpCompletion !== "function") {
    throw new TypeError("validateMcpCompletion must be a function");
  }
  if (
    validateForeignTurnNotification !== undefined &&
    typeof validateForeignTurnNotification !== "function"
  ) {
    throw new TypeError("validateForeignTurnNotification must be a function");
  }
  if (
    awaitAdditionalEvidence !== undefined &&
    typeof awaitAdditionalEvidence !== "function"
  ) {
    throw new TypeError("awaitAdditionalEvidence must be a function");
  }
  const allowedMcpToolSet = snapshotToolSet(allowedMcpTools, "allowedMcpTools");
  const requiredMcpToolSet = snapshotToolSet(requiredMcpTools, "requiredMcpTools");
  for (const tool of requiredMcpToolSet) {
    if (!allowedMcpToolSet.has(tool)) {
      throw new TypeError("requiredMcpTools must be a subset of allowedMcpTools");
    }
  }
  if (signal?.aborted) {
    throw new StructuredTurnError("TURN_ABORTED", "Structured turn was aborted before start", {
      kind: "aborted",
    });
  }
  if (client.serverRequestsForbidden !== true) {
    throw new StructuredTurnError(
      "SERVER_REQUEST_POLICY_UNSAFE",
      "Structured turns require an exact empty server-request allowlist",
      { kind: "policy" },
    );
  }
  if (QUARANTINED_TURN_CLIENTS.has(client)) {
    throw new StructuredTurnError(
      "CLIENT_QUARANTINED",
      "App-server client was quarantined after an uncertain turn",
      { kind: "state" },
    );
  }
  if (RETIRED_TURN_CLIENTS.has(client)) {
    throw new StructuredTurnError(
      "CLIENT_RETIRED",
      "App-server client was retired after an accepted structured turn",
      { kind: "state" },
    );
  }
  if (ACTIVE_TURN_CLIENTS.has(client)) {
    throw new StructuredTurnError(
      "TURN_ALREADY_ACTIVE",
      "Only one top-level structured turn may run on an app-server client",
      { kind: "state" },
    );
  }

  const params = Object.freeze({
    threadId,
    input: cloneJson(input, "input"),
    outputSchema: cloneJson(outputSchema, "outputSchema"),
  });
  assertExactKeys(params, ["input", "outputSchema", "threadId"], "turn/start params");
  assertOutboundMethod("turn/start");
  ACTIVE_TURN_CLIENTS.add(client);
  const deadlineAt = performance.now() + deadlineMs;

  /** @type {Promise<void> | null} */
  let additionalEvidencePromise = null;
  try {
    if (awaitAdditionalEvidence !== undefined) {
      let evidence;
      try {
        evidence = awaitAdditionalEvidence();
        if (!isThenable(evidence)) {
          throw new TypeError("awaitAdditionalEvidence must return a promise");
        }
        additionalEvidencePromise = Promise.resolve(evidence).then(
          () => undefined,
          () => {
            throw new StructuredTurnError(
              "ADDITIONAL_EVIDENCE_REJECTED",
              "Additional structured-turn acceptance evidence failed local validation",
              { kind: "protocol" },
            );
          },
        );
        void additionalEvidencePromise.catch(() => {});
      } catch {
        throw new StructuredTurnError(
          "ADDITIONAL_EVIDENCE_REJECTED",
          "Additional structured-turn acceptance evidence failed local validation",
          { kind: "protocol" },
        );
      }
    }
    assertBeforeDeadline(deadlineAt, deadlineMs);
    if (signal?.aborted) {
      throw new StructuredTurnError("TURN_ABORTED", "Structured turn was aborted before start", {
        kind: "aborted",
      });
    }
  } catch (error) {
    ACTIVE_TURN_CLIENTS.delete(client);
    throw error;
  }

  /** @type {string | null} */
  let turnId = null;
  /** @type {Readonly<Record<string, unknown>> | null} */
  let terminalTurn = null;
  /** @type {Readonly<Record<string, unknown>>[]} */
  const bufferedTurnNotifications = [];
  /** @type {Set<string>} */
  const startedItemIds = new Set();
  /** @type {Map<string, string>} */
  const activeStartedItems = new Map();
  /** @type {Set<string>} */
  const completedItemIds = new Set();
  /** @type {{id: string, text: string, phase: "commentary" | "final_answer" | "unknown"}[]} */
  const completedAgentMessages = [];
  const successfulRequiredMcpTools = new Set();
  const failedRequiredMcpTools = new Set();
  const delegatedAgentIds = new Set();
  const v2StartedAgentIds = new Set();
  let notificationCount = 0;
  let bufferedNotificationBytes = 0;
  /** @type {"awaitingTurnStarted" | "active" | "terminal"} */
  let lifecycleState = "awaitingTurnStarted";
  let terminalObserved = false;
  let gateSettled = false;
  /** @type {StructuredTurnError | null} */
  let lateFailure = null;
  /** @type {NodeJS.Timeout | null} */
  let deadlineTimer = null;
  /** @type {NodeJS.Immediate | null} */
  let terminalSettle = null;
  const requestAbort = new AbortController();

  /** @type {(value: Readonly<Record<string, unknown>>) => void} */
  let resolveTerminal;
  /** @type {(reason?: unknown) => void} */
  let rejectTerminal;
  const terminalPromise = new Promise((resolve, reject) => {
    resolveTerminal = resolve;
    rejectTerminal = reject;
  });
  // A protocol incident can arrive in the same stdout batch as the start
  // response. Mark the promise handled immediately while request validation is
  // still awaiting its own result.
  void terminalPromise.catch(() => {});
  const failureOnly = terminalPromise.then(() => new Promise(() => {}));
  void failureOnly.catch(() => {});
  /** @type {(reason?: unknown) => void} */
  let rejectLateFailure;
  const lateFailurePromise = new Promise((_, reject) => {
    rejectLateFailure = reject;
  });
  void lateFailurePromise.catch(() => {});
  let lateFailureSignaled = false;

  /** @param {unknown} error */
  const fail = (error) => {
    const failure = normalizeFailure(error);
    if (gateSettled) {
      lateFailure ??= failure;
      if (!lateFailureSignaled) {
        lateFailureSignaled = true;
        rejectLateFailure(failure);
      }
      return;
    }
    gateSettled = true;
    clearTerminalSettle();
    rejectTerminal(failure);
    requestAbort.abort(failure);
  };

  if (additionalEvidencePromise !== null) {
    // Arm the observer before turn/start and route early rejection through the
    // same fail-closed channel as transport and lifecycle incidents.
    void additionalEvidencePromise.catch(fail);
  }

  /** @param {Readonly<Record<string, unknown>>} turn */
  const observeTerminal = (turn) => {
    if (terminalObserved) {
      fail(new StructuredTurnError(
        "DUPLICATE_TERMINAL",
        "App-server emitted more than one terminal turn notification",
        { kind: "protocol" },
      ));
      return;
    }
    terminalObserved = true;
    terminalTurn = turn;
    // Delay acceptance by one event-loop phase so a duplicate response or
    // protocol violation later in the same stdout batch wins fail-closed.
    terminalSettle = setImmediate(() => {
      terminalSettle = null;
      if (gateSettled || terminalTurn === null) return;
      if (performance.now() >= deadlineAt) {
        fail(new StructuredTurnError(
          "TURN_TIMEOUT",
          `Structured turn exceeded its ${deadlineMs} ms deadline`,
          { kind: "timeout", details: { deadlineMs } },
        ));
        return;
      }
      gateSettled = true;
      resolveTerminal(terminalTurn);
    });
  };

  /** @param {{method: string, params?: unknown}} notification */
  const onNotification = (notification) => {
    try {
      notificationCount += 1;
      if (notificationCount > MAX_NOTIFICATIONS_PER_TURN) {
        throw new StructuredTurnError(
          "NOTIFICATION_LIMIT_EXCEEDED",
          "App-server exceeded the structured-turn notification limit",
          { kind: "protocol", details: { maxNotifications: MAX_NOTIFICATIONS_PER_TURN } },
        );
      }
      const disposition = classifyNotification(notification.method);
      if (disposition === "fail-closed") {
        const code = notification.method === "model/rerouted"
          ? "MODEL_REROUTED"
          : "RUNTIME_INVENTORY_CHANGED";
        throw new StructuredTurnError(
          code,
          `App-server emitted fail-closed notification ${notification.method}`,
          { kind: "policy" },
        );
      }
      if (!TURN_NOTIFICATION_METHODS.has(notification.method)) return;
      const paramsRecord = requireRecord(notification.params, `${notification.method} params`);
      if (paramsRecord.threadId !== threadId) {
        if (validateForeignTurnNotification === undefined) {
          throw new StructuredTurnError(
            "THREAD_ID_MISMATCH",
            "Turn notification did not match the primary structured thread",
            { kind: "protocol" },
          );
        }
        applyForeignTurnNotificationValidator(
          notification.method,
          paramsRecord,
          validateForeignTurnNotification,
        );
        return;
      }
      if (turnId === null) {
        // Responses and notifications share one JSONL stream, but the server
        // may emit an ordered turn/started -> item -> terminal sequence before
        // the turn/start response resolves locally. Buffer only these bounded
        // turn lifecycle methods until the response supplies the authoritative
        // turn ID, then replay them in original wire order through the strict
        // lifecycle state machine below.
        if (bufferedTurnNotifications.length >= MAX_BUFFERED_NOTIFICATIONS) {
          throw new StructuredTurnError(
            "PRESTART_BUFFER_LIMIT_EXCEEDED",
            "App-server exceeded the pre-start notification buffer limit",
            { kind: "protocol", details: { maxNotifications: MAX_BUFFERED_NOTIFICATIONS } },
          );
        }
        bufferedNotificationBytes += Buffer.byteLength(
          JSON.stringify({ method: notification.method, params: paramsRecord }),
          "utf8",
        );
        if (bufferedNotificationBytes > MAX_BUFFERED_NOTIFICATION_BYTES) {
          throw new StructuredTurnError(
            "PRESTART_BUFFER_LIMIT_EXCEEDED",
            "App-server exceeded the pre-start notification byte budget",
            { kind: "protocol", details: { maxBytes: MAX_BUFFERED_NOTIFICATION_BYTES } },
          );
        }
        bufferedTurnNotifications.push(Object.freeze({
          method: notification.method,
          params: paramsRecord,
        }));
        return;
      }
      consumeTurnNotification(notification.method, paramsRecord);
    } catch (error) {
      fail(error);
    }
  };

  /**
   * @param {string} method
   * @param {Readonly<Record<string, unknown>>} paramsRecord
   */
  const consumeTurnNotification = (method, paramsRecord) => {
    assertTurnIdentity(paramsRecord, threadId, /** @type {string} */ (turnId), method);
    if (method === "turn/started") {
      if (lifecycleState !== "awaitingTurnStarted") {
        throw new StructuredTurnError(
          lifecycleState === "active" ? "DUPLICATE_TURN_STARTED" : "EVENT_AFTER_TERMINAL",
          lifecycleState === "active"
            ? "App-server emitted duplicate turn/started notifications"
            : "App-server emitted turn/started after terminal completion",
          { kind: "protocol" },
        );
      }
      const turn = requireRecord(paramsRecord.turn, "turn/started turn");
      assertTurnId(turn, /** @type {string} */ (turnId), "turn/started");
      if (turn.status !== "inProgress") {
        throw new StructuredTurnError(
          "START_STATUS_INVALID",
          "turn/started did not report inProgress",
          { kind: "protocol", details: { statusClass: classifyTurnStatus(turn.status) } },
        );
      }
      lifecycleState = "active";
      return;
    }
    if (method === "item/started" || method === "item/completed") {
      if (lifecycleState !== "active") {
        throw new StructuredTurnError(
          lifecycleState === "awaitingTurnStarted"
            ? "ITEM_BEFORE_TURN_STARTED"
            : "EVENT_AFTER_TERMINAL",
          lifecycleState === "awaitingTurnStarted"
            ? "App-server emitted an item before turn/started"
            : "App-server emitted an item after terminal completion",
          { kind: "protocol" },
        );
      }
      const item = requireRecord(paramsRecord.item, `${method} item`);
      const itemId = requireNonEmptyText(item.id, `${method} item id`);
      if (method === "item/started" && startedItemIds.has(itemId)) {
        throw new StructuredTurnError(
          "DUPLICATE_ITEM_STARTED",
          "App-server started the same item more than once",
          { kind: "protocol", details: { itemIdSha256: sha256Text(itemId) } },
        );
      }
      validateItem(item, allowedMcpToolSet, {
        primaryThreadId: threadId,
        delegatedAgentIds,
        v2StartedAgentIds,
        completed: method === "item/completed",
      });
      if (method === "item/started") {
        startedItemIds.add(itemId);
        if (startedItemIds.size > MAX_COMPLETED_ITEMS) {
          throw new StructuredTurnError(
            "ITEM_LIMIT_EXCEEDED",
            "App-server exceeded the structured-turn item limit",
            { kind: "protocol", details: { maxItems: MAX_COMPLETED_ITEMS } },
          );
        }
        activeStartedItems.set(itemId, itemLifecycleSignature(item));
        return;
      }
      if (method === "item/completed") {
        if (completedItemIds.has(itemId)) {
          throw new StructuredTurnError(
            "DUPLICATE_ITEM",
            "App-server completed the same item more than once",
            { kind: "protocol", details: { itemIdSha256: sha256Text(itemId) } },
          );
        }
        const startedSignature = activeStartedItems.get(itemId);
        // Pinned MultiAgent V2 emits subAgentActivity through the atomic
        // completion-only helper. Every other stable item follows the
        // documented started -> completed lifecycle.
        const atomicSubAgentActivity =
          startedSignature === undefined && item.type === "subAgentActivity";
        if (startedSignature === undefined && !atomicSubAgentActivity) {
          throw new StructuredTurnError(
            "ITEM_STARTED_MISSING",
            "App-server completed an item without its matching item/started notification",
            { kind: "protocol", details: { itemIdSha256: sha256Text(itemId) } },
          );
        }
        if (
          startedSignature !== undefined &&
          startedSignature !== itemLifecycleSignature(item)
        ) {
          throw new StructuredTurnError(
            "ITEM_LIFECYCLE_MISMATCH",
            "App-server changed an item's stable identity between start and completion",
            { kind: "protocol", details: { itemIdSha256: sha256Text(itemId) } },
          );
        }
        if (!atomicSubAgentActivity) activeStartedItems.delete(itemId);
        completedItemIds.add(itemId);
        if (completedItemIds.size > MAX_COMPLETED_ITEMS) {
          throw new StructuredTurnError(
            "ITEM_LIMIT_EXCEEDED",
            "App-server exceeded the structured-turn item limit",
            { kind: "protocol", details: { maxItems: MAX_COMPLETED_ITEMS } },
          );
        }
        if (item.type === "mcpToolCall") {
          const evidence = inspectMcpCompletion(item);
          applyMcpCompletionValidator(evidence, validateMcpCompletion);
          recordRequiredMcpCompletion(
            evidence,
            requiredMcpToolSet,
            successfulRequiredMcpTools,
            failedRequiredMcpTools,
          );
        } else if (item.type === "agentMessage") {
          completedAgentMessages.push({
            id: itemId,
            text: requireNonEmptyText(item.text, "completed agent message text"),
            phase: requireAgentMessagePhase(item.phase),
          });
        }
      }
      return;
    }
    if (method === "model/rerouted") {
      throw new StructuredTurnError(
        "MODEL_REROUTED",
        "App-server rerouted the required model",
        { kind: "policy" },
      );
    }
    if (method === "turn/completed") {
      if (lifecycleState === "awaitingTurnStarted") {
        throw new StructuredTurnError(
          "TERMINAL_BEFORE_TURN_STARTED",
          "App-server emitted terminal completion before turn/started",
          { kind: "protocol" },
        );
      }
      if (lifecycleState === "terminal") {
        throw new StructuredTurnError(
          "DUPLICATE_TERMINAL",
          "App-server emitted more than one terminal turn notification",
          { kind: "protocol" },
        );
      }
      const turn = requireRecord(paramsRecord.turn, "turn/completed turn");
      assertTurnId(turn, /** @type {string} */ (turnId), "turn/completed");
      if (activeStartedItems.size !== 0) {
        throw new StructuredTurnError(
          "ITEM_COMPLETED_MISSING",
          "App-server ended a turn with unfinished item lifecycles",
          { kind: "protocol", details: { unfinishedItemCount: activeStartedItems.size } },
        );
      }
      lifecycleState = "terminal";
      observeTerminal(turn);
    }
  };

  const onServerRequest = (request) => {
    try {
      rejectServerRequest(request?.method);
    } catch (cause) {
      fail(new StructuredTurnError(
        "SERVER_REQUEST_FORBIDDEN",
        "App-server attempted a forbidden server-initiated request",
        { kind: "policy", cause },
      ));
    }
  };
  const onIncident = (error) => fail(error);
  const onExit = (event) => {
    if (event?.error || !event?.expected) {
      fail(event?.error ?? new StructuredTurnError(
        "APP_SERVER_EXIT",
        "App-server exited before structured turn acceptance",
        { kind: "process" },
      ));
    }
  };
  const onAbort = () => fail(new StructuredTurnError(
    "TURN_ABORTED",
    "Structured turn was aborted",
    { kind: "aborted" },
  ));

  try {
    client.on("notification", onNotification);
    client.on("serverRequest", onServerRequest);
    client.on("incident", onIncident);
    client.on("exit", onExit);
    signal?.addEventListener("abort", onAbort, { once: true });
    deadlineTimer = setTimeout(() => fail(new StructuredTurnError(
      "TURN_TIMEOUT",
      `Structured turn exceeded its ${deadlineMs} ms deadline`,
      { kind: "timeout", details: { deadlineMs } },
    )), Math.max(1, Math.ceil(deadlineAt - performance.now())));
    deadlineTimer.unref?.();

    const startResult = await Promise.race([
      client.request("turn/start", params, {
        timeoutMs: deadlineMs,
        signal: requestAbort.signal,
      }),
      failureOnly,
    ]);
    const startRecord = requireRecord(startResult, "turn/start response");
    const startedTurn = requireRecord(startRecord.turn, "turn/start response turn");
    turnId = requireNonEmptyText(startedTurn.id, "turn/start response turn id");
    if (startedTurn.status !== "inProgress") {
      throw new StructuredTurnError(
        "START_STATUS_INVALID",
        "turn/start response did not report inProgress",
        { kind: "protocol", details: { statusClass: classifyTurnStatus(startedTurn.status) } },
      );
    }

    for (const buffered of bufferedTurnNotifications) {
      consumeTurnNotification(
        /** @type {string} */ (buffered.method),
        /** @type {Readonly<Record<string, unknown>>} */ (buffered.params),
      );
    }
    bufferedTurnNotifications.length = 0;

    const completedTurn = await terminalPromise;
    assertBeforeDeadline(deadlineAt, deadlineMs);
    validateTerminalStatus(completedTurn);
    if (lifecycleState === "awaitingTurnStarted") {
      throw new StructuredTurnError(
        "TURN_STARTED_MISSING",
        "Terminal turn arrived without a matching turn/started notification",
        { kind: "protocol" },
      );
    }

    const final = extractUnambiguousFinal(
      completedTurn,
      completedAgentMessages,
    );
    assertRequiredMcpToolsCompleted(
      requiredMcpToolSet,
      successfulRequiredMcpTools,
      failedRequiredMcpTools,
    );
    assertBeforeDeadline(deadlineAt, deadlineMs);
    let artifact;
    try {
      artifact = parseFinal(final.text);
      if (isThenable(artifact)) {
        void Promise.resolve(artifact).catch(() => {});
        throw new TypeError("parseFinal must return synchronously");
      }
    } catch {
      throw new StructuredTurnError(
        "OUTPUT_INVALID",
        "Final agent message failed independent artifact validation",
        { kind: "schema" },
      );
    }
    assertBeforeDeadline(deadlineAt, deadlineMs);
    if (artifact === undefined) {
      throw new StructuredTurnError(
        "OUTPUT_INVALID",
        "Artifact parser returned undefined",
        { kind: "schema" },
      );
    }

    if (additionalEvidencePromise !== null) {
      await Promise.race([additionalEvidencePromise, lateFailurePromise]);
      assertBeforeDeadline(deadlineAt, deadlineMs);
      if (lateFailure !== null) throw lateFailure;
    }

    // Acceptance owns one physical connection. Keep every protocol listener
    // installed until the child has exited so no arbitrarily delayed record can
    // arrive after the artifact is handed to the caller.
    RETIRED_TURN_CLIENTS.add(client);
    await client.stop();
    assertBeforeDeadline(deadlineAt, deadlineMs);
    if (lateFailure !== null) throw lateFailure;
    if (client.state !== "stopped") {
      throw new StructuredTurnError(
        "ACCEPTANCE_STOP_FAILED",
        "App-server did not stop cleanly before structured-turn acceptance",
        { kind: "recovery" },
      );
    }

    return Object.freeze({
      threadId,
      turnId,
      status: "completed",
      finalMessageId: final.id,
      artifact,
    });
  } catch (error) {
    const failure = normalizeFailure(error);
    if (!terminalObserved && turnId !== null && client.state === "running") {
      await bestEffortInterrupt(client, threadId, turnId, deadlineMs);
    }
    if (requiresClientQuarantine(failure)) {
      QUARANTINED_TURN_CLIENTS.add(client);
      try {
        await client.stop();
      } catch (cause) {
        throw new StructuredTurnError(
          "RECOVERY_STOP_FAILED",
          "App-server client could not be stopped after an uncertain turn",
          {
            kind: "recovery",
            details: { originalCodeSha256: sha256Text(failure.code) },
            cause,
          },
        );
      }
    }
    throw failure;
  } finally {
    if (deadlineTimer !== null) clearTimeout(deadlineTimer);
    clearTerminalSettle();
    signal?.removeEventListener("abort", onAbort);
    client.off("notification", onNotification);
    client.off("serverRequest", onServerRequest);
    client.off("incident", onIncident);
    client.off("exit", onExit);
    ACTIVE_TURN_CLIENTS.delete(client);
  }

  function clearTerminalSettle() {
    if (terminalSettle !== null) {
      clearImmediate(terminalSettle);
      terminalSettle = null;
    }
  }
}

/**
 * @param {import("./app-server-client.mjs").AppServerClient} client
 * @param {string} threadId
 * @param {string} turnId
 * @param {number} deadlineMs
 */
async function bestEffortInterrupt(client, threadId, turnId, deadlineMs) {
  try {
    assertOutboundMethod("turn/interrupt");
    await client.request("turn/interrupt", { threadId, turnId }, {
      timeoutMs: Math.max(50, Math.min(1_000, deadlineMs)),
    });
  } catch {
    // The original typed failure remains authoritative. The caller quarantines
    // and stops this client immediately after this best-effort request.
  }
}

/** @param {Readonly<Record<string, unknown>>} turn */
function validateTerminalStatus(turn) {
  if (turn.status === "completed") return;
  if (turn.status === "failed") {
    const error = turn.error && typeof turn.error === "object" && !Array.isArray(turn.error)
      ? /** @type {Readonly<Record<string, unknown>>} */ (turn.error)
      : {};
    const info = typeof error.codexErrorInfo === "string" ? error.codexErrorInfo : "unknown";
    const code = info === "unauthorized"
      ? "AUTH_REQUIRED"
      : info === "usageLimitExceeded"
        ? "RATE_LIMITED"
        : "TURN_FAILED";
    throw new StructuredTurnError(code, "App-server reported a failed terminal turn", {
      kind: code === "TURN_FAILED" ? "turn" : "service",
      details: { codexErrorClass: classifyCodexErrorInfo(info) },
    });
  }
  if (turn.status === "interrupted") {
    throw new StructuredTurnError(
      "TURN_INTERRUPTED",
      "App-server reported an interrupted terminal turn",
      { kind: "aborted" },
    );
  }
  throw new StructuredTurnError(
    "TERMINAL_STATUS_INVALID",
    "turn/completed contained an unsupported terminal status",
    { kind: "protocol", details: { statusClass: classifyTurnStatus(turn.status) } },
  );
}

/**
 * @param {Readonly<Record<string, unknown>>} turn
 * @param {readonly {id: string, text: string, phase: "commentary" | "final_answer" | "unknown"}[]} completedAgentMessages
 */
function extractUnambiguousFinal(
  turn,
  completedAgentMessages,
) {
  if (!Array.isArray(turn.items)) {
    throw new StructuredTurnError(
      "TERMINAL_ITEMS_INVALID",
      "Terminal turn did not contain an item array",
      { kind: "protocol" },
    );
  }
  if (turn.items.length !== 0) {
    throw new StructuredTurnError(
      "TERMINAL_ITEMS_NOT_EMPTY",
      "Pinned app-server terminal turns must use the documented empty item snapshot",
      { kind: "protocol", details: { terminalItemCount: turn.items.length } },
    );
  }
  const finalMessages = completedAgentMessages.filter(({ phase }) => phase === "final_answer");
  if (finalMessages.length !== 1) {
    throw new StructuredTurnError(
      "OUTPUT_AMBIGUOUS",
      "The canonical completed-item stream must contain exactly one final-answer message",
      {
        kind: "schema",
        details: {
          agentMessageCount: completedAgentMessages.length,
          commentaryCount: completedAgentMessages.filter(({ phase }) => phase === "commentary").length,
          finalAnswerCount: finalMessages.length,
          unknownPhaseCount: completedAgentMessages.filter(({ phase }) => phase === "unknown").length,
        },
      },
    );
  }
  return finalMessages[0];
}

/** @param {unknown} value @returns {"commentary" | "final_answer" | "unknown"} */
function requireAgentMessagePhase(value) {
  if (value === "commentary" || value === "final_answer") return value;
  // The pinned stable schema permits null for legacy/provider output. Codex's
  // own history materializer treats it as non-final, so it can never satisfy
  // the one explicit final-answer requirement here.
  if (value === null || value === undefined) return "unknown";
  throw new StructuredTurnError(
    "AGENT_MESSAGE_PHASE_INVALID",
    "Completed agent messages contain an unsupported phase value",
    { kind: "protocol", details: { phaseSha256: hashUnknownText(value) } },
  );
}

/** @param {string} value */
function sha256Text(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * @param {Readonly<Record<string, unknown>>} item
 * @param {ReadonlySet<string>} allowedMcpTools
 * @param {{
 *   primaryThreadId: string,
 *   delegatedAgentIds: Set<string>,
 *   v2StartedAgentIds: Set<string>,
 *   completed: boolean,
 *   terminalReplay?: boolean
 * }} context
 */
function validateItem(item, allowedMcpTools, context) {
  try {
    assertAllowedItem(item);
  } catch (cause) {
    throw new StructuredTurnError(
      "ITEM_FORBIDDEN",
      "App-server emitted a forbidden or malformed item type",
      { kind: "policy", cause },
    );
  }
  if (item.type === "mcpToolCall") {
    const server = requireNonEmptyText(item.server, "MCP server name");
    const tool = requireNonEmptyText(item.tool, "MCP tool name");
    if (!allowedMcpTools.has(`${server}.${tool}`)) {
      throw new StructuredTurnError(
        "MCP_TOOL_FORBIDDEN",
        "App-server emitted an MCP tool outside the exact turn allowlist",
        { kind: "policy", details: { toolSha256: sha256Text(`${server}\0${tool}`) } },
      );
    }
    if (!context.completed && item.status !== "inProgress") {
      throw new StructuredTurnError(
        "MCP_START_STATUS_INVALID",
        "Started MCP items must report in-progress status",
        { kind: "protocol", details: { toolSha256: sha256Text(`${server}\0${tool}`) } },
      );
    }
    return;
  }
  if (item.type === "collabAgentToolCall") {
    validateCollabAgentItem(item, context);
    return;
  }
  if (item.type === "subAgentActivity") {
    validateSubAgentActivity(item, context);
  }
}

/**
 * Capture only stable, non-content identity fields that must not change across
 * the documented item/started -> item/completed lifecycle. Mutable status,
 * output, agent-state, and message fields are deliberately excluded.
 *
 * @param {Readonly<Record<string, unknown>>} item
 */
function itemLifecycleSignature(item) {
  if (item.type === "mcpToolCall") {
    const identity = {
      type: item.type,
      server: item.server,
      tool: item.tool,
      arguments: item.arguments,
    };
    // These invocation-context fields are copied unchanged from the same
    // pinned core event into both lifecycle projections. Preserve field
    // presence as well as value so an omitted field cannot be swapped for an
    // explicit null between item/started and item/completed.
    for (const field of ["appContext", "mcpAppResourceUri", "pluginId"]) {
      if (Object.hasOwn(item, field)) Reflect.set(identity, field, Reflect.get(item, field));
    }
    return canonicalJson(identity, "MCP lifecycle identity");
  }
  if (item.type === "collabAgentToolCall") {
    const identity = {
      type: item.type,
      tool: item.tool,
      senderThreadId: item.senderThreadId,
    };
    if (Object.hasOwn(item, "prompt")) identity.prompt = item.prompt;
    return canonicalJson(identity, "collaboration lifecycle identity");
  }
  if (item.type === "subAgentActivity") {
    return JSON.stringify([
      item.type,
      item.agentThreadId,
      item.agentPath,
      item.kind,
    ]);
  }
  return JSON.stringify([item.type]);
}

/**
 * @param {Readonly<Record<string, unknown>>} item
 * @returns {Readonly<{
 *   toolName: string,
 *   arguments: unknown,
 *   result: unknown,
 *   isError: boolean,
 *   item: Readonly<Record<string, unknown>>
 * }>}
 */
function inspectMcpCompletion(item) {
  const server = requireNonEmptyText(item.server, "MCP server name");
  const tool = requireNonEmptyText(item.tool, "MCP tool name");
  if (item.status !== "completed" && item.status !== "failed") {
    throw new StructuredTurnError(
      "MCP_COMPLETION_STATUS_INVALID",
      "Completed MCP item contained a non-terminal status",
      {
        kind: "protocol",
        details: {
          toolSha256: sha256Text(`${server}\0${tool}`),
          statusSha256: hashUnknownText(item.status),
        },
      },
    );
  }
  if (!Object.hasOwn(item, "arguments")) {
    throw new StructuredTurnError(
      "MCP_COMPLETION_ARGUMENTS_INVALID",
      "Completed MCP item omitted its arguments",
      { kind: "protocol", details: { toolSha256: sha256Text(`${server}\0${tool}`) } },
    );
  }

  let result = null;
  if (item.result !== null && item.result !== undefined) {
    const resultRecord = requireRecord(item.result, "MCP completion result");
    if (!Array.isArray(resultRecord.content)) {
      throw new StructuredTurnError(
        "MCP_COMPLETION_RESULT_INVALID",
        "Completed MCP item result omitted its content array",
        { kind: "protocol", details: { toolSha256: sha256Text(`${server}\0${tool}`) } },
      );
    }
    result = snapshotJson(resultRecord, "MCP completion result");
  } else if (item.status === "completed") {
    throw new StructuredTurnError(
      "MCP_COMPLETION_RESULT_INVALID",
      "Successful MCP item omitted its result",
      { kind: "protocol", details: { toolSha256: sha256Text(`${server}\0${tool}`) } },
    );
  }

  const evidence = {
    toolName: `${server}.${tool}`,
    arguments: snapshotJson(item.arguments, "MCP completion arguments"),
    result,
    isError: deriveMcpIsError(item),
    item: snapshotJson(item, "MCP completion item"),
  };
  return deepFreeze(evidence);
}

/**
 * @param {ReturnType<typeof inspectMcpCompletion>} evidence
 * @param {((evidence: ReturnType<typeof inspectMcpCompletion>) => boolean | void) | undefined} validator
 */
function applyMcpCompletionValidator(evidence, validator) {
  if (validator === undefined) return;
  let accepted;
  try {
    accepted = validator(evidence);
  } catch {
    throw new StructuredTurnError(
      "MCP_COMPLETION_REJECTED",
      "MCP completion failed its caller-supplied evidence validator",
      { kind: "tool" },
    );
  }
  if (isThenable(accepted)) {
    void Promise.resolve(accepted).catch(() => {});
    throw new StructuredTurnError(
      "MCP_COMPLETION_VALIDATOR_ASYNC",
      "MCP completion validators must return synchronously",
      { kind: "policy" },
    );
  }
  if (accepted !== undefined && accepted !== true) {
    throw new StructuredTurnError(
      "MCP_COMPLETION_REJECTED",
      "MCP completion failed its caller-supplied evidence validator",
      { kind: "tool" },
    );
  }
}

/**
 * @param {string} method
 * @param {Readonly<Record<string, unknown>>} params
 * @param {(notification: Readonly<{method: string, params: Readonly<Record<string, unknown>>}>) => boolean | void} validator
 */
function applyForeignTurnNotificationValidator(method, params, validator) {
  const evidence = Object.freeze({
    method,
    params: snapshotJson(params, "foreign turn notification params"),
  });
  let accepted;
  try {
    accepted = validator(evidence);
  } catch {
    throw new StructuredTurnError(
      "FOREIGN_NOTIFICATION_REJECTED",
      "Multiplexed non-primary turn notification failed local validation",
      { kind: "protocol" },
    );
  }
  if (isThenable(accepted)) {
    void Promise.resolve(accepted).catch(() => {});
    throw new StructuredTurnError(
      "FOREIGN_NOTIFICATION_VALIDATOR_ASYNC",
      "Foreign turn notification validators must return synchronously",
      { kind: "policy" },
    );
  }
  if (accepted !== undefined && accepted !== true) {
    throw new StructuredTurnError(
      "FOREIGN_NOTIFICATION_REJECTED",
      "Multiplexed non-primary turn notification failed local validation",
      { kind: "protocol" },
    );
  }
}

/** @param {Readonly<Record<string, unknown>>} item */
function deriveMcpIsError(item) {
  const result = item.result;
  if (result !== null && typeof result === "object" && !Array.isArray(result)) {
    const explicit = Reflect.get(result, "isError");
    if (explicit !== undefined && explicit !== null) {
      if (typeof explicit !== "boolean") {
        throw new StructuredTurnError(
          "MCP_COMPLETION_IS_ERROR_INVALID",
          "MCP completion isError must be boolean when present",
          { kind: "protocol" },
        );
      }
      return explicit;
    }
  }
  return item.status === "failed";
}

/**
 * @param {Readonly<Record<string, unknown>>} item
 * @param {{
 *   primaryThreadId: string,
 *   delegatedAgentIds: Set<string>,
 *   completed: boolean,
 *   terminalReplay?: boolean
 * }} context
 */
function validateCollabAgentItem(item, context) {
  requireNonEmptyText(item.id, "collaboration item id");
  const tool = requireAllowedText(item.tool, COLLAB_TOOLS, "collaboration tool");
  const status = requireAllowedText(item.status, COLLAB_STATUSES, "collaboration status");
  if (context.completed && status === "inProgress") {
    throw new StructuredTurnError(
      "COLLAB_COMPLETION_STATUS_INVALID",
      "Completed collaboration item retained an in-progress status",
      { kind: "protocol" },
    );
  }
  if (!context.completed && status !== "inProgress") {
    throw new StructuredTurnError(
      "COLLAB_START_STATUS_INVALID",
      "Started collaboration items must report in-progress status",
      { kind: "protocol" },
    );
  }
  const senderThreadId = requireNonEmptyText(item.senderThreadId, "collaboration sender thread id");
  if (senderThreadId !== context.primaryThreadId) {
    throw new StructuredTurnError(
      "COLLAB_SENDER_FORBIDDEN",
      "Collaboration item sender did not match the primary turn thread",
      { kind: "policy", details: { senderSha256: sha256Text(senderThreadId) } },
    );
  }
  if (tool === "spawnAgent") {
    if (context.completed) {
      if (status !== "completed") {
        throw new StructuredTurnError(
          "COLLAB_SPAWN_NOT_COMPLETED",
          "Delegated collaboration spawn did not complete successfully",
          { kind: "policy" },
        );
      }
      // Pinned V1 start items carry requested values, including empty/default
      // inheritance markers. Only the completion carries the effective child
      // snapshot and is therefore eligible to prove exact Sol Ultra policy.
      if (item.model !== "gpt-5.6-sol") {
        throw new StructuredTurnError(
          "COLLAB_MODEL_FORBIDDEN",
          "Completed delegation did not prove the qualified model",
          { kind: "policy", details: { modelSha256: hashUnknownText(item.model) } },
        );
      }
      if (item.reasoningEffort !== "ultra") {
        throw new StructuredTurnError(
          "COLLAB_REASONING_FORBIDDEN",
          "Completed delegation did not prove qualified reasoning effort",
          { kind: "policy", details: { effortSha256: hashUnknownText(item.reasoningEffort) } },
        );
      }
    } else if (
      (item.model !== undefined && item.model !== null && typeof item.model !== "string") ||
      (item.reasoningEffort !== undefined &&
        item.reasoningEffort !== null &&
        typeof item.reasoningEffort !== "string")
    ) {
      throw new StructuredTurnError(
        "COLLAB_REQUEST_POLICY_INVALID",
        "Started delegation contained malformed requested policy fields",
        { kind: "protocol" },
      );
    }
  }
  if (!Array.isArray(item.receiverThreadIds)) {
    throw new StructuredTurnError(
      "COLLAB_RECEIVERS_INVALID",
      "Collaboration item receiverThreadIds must be an array",
      { kind: "protocol" },
    );
  }
  const receivers = item.receiverThreadIds.map((receiver) =>
    requireNonEmptyText(receiver, "collaboration receiver thread id"),
  );
  if (new Set(receivers).size !== receivers.length) {
    throw new StructuredTurnError(
      "COLLAB_RECEIVERS_INVALID",
      "Collaboration item repeated a receiver thread",
      { kind: "protocol" },
    );
  }

  if (tool === "spawnAgent" && context.terminalReplay !== true) {
    const expectedReceiverCount = context.completed ? 1 : 0;
    if (receivers.length !== expectedReceiverCount) {
      throw new StructuredTurnError(
        "COLLAB_SPAWN_RECEIVERS_INVALID",
        "Delegation spawn did not preserve the pinned receiver lifecycle",
        { kind: "protocol", details: { expectedReceiverCount } },
      );
    }
    if (context.completed) context.delegatedAgentIds.add(receivers[0]);
    if (context.delegatedAgentIds.size > MAX_DELEGATED_AGENTS) {
      throw new StructuredTurnError(
        "DELEGATION_LIMIT_EXCEEDED",
        "Structured turn exceeded the delegated-agent limit",
        { kind: "policy", details: { maxDelegatedAgents: MAX_DELEGATED_AGENTS } },
      );
    }
  } else {
    assertKnownDelegatedReceivers(receivers, context.delegatedAgentIds);
  }

  const agentsStates = requireRecord(item.agentsStates, "collaboration agentsStates");
  if (tool === "spawnAgent" && context.terminalReplay !== true) {
    const stateReceivers = Object.keys(agentsStates);
    if (
      (!context.completed && stateReceivers.length !== 0) ||
      (context.completed &&
        (stateReceivers.length !== 1 || stateReceivers[0] !== receivers[0]))
    ) {
      throw new StructuredTurnError(
        "COLLAB_SPAWN_STATES_INVALID",
        "Delegation spawn did not preserve the pinned agent-state lifecycle",
        { kind: "protocol" },
      );
    }
  }
  for (const [receiver, rawState] of Object.entries(agentsStates)) {
    if (!context.delegatedAgentIds.has(receiver)) {
      throw new StructuredTurnError(
        "COLLAB_RECEIVER_UNKNOWN",
        "Collaboration state referenced an unqualified receiver thread",
        { kind: "policy", details: { receiverSha256: sha256Text(receiver) } },
      );
    }
    const state = requireRecord(rawState, "collaboration agent state");
    requireAllowedText(state.status, COLLAB_AGENT_STATUSES, "collaboration agent status");
    if (state.message !== undefined && state.message !== null && typeof state.message !== "string") {
      throw new StructuredTurnError(
        "COLLAB_AGENT_STATE_INVALID",
        "Collaboration agent-state message must be text or null",
        { kind: "protocol" },
      );
    }
  }
}

/** @param {readonly string[]} receivers @param {ReadonlySet<string>} delegatedAgentIds */
function assertKnownDelegatedReceivers(receivers, delegatedAgentIds) {
  for (const receiver of receivers) {
    if (!delegatedAgentIds.has(receiver)) {
      throw new StructuredTurnError(
        "COLLAB_RECEIVER_UNKNOWN",
        "Collaboration item referenced an unqualified receiver thread",
        { kind: "policy", details: { receiverSha256: sha256Text(receiver) } },
      );
    }
  }
}

/**
 * @param {Readonly<Record<string, unknown>>} item
 * @param {{delegatedAgentIds: Set<string>, v2StartedAgentIds: Set<string>}} context
 */
function validateSubAgentActivity(item, context) {
  requireNonEmptyText(item.id, "sub-agent activity item id");
  const agentThreadId = requireNonEmptyText(item.agentThreadId, "sub-agent thread id");
  const agentPath = requireNonEmptyText(item.agentPath, "sub-agent path");
  const kind = requireAllowedText(
    item.kind,
    SUB_AGENT_ACTIVITY_KINDS,
    "sub-agent activity kind",
  );
  if (kind === "started") {
    if (context.v2StartedAgentIds.has(agentThreadId)) {
      throw new StructuredTurnError(
        "SUB_AGENT_STARTED_DUPLICATE",
        "Sub-agent activity started the same V2 receiver more than once",
        { kind: "protocol", details: { receiverSha256: sha256Text(agentThreadId) } },
      );
    }
    context.v2StartedAgentIds.add(agentThreadId);
    context.delegatedAgentIds.add(agentThreadId);
    if (context.delegatedAgentIds.size > MAX_DELEGATED_AGENTS) {
      throw new StructuredTurnError(
        "DELEGATION_LIMIT_EXCEEDED",
        "Structured turn exceeded the delegated-agent limit",
        { kind: "policy", details: { maxDelegatedAgents: MAX_DELEGATED_AGENTS } },
      );
    }
    return;
  }
  if (!context.delegatedAgentIds.has(agentThreadId)) {
    throw new StructuredTurnError(
      "SUB_AGENT_UNKNOWN",
      "Sub-agent activity referenced an unqualified receiver thread",
      { kind: "policy", details: { receiverSha256: sha256Text(agentThreadId) } },
    );
  }
  // Force path validation above even when only thread identity is used here.
  void agentPath;
}

/**
 * @param {Readonly<{
 *   toolName: string,
 *   arguments: unknown,
 *   result: unknown,
 *   isError: boolean,
 *   item: Readonly<Record<string, unknown>>
 * }>} evidence
 * @param {ReadonlySet<string>} requiredMcpTools
 * @param {Set<string>} successfulRequiredMcpTools
 * @param {Set<string>} failedRequiredMcpTools
 */
function recordRequiredMcpCompletion(
  evidence,
  requiredMcpTools,
  successfulRequiredMcpTools,
  failedRequiredMcpTools,
) {
  const key = evidence.toolName;
  if (!requiredMcpTools.has(key)) return;
  if (evidence.item.status === "completed" && evidence.isError === false) {
    successfulRequiredMcpTools.add(key);
  } else {
    failedRequiredMcpTools.add(key);
  }
}

/**
 * @param {ReadonlySet<string>} requiredMcpTools
 * @param {ReadonlySet<string>} successfulRequiredMcpTools
 * @param {ReadonlySet<string>} failedRequiredMcpTools
 */
function assertRequiredMcpToolsCompleted(
  requiredMcpTools,
  successfulRequiredMcpTools,
  failedRequiredMcpTools,
) {
  const failed = [...failedRequiredMcpTools].sort();
  if (failed.length > 0) {
    throw new StructuredTurnError(
      "REQUIRED_MCP_TOOL_FAILED",
      "A required MCP tool call did not complete successfully",
      { kind: "tool", details: { toolSha256: failed.map(sha256Text) } },
    );
  }
  const missing = [...requiredMcpTools]
    .filter((tool) => !successfulRequiredMcpTools.has(tool))
    .sort();
  if (missing.length > 0) {
    throw new StructuredTurnError(
      "REQUIRED_MCP_TOOL_MISSING",
      "The terminal turn omitted a required MCP tool call",
      { kind: "tool", details: { toolSha256: missing.map(sha256Text) } },
    );
  }
}

/**
 * @param {Readonly<Record<string, unknown>>} params
 * @param {string} threadId
 * @param {string} turnId
 * @param {string} method
 */
function assertTurnIdentity(params, threadId, turnId, method) {
  if (params.threadId !== threadId) {
    throw new StructuredTurnError(
      "THREAD_ID_MISMATCH",
      `${method} did not match the requested thread`,
      { kind: "protocol" },
    );
  }
  const observedTurnId = params.turnId ?? (
    params.turn && typeof params.turn === "object" && !Array.isArray(params.turn)
      ? Reflect.get(params.turn, "id")
      : undefined
  );
  if (observedTurnId !== turnId) {
    throw new StructuredTurnError(
      "TURN_ID_MISMATCH",
      `${method} did not match the started turn`,
      { kind: "protocol" },
    );
  }
}

/** @param {Readonly<Record<string, unknown>>} turn @param {string} turnId @param {string} label */
function assertTurnId(turn, turnId, label) {
  if (turn.id !== turnId) {
    throw new StructuredTurnError(
      "TURN_ID_MISMATCH",
      `${label} contained a mismatched turn identifier`,
      { kind: "protocol" },
    );
  }
}

/** @param {unknown} error */
function normalizeFailure(error) {
  if (error instanceof StructuredTurnError) return error;
  if (error instanceof ProtocolPolicyError) {
    return new StructuredTurnError(
      "PROTOCOL_POLICY_VIOLATION",
      "App-server violated the structured-turn protocol policy",
      { kind: "policy", cause: error },
    );
  }
  if (error && typeof error === "object") {
    const kind = Reflect.get(error, "kind");
    const code = Reflect.get(error, "code");
    const cause = Reflect.get(error, "cause");
    if (code === "REQUEST_ABORTED" && cause instanceof StructuredTurnError) {
      return cause;
    }
    if (kind === "timeout" || code === "REQUEST_TIMEOUT") {
      return new StructuredTurnError(
        "TURN_TIMEOUT",
        "App-server did not complete the structured turn before its deadline",
        { kind: "timeout", cause: error },
      );
    }
    if (kind === "aborted" || code === "REQUEST_ABORTED") {
      return new StructuredTurnError(
        "TURN_ABORTED",
        "Structured turn was aborted",
        { kind: "aborted", cause: error },
      );
    }
    if (kind === "protocol") {
      return new StructuredTurnError(
        "TRANSPORT_PROTOCOL_FAILURE",
        "App-server transport failed protocol validation",
        { kind: "protocol", details: { transportCode: safeScalar(code) }, cause: error },
      );
    }
    if (kind === "remote") {
      const remoteCode = Reflect.get(error, "remoteCode");
      if (remoteCode === 401 || remoteCode === 403 || remoteCode === "unauthorized") {
        return new StructuredTurnError(
          "AUTH_REQUIRED",
          "App-server authentication is unavailable or expired",
          { kind: "service", details: { remoteCode: safeScalar(remoteCode) } },
        );
      }
      if (remoteCode === 429 || remoteCode === "usageLimitExceeded") {
        return new StructuredTurnError(
          "RATE_LIMITED",
          "App-server service limit prevented the structured turn",
          { kind: "service", details: { remoteCode: safeScalar(remoteCode) } },
        );
      }
      return new StructuredTurnError(
        "REMOTE_REQUEST_FAILED",
        "App-server rejected the structured-turn request",
        { kind: "service", details: { remoteCode: safeScalar(remoteCode) } },
      );
    }
    if (kind === "process" || kind === "state") {
      return new StructuredTurnError(
        "APP_SERVER_UNAVAILABLE",
        "App-server became unavailable before structured turn acceptance",
        { kind: "process", details: { transportCode: safeScalar(code) }, cause: error },
      );
    }
  }
  if (error instanceof TypeError) {
    return new StructuredTurnError(
      "TRANSPORT_PROTOCOL_FAILURE",
      "App-server response failed required-shape validation",
      { kind: "protocol" },
    );
  }
  return new StructuredTurnError(
    "STRUCTURED_TURN_FAILED",
    "Structured turn failed before artifact acceptance",
    { cause: error },
  );
}

const SAFE_TERMINAL_FAILURE_CODES = new Set([
  "AUTH_REQUIRED",
  "OUTPUT_AMBIGUOUS",
  "OUTPUT_INVALID",
  "RATE_LIMITED",
  "REQUIRED_MCP_TOOL_FAILED",
  "REQUIRED_MCP_TOOL_MISSING",
  "TURN_FAILED",
  "TURN_INTERRUPTED",
]);

/** @param {StructuredTurnError} failure */
function requiresClientQuarantine(failure) {
  return !SAFE_TERMINAL_FAILURE_CODES.has(failure.code);
}

/** @param {number} deadlineAt @param {number} deadlineMs */
function assertBeforeDeadline(deadlineAt, deadlineMs) {
  if (performance.now() >= deadlineAt) {
    throw new StructuredTurnError(
      "TURN_TIMEOUT",
      `Structured turn exceeded its ${deadlineMs} ms deadline`,
      { kind: "timeout", details: { deadlineMs } },
    );
  }
}

/** @param {unknown} value */
function isThenable(value) {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof Reflect.get(value, "then") === "function"
  );
}

/** @param {unknown} value */
function isAbortSignal(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof Reflect.get(value, "aborted") === "boolean" &&
    typeof Reflect.get(value, "addEventListener") === "function" &&
    typeof Reflect.get(value, "removeEventListener") === "function"
  );
}

/** @param {unknown} value @param {string} label */
function snapshotToolSet(value, label) {
  if (!(value instanceof Set)) {
    throw new TypeError(`${label} must be a Set`);
  }
  const snapshot = new Set();
  for (const tool of value) {
    snapshot.add(requireNonEmptyText(tool, `${label} entry`));
  }
  return snapshot;
}

/** @param {unknown} client */
function assertClient(client) {
  if (!client || typeof client !== "object") {
    throw new TypeError("client must be an AppServerClient-compatible object");
  }
  for (const method of ["request", "stop", "on", "off"]) {
    if (typeof Reflect.get(client, method) !== "function") {
      throw new TypeError(`client.${method} must be a function`);
    }
  }
}

/** @param {unknown} input */
function assertInput(input) {
  if (!Array.isArray(input) || input.length === 0) {
    throw new TypeError("input must contain at least one text item");
  }
  for (const [index, item] of input.entries()) {
    assertPlainRecord(item, `input[${index}]`);
    assertExactKeys(item, ["text", "type"], `input[${index}]`);
    if (item.type !== "text") {
      throw new TypeError(`input[${index}].type must be text`);
    }
    const text = requireNonEmptyText(item.text, `input[${index}].text`);
    if (Buffer.byteLength(text, "utf8") > MAX_INPUT_TEXT_BYTES) {
      throw new TypeError(`input[${index}].text exceeds ${MAX_INPUT_TEXT_BYTES} bytes`);
    }
  }
}

/** @param {unknown} value @param {string} label */
function requireRecord(value, label) {
  assertPlainRecord(value, label);
  return /** @type {Readonly<Record<string, unknown>>} */ (value);
}

/** @param {unknown} value @param {string} label */
function assertPlainRecord(value, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    throw new TypeError(`${label} must be a plain object`);
  }
}

/** @param {Readonly<Record<string, unknown>>} value @param {readonly string[]} expected @param {string} label */
function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (actual.join("\0") !== sortedExpected.join("\0")) {
    throw new TypeError(`${label} contains missing or additional fields`);
  }
}

/** @param {unknown} value @param {string} label */
function requireNonEmptyText(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be non-empty text`);
  }
  return value;
}

/** @param {number} value @param {string} label */
function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

/** @param {unknown} value @param {string} label */
function cloneJson(value, label) {
  try {
    const text = JSON.stringify(value);
    if (text === undefined) throw new TypeError(`${label} is not JSON-serializable`);
    return JSON.parse(text);
  } catch (cause) {
    throw new TypeError(`${label} must be JSON-serializable`, { cause });
  }
}

/** @param {unknown} value @param {string} label */
function snapshotJson(value, label) {
  canonicalJson(value, label);
  return deepFreeze(cloneJson(value, label));
}

/**
 * Serialize JSON with recursively sorted object keys. This is used only as
 * input to SHA-256 safety signatures; it never appears in diagnostics.
 * @param {unknown} value
 * @param {string} label
 */
function canonicalJson(value, label) {
  const normalized = normalize(value);
  return JSON.stringify(normalized);

  /** @param {unknown} candidate @returns {unknown} */
  function normalize(candidate) {
    if (
      candidate === null ||
      typeof candidate === "string" ||
      typeof candidate === "boolean"
    ) {
      return candidate;
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) throw new TypeError(`${label} contains a non-finite number`);
      return candidate;
    }
    if (Array.isArray(candidate)) return candidate.map(normalize);
    if (
      candidate === undefined ||
      typeof candidate !== "object" ||
      (Object.getPrototypeOf(candidate) !== Object.prototype &&
        Object.getPrototypeOf(candidate) !== null)
    ) {
      throw new TypeError(`${label} contains a non-JSON value`);
    }
    return Object.fromEntries(
      Object.keys(candidate)
        .sort()
        .map((key) => [key, normalize(Reflect.get(candidate, key))]),
    );
  }
}

/** @template T @param {T} value @returns {Readonly<T>} */
function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return /** @type {Readonly<T>} */ (value);
}

/** @param {unknown} value @param {ReadonlySet<string>} allowed @param {string} label */
function requireAllowedText(value, allowed, label) {
  const text = requireNonEmptyText(value, label);
  if (!allowed.has(text)) {
    throw new StructuredTurnError(
      "ENUM_VALUE_INVALID",
      `${label} is outside the qualified allowlist`,
      { kind: "protocol", details: { valueSha256: sha256Text(text) } },
    );
  }
  return text;
}

/** @param {unknown} value */
function classifyTurnStatus(value) {
  if (value === "inProgress" || TERMINAL_TURN_STATUSES.has(/** @type {string} */ (value))) {
    return value;
  }
  return "unknown";
}

/** @param {unknown} value */
function classifyCodexErrorInfo(value) {
  return value === "unauthorized" || value === "usageLimitExceeded" ? value : "unknown";
}

/** @param {unknown} value */
function hashUnknownText(value) {
  return sha256Text(typeof value === "string" ? value : `[${typeof value}]`);
}

/** @param {unknown} value */
function safeScalar(value) {
  if (typeof value === "string") return `sha256:${sha256Text(value)}`;
  return typeof value === "number" || typeof value === "boolean" ? value : "unknown";
}
