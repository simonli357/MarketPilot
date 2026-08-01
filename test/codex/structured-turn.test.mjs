// @ts-check

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { AppServerClient } from "../../src/codex/app-server-client.mjs";
import {
  parseProbeArtifact,
  PROBE_OUTPUT_SCHEMA,
} from "../../src/codex/probe-artifact.mjs";
import {
  FIXTURE_MCP_NAME,
  FIXTURE_MCP_READ_TOOL,
} from "../../src/codex/runtime-policy.mjs";
import {
  isStructuredTurnClientQuarantined,
  runStructuredTurn,
  StructuredTurnError,
} from "../../src/codex/structured-turn.mjs";

const fixturePath = fileURLToPath(
  new URL("../fixtures/fake-app-server.mjs", import.meta.url),
);
const REQUIRED_MCP_TOOL = `${FIXTURE_MCP_NAME}.${FIXTURE_MCP_READ_TOOL}`;

test("accepts one matching completed message only after independent strict parsing", async (context) => {
  const harness = await startHarness(context, "happy");

  const result = await runFixtureTurn(harness);

  assert.deepEqual(result, {
    threadId: "fixture-thread-1",
    turnId: "fixture-turn-1",
    status: "completed",
    finalMessageId: "fixture-agent-message-1",
    artifact: {
      status: "ok",
      summary: "Fixture compatibility contract is intact.",
      checks: [{
        name: "fixture-source",
        passed: true,
        detail: "The fixture contains public, non-sensitive evidence.",
      }],
    },
  });
  assert.equal(harness.client.state, "stopped");
  assert.equal(isStructuredTurnClientQuarantined(harness.client), false);
  assertNoStructuredTurnListeners(harness.client);
});

test("preserves valid lifecycle ordering when notifications overtake the start response", async (context) => {
  const harness = await startHarness(context, "pre-response-ordered");

  const result = await runFixtureTurn(harness);

  assert.equal(result.status, "completed");
  assert.equal(harness.client.state, "stopped");
});

test("rejects an item that overtakes turn/started even when both precede the response", async (context) => {
  const harness = await startHarness(context, "item-before-turn-started");

  await expectCode(runFixtureTurn(harness), "ITEM_BEFORE_TURN_STARTED");
  assert.equal(isStructuredTurnClientQuarantined(harness.client), true);
});

test("rejects terminal completion that overtakes turn/started", async (context) => {
  const harness = await startHarness(context, "terminal-before-turn-started");

  await expectCode(runFixtureTurn(harness), "TERMINAL_BEFORE_TURN_STARTED");
  assert.equal(isStructuredTurnClientQuarantined(harness.client), true);
});

test("stops the owned connection before returning so delayed post-terminal items fail", async (context) => {
  const harness = await startHarness(context, "post-terminal-item");

  await expectCode(runFixtureTurn(harness), "EVENT_AFTER_TERMINAL");
  assert.equal(isStructuredTurnClientQuarantined(harness.client), true);
  assertNoStructuredTurnListeners(harness.client);
});

test("process retirement remains inside the absolute acceptance deadline", async (context) => {
  const harness = await startHarness(context, "slow-stop");

  await expectCode(runFixtureTurn(harness, { deadlineMs: 100 }), "TURN_TIMEOUT");
  assert.equal(isStructuredTurnClientQuarantined(harness.client), true);
  assertNoStructuredTurnListeners(harness.client);
});

test("an accepted turn retires its physical client", async (context) => {
  const harness = await startHarness(context, "happy");
  await runFixtureTurn(harness);

  await expectCode(runFixtureTurn(harness), "CLIENT_RETIRED");
  assert.equal(isStructuredTurnClientQuarantined(harness.client), false);
});

test("rejects unknown outbound input fields before contacting the server", async (context) => {
  const harness = await startHarness(context, "happy");
  await assert.rejects(
    runStructuredTurn({
      client: harness.client,
      threadId: harness.threadId,
      input: [{ type: "text", text: "fixture input only", forbidden: true }],
      outputSchema: PROBE_OUTPUT_SCHEMA,
      parseFinal: parseProbeArtifact,
    }),
    /missing or additional fields/,
  );
  assert.equal(harness.client.state, "running");
});

for (const [scenario, code] of [
  ["invalid-output-json", "OUTPUT_INVALID"],
  ["schema-mismatch", "OUTPUT_INVALID"],
  ["malformed-start-response", "TRANSPORT_PROTOCOL_FAILURE"],
  ["malformed-item", "TRANSPORT_PROTOCOL_FAILURE"],
  ["completion-without-start", "ITEM_STARTED_MISSING"],
  ["dangling-item-start", "ITEM_COMPLETED_MISSING"],
  ["duplicate-item-start", "DUPLICATE_ITEM_STARTED"],
  ["item-lifecycle-mismatch", "ITEM_LIFECYCLE_MISMATCH"],
  ["missing-final", "OUTPUT_AMBIGUOUS"],
  ["ambiguous-final", "OUTPUT_AMBIGUOUS"],
  ["missing-message-phase", "OUTPUT_AMBIGUOUS"],
  ["invalid-message-phase", "AGENT_MESSAGE_PHASE_INVALID"],
  ["interrupted", "TURN_INTERRUPTED"],
  ["rate-limit", "RATE_LIMITED"],
  ["auth-error", "AUTH_REQUIRED"],
  ["remote-rate-limit", "RATE_LIMITED"],
  ["remote-auth-error", "AUTH_REQUIRED"],
  ["mismatched-terminal", "THREAD_ID_MISMATCH"],
  ["conflicting-terminal-item", "TERMINAL_ITEMS_NOT_EMPTY"],
]) {
  test(`${scenario} never returns an accepted artifact`, async (context) => {
    const harness = await startHarness(context, scenario);
    await expectCode(runFixtureTurn(harness), code);
  });
}

test("selects one final-answer message while allowing phased commentary", async (context) => {
  const harness = await startHarness(context, "commentary-before-final");
  const result = await runFixtureTurn(harness);
  assert.equal(result.status, "completed");
  assert.equal(result.finalMessageId, "fixture-agent-message-2");
});

test("ignores a schema-valid unphased message before one explicit final answer", async (context) => {
  const harness = await startHarness(context, "unphased-before-final");

  const result = await runFixtureTurn(harness);

  assert.equal(result.finalMessageId, "fixture-agent-message-2");
  assert.equal(result.status, "completed");
});

test("forbidden MCP tool fails the exact server/tool allowlist", async (context) => {
  const harness = await startHarness(context, "forbidden-tool");
  await expectCode(
    runFixtureTurn(harness, {
      allowedMcpTools: new Set([REQUIRED_MCP_TOOL]),
    }),
    "MCP_TOOL_FORBIDDEN",
  );
});

test("MCP arguments cannot change across the item lifecycle", async (context) => {
  const harness = await startHarness(context, "mcp-lifecycle-arguments-mismatch");
  await expectCode(
    runFixtureTurn(harness, {
      allowedMcpTools: new Set([REQUIRED_MCP_TOOL]),
    }),
    "ITEM_LIFECYCLE_MISMATCH",
  );
});

test("required MCP tool must be observed as a successful completed call", async (context) => {
  const harness = await startHarness(context, "required-tool-success");
  const result = await runFixtureTurn(harness, {
    allowedMcpTools: new Set([REQUIRED_MCP_TOOL]),
    requiredMcpTools: new Set([REQUIRED_MCP_TOOL]),
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(Object.keys(result).sort(), [
    "artifact",
    "finalMessageId",
    "status",
    "threadId",
    "turnId",
  ]);
  assert.equal(harness.client.state, "stopped");
});

test("passes frozen exact MCP evidence to a synchronous completion validator", async (context) => {
  const harness = await startHarness(context, "required-tool-success");
  let calls = 0;
  const result = await runFixtureTurn(harness, {
    allowedMcpTools: new Set([REQUIRED_MCP_TOOL]),
    requiredMcpTools: new Set([REQUIRED_MCP_TOOL]),
    validateMcpCompletion: (evidence) => {
      calls += 1;
      assert.equal(evidence.toolName, REQUIRED_MCP_TOOL);
      assert.deepEqual(evidence.arguments, { fixtureId: "public-event-001" });
      assert.equal(evidence.isError, false);
      assert.equal(evidence.result.structuredContent.fixtureId, "public-event-001");
      assert.equal(evidence.result.structuredContent.sourceClass, "PUBLIC_OFFICIAL");
      assert.equal(Object.isFrozen(evidence), true);
      assert.equal(Object.isFrozen(evidence.result.structuredContent), true);
      assert.equal(Object.isFrozen(evidence.item), true);
      return true;
    },
  });

  assert.equal(result.status, "completed");
  assert.equal(calls, 1);
});

test("completion validator rejection cannot satisfy a required MCP tool", async (context) => {
  const harness = await startHarness(context, "required-tool-success");
  await expectCode(
    runFixtureTurn(harness, {
      allowedMcpTools: new Set([REQUIRED_MCP_TOOL]),
      requiredMcpTools: new Set([REQUIRED_MCP_TOOL]),
      validateMcpCompletion: () => false,
    }),
    "MCP_COMPLETION_REJECTED",
  );
});

test("async completion validators fail closed", async (context) => {
  const harness = await startHarness(context, "required-tool-success");
  await expectCode(
    runFixtureTurn(harness, {
      allowedMcpTools: new Set([REQUIRED_MCP_TOOL]),
      requiredMcpTools: new Set([REQUIRED_MCP_TOOL]),
      validateMcpCompletion: async () => true,
    }),
    "MCP_COMPLETION_VALIDATOR_ASYNC",
  );
});

test("malformed completed MCP evidence fails before required-tool acceptance", async (context) => {
  const harness = await startHarness(context, "required-tool-malformed");
  await expectCode(
    runFixtureTurn(harness, {
      allowedMcpTools: new Set([REQUIRED_MCP_TOOL]),
      requiredMcpTools: new Set([REQUIRED_MCP_TOOL]),
    }),
    "MCP_COMPLETION_RESULT_INVALID",
  );
});

for (const scenario of [
  "conflicting-terminal-mcp",
  "conflicting-terminal-mcp-result",
  "conflicting-terminal-mcp-is-error",
]) {
  test(`${scenario} cannot inject a non-empty terminal item snapshot`, async (context) => {
    const harness = await startHarness(context, scenario);
    await expectCode(
      runFixtureTurn(harness, {
        allowedMcpTools: new Set([REQUIRED_MCP_TOOL]),
        requiredMcpTools: new Set([REQUIRED_MCP_TOOL]),
      }),
      "TERMINAL_ITEMS_NOT_EMPTY",
    );
  });
}

test("attacker-shaped item identifiers are represented only by hashes in details", async (context) => {
  const harness = await startHarness(context, "secret-duplicate-item");
  const error = await captureCode(runFixtureTurn(harness), "DUPLICATE_ITEM");
  const diagnostic = `${error.message} ${JSON.stringify(error.details)}`;
  assert.equal(diagnostic.includes("sk-secret-item-identifier-never-report"), false);
  assert.match(String(error.details.itemIdSha256), /^[a-f0-9]{64}$/);
});

test("attacker-shaped MCP status is represented only by a hash in details", async (context) => {
  const harness = await startHarness(context, "secret-mcp-status");
  const error = await captureCode(
    runFixtureTurn(harness, { allowedMcpTools: new Set([REQUIRED_MCP_TOOL]) }),
    "MCP_COMPLETION_STATUS_INVALID",
  );
  const diagnostic = `${error.message} ${JSON.stringify(error.details)}`;
  assert.equal(diagnostic.includes("sk-secret-status-never-report"), false);
  assert.match(String(error.details.statusSha256), /^[a-f0-9]{64}$/);
});

test("allows at most two exact Sol Ultra delegated receivers", async (context) => {
  const harness = await startHarness(context, "bounded-delegation-success");
  const result = await runFixtureTurn(harness);
  assert.equal(result.status, "completed");
});

test("accepts pinned V2 atomic delegation with an empty-evidence wait item", async (context) => {
  const harness = await startHarness(context, "v2-delegation-success");
  const result = await runFixtureTurn(harness);
  assert.equal(result.status, "completed");
});

test("multiplexed child lifecycle is rejected unless an exact synchronous validator owns it", async (context) => {
  const rejected = await startHarness(context, "foreign-child-lifecycle");
  await expectCode(runFixtureTurn(rejected), "THREAD_ID_MISMATCH");

  const accepted = await startHarness(context, "foreign-child-lifecycle");
  const methods = [];
  const result = await runFixtureTurn(accepted, {
    validateForeignTurnNotification: (notification) => {
      methods.push(notification.method);
      assert.equal(notification.params.threadId, "fixture-child-thread");
      assert.equal(Object.isFrozen(notification), true);
      assert.equal(Object.isFrozen(notification.params), true);
      if (notification.params.item) {
        assert.equal(Object.isFrozen(notification.params.item), true);
      }
      return true;
    },
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(methods, [
    "turn/started",
    "item/started",
    "item/completed",
    "turn/completed",
  ]);
});

test("keeps multiplex listeners alive until delayed child terminal evidence settles", async (context) => {
  const harness = await startHarness(context, "foreign-child-delayed-terminal");
  const methods = [];
  let resolveEvidence;
  const evidence = new Promise((resolve) => {
    resolveEvidence = resolve;
  });

  const result = await runFixtureTurn(harness, {
    validateForeignTurnNotification: (notification) => {
      methods.push(notification.method);
      assert.equal(harness.client.state, "running");
      if (notification.method === "turn/completed") resolveEvidence();
      return true;
    },
    awaitAdditionalEvidence: () => evidence,
  });

  assert.equal(result.status, "completed");
  assert.equal(harness.client.state, "stopped");
  assert.deepEqual(methods, [
    "turn/started",
    "item/started",
    "item/completed",
    "turn/completed",
  ]);
});

test("missing additional evidence fails on the original absolute deadline", async (context) => {
  const harness = await startHarness(context, "happy");
  const startedAt = performance.now();

  await expectCode(
    runFixtureTurn(harness, {
      deadlineMs: 100,
      awaitAdditionalEvidence: () => new Promise(() => {}),
    }),
    "TURN_TIMEOUT",
  );

  assert(performance.now() - startedAt < 700, "additional evidence amplified the deadline");
  assert.equal(harness.client.state, "stopped");
  assert.equal(isStructuredTurnClientQuarantined(harness.client), true);
});

test("additional evidence rejection fails closed without exposing its reason", async (context) => {
  const harness = await startHarness(context, "happy");
  const error = await captureCode(
    runFixtureTurn(harness, {
      awaitAdditionalEvidence: () => Promise.reject(
        new Error("sk-secret-observer-reason-never-report"),
      ),
    }),
    "ADDITIONAL_EVIDENCE_REJECTED",
  );

  assert.equal(
    `${error.message} ${JSON.stringify(error.details)}`.includes(
      "sk-secret-observer-reason-never-report",
    ),
    false,
  );
});

test("an invalid additional-evidence gate cannot start external turn work", async (context) => {
  for (const awaitAdditionalEvidence of [
    () => {
      throw new Error("observer setup failed");
    },
    /** @type {any} */ (() => true),
  ]) {
    const harness = await startHarness(context, "happy");
    const request = harness.client.request.bind(harness.client);
    let turnStartCalls = 0;
    harness.client.request = (method, params, options) => {
      if (method === "turn/start") turnStartCalls += 1;
      return request(method, params, options);
    };
    await expectCode(
      runFixtureTurn(harness, { awaitAdditionalEvidence }),
      "ADDITIONAL_EVIDENCE_REJECTED",
    );
    assert.equal(turnStartCalls, 0, "invalid evidence setup started external turn work");
    assert.equal(harness.client.state, "running");
  }
});

test("additional-evidence setup owns the client and counts against the deadline", async (context) => {
  const harness = await startHarness(context, "happy");
  let nestedTurn;
  const result = await runFixtureTurn(harness, {
    awaitAdditionalEvidence: () => {
      nestedTurn = runFixtureTurn(harness);
      void nestedTurn.catch(() => {});
      return Promise.resolve();
    },
  });
  assert.equal(result.status, "completed");
  await expectCode(nestedTurn, "TURN_ALREADY_ACTIVE");

  const slowHarness = await startHarness(context, "happy");
  const request = slowHarness.client.request.bind(slowHarness.client);
  let turnStartCalls = 0;
  slowHarness.client.request = (method, params, options) => {
    if (method === "turn/start") turnStartCalls += 1;
    return request(method, params, options);
  };
  await expectCode(
    runFixtureTurn(slowHarness, {
      deadlineMs: 50,
      awaitAdditionalEvidence: () => {
        const stopAt = performance.now() + 75;
        while (performance.now() < stopAt) {
          // Deliberately occupy setup to prove the absolute deadline starts first.
        }
        return Promise.resolve();
      },
    }),
    "TURN_TIMEOUT",
  );
  assert.equal(turnStartCalls, 0);
  assert.equal(slowHarness.client.state, "running");
});

test("post-terminal runtime failure rejects a pending evidence gate promptly", async (context) => {
  const harness = await startHarness(context, "happy");
  const startedAt = performance.now();
  await expectCode(
    runFixtureTurn(harness, {
      deadlineMs: 1_000,
      awaitAdditionalEvidence: () => new Promise(() => {}),
      parseFinal: (text) => {
        setTimeout(() => {
          harness.client.emit("incident", new StructuredTurnError(
            "POST_TERMINAL_INCIDENT",
            "Fixture transport incident after primary terminal",
            { kind: "protocol" },
          ));
        }, 20);
        return parseProbeArtifact(text);
      },
    }),
    "POST_TERMINAL_INCIDENT",
  );
  assert(performance.now() - startedAt < 700, "late failure waited for the turn deadline");
  assert.equal(harness.client.state, "stopped");
  assert.equal(isStructuredTurnClientQuarantined(harness.client), true);
});

test("foreign lifecycle validators fail closed on rejection or async output", async (context) => {
  const rejected = await startHarness(context, "foreign-child-lifecycle");
  await expectCode(
    runFixtureTurn(rejected, { validateForeignTurnNotification: () => false }),
    "FOREIGN_NOTIFICATION_REJECTED",
  );

  const asynchronous = await startHarness(context, "foreign-child-lifecycle");
  await expectCode(
    runFixtureTurn(asynchronous, {
      validateForeignTurnNotification: async () => true,
    }),
    "FOREIGN_NOTIFICATION_VALIDATOR_ASYNC",
  );
});

for (const [scenario, code] of [
  ["delegation-over-limit", "DELEGATION_LIMIT_EXCEEDED"],
  ["delegation-wrong-model", "COLLAB_MODEL_FORBIDDEN"],
  ["delegation-unknown-receiver", "COLLAB_RECEIVER_UNKNOWN"],
]) {
  test(`${scenario} fails the bounded delegation contract`, async (context) => {
    const harness = await startHarness(context, scenario);
    await expectCode(runFixtureTurn(harness), code);
  });
}

test("missing required MCP tool rejects an otherwise valid artifact", async (context) => {
  const harness = await startHarness(context, "happy");
  await expectCode(
    runFixtureTurn(harness, {
      allowedMcpTools: new Set([REQUIRED_MCP_TOOL]),
      requiredMcpTools: new Set([REQUIRED_MCP_TOOL]),
    }),
    "REQUIRED_MCP_TOOL_MISSING",
  );
  assert.equal(harness.client.state, "running");
});

test("failed required MCP tool rejects an otherwise valid artifact", async (context) => {
  const harness = await startHarness(context, "required-tool-failed");
  await expectCode(
    runFixtureTurn(harness, {
      allowedMcpTools: new Set([REQUIRED_MCP_TOOL]),
      requiredMcpTools: new Set([REQUIRED_MCP_TOOL]),
    }),
    "REQUIRED_MCP_TOOL_FAILED",
  );
  assert.equal(harness.client.state, "running");
});

test("required MCP tools must be a subset of the exact allowlist", async (context) => {
  const harness = await startHarness(context, "happy");
  await assert.rejects(
    runFixtureTurn(harness, {
      requiredMcpTools: new Set([REQUIRED_MCP_TOOL]),
    }),
    /subset of allowedMcpTools/,
  );
  assert.equal(harness.client.state, "running");
});

test("forbidden item type fails closed", async (context) => {
  const harness = await startHarness(context, "forbidden-item");
  await expectCode(runFixtureTurn(harness), "ITEM_FORBIDDEN");
});

test("pre-start notification floods are bounded and quarantine the client", async (context) => {
  const harness = await startHarness(context, "notification-flood");
  await expectCode(runFixtureTurn(harness), "PRESTART_BUFFER_LIMIT_EXCEEDED");
  assert.equal(isStructuredTurnClientQuarantined(harness.client), true);
  assert.notEqual(harness.client.state, "running");
});

test("server-initiated approval request fails closed", async (context) => {
  const harness = await startHarness(context, "unexpected-server-request");
  await expectCode(runFixtureTurn(harness), "SERVER_REQUEST_FORBIDDEN");
});

test("a permissive transport handler is rejected before it can receive a server request", async (context) => {
  let handlerCalls = 0;
  const harness = await startHarness(context, "unexpected-server-request", {
    serverRequestHandler: () => {
      handlerCalls += 1;
      return { approved: true };
    },
  });
  await expectCode(runFixtureTurn(harness), "SERVER_REQUEST_POLICY_UNSAFE");
  assert.equal(handlerCalls, 0);
  assert.equal(harness.client.state, "running");
});

test("model reroute fails before its otherwise valid terminal output", async (context) => {
  const harness = await startHarness(context, "reroute");
  await expectCode(runFixtureTurn(harness), "MODEL_REROUTED");
});

test("terminal deadline interrupts a hanging turn but still reports timeout", async (context) => {
  const harness = await startHarness(context, "timeout");
  await expectCode(runFixtureTurn(harness, { deadlineMs: 150 }), "TURN_TIMEOUT");
  assert.equal(harness.client.state, "stopped");
  assert.equal(isStructuredTurnClientQuarantined(harness.client), true);
  assertNoStructuredTurnListeners(harness.client);
  await expectCode(runFixtureTurn(harness), "CLIENT_QUARANTINED");
});

test("a second top-level turn cannot attach to the same client", async (context) => {
  const harness = await startHarness(context, "timeout");
  const first = expectCode(runFixtureTurn(harness, { deadlineMs: 150 }), "TURN_TIMEOUT");
  await expectCode(runFixtureTurn(harness), "TURN_ALREADY_ACTIVE");
  await first;
});

test("caller abort quarantines uncertain work and releases every listener", async (context) => {
  const harness = await startHarness(context, "timeout");
  const controller = new AbortController();
  const turn = runFixtureTurn(harness, { signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await expectCode(turn, "TURN_ABORTED");
  assert.equal(isStructuredTurnClientQuarantined(harness.client), true);
  assert.notEqual(harness.client.state, "running");
  assertNoStructuredTurnListeners(harness.client);
});

test("an async artifact parser is rejected without accepting its promise", async (context) => {
  const harness = await startHarness(context, "happy");
  await expectCode(
    runFixtureTurn(harness, { parseFinal: async () => ({ status: "ok" }) }),
    "OUTPUT_INVALID",
  );
  assert.equal(harness.client.state, "running");
});

test("artifact acceptance cannot cross the absolute deadline during parsing", async (context) => {
  const harness = await startHarness(context, "happy");
  await expectCode(
    runFixtureTurn(harness, {
      deadlineMs: 200,
      parseFinal: (text) => {
        const stopAt = performance.now() + 250;
        while (performance.now() < stopAt) {
          // Deliberately occupy the event loop to verify the post-parse check.
        }
        return parseProbeArtifact(text);
      },
    }),
    "TURN_TIMEOUT",
  );
  assert.equal(isStructuredTurnClientQuarantined(harness.client), true);
});

test("process crash cannot produce an accepted artifact", async (context) => {
  const harness = await startHarness(context, "crash");
  await expectCode(runFixtureTurn(harness), "APP_SERVER_UNAVAILABLE");
  assert.equal(isStructuredTurnClientQuarantined(harness.client), true);
  assertNoStructuredTurnListeners(harness.client);
});

test("duplicate response ID wins over later turn output in the same stdout batch", async (context) => {
  const harness = await startHarness(context, "duplicate-response");
  await expectCode(runFixtureTurn(harness), "TRANSPORT_PROTOCOL_FAILURE");
});

test("malformed JSONL is a transport failure, never an output-schema failure", async (context) => {
  const harness = await startHarness(context, "malformed-json");
  await expectCode(runFixtureTurn(harness), "TRANSPORT_PROTOCOL_FAILURE");
});

/**
 * @param {import("node:test").TestContext} context
 * @param {string} scenario
 */
async function startHarness(context, scenario, clientOptions = {}) {
  const client = new AppServerClient({
    command: process.execPath,
    args: [fixturePath],
    env: {
      PATH: process.env.PATH,
      MARKETPILOT_FAKE_APP_SERVER_SCENARIO: scenario,
    },
    requestTimeoutMs: 1_000,
    stopTimeoutMs: 200,
    ...clientOptions,
  });
  context.after(async () => {
    await client.stop();
  });
  await client.start();
  await client.request("initialize", {
    clientInfo: { name: "marketpilot-structured-turn-test", version: "1.0.0" },
  });
  await client.notify("initialized", {});
  const response = await client.request("thread/start", {
    model: "gpt-5.6-sol",
    reasoningEffort: "ultra",
    ephemeral: true,
  });
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new TypeError("fixture thread/start response is invalid");
  }
  const thread = Reflect.get(response, "thread");
  if (!thread || typeof thread !== "object" || Array.isArray(thread)) {
    throw new TypeError("fixture thread/start thread is invalid");
  }
  return { client, threadId: Reflect.get(thread, "id") };
}

/**
 * @param {{client: AppServerClient, threadId: string}} harness
 * @param {{
 *   deadlineMs?: number,
 *   allowedMcpTools?: ReadonlySet<string>,
 *   requiredMcpTools?: ReadonlySet<string>,
 *   validateMcpCompletion?: (evidence: any) => boolean | void,
 *   validateForeignTurnNotification?: (notification: any) => boolean | void,
 *   awaitAdditionalEvidence?: () => Promise<void>,
 *   parseFinal?: (text: string) => unknown,
 *   signal?: AbortSignal
 * }} [options]
 */
function runFixtureTurn(harness, options = {}) {
  return runStructuredTurn({
    client: harness.client,
    threadId: harness.threadId,
    input: [{ type: "text", text: "Use the fixture and return the required artifact." }],
    outputSchema: PROBE_OUTPUT_SCHEMA,
    parseFinal: options.parseFinal ?? parseProbeArtifact,
    deadlineMs: options.deadlineMs ?? 1_000,
    signal: options.signal,
    allowedMcpTools: options.allowedMcpTools ?? new Set(),
    requiredMcpTools: options.requiredMcpTools ?? new Set(),
    validateMcpCompletion: options.validateMcpCompletion,
    validateForeignTurnNotification: options.validateForeignTurnNotification,
    awaitAdditionalEvidence: options.awaitAdditionalEvidence,
  });
}

/** @param {AppServerClient} client */
function assertNoStructuredTurnListeners(client) {
  for (const event of ["notification", "serverRequest", "incident", "exit"]) {
    assert.equal(client.listenerCount(event), 0, `${event} listener leaked`);
  }
}

/** @param {Promise<unknown>} promise @param {string} code */
async function expectCode(promise, code) {
  await captureCode(promise, code);
}

/** @param {Promise<unknown>} promise @param {string} code */
async function captureCode(promise, code) {
  let captured;
  await assert.rejects(
    promise,
    (error) => {
      assert(error instanceof StructuredTurnError);
      assert.equal(error.code, code);
      captured = error;
      return true;
    },
  );
  return captured;
}
