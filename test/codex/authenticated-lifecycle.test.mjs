// @ts-check

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  AuthenticatedLifecycleError,
  continueAuthenticatedLifecycleProof,
  runAuthenticatedLifecycleProof,
} from "../../src/codex/authenticated-lifecycle.mjs";

const CWD = "/private/marketpilot/work";
const CODEX_HOME = "/private/runtime/marketpilot-codex";
const PARENT_THREAD_ID = "0198-parent-thread";
const PARENT_THREAD_PATH = `${CODEX_HOME}/sessions/2026/08/01/parent.jsonl`;
const MATERIALIZED_TURN_ID = "0198-materialized-turn";
const MATERIALIZED_FINAL_ID = "0198-materialized-final";
const RESUMED_TURN_ID = "0198-resumed-turn";
const CHILD_THREAD_ID = "0198-child-thread-1";
const CHILD_TURN_ID = "0198-child-turn";
const CHILD_FINAL_ID = "0198-child-final-1";
const CHILD_AGENT_PATH = "/root/auth_probe";
const INTERRUPT_THREAD_ID = "0198-interrupt-thread";
const INTERRUPT_TURN_ID = "0198-interrupt-turn";
const SECRET = "sk-never-leak-lifecycle-secret";
const CLIENT_INFO = Object.freeze({
  name: "marketpilot-lifecycle-test",
  title: "MarketPilot lifecycle test",
  version: "1.0.0",
});

const MATERIALIZED_PROOF = Object.freeze({
  threadId: PARENT_THREAD_ID,
  threadPath: PARENT_THREAD_PATH,
  turnId: MATERIALIZED_TURN_ID,
  status: "completed",
  finalMessageId: MATERIALIZED_FINAL_ID,
  artifact: Object.freeze({ marker: "public-sequence-1", privateProbe: SECRET }),
});

test("proves materialization, fresh-process resume, V2 delegation, and interrupt recovery", async () => {
  const harness = createHarness();

  const result = await runAuthenticatedLifecycleProof(fullOptions(harness));

  assert.deepEqual(result, {
    schemaVersion: 1,
    materializationPassed: true,
    restartResumePassed: true,
    interruptRecoveryPassed: true,
    delegationPassed: true,
    delegatedAgentCount: 1,
  });
  assert.equal(Object.isFrozen(result), true);
  const serialized = JSON.stringify(result);
  for (const forbidden of [
    SECRET,
    PARENT_THREAD_ID,
    PARENT_THREAD_PATH,
    "0198-child-thread-1",
    CHILD_AGENT_PATH,
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }

  assert.deepEqual(harness.factoryContexts, [
    { generation: 1, purpose: "materialize" },
    { generation: 2, purpose: "resume" },
    { generation: 3, purpose: "interrupt-recovery" },
  ]);
  assert.equal(new Set(harness.clients).size, 3);

  const materializationStart = requestFor(harness.clients[0], "thread/start");
  assert.deepEqual(materializationStart.params, {
    model: "gpt-5.6-sol",
    approvalPolicy: "never",
    sandbox: "read-only",
    cwd: CWD,
    ephemeral: false,
    config: { model_reasoning_effort: "ultra" },
    developerInstructions: "Use only the fixed public lifecycle fixture.",
  });
  assert.deepEqual(requestFor(harness.clients[1], "thread/resume").params, {
    threadId: PARENT_THREAD_ID,
  });
  assert.deepEqual(
    harness.clients[2].requests
      .filter(({ method }) => method === "thread/resume")
      .map(({ params }) => params),
    [{ threadId: "0198-child-thread-1" }],
  );
  assert.deepEqual(
    harness.clients[2].requests
      .filter(({ method }) => method === "thread/unsubscribe")
      .map(({ params }) => params),
    [{ threadId: "0198-child-thread-1" }],
  );
  assert.equal(requestFor(harness.clients[2], "thread/start").params.ephemeral, true);
  assert.deepEqual(requestFor(harness.clients[2], "turn/interrupt").params, {
    threadId: INTERRUPT_THREAD_ID,
    turnId: INTERRUPT_TURN_ID,
  });
  assert.deepEqual(
    harness.clients[2].requests.map(({ method }) => method),
    [
      "initialize",
      "thread/resume",
      "thread/unsubscribe",
      "thread/start",
      "turn/start",
      "turn/interrupt",
    ],
  );
  assert.equal(harness.runTurnCalls[0].deadlineMs, 201);
  assert.equal(harness.runTurnCalls[1].deadlineMs, 202);
  assert.equal(harness.runTurnCalls[2].deadlineMs, 204);
  assert.equal(harness.runTurnCalls[0].awaitAdditionalEvidence, undefined);
  assert.equal(typeof harness.runTurnCalls[1].awaitAdditionalEvidence, "function");
  assert.equal(harness.runTurnCalls[2].awaitAdditionalEvidence, undefined);
  assertAllRetiredAndDetached(harness.clients);
});

test("continues an existing accepted bootstrap without creating generation 1", async () => {
  const harness = createHarness();
  const materializedClient = retiredMaterializationClient();

  const result = await continueAuthenticatedLifecycleProof(
    continuationOptions(harness, materializedClient),
  );

  assert.equal(result.delegatedAgentCount, 1);
  assert.deepEqual(harness.factoryContexts, [
    { generation: 2, purpose: "resume" },
    { generation: 3, purpose: "interrupt-recovery" },
  ]);
  assert.equal(
    harness.clients[1].requests.filter(({ method }) => method === "thread/resume").length,
    1,
  );
  assertAllRetiredAndDetached([...harness.clients, materializedClient]);
});

test("waits for a child terminal that arrives after the parent activity", async () => {
  const harness = createHarness({ childLifecycle: "late-terminal" });
  const materializedClient = retiredMaterializationClient();

  const result = await continueAuthenticatedLifecycleProof(
    continuationOptions(harness, materializedClient),
  );

  assert.equal(result.delegationPassed, true);
  assert.equal(harness.runTurnCalls[0].awaitAdditionalEvidence instanceof Function, true);
  assertAllRetiredAndDetached([...harness.clients, materializedClient]);
});

test("rejects physical-client reuse across the bootstrap and resume generations", async () => {
  const harness = createHarness();
  const materializedClient = retiredMaterializationClient();
  harness.createClient = async (context) => {
    harness.factoryContexts.push(context);
    return materializedClient;
  };

  await expectCode(
    continueAuthenticatedLifecycleProof(
      continuationOptions(harness, materializedClient),
    ),
    "FRESH_CLIENT_REQUIRED",
  );
  assert.equal(materializedClient.startCalls, 0);
  assertAllRetiredAndDetached([materializedClient]);
});

test("rejects reuse of the stopped resume client for generation 3", async () => {
  const harness = createHarness();
  const materializedClient = retiredMaterializationClient();
  let sharedClient;
  harness.createClient = async (context) => {
    harness.factoryContexts.push(context);
    if (sharedClient !== undefined) return sharedClient;
    sharedClient = new FakeLifecycleClient(context.generation, harness.scenario);
    harness.clients.push(sharedClient);
    return sharedClient;
  };

  await expectCode(
    continueAuthenticatedLifecycleProof(
      continuationOptions(harness, materializedClient),
    ),
    "FRESH_CLIENT_REQUIRED",
  );
  assertAllRetiredAndDetached([...harness.clients, materializedClient]);
});

test("rejects and retires a factory client that is not idle", async () => {
  const harness = createHarness();
  const materializedClient = retiredMaterializationClient();
  const runningClient = new FakeLifecycleClient(2, harness.scenario);
  runningClient.state = "running";
  harness.createClient = async (context) => {
    harness.factoryContexts.push(context);
    harness.clients.push(runningClient);
    return runningClient;
  };

  await expectCode(
    continueAuthenticatedLifecycleProof(
      continuationOptions(harness, materializedClient),
    ),
    "FRESH_CLIENT_NOT_IDLE",
  );
  assert.equal(runningClient.stopCalls, 1);
  assertAllRetiredAndDetached([...harness.clients, materializedClient]);
});

test("cleanup-owns a malformed but stoppable factory candidate", async () => {
  const harness = createHarness();
  const materializedClient = retiredMaterializationClient();
  let stopCalls = 0;
  harness.createClient = async (context) => {
    harness.factoryContexts.push(context);
    return {
      async stop() {
        stopCalls += 1;
      },
    };
  };

  await expectCode(
    continueAuthenticatedLifecycleProof(
      continuationOptions(harness, materializedClient),
    ),
    "AUTHENTICATED_LIFECYCLE_FAILED",
  );
  assert.equal(stopCalls, 1);
});

for (const [name, materializationPath] of [
  ["missing", undefined],
  ["relative", "sessions/parent.jsonl"],
  ["outside CODEX_HOME", "/private/other/parent.jsonl"],
]) {
  test(`durable materialization rejects a ${name} rollout path`, async () => {
    const harness = createHarness({ materializationPath });
    await expectCode(
      runAuthenticatedLifecycleProof(fullOptions(harness)),
      "THREAD_POLICY_INVALID",
    );
    assertAllRetiredAndDetached(harness.clients);
  });
}

test("parent resume must return the exact accepted rollout path", async () => {
  const harness = createHarness({
    parentResumePath: `${CODEX_HOME}/sessions/2026/08/01/different.jsonl`,
  });
  const materializedClient = retiredMaterializationClient();

  await expectCode(
    continueAuthenticatedLifecycleProof(
      continuationOptions(harness, materializedClient),
    ),
    "THREAD_POLICY_INVALID",
  );
  assertAllRetiredAndDetached([...harness.clients, materializedClient]);
});

test("rejects an accepted path outside the private Codex home before process creation", async () => {
  const harness = createHarness();
  const materializedClient = retiredMaterializationClient();
  const materialized = {
    ...MATERIALIZED_PROOF,
    threadPath: "/private/other/parent.jsonl",
  };

  await expectCode(
    continueAuthenticatedLifecycleProof({
      ...continuationOptions(harness, materializedClient),
      materialized,
    }),
    "THREAD_PATH_OUTSIDE_CODEX_HOME",
  );
  assert.equal(harness.factoryContexts.length, 0);
});

test("accepts a bounded unphased non-final message in Legacy parent history", async () => {
  const harness = createHarness({ parentHistory: "null-phase" });
  const materializedClient = retiredMaterializationClient();

  const result = await continueAuthenticatedLifecycleProof(
    continuationOptions(harness, materializedClient),
  );

  assert.equal(result.restartResumePassed, true);
  assertAllRetiredAndDetached([...harness.clients, materializedClient]);
});

for (const [history, code] of [
  ["missing", "RESUME_HISTORY_INVALID"],
  ["extra", "RESUME_HISTORY_INVALID"],
  ["wrong-turn", "RESUME_HISTORY_INVALID"],
  ["extra-final", "RESUME_HISTORY_INVALID"],
  ["commentary-final", "RESUME_HISTORY_INVALID"],
  ["empty-final", "RESUME_HISTORY_ITEM_INVALID"],
  ["turn-error", "RESUME_HISTORY_INVALID"],
  ["partial-items", "RESUME_HISTORY_INVALID"],
  ["missing-mcp", "RESUME_HISTORY_INVALID"],
  ["extra-mcp", "RESUME_HISTORY_INVALID"],
  ["wrong-mcp", "RESUME_HISTORY_MCP_INVALID"],
  ["unknown-item", "RESUME_HISTORY_ITEM_FORBIDDEN"],
  ["nested-delegate", "RESUME_HISTORY_ITEM_FORBIDDEN"],
  ["unsupported-phase", "RESUME_HISTORY_ITEM_INVALID"],
]) {
  test(`fails closed when parent resume history is ${history}`, async () => {
    const harness = createHarness({ parentHistory: history });
    const materializedClient = retiredMaterializationClient();
    await expectCode(
      continueAuthenticatedLifecycleProof(
        continuationOptions(harness, materializedClient),
      ),
      code,
    );
    assert.equal(harness.factoryContexts.length, 1);
    assertAllRetiredAndDetached([...harness.clients, materializedClient]);
  });
}

for (const [delegation, code] of [
  ["none", "DELEGATION_COUNT_INVALID"],
  ["over-limit", "DELEGATION_LIMIT_EXCEEDED"],
  ["v1-spawn", "DELEGATION_V1_FORBIDDEN"],
  ["started-then-completed", "DELEGATION_ACTIVITY_NOT_ATOMIC"],
  ["duplicate-item", "DELEGATION_ITEM_ID_REUSED"],
  ["duplicate-receiver", "DELEGATION_RECEIVER_DUPLICATED"],
  ["cross-type-item-id", "DELEGATION_ITEM_ID_REUSED"],
  ["wrong-turn", "DELEGATION_TURN_ID_INVALID"],
  ["bad-agent-path", "DELEGATION_AGENT_PATH_INVALID"],
  ["wrong-agent-name", "DELEGATION_AGENT_PATH_INVALID"],
  ["reserved-agent-path", "DELEGATION_AGENT_PATH_INVALID"],
  ["nested-agent-path", "DELEGATION_AGENT_PATH_INVALID"],
]) {
  test(`rejects invalid V2 delegation evidence: ${delegation}`, async () => {
    const harness = createHarness({ delegation });
    const materializedClient = retiredMaterializationClient();
    await expectCode(
      continueAuthenticatedLifecycleProof(
        continuationOptions(harness, materializedClient),
      ),
      code,
    );
    assert.equal(harness.factoryContexts.length, 1);
    assertAllRetiredAndDetached([...harness.clients, materializedClient]);
  });
}

for (const [childLifecycle, code] of [
  ["none", "DELEGATION_CHILD_LIFECYCLE_MISSING"],
  ["no-start", "DELEGATION_EVENT_BEFORE_TURN_STARTED"],
  ["duplicate-start", "DELEGATION_DUPLICATE_TURN_STARTED"],
  ["bad-start-envelope", "DELEGATION_CHILD_START_INVALID"],
  ["wrong-turn", "TURN_ID_MISMATCH"],
  ["mcp-tool", "DELEGATION_CHILD_CAPABILITY_FORBIDDEN"],
  ["nested-delegate", "DELEGATION_CHILD_CAPABILITY_FORBIDDEN"],
  ["collaboration-tool", "DELEGATION_CHILD_CAPABILITY_FORBIDDEN"],
  ["missing-item-completion", "DELEGATION_CHILD_TERMINAL_INVALID"],
  ["wrong-final-text", "DELEGATION_FINAL_ANSWER_INVALID"],
  ["missing-terminal", "DELEGATION_CHILD_LIFECYCLE_MISSING"],
  ["second-thread", "DELEGATION_LIMIT_EXCEEDED"],
  ["model-rerouted", "MODEL_REROUTED"],
]) {
  test(`rejects invalid multiplexed child lifecycle: ${childLifecycle}`, async () => {
    const harness = createHarness({ childLifecycle });
    const materializedClient = retiredMaterializationClient();
    await expectCode(
      continueAuthenticatedLifecycleProof(
        continuationOptions(harness, materializedClient),
      ),
      code,
    );
    assert.equal(harness.factoryContexts.length, 1);
    assertAllRetiredAndDetached([...harness.clients, materializedClient]);
  });
}

for (const [childProof, code] of [
  ["wrong-model", "THREAD_POLICY_INVALID"],
  ["wrong-effort", "THREAD_POLICY_INVALID"],
  ["wrong-provider", "THREAD_POLICY_INVALID"],
  ["outside-home", "THREAD_POLICY_INVALID"],
  ["wrong-parent", "DELEGATION_PROVENANCE_INVALID"],
  ["wrong-fork", "DELEGATION_PROVENANCE_INVALID"],
  ["wrong-thread-source", "DELEGATION_PROVENANCE_INVALID"],
  ["wrong-agent-path", "DELEGATION_PROVENANCE_INVALID"],
  ["active", "DELEGATION_PROVENANCE_INVALID"],
  ["no-turns", "DELEGATION_COMPLETION_MISSING"],
  ["in-progress-turn", "DELEGATION_COMPLETION_MISSING"],
  ["extra-turn", "DELEGATION_COMPLETION_MISSING"],
  ["turn-error", "DELEGATION_COMPLETION_MISSING"],
  ["partial-items", "DELEGATION_COMPLETION_MISSING"],
  ["no-final", "DELEGATION_FINAL_ANSWER_INVALID"],
  ["empty-final", "DELEGATION_HISTORY_ITEM_INVALID"],
  ["wrong-final-text", "DELEGATION_FINAL_ANSWER_INVALID"],
  ["wrong-live-turn", "DELEGATION_COMPLETION_MISSING"],
  ["two-finals", "DELEGATION_FINAL_ANSWER_INVALID"],
  ["mcp-history", "DELEGATION_HISTORY_ITEM_FORBIDDEN"],
  ["nested-history", "DELEGATION_HISTORY_ITEM_FORBIDDEN"],
  ["unknown-history", "DELEGATION_HISTORY_ITEM_FORBIDDEN"],
  ["unsubscribe-failed", "DELEGATION_UNSUBSCRIBE_INVALID"],
]) {
  test(`fresh child resume rejects invalid delegated proof: ${childProof}`, async () => {
    const harness = createHarness({ childProof });
    const materializedClient = retiredMaterializationClient();
    await expectCode(
      continueAuthenticatedLifecycleProof(
        continuationOptions(harness, materializedClient),
      ),
      code,
    );
    assert.equal(harness.factoryContexts.length, 2);
    assertAllRetiredAndDetached([...harness.clients, materializedClient]);
  });
}

test("logical continuity validator is synchronous, local, and redaction safe", async () => {
  for (const validator of [
    () => false,
    () => {
      throw new Error(SECRET);
    },
  ]) {
    const harness = createHarness();
    const materializedClient = retiredMaterializationClient();
    await expectCode(
      continueAuthenticatedLifecycleProof({
        ...continuationOptions(harness, materializedClient),
        validateContinuity: validator,
      }),
      "CONTINUITY_NOT_PROVEN",
    );
    assert.equal(harness.factoryContexts.length, 1);
    assertAllRetiredAndDetached([...harness.clients, materializedClient]);
  }
});

for (const [generationFailure, code] of [
  ["unknown-notification", "RUNTIME_NOTIFICATION_FORBIDDEN"],
  ["unknown-during-turn", "RUNTIME_NOTIFICATION_FORBIDDEN"],
  ["malformed-notification", "RUNTIME_NOTIFICATION_MALFORMED"],
  ["unclaimed-lifecycle", "UNCLAIMED_LIFECYCLE_NOTIFICATION"],
  ["notification-limit", "GENERATION_NOTIFICATION_LIMIT_EXCEEDED"],
  ["skills-changed", "RUNTIME_INVENTORY_CHANGED"],
  ["model-rerouted-between-turns", "MODEL_REROUTED"],
  ["server-request", "SERVER_REQUEST_FORBIDDEN"],
  ["incident", "APP_SERVER_INCIDENT"],
  ["unexpected-exit", "APP_SERVER_EXIT"],
]) {
  test(`generation-wide guard fails closed for ${generationFailure}`, async () => {
    const harness = createHarness({ generationFailure });
    const materializedClient = retiredMaterializationClient();

    await expectCode(
      continueAuthenticatedLifecycleProof(
        continuationOptions(harness, materializedClient),
      ),
      code,
    );
    assertAllRetiredAndDetached([...harness.clients, materializedClient]);
  });
}

for (const [interrupt, code] of [
  ["completed-terminal", "INTERRUPT_TERMINAL_INVALID"],
  ["wrong-thread", "THREAD_ID_MISMATCH"],
  ["wrong-turn", "TURN_ID_MISMATCH"],
  ["post-terminal", "EVENT_AFTER_TERMINAL"],
  ["duplicate-terminal", "DUPLICATE_TERMINAL"],
  ["item-before-started", "ITEM_BEFORE_TURN_STARTED"],
  ["terminal-before-started", "TERMINAL_BEFORE_TURN_STARTED"],
  ["completed-before-interrupt", "INTERRUPT_RACE_LOST"],
  ["started-event-envelope", "INTERRUPT_START_INVALID"],
  ["start-response-envelope", "INTERRUPT_START_INVALID"],
  ["completion-without-start", "ITEM_STARTED_MISSING"],
  ["duplicate-item-start", "DUPLICATE_ITEM_STARTED"],
  ["duplicate-item-completion", "DUPLICATE_ITEM"],
  ["item-signature-mismatch", "ITEM_LIFECYCLE_MISMATCH"],
  ["terminal-items-missing", "TERMINAL_ITEMS_INVALID"],
  ["terminal-items-nonempty", "TERMINAL_ITEMS_NOT_EMPTY"],
  ["terminal-items-view", "INTERRUPT_TERMINAL_INVALID"],
  ["terminal-error", "INTERRUPT_TERMINAL_INVALID"],
  ["server-request", "SERVER_REQUEST_FORBIDDEN"],
  ["no-start", "INTERRUPT_TIMEOUT"],
  ["no-terminal", "INTERRUPT_TIMEOUT"],
]) {
  test(`interrupt lifecycle fails closed for ${interrupt}`, async () => {
    const harness = createHarness({ interrupt });
    const materializedClient = retiredMaterializationClient();
    await expectCode(
      continueAuthenticatedLifecycleProof(
        continuationOptions(harness, materializedClient, {
          interruptTimeoutMs: ["no-start", "no-terminal"].includes(interrupt)
            ? 20
            : 2_000,
        }),
      ),
      code,
    );
    assertAllRetiredAndDetached([...harness.clients, materializedClient]);
  });
}

test("accepts an interrupted terminal with an in-flight item left unfinished", async () => {
  const harness = createHarness({ interrupt: "dangling-item" });
  const materializedClient = retiredMaterializationClient();

  const result = await continueAuthenticatedLifecycleProof(
    continuationOptions(harness, materializedClient),
  );

  assert.equal(result.interruptRecoveryPassed, true);
  assertAllRetiredAndDetached([...harness.clients, materializedClient]);
});

test("pre-aborted lifecycle creates no app-server process", async () => {
  const harness = createHarness();
  const controller = new AbortController();
  controller.abort(new Error(SECRET));

  await expectCode(
    runAuthenticatedLifecycleProof({
      ...fullOptions(harness),
      signal: controller.signal,
    }),
    "LIFECYCLE_ABORTED",
  );
  assert.equal(harness.factoryContexts.length, 0);
});

test("a stop failure can never return a passed proof", async () => {
  const harness = createHarness({ stopFailureGeneration: 3 });
  const materializedClient = retiredMaterializationClient();

  await expectCode(
    continueAuthenticatedLifecycleProof(
      continuationOptions(harness, materializedClient),
    ),
    "CLIENT_CLEANUP_FAILED",
  );
  assertNoLifecycleListeners(harness.clients[1]);
});

for (const identityReuse of [
  "resumed-turn",
  "ephemeral-thread",
  "interrupt-turn",
  "recovery-turn",
]) {
  test(`rejects cross-stage lifecycle identity reuse: ${identityReuse}`, async () => {
    const harness = createHarness({ identityReuse });
    const materializedClient = retiredMaterializationClient();

    await expectCode(
      continueAuthenticatedLifecycleProof(
        continuationOptions(harness, materializedClient),
      ),
      "LIFECYCLE_ID_REUSED",
    );
    assertAllRetiredAndDetached([...harness.clients, materializedClient]);
  });
}

/**
 * @param {Partial<Scenario>} [overrides]
 * @returns {Harness}
 */
function createHarness(overrides = {}) {
  const scenario = {
    delegatedAgents: 1,
    delegation: "valid",
    childProof: "valid",
    childLifecycle: "valid",
    generationFailure: "none",
    identityReuse: "none",
    interrupt: "valid",
    materializationPath: PARENT_THREAD_PATH,
    parentResumePath: PARENT_THREAD_PATH,
    parentHistory: "valid",
    stopFailureGeneration: 0,
    ...overrides,
  };
  /** @type {FakeLifecycleClient[]} */
  const clients = [];
  /** @type {Readonly<{generation: number, purpose: string}>[]} */
  const factoryContexts = [];
  /** @type {any[]} */
  const runTurnCalls = [];

  /** @type {Harness} */
  const harness = {
    scenario,
    clients,
    factoryContexts,
    runTurnCalls,
    async createClient(context) {
      factoryContexts.push(context);
      const client = new FakeLifecycleClient(context.generation, scenario);
      clients.push(client);
      return client;
    },
    async runTurn(options) {
      runTurnCalls.push(options);
      assert.equal(options.client.state, "running");
      const client = /** @type {FakeLifecycleClient} */ (options.client);
      if (client.generation === 1) {
        await client.stop();
        return {
          threadId: PARENT_THREAD_ID,
          turnId: MATERIALIZED_TURN_ID,
          status: "completed",
          finalMessageId: MATERIALIZED_FINAL_ID,
          artifact: MATERIALIZED_PROOF.artifact,
        };
      }
      if (client.generation === 2) {
        if (scenario.generationFailure === "unknown-during-turn") {
          client.emit("notification", { method: "future/notification", params: {} });
        }
        emitDelegatedChildLifecycle(client, options, scenario);
        emitDelegationEvidence(client, options.threadId, scenario);
        if (
          scenario.delegation !== "none" &&
          !["missing-terminal", "model-rerouted", "none"].includes(
            scenario.childLifecycle,
          )
        ) {
          assert.equal(typeof options.awaitAdditionalEvidence, "function");
          await options.awaitAdditionalEvidence();
        }
        await client.stop();
        return {
          threadId: options.threadId,
          turnId: scenario.identityReuse === "resumed-turn"
            ? MATERIALIZED_TURN_ID
            : RESUMED_TURN_ID,
          status: "completed",
          finalMessageId: "0198-resumed-final",
          artifact: Object.freeze({
            previousMarker: "public-sequence-1",
            marker: "public-sequence-2",
          }),
        };
      }
      assert.equal(options.threadId, INTERRUPT_THREAD_ID);
      await client.stop();
      return {
        threadId: INTERRUPT_THREAD_ID,
        turnId: scenario.identityReuse === "recovery-turn"
          ? fixtureInterruptTurnId(scenario)
          : "0198-recovery-turn",
        status: "completed",
        finalMessageId: "0198-recovery-final",
        artifact: Object.freeze({ status: "recovered" }),
      };
    },
  };
  return harness;
}

class FakeLifecycleClient extends EventEmitter {
  /** @param {number} generation @param {Scenario} scenario */
  constructor(generation, scenario) {
    super();
    this.generation = generation;
    this.scenario = scenario;
    this.state = "idle";
    this.serverRequestsForbidden = true;
    this.startCalls = 0;
    this.stopCalls = 0;
    /** @type {{method: string, params: any, options: any}[]} */
    this.requests = [];
    /** @type {{method: string, params: any}[]} */
    this.notifications = [];
  }

  async start() {
    this.startCalls += 1;
    this.state = "running";
  }

  async stop() {
    this.stopCalls += 1;
    if (this.scenario.stopFailureGeneration === this.generation) {
      throw new Error(`${SECRET}: stop failed`);
    }
    this.state = "stopped";
  }

  /** @param {string} method @param {any} params @param {any} [options] */
  async request(method, params, options) {
    this.requests.push({ method, params, options });
    if (method === "initialize") {
      if (this.generation === 2) {
        emitGenerationFailure(this, this.scenario.generationFailure, "initialize");
      }
      return {};
    }
    assert.equal(this.state, "running");
    if (method === "thread/start") {
      if (this.generation === 1) {
        this.emit("notification", {
          method: "thread/started",
          params: { thread: { id: PARENT_THREAD_ID } },
        });
        return qualifiedResponse({
          id: PARENT_THREAD_ID,
          cwd: CWD,
          ephemeral: false,
          path: this.scenario.materializationPath,
          turns: [],
        });
      }
      emitGenerationFailure(this, this.scenario.generationFailure, "ephemeral-start");
      const ephemeralThreadId = this.scenario.identityReuse === "ephemeral-thread"
        ? PARENT_THREAD_ID
        : INTERRUPT_THREAD_ID;
      this.emit("notification", {
        method: "thread/started",
        params: { thread: { id: ephemeralThreadId } },
      });
      return qualifiedResponse({
        id: ephemeralThreadId,
        cwd: CWD,
        ephemeral: true,
        path: null,
        turns: [],
      });
    }
    if (method === "thread/resume") {
      if (this.generation === 2) {
        emitGenerationFailure(this, this.scenario.generationFailure, "parent-resume");
        return qualifiedResponse({
          id: PARENT_THREAD_ID,
          cwd: CWD,
          ephemeral: false,
          path: this.scenario.parentResumePath,
          turns: parentHistory(this.scenario.parentHistory),
        });
      }
      return childResponse(params.threadId, this.scenario);
    }
    if (method === "thread/unsubscribe") {
      return {
        status: this.scenario.childProof === "unsubscribe-failed"
          ? "notSubscribed"
          : "unsubscribed",
      };
    }
    if (method === "turn/start") {
      const interruptTurnId = fixtureInterruptTurnId(this.scenario);
      const startedEventTurn = interruptTurnEnvelope("inProgress", interruptTurnId);
      if (this.scenario.interrupt === "started-event-envelope") {
        startedEventTurn.itemsView = "full";
      }
      if (this.scenario.interrupt === "item-before-started") {
        this.emit("notification", {
          method: "item/completed",
          params: {
            threadId: INTERRUPT_THREAD_ID,
            turnId: interruptTurnId,
            item: { id: "0198-early-item", type: "reasoning" },
          },
        });
      }
      if (this.scenario.interrupt === "terminal-before-started") {
        this.emit("notification", {
          method: "turn/completed",
          params: {
            threadId: INTERRUPT_THREAD_ID,
            turnId: interruptTurnId,
            turn: interruptTurnEnvelope("interrupted", interruptTurnId),
          },
        });
      }
      if (this.scenario.interrupt !== "no-start") {
        this.emit("notification", {
          method: "turn/started",
          params: {
            threadId: INTERRUPT_THREAD_ID,
            turnId: interruptTurnId,
            turn: startedEventTurn,
          },
        });
      }
      this.emitInterruptItemsBeforeResponse();
      if (this.scenario.interrupt === "completed-before-interrupt") {
        this.emit("notification", {
          method: "turn/completed",
          params: {
            threadId: INTERRUPT_THREAD_ID,
            turnId: interruptTurnId,
            turn: interruptTurnEnvelope("interrupted", interruptTurnId),
          },
        });
      }
      const startResponseTurn = interruptTurnEnvelope("inProgress", interruptTurnId);
      if (this.scenario.interrupt === "start-response-envelope") {
        startResponseTurn.items = [{ id: "0198-unexpected-start-item", type: "reasoning" }];
      }
      return { turn: startResponseTurn };
    }
    if (method === "turn/interrupt") {
      this.emitInterruptOutcome();
      return {};
    }
    throw new Error(`${SECRET}: unexpected request method`);
  }

  /** @param {string} method @param {any} params */
  async notify(method, params) {
    this.notifications.push({ method, params });
  }

  emitInterruptOutcome() {
    if (this.scenario.interrupt === "server-request") {
      this.emit("serverRequest", { method: "item/tool/requestUserInput" });
      return;
    }
    if (this.scenario.interrupt === "no-terminal") return;
    const threadId = this.scenario.interrupt === "wrong-thread"
      ? "0198-wrong-thread"
      : INTERRUPT_THREAD_ID;
    const turnId = this.scenario.interrupt === "wrong-turn"
      ? "0198-wrong-turn"
      : fixtureInterruptTurnId(this.scenario);
    const status = this.scenario.interrupt === "completed-terminal"
      ? "completed"
      : "interrupted";
    const terminalTurn = interruptTurnEnvelope(status, turnId);
    if (this.scenario.interrupt === "terminal-items-missing") {
      delete terminalTurn.items;
    } else if (this.scenario.interrupt === "terminal-items-nonempty") {
      terminalTurn.items = [{ id: "0198-terminal-snapshot", type: "reasoning" }];
    } else if (this.scenario.interrupt === "terminal-items-view") {
      terminalTurn.itemsView = "full";
    } else if (this.scenario.interrupt === "terminal-error") {
      terminalTurn.error = { message: "public interrupt error" };
    }
    this.emit("notification", {
      method: "turn/completed",
      params: { threadId, turnId, turn: terminalTurn },
    });
    if (this.scenario.interrupt === "duplicate-terminal") {
      this.emit("notification", {
        method: "turn/completed",
        params: { threadId, turnId, turn: terminalTurn },
      });
    }
    if (this.scenario.interrupt === "post-terminal") {
      setImmediate(() => this.emit("notification", {
        method: "item/completed",
        params: {
          threadId: INTERRUPT_THREAD_ID,
          turnId,
          item: { id: "0198-late-item", type: "reasoning" },
        },
      }));
    }
  }

  emitInterruptItemsBeforeResponse() {
    const scenario = this.scenario.interrupt;
    const interruptTurnId = fixtureInterruptTurnId(this.scenario);
    const started = { id: "0198-interrupt-item", type: "reasoning", summary: [] };
    const completed = { ...started, summary: ["public"] };
    if (scenario === "completion-without-start") {
      emitItem(this, "item/completed", INTERRUPT_THREAD_ID, interruptTurnId, completed);
      return;
    }
    if (
      ![
        "dangling-item",
        "duplicate-item-completion",
        "duplicate-item-start",
        "item-signature-mismatch",
      ].includes(scenario)
    ) {
      return;
    }
    emitItem(this, "item/started", INTERRUPT_THREAD_ID, interruptTurnId, started);
    if (scenario === "duplicate-item-start") {
      emitItem(this, "item/started", INTERRUPT_THREAD_ID, interruptTurnId, started);
      return;
    }
    if (scenario === "dangling-item") return;
    emitItem(
      this,
      "item/completed",
      INTERRUPT_THREAD_ID,
      interruptTurnId,
      scenario === "item-signature-mismatch"
        ? { id: started.id, type: "agentMessage", text: "public" }
        : completed,
    );
    if (scenario === "duplicate-item-completion") {
      emitItem(this, "item/completed", INTERRUPT_THREAD_ID, interruptTurnId, completed);
    }
  }
}

/** @param {Harness} harness */
function fullOptions(harness) {
  return {
    createClient: harness.createClient,
    runTurn: harness.runTurn,
    clientInfo: CLIENT_INFO,
    cwd: CWD,
    codexHome: CODEX_HOME,
    developerInstructions: "Use only the fixed public lifecycle fixture.",
    materializationTurn: turnSpecification("materialize", 201),
    resumedTurn: turnSpecification("resume", 202),
    interruptTurn: turnSpecification("interrupt", 203),
    recoveryTurn: turnSpecification("recovery", 204),
    validateContinuity,
    requestTimeoutMs: 150,
    interruptTimeoutMs: 2_000,
  };
}

/**
 * @param {Harness} harness
 * @param {FakeLifecycleClient} materializedClient
 * @param {Record<string, unknown>} [overrides]
 */
function continuationOptions(harness, materializedClient, overrides = {}) {
  return {
    createClient: harness.createClient,
    runTurn: harness.runTurn,
    clientInfo: CLIENT_INFO,
    cwd: CWD,
    codexHome: CODEX_HOME,
    developerInstructions: "Use only the fixed public lifecycle fixture.",
    materialized: MATERIALIZED_PROOF,
    materializedClient,
    resumedTurn: turnSpecification("resume", 202),
    interruptTurn: turnSpecification("interrupt", 203),
    recoveryTurn: turnSpecification("recovery", 204),
    validateContinuity,
    requestTimeoutMs: 150,
    interruptTimeoutMs: 2_000,
    ...overrides,
  };
}

/** @param {string} label @param {number} deadlineMs */
function turnSpecification(label, deadlineMs) {
  return {
    input: [{ type: "text", text: `fixed public ${label} fixture` }],
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["status"],
      properties: { status: { type: "string", const: "ok" } },
    },
    parseFinal: JSON.parse,
    deadlineMs,
    allowedMcpTools: new Set(),
    requiredMcpTools: new Set(),
  };
}

/** @param {{materializedArtifact: any, resumedArtifact: any}} evidence */
function validateContinuity(evidence) {
  return (
    evidence.materializedArtifact.marker === "public-sequence-1" &&
    evidence.resumedArtifact.previousMarker === evidence.materializedArtifact.marker
  );
}

/** @returns {FakeLifecycleClient} */
function retiredMaterializationClient() {
  const client = new FakeLifecycleClient(1, /** @type {Scenario} */ ({}));
  client.state = "stopped";
  return client;
}

/** @param {FakeLifecycleClient} client @param {string} method */
function requestFor(client, method) {
  const match = client.requests.find((entry) => entry.method === method);
  assert.ok(match, `missing request ${method}`);
  return match;
}

/** @param {string | undefined} mode */
function parentHistory(mode) {
  if (mode === "missing") return [];
  const fixtureMcp = {
    id: "0198-materialized-mcp",
    type: "mcpToolCall",
    server: "marketpilot_fixture",
    tool: mode === "wrong-mcp" ? "other_tool" : "research_read",
    arguments: { fixtureId: "public-event-001" },
    status: "completed",
  };
  const items = [
    {
      id: "0198-materialized-user",
      type: "userMessage",
      content: [{ type: "text", text: "fixed public fixture" }],
    },
    {
      id: "0198-materialized-reasoning",
      type: "reasoning",
      summary: [],
      content: [],
    },
    ...(mode === "missing-mcp" ? [] : [fixtureMcp]),
    ...(mode === "extra-mcp"
      ? [{ ...fixtureMcp, id: "0198-materialized-mcp-2" }]
      : []),
    ...(mode === "unknown-item"
      ? [{ id: "0198-materialized-unknown", type: "futureCapability" }]
      : []),
    ...(mode === "nested-delegate"
      ? [{
          id: "0198-materialized-child",
          type: "subAgentActivity",
          kind: "started",
          agentThreadId: CHILD_THREAD_ID,
          agentPath: "/root/fixture_agent_1",
        }]
      : []),
    {
      id: "0198-materialized-commentary",
      type: "agentMessage",
      phase: mode === "null-phase"
        ? null
        : mode === "unsupported-phase"
          ? "future_phase"
          : "commentary",
      text: "public commentary",
    },
    {
      id: "item-materialized-final",
      type: "agentMessage",
      phase: mode === "commentary-final" ? "commentary" : "final_answer",
      text: mode === "empty-final" ? "" : "public materialization",
    },
    ...(mode === "extra-final"
      ? [{
          id: "0198-extra-final",
          type: "agentMessage",
          phase: "final_answer",
          text: "public extra",
        }]
      : []),
  ];
  const turn = {
    id: mode === "wrong-turn" ? "0198-wrong-materialized-turn" : MATERIALIZED_TURN_ID,
    status: "completed",
    error: mode === "turn-error" ? { message: "public failure" } : null,
    itemsView: mode === "partial-items" ? "summary" : "full",
    items,
  };
  return mode === "extra"
    ? [
        turn,
        {
          id: "0198-extra-turn",
          status: "completed",
          error: null,
          itemsView: "full",
          items: [],
        },
      ]
    : [turn];
}

/** @param {FakeLifecycleClient} client @param {string} threadId @param {Scenario} scenario */
function emitDelegationEvidence(client, threadId, scenario) {
  if (scenario.delegation === "none") return;
  if (scenario.delegation === "v1-spawn") {
    emitItem(client, "item/completed", threadId, RESUMED_TURN_ID, {
      id: "0198-v1-spawn",
      type: "collabAgentToolCall",
      tool: "spawnAgent",
    });
    return;
  }
  if (scenario.delegation === "cross-type-item-id") {
    emitItem(client, "item/completed", threadId, RESUMED_TURN_ID, {
      id: "0198-activity-1",
      type: "reasoning",
    });
  }
  const count = scenario.delegation === "over-limit"
    ? 3
    : ["duplicate-item", "duplicate-receiver"].includes(scenario.delegation)
      ? 2
      : scenario.delegatedAgents;
  for (let index = 1; index <= count; index += 1) {
    let agentPath = index === 1 ? CHILD_AGENT_PATH : `/root/fixture_agent_${index}`;
    if (scenario.delegation === "bad-agent-path") {
      agentPath = `relative/fixture-agent-${index}`;
    } else if (scenario.delegation === "reserved-agent-path") {
      agentPath = "/root/root";
    } else if (scenario.delegation === "nested-agent-path") {
      agentPath = "/root/fixture_agent/child";
    } else if (scenario.delegation === "wrong-agent-name") {
      agentPath = "/root/other_probe";
    }
    const item = {
      id: scenario.delegation === "duplicate-item" ? "0198-activity-1" : `0198-activity-${index}`,
      type: "subAgentActivity",
      kind: "started",
      agentThreadId: scenario.delegation === "duplicate-receiver"
        ? "0198-child-thread-1"
        : `0198-child-thread-${index}`,
      agentPath,
    };
    if (scenario.delegation === "started-then-completed") {
      emitItem(client, "item/started", threadId, RESUMED_TURN_ID, item);
    }
    emitItem(
      client,
      "item/completed",
      threadId,
      scenario.delegation === "wrong-turn" ? "0198-wrong-turn" : RESUMED_TURN_ID,
      item,
    );
  }
}

/** @param {FakeLifecycleClient} client @param {any} turnOptions @param {Scenario} scenario */
function emitDelegatedChildLifecycle(client, turnOptions, scenario) {
  if (["none", "v1-spawn"].includes(scenario.delegation)) return;
  const mode = scenario.childLifecycle;
  if (mode === "none") return;
  assert.equal(typeof turnOptions.validateForeignTurnNotification, "function");
  const emit = (method, params) => {
    const notification = { method, params };
    client.emit("notification", notification);
    turnOptions.validateForeignTurnNotification(notification);
  };
  if (mode === "model-rerouted") {
    client.emit("notification", {
      method: "model/rerouted",
      params: { threadId: CHILD_THREAD_ID, turnId: CHILD_TURN_ID },
    });
    return;
  }
  const startedTurn = interruptTurnEnvelope("inProgress", CHILD_TURN_ID);
  if (mode === "bad-start-envelope") startedTurn.itemsView = "full";
  if (mode !== "no-start") {
    emit("turn/started", {
      threadId: CHILD_THREAD_ID,
      turnId: CHILD_TURN_ID,
      turn: startedTurn,
    });
  }
  if (mode === "duplicate-start") {
    emit("turn/started", {
      threadId: CHILD_THREAD_ID,
      turnId: CHILD_TURN_ID,
      turn: startedTurn,
    });
    return;
  }
  const itemType = mode === "mcp-tool"
    ? "mcpToolCall"
    : mode === "nested-delegate"
      ? "subAgentActivity"
      : mode === "collaboration-tool"
        ? "collabAgentToolCall"
        : "reasoning";
  const firstItem = itemType === "reasoning"
    ? { id: "0198-child-reasoning", type: itemType, summary: [], content: [] }
    : { id: "0198-child-forbidden", type: itemType };
  emit("item/started", {
    threadId: CHILD_THREAD_ID,
    turnId: mode === "wrong-turn" ? "0198-wrong-child-turn" : CHILD_TURN_ID,
    item: firstItem,
  });
  if (["mcp-tool", "nested-delegate", "collaboration-tool", "no-start", "wrong-turn"].includes(mode)) {
    return;
  }
  if (mode !== "missing-item-completion") {
    emit("item/completed", {
      threadId: CHILD_THREAD_ID,
      turnId: CHILD_TURN_ID,
      item: firstItem,
    });
  }
  const startedFinal = {
    id: CHILD_FINAL_ID,
    type: "agentMessage",
    phase: "final_answer",
    text: "",
  };
  emit("item/started", {
    threadId: CHILD_THREAD_ID,
    turnId: CHILD_TURN_ID,
    item: startedFinal,
  });
  emit("item/completed", {
    threadId: CHILD_THREAD_ID,
    turnId: CHILD_TURN_ID,
    item: {
      ...startedFinal,
      text: mode === "wrong-final-text" ? "NOT_OK" : "DELEGATE_OK",
    },
  });
  if (mode === "missing-terminal") return;
  const emitTerminal = () => emit("turn/completed", {
    threadId: CHILD_THREAD_ID,
    turnId: CHILD_TURN_ID,
    turn: interruptTurnEnvelope("completed", CHILD_TURN_ID),
  });
  if (mode === "late-terminal") {
    setImmediate(emitTerminal);
  } else {
    emitTerminal();
  }
  if (mode === "second-thread") {
    emit("turn/started", {
      threadId: "0198-child-thread-2",
      turnId: "0198-child-turn-2",
      turn: interruptTurnEnvelope("inProgress", "0198-child-turn-2"),
    });
  }
}

/** @param {FakeLifecycleClient} client @param {string | undefined} mode @param {string} point */
function emitGenerationFailure(client, mode, point) {
  if (point === "initialize") {
    if (mode === "server-request") {
      client.emit("serverRequest", { method: "item/tool/requestUserInput" });
    } else if (mode === "incident") {
      client.emit("incident", new Error(SECRET));
    } else if (mode === "unexpected-exit") {
      client.emit("exit", { expected: false, error: new Error(SECRET) });
    }
    return;
  }
  if (point === "parent-resume") {
    if (mode === "unknown-notification") {
      client.emit("notification", { method: "future/notification", params: {} });
    } else if (mode === "malformed-notification") {
      client.emit("notification", { method: "warning" });
    } else if (mode === "unclaimed-lifecycle") {
      client.emit("notification", {
        method: "item/completed",
        params: {
          threadId: PARENT_THREAD_ID,
          turnId: "0198-late-turn",
          item: { id: "0198-late-item", type: "reasoning" },
        },
      });
    } else if (mode === "notification-limit") {
      for (let index = 0; index < 2_049; index += 1) {
        client.emit("notification", {
          method: "warning",
          params: { publicIndex: index },
        });
      }
    }
    return;
  }
  if (point === "ephemeral-start") {
    if (mode === "skills-changed") {
      client.emit("notification", { method: "skills/changed", params: {} });
    } else if (mode === "model-rerouted-between-turns") {
      client.emit("notification", { method: "model/rerouted", params: {} });
    }
  }
}

/** @param {FakeLifecycleClient} client @param {string} method @param {string} threadId @param {string} turnId @param {any} item */
function emitItem(client, method, threadId, turnId, item) {
  client.emit("notification", {
    method,
    params: { threadId, turnId, item },
  });
}

/** @param {string} childThreadId @param {Scenario} scenario */
function childResponse(childThreadId, scenario) {
  const index = Number(childThreadId.at(-1));
  const expectedAgentPath = index === 1 ? CHILD_AGENT_PATH : `/root/fixture_agent_${index}`;
  const sourceAgentPath = scenario.childProof === "wrong-agent-path"
    ? "/root/different_agent"
    : expectedAgentPath;
  const parentThreadId = scenario.childProof === "wrong-parent"
    ? "0198-wrong-parent"
    : PARENT_THREAD_ID;
  const turns = childTurns(scenario.childProof);
  return qualifiedResponse({
    id: childThreadId,
    cwd: CWD,
    ephemeral: false,
    path: scenario.childProof === "outside-home"
      ? `/private/other/child-${index}.jsonl`
      : `${CODEX_HOME}/sessions/2026/08/01/child-${index}.jsonl`,
    parentThreadId,
    forkedFromId: scenario.childProof === "wrong-fork" ? PARENT_THREAD_ID : null,
    threadSource: scenario.childProof === "wrong-thread-source" ? "appServer" : "subagent",
    status: { type: scenario.childProof === "active" ? "active" : "idle" },
    source: {
      subAgent: {
        thread_spawn: {
          parent_thread_id: parentThreadId,
          depth: 1,
          agent_path: sourceAgentPath,
          agent_nickname: null,
          agent_role: null,
        },
      },
    },
    turns,
    model: scenario.childProof === "wrong-model" ? "gpt-other" : "gpt-5.6-sol",
    reasoningEffort: scenario.childProof === "wrong-effort" ? "high" : "ultra",
    modelProvider: scenario.childProof === "wrong-provider" ? "other" : "openai",
  });
}

/** @param {string | undefined} proof */
function childTurns(proof) {
  if (proof === "no-turns") return [];
  const status = proof === "in-progress-turn" ? "inProgress" : "completed";
  const items = proof === "no-final"
    ? [{ id: "0198-child-commentary", type: "agentMessage", phase: "commentary", text: "public" }]
    : [
        {
          id: "0198-child-commentary",
          type: "agentMessage",
          phase: "commentary",
          text: "public commentary",
        },
        {
          id: "item-child-final",
          type: "agentMessage",
          phase: "final_answer",
          text: proof === "empty-final"
            ? ""
            : proof === "wrong-final-text"
              ? "NOT_OK"
              : "DELEGATE_OK",
        },
        ...(proof === "two-finals"
          ? [{ id: "0198-child-final-2", type: "agentMessage", phase: "final_answer", text: "public" }]
          : []),
        ...(proof === "mcp-history"
          ? [{ id: "0198-child-mcp", type: "mcpToolCall" }]
          : []),
        ...(proof === "nested-history"
          ? [{ id: "0198-child-nested", type: "subAgentActivity" }]
          : []),
        ...(proof === "unknown-history"
          ? [{ id: "0198-child-unknown", type: "futureCapability" }]
          : []),
      ];
  const turn = {
    id: proof === "wrong-live-turn" ? "0198-wrong-child-turn" : CHILD_TURN_ID,
    status,
    error: proof === "turn-error" ? { message: "public failure" } : null,
    itemsView: proof === "partial-items" ? "summary" : "full",
    items,
  };
  return proof === "extra-turn"
    ? [
        turn,
        {
          id: "0198-child-turn-2",
          status: "completed",
          error: null,
          itemsView: "full",
          items: [],
        },
      ]
    : [turn];
}

/** @param {Scenario} scenario */
function fixtureInterruptTurnId(scenario) {
  return scenario.identityReuse === "interrupt-turn"
    ? RESUMED_TURN_ID
    : INTERRUPT_TURN_ID;
}

/** @param {string} status @param {string} [id] */
function interruptTurnEnvelope(status, id = INTERRUPT_TURN_ID) {
  return {
    id,
    status,
    error: null,
    itemsView: "notLoaded",
    items: [],
  };
}

/** @param {object} options */
function qualifiedResponse({
  id,
  cwd,
  ephemeral,
  path,
  turns,
  parentThreadId = null,
  forkedFromId = null,
  threadSource = "appServer",
  status = { type: "idle" },
  source = "appServer",
  model = "gpt-5.6-sol",
  modelProvider = "openai",
  reasoningEffort = "ultra",
}) {
  return {
    thread: {
      id,
      ephemeral,
      path,
      cwd,
      modelProvider,
      parentThreadId,
      forkedFromId,
      threadSource,
      status,
      source,
      turns,
    },
    model,
    modelProvider,
    reasoningEffort,
    approvalPolicy: "never",
    cwd,
    sandbox: { type: "readOnly", networkAccess: false },
  };
}

/** @param {Promise<unknown>} promise @param {string} code */
async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error instanceof AuthenticatedLifecycleError, true);
    assert.equal(error.code, code);
    const safeSurface = JSON.stringify({
      name: error.name,
      message: error.message,
      code: error.code,
      kind: error.kind,
      details: error.details,
    });
    assert.equal(safeSurface.includes(SECRET), false);
    return true;
  });
}

/** @param {readonly FakeLifecycleClient[]} clients */
function assertAllRetiredAndDetached(clients) {
  for (const client of clients) {
    assert.equal(client.state, "stopped");
    assertNoLifecycleListeners(client);
  }
}

/** @param {FakeLifecycleClient} client */
function assertNoLifecycleListeners(client) {
  for (const event of ["notification", "serverRequest", "incident", "exit"]) {
    assert.equal(client.listenerCount(event), 0, `${event} listener leaked`);
  }
}

/**
 * @typedef {object} Scenario
 * @property {number} [delegatedAgents]
 * @property {string} [delegation]
 * @property {string} [childProof]
 * @property {string} [childLifecycle]
 * @property {string} [generationFailure]
 * @property {string} [identityReuse]
 * @property {string} [interrupt]
 * @property {string | undefined} [materializationPath]
 * @property {string | undefined} [parentResumePath]
 * @property {string} [parentHistory]
 * @property {number} [stopFailureGeneration]
 */

/**
 * @typedef {object} Harness
 * @property {Scenario} scenario
 * @property {FakeLifecycleClient[]} clients
 * @property {Readonly<{generation: number, purpose: string}>[]} factoryContexts
 * @property {any[]} runTurnCalls
 * @property {(context: Readonly<{generation: number, purpose: string}>) => Promise<FakeLifecycleClient>} createClient
 * @property {(options: any) => Promise<any>} runTurn
 */
