// @ts-check

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { AppServerClient } from "../../src/codex/app-server-client.mjs";
import {
  parseProbeArtifact,
  PROBE_OUTPUT_SCHEMA,
} from "../../src/codex/probe-artifact.mjs";
import {
  CodexProcessSupervisor,
  CodexProcessSupervisorError,
} from "../../src/codex/process-supervisor.mjs";
import { runStructuredTurn } from "../../src/codex/structured-turn.mjs";

const fixturePath = fileURLToPath(
  new URL("../fixtures/fake-app-server.mjs", import.meta.url),
);

test("accepts only after expected retirement and fences the returned artifact key", async () => {
  const runtime = new ManualRuntime();
  const clients = [];
  let acceptanceCalls = 0;
  const supervisor = makeSupervisor(runtime, ({ generation }) => {
    const client = new FakeClient(`client-${generation}`, runtime.log);
    clients.push(client);
    return client;
  });

  const accepted = await supervisor.run({
    idempotencyKey: "public-fixture-accept-1",
    runAttempt: async ({ client }) => {
      assert.equal(client.state, "running");
      return Object.freeze({ artifact: "fixture-artifact" });
    },
    accept: ({ candidate }) => {
      acceptanceCalls += 1;
      assert.equal(clients[0].state, "stopped");
      return Object.freeze({ committed: candidate.artifact });
    },
  });

  assert.deepEqual(accepted, { committed: "fixture-artifact" });
  assert.equal(acceptanceCalls, 1);
  assert.equal(clients[0].closed, true);
  assert.equal(clients[0].listenerCount("exit"), 0);
  assert.deepEqual(pickSnapshot(supervisor.snapshot()), {
    lifecycle: "open",
    runActive: false,
    circuit: "closed",
    crashCount: 0,
    acceptedKeyCount: 1,
    uncertainKeyCount: 0,
    fencedKeyCount: 1,
  });

  const fenced = await captureCode(
    supervisor.run({
      idempotencyKey: "public-fixture-accept-1",
      runAttempt: () => assert.fail("a fenced key must not launch"),
      accept: () => assert.fail("a fenced key must not commit twice"),
    }),
    "IDEMPOTENCY_KEY_FENCED",
  );
  assert.equal(acceptanceCalls, 1);
  assert.equal(clients.length, 1);
  assert.match(String(fenced.details.idempotencyKeySha256), /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(fenced.details).includes("public-fixture-accept-1"), false);
});

test("typed process start failures close fresh clients before 1s and 5s retries", async () => {
  const runtime = new ManualRuntime();
  const clients = [];
  let acceptanceCalls = 0;
  const supervisor = makeSupervisor(runtime, ({ generation }) => {
    if (clients.some((client) => !client.closed)) {
      assert.fail("a replacement was created before its predecessor closed");
    }
    const attemptIndex = clients.length;
    const client = new FakeClient(`client-${generation}`, runtime.log, {
      startBehavior: attemptIndex < 2
        ? () => {
            throw new ProcessFailure(
              "secret spawn diagnostic",
              attemptIndex === 0 ? "PROCESS_ERROR" : "PROCESS_WRITE_FAILED",
            );
          }
        : undefined,
    });
    clients.push(client);
    return client;
  });

  const run = supervisor.run({
    idempotencyKey: "retry-then-accept",
    runAttempt: () => ({ artifact: "fresh" }),
    accept: ({ candidate }) => {
      acceptanceCalls += 1;
      return candidate;
    },
  });

  await runtime.waitForPending(1);
  assert.equal(clients[0].closed, true);
  await runtime.fireNext();
  await runtime.waitForPending(1);
  assert.equal(clients[1].closed, true);
  await runtime.fireNext();

  assert.deepEqual(await run, { artifact: "fresh" });
  assert.deepEqual(runtime.retryDelays(), [1_000, 5_000]);
  assert.equal(clients.length, 3);
  assert.equal(new Set(clients).size, 3);
  assert.equal(acceptanceCalls, 1);
  assert.equal(supervisor.snapshot().crashCount, 2);
});

test("a still-active ten-minute generation resets crash history through one fenced timer", async () => {
  const runtime = new ManualRuntime();
  const longAttempt = deferred();
  const clients = [];
  let factoryCalls = 0;
  const supervisor = makeSupervisor(runtime, ({ generation }) => {
    factoryCalls += 1;
    const client = new FakeClient(`client-${generation}`, runtime.log, {
      startBehavior: factoryCalls === 1
        ? () => { throw new ProcessFailure("first crash"); }
        : undefined,
    });
    clients.push(client);
    return client;
  });
  const run = supervisor.run({
    idempotencyKey: "stable-reset",
    runAttempt: ({ generation }) => generation === 2
      ? longAttempt.promise
      : { artifact: "after-stable-reset" },
    accept: ({ candidate }) => candidate,
  });

  await runtime.waitForDelay(1_000);
  await runtime.fireDelay(1_000);
  await runtime.waitForDelay(600_000);
  await runtime.fireDelay(600_000);
  assert.equal(supervisor.snapshot().crashCount, 0);

  clients[1].crash(new ProcessFailure("crash after stable interval"));
  await runtime.waitForDelay(1_000);
  await runtime.fireDelay(1_000);
  assert.deepEqual(await run, { artifact: "after-stable-reset" });
  assert.deepEqual(runtime.retryDelays(), [1_000, 1_000]);
  assert.equal(supervisor.snapshot().crashCount, 1);

  longAttempt.resolve({ artifact: "late-old-generation" });
  await flushTurns();
});

test("an unexpected exit wins once, closes, and fences a late generation result", async () => {
  const runtime = new ManualRuntime();
  const stale = deferred();
  const acceptedCandidates = [];
  const clients = [];
  const supervisor = makeSupervisor(runtime, ({ generation }) => {
    if (generation > 1) assert.equal(clients.at(-1)?.closed, true);
    const client = new FakeClient(`client-${generation}`, runtime.log);
    clients.push(client);
    return client;
  });

  const run = supervisor.run({
    idempotencyKey: "generation-fence",
    runAttempt: ({ client, generation }) => {
      if (generation === 1) {
        queueMicrotask(() => {
          client.emit("incident", new Error("sk-secret-incident"));
          client.crash(new ProcessFailure("sk-secret-crash"));
        });
        return stale.promise;
      }
      return { artifact: "current-generation" };
    },
    accept: ({ candidate }) => {
      acceptedCandidates.push(candidate.artifact);
      return candidate;
    },
  });

  await runtime.waitForPending(1);
  assert.equal(clients[0].closed, true);
  assertOrder(runtime.log, "client-1:stop", "schedule:1000");
  await runtime.fireNext();
  assert.deepEqual(await run, { artifact: "current-generation" });

  stale.resolve({ artifact: "stale-generation" });
  await flushTurns();
  assert.deepEqual(acceptedCandidates, ["current-generation"]);
  assert.equal(supervisor.snapshot().crashCount, 1);
  assert.equal(clients[0].listenerCount("exit"), 0);
});

test("three crashes in ten minutes open the circuit until idle operator reset", async () => {
  const runtime = new ManualRuntime();
  let factoryCalls = 0;
  const supervisor = makeSupervisor(runtime, ({ generation }) => {
    factoryCalls += 1;
    return new FakeClient(`client-${generation}`, runtime.log, {
      startBehavior: factoryCalls <= 3
        ? () => { throw new ProcessFailure("private crash text"); }
        : undefined,
    });
  });

  const run = supervisor.run({
    idempotencyKey: "open-circuit",
    runAttempt: () => ({ artifact: "not-before-reset" }),
    accept: ({ candidate }) => candidate,
  });
  const circuitResult = captureCode(run, "CRASH_CIRCUIT_OPEN");
  await runtime.waitForPending(1);
  await runtime.fireNext();
  await runtime.waitForPending(1);
  await runtime.fireNext();

  const circuit = await circuitResult;
  assert.deepEqual(runtime.retryDelays(), [1_000, 5_000]);
  assert.equal(factoryCalls, 3);
  assert.equal(circuit.details.crashCount, 3);
  assert.equal(circuit.details.waitMs, 30_000);
  assert.equal(supervisor.snapshot().circuit, "open");

  assert.throws(
    () => supervisor.resetOpenCircuit(),
    (error) => hasCode(error, "CIRCUIT_RESET_COOLDOWN"),
  );
  runtime.nowMs = 36_000;
  assert.equal(supervisor.resetOpenCircuit().circuit, "closed");
  assert.equal(supervisor.snapshot().crashCount, 0);

  const accepted = await supervisor.run({
    idempotencyKey: "after-operator-reset",
    runAttempt: () => ({ artifact: "after-reset" }),
    accept: ({ candidate }) => candidate,
  });
  assert.deepEqual(accepted, { artifact: "after-reset" });
  assert.equal(factoryCalls, 4);
});

test("expected client retirement is not a crash", async () => {
  const runtime = new ManualRuntime();
  const supervisor = makeSupervisor(
    runtime,
    ({ generation }) => new FakeClient(`client-${generation}`, runtime.log),
  );

  const result = await supervisor.run({
    idempotencyKey: "expected-retirement",
    runAttempt: async ({ client }) => {
      await client.stop();
      return { artifact: "retired" };
    },
    accept: ({ candidate }) => candidate,
  });

  assert.deepEqual(result, { artifact: "retired" });
  assert.equal(supervisor.snapshot().crashCount, 0);
  assert.deepEqual(runtime.retryDelays(), []);
});

test("a non-retryable terminal exit during close vetoes an already-settled candidate", async () => {
  const runtime = new ManualRuntime();
  let acceptanceCalls = 0;
  const client = new FakeClient("late-service-exit", runtime.log, {
    stopBehavior: (stoppingClient) => {
      stoppingClient.closed = true;
      stoppingClient.state = "failed";
      stoppingClient.emit("exit", {
        expected: false,
        error: new ServiceFailure("SERVICE_UNAVAILABLE", "sk-secret-service-exit"),
      });
    },
  });
  const supervisor = makeSupervisor(runtime, () => client);

  const error = await captureCode(
    supervisor.run({
      idempotencyKey: "late-service-exit",
      runAttempt: () => ({ artifact: "must-not-be-accepted" }),
      accept: () => {
        acceptanceCalls += 1;
        return "forbidden";
      },
    }),
    "ATTEMPT_FAILED",
  );

  assert.equal(acceptanceCalls, 0);
  assert.equal(client.state, "failed");
  assert.equal(client.closed, true);
  assert.equal(client.listenerCount("exit"), 0);
  assert.deepEqual(runtime.retryDelays(), []);
  assert.equal(supervisor.snapshot().crashCount, 0);
  assert.equal(JSON.stringify(error.details).includes("sk-secret"), false);
});

test("a real crashed app-server is fully retired before one fresh replacement is accepted", async (context) => {
  const runtime = new ManualRuntime();
  const retryScheduled = deferred();
  const operationController = new AbortController();
  const clients = [];
  const fullyStoppedGenerations = new Set();
  let acceptanceCalls = 0;

  const supervisor = new CodexProcessSupervisor({
    createClient: ({ generation }) => {
      if (generation === 2) {
        assert.equal(
          fullyStoppedGenerations.has(1),
          true,
          "replacement started before the crashed process group was conclusively retired",
        );
      }
      const client = new StopTrackedAppServerClient({
        command: process.execPath,
        args: [fixturePath],
        env: {
          PATH: process.env.PATH,
          MARKETPILOT_FAKE_APP_SERVER_SCENARIO: generation === 1 ? "crash" : "happy",
        },
        requestTimeoutMs: 1_000,
        stopTimeoutMs: 200,
      }, () => fullyStoppedGenerations.add(generation));
      clients.push(client);
      return client;
    },
    clock: { nowMs: () => runtime.nowMs },
    scheduler: {
      schedule: (delayMs, callback) => {
        const handle = runtime.schedule(delayMs, callback);
        if (delayMs === 1_000) retryScheduled.resolve();
        return handle;
      },
    },
  });
  /** @type {Promise<unknown> | undefined} */
  let operation;
  context.after(async () => {
    operationController.abort();
    await Promise.allSettled([
      operation ?? Promise.resolve(),
      ...clients.map((client) => client.stop()),
    ]);
    await supervisor.shutdown();
  });

  operation = supervisor.run({
    idempotencyKey: "real-child-crash-replacement",
    signal: operationController.signal,
    runAttempt: ({ client, signal }) => runRealFixtureTurn(client, signal),
    accept: ({ candidate }) => {
      acceptanceCalls += 1;
      assert.equal(clients.length, 2);
      assert.equal(clients[1].state, "stopped");
      return candidate;
    },
  });
  void operation.catch(() => {});

  await within(retryScheduled.promise, 3_000, "real child did not reach retry backoff");
  assert.equal(clients.length, 1);
  assert.equal(fullyStoppedGenerations.has(1), true);
  assert.notEqual(clients[0].state, "running");
  await runtime.fireDelay(1_000);

  const accepted = await within(operation, 3_000, "replacement did not finish");
  assert.equal(accepted.artifact.status, "ok");
  assert.equal(acceptanceCalls, 1);
  assert.equal(clients.length, 2);
  assert.equal(new Set(clients).size, 2);
  assert.equal(fullyStoppedGenerations.has(2), true);
  assert.deepEqual(runtime.retryDelays(), [1_000]);
  assert.equal(supervisor.snapshot().crashCount, 1);
});

test("auth and arbitrary start failures close without retry or attacker text", async (t) => {
  for (const fixture of [
    {
      name: "auth run failure",
      startBehavior: undefined,
      runAttempt: () => { throw new ServiceFailure("AUTH_REQUIRED", "sk-secret-auth"); },
      failureClass: "auth",
    },
    {
      name: "untyped start failure",
      startBehavior: () => { throw new Error("sk-secret-start"); },
      runAttempt: () => assert.fail("runAttempt must not follow failed start"),
      failureClass: "unknown",
    },
    {
      name: "qualification process failure",
      startBehavior: () => {
        throw new ProcessFailure("sk-secret-qualification", "SPAWN_QUALIFICATION_FAILED");
      },
      runAttempt: () => assert.fail("runAttempt must not follow failed qualification"),
      failureClass: "unknown",
    },
  ]) {
    await t.test(fixture.name, async () => {
      const runtime = new ManualRuntime();
      let factoryCalls = 0;
      const supervisor = makeSupervisor(runtime, ({ generation }) => {
        factoryCalls += 1;
        return new FakeClient(`client-${generation}`, runtime.log, {
          startBehavior: fixture.startBehavior,
        });
      });

      const error = await captureCode(
        supervisor.run({
          idempotencyKey: `non-retry-${fixture.name}`,
          runAttempt: fixture.runAttempt,
          accept: () => assert.fail("failed work must not be accepted"),
        }),
        "ATTEMPT_FAILED",
      );
      assert.equal(error.details.failureClass, fixture.failureClass);
      assert.equal(factoryCalls, 1);
      assert.equal(supervisor.snapshot().crashCount, 0);
      assert.deepEqual(runtime.retryDelays(), []);
      const diagnostic = `${error.message} ${JSON.stringify(error.details)}`;
      assert.equal(diagnostic.includes("sk-secret"), false);
    });
  }
});

test("throwing process-classification getters fail closed without stranding an attempt", async (t) => {
  for (const property of ["kind", "code"]) {
    await t.test(`${property} getter`, async () => {
      const runtime = new ManualRuntime();
      const controller = new AbortController();
      const client = new FakeClient(`throwing-${property}`, runtime.log);
      const supervisor = makeSupervisor(runtime, () => client);
      const failure = new Error("sk-secret-classification");
      Object.defineProperties(failure, {
        kind: property === "kind"
          ? { get: () => { throw new Error("sk-secret-kind-getter"); } }
          : { value: "process" },
        code: property === "code"
          ? { get: () => { throw new Error("sk-secret-code-getter"); } }
          : { value: "APP_SERVER_UNAVAILABLE" },
      });
      const watchdog = setTimeout(() => controller.abort(), 250);
      try {
        const error = await captureCode(
          supervisor.run({
            idempotencyKey: `throwing-${property}-getter`,
            signal: controller.signal,
            runAttempt: () => { throw failure; },
            accept: () => assert.fail("unclassified work must not be accepted"),
          }),
          "ATTEMPT_FAILED",
        );
        assert.equal(error.details.failureClass, "unknown");
        assert.equal(client.closed, true);
        assert.equal(client.listenerCount("exit"), 0);
        assert.deepEqual(runtime.retryDelays(), []);
        assert.equal(JSON.stringify(error.details).includes("sk-secret"), false);
      } finally {
        clearTimeout(watchdog);
        await supervisor.shutdown();
      }
    });
  }
});

test("ownership and process-group exit failures never authorize a replacement", async () => {
  const runtime = new ManualRuntime();
  const pending = deferred();
  let factoryCalls = 0;
  const supervisor = makeSupervisor(runtime, ({ generation }) => {
    factoryCalls += 1;
    return new FakeClient(`client-${generation}`, runtime.log);
  });
  const run = supervisor.run({
    idempotencyKey: "group-cleanup-failure",
    runAttempt: ({ client }) => {
      queueMicrotask(() => client.crash(new ProcessFailure(
        "sk-secret-group-state",
        "PROCESS_GROUP_CLEANUP_TIMEOUT",
      )));
      return pending.promise;
    },
    accept: () => assert.fail("unsafe exit must not be accepted"),
  });
  const error = await captureCode(run, "ATTEMPT_FAILED");
  assert.equal(error.details.failureClass, "unknown");
  assert.equal(factoryCalls, 1);
  assert.equal(supervisor.snapshot().crashCount, 0);
  assert.deepEqual(runtime.retryDelays(), []);
  assert.equal(JSON.stringify(error.details).includes("sk-secret"), false);
  pending.resolve({ artifact: "late" });
  await flushTurns();
});

test("run abort stops one active generation, rejects overlap, and returns to reusable idle", async () => {
  const runtime = new ManualRuntime();
  const late = deferred();
  const controller = new AbortController();
  let factoryCalls = 0;
  let acceptanceCalls = 0;
  const supervisor = makeSupervisor(runtime, ({ generation }) => {
    factoryCalls += 1;
    return new FakeClient(`client-${generation}`, runtime.log);
  });

  const first = supervisor.run({
    idempotencyKey: "abort-active",
    signal: controller.signal,
    runAttempt: () => late.promise,
    accept: () => {
      acceptanceCalls += 1;
      return "never";
    },
  });
  await waitFor(() => supervisor.snapshot().activeAttemptGeneration !== null);
  await expectCode(
    supervisor.run({
      idempotencyKey: "overlap",
      runAttempt: () => "never",
      accept: () => "never",
    }),
    "RUN_ALREADY_ACTIVE",
  );
  assert.throws(
    () => supervisor.resetOpenCircuit(),
    (error) => hasCode(error, "CIRCUIT_RESET_BUSY"),
  );

  controller.abort();
  await expectCode(first, "OPERATION_ABORTED");
  late.resolve({ artifact: "late" });
  await flushTurns();
  assert.equal(acceptanceCalls, 0);
  assert.equal(supervisor.snapshot().lifecycle, "open");
  assert.equal(supervisor.snapshot().runActive, false);

  const later = await supervisor.run({
    idempotencyKey: "after-abort",
    runAttempt: () => ({ artifact: "later" }),
    accept: ({ candidate }) => candidate,
  });
  assert.deepEqual(later, { artifact: "later" });
  assert.equal(factoryCalls, 2);
});

test("run abort disposes pending backoff and a canceled callback cannot relaunch", async () => {
  const runtime = new ManualRuntime();
  const controller = new AbortController();
  let factoryCalls = 0;
  const supervisor = makeSupervisor(runtime, ({ generation }) => {
    factoryCalls += 1;
    return new FakeClient(`client-${generation}`, runtime.log, {
      startBehavior: factoryCalls === 1
        ? () => { throw new ProcessFailure("first crash"); }
        : undefined,
    });
  });

  const run = supervisor.run({
    idempotencyKey: "abort-backoff",
    signal: controller.signal,
    runAttempt: () => ({ artifact: "later" }),
    accept: ({ candidate }) => candidate,
  });
  const task = await runtime.waitForPending(1);
  controller.abort();
  await expectCode(run, "OPERATION_ABORTED");
  assert.equal(task.cancelled, true);
  task.callback();
  await flushTurns();
  assert.equal(factoryCalls, 1);
  assert.equal(supervisor.snapshot().pendingBackoff, false);
  assert.equal(supervisor.snapshot().lifecycle, "open");

  runtime.nowMs = 1_000;
  const later = await supervisor.run({
    idempotencyKey: "after-backoff-abort",
    runAttempt: () => ({ artifact: "later" }),
    accept: ({ candidate }) => candidate,
  });
  assert.deepEqual(later, { artifact: "later" });
  assert.equal(factoryCalls, 2);
});

test("permanent shutdown cancels backoff and forbids every later launch", async () => {
  const runtime = new ManualRuntime();
  let factoryCalls = 0;
  const supervisor = makeSupervisor(runtime, ({ generation }) => {
    factoryCalls += 1;
    return new FakeClient(`client-${generation}`, runtime.log, {
      startBehavior: () => { throw new ProcessFailure("crash before shutdown"); },
    });
  });
  const run = supervisor.run({
    idempotencyKey: "shutdown-backoff",
    runAttempt: () => "never",
    accept: () => "never",
  });
  const task = await runtime.waitForPending(1);

  await supervisor.shutdown();
  await expectCode(run, "SUPERVISOR_SHUTDOWN");
  assert.equal(task.cancelled, true);
  task.callback();
  await flushTurns();
  assert.equal(factoryCalls, 1);
  assert.equal(supervisor.snapshot().lifecycle, "shutdown");
  await expectCode(
    supervisor.run({
      idempotencyKey: "after-shutdown",
      runAttempt: () => "never",
      accept: () => "never",
    }),
    "SUPERVISOR_SHUTDOWN",
  );
});

test("acceptance throw permanently fences an uncertain key without leaking content", async () => {
  const runtime = new ManualRuntime();
  let factoryCalls = 0;
  let acceptanceCalls = 0;
  const supervisor = makeSupervisor(
    runtime,
    ({ generation }) => {
      factoryCalls += 1;
      return new FakeClient(`client-${generation}`, runtime.log);
    },
  );
  const error = await captureCode(
    supervisor.run({
      idempotencyKey: "private-operation-key",
      runAttempt: () => ({ artifact: "sk-secret-candidate" }),
      accept: () => {
        acceptanceCalls += 1;
        throw new Error("sk-secret-after-commit");
      },
    }),
    "ACCEPTANCE_UNCERTAIN",
  );

  assert.equal(acceptanceCalls, 1);
  assert.equal(supervisor.snapshot().uncertainKeyCount, 1);
  const diagnostic = `${error.message} ${JSON.stringify(error.details)}`;
  assert.equal(diagnostic.includes("sk-secret"), false);
  assert.equal(diagnostic.includes("private-operation-key"), false);
  await expectCode(
    supervisor.run({
      idempotencyKey: "private-operation-key",
      runAttempt: () => "duplicate",
      accept: () => { acceptanceCalls += 1; },
    }),
    "IDEMPOTENCY_KEY_FENCED",
  );
  assert.equal(acceptanceCalls, 1);
  assert.equal(factoryCalls, 1);
});

test("acceptance timeout fences an ignoring callback and leaves the supervisor reusable", async () => {
  const runtime = new ManualRuntime();
  const never = deferred();
  const supervisor = makeSupervisor(
    runtime,
    ({ generation }) => new FakeClient(`client-${generation}`, runtime.log),
    { acceptanceTimeoutMs: 50 },
  );
  const run = supervisor.run({
    idempotencyKey: "acceptance-timeout",
    runAttempt: () => ({ artifact: "candidate" }),
    accept: () => never.promise,
  });
  const result = captureCode(run, "ACCEPTANCE_TIMEOUT_UNCERTAIN");
  await runtime.waitForDelay(50);
  await runtime.fireDelay(50);
  await result;
  assert.equal(supervisor.snapshot().uncertainKeyCount, 1);
  assert.equal(supervisor.snapshot().lifecycle, "open");

  const other = await supervisor.run({
    idempotencyKey: "after-acceptance-timeout",
    runAttempt: () => ({ artifact: "other" }),
    accept: ({ candidate }) => candidate,
  });
  assert.deepEqual(other, { artifact: "other" });
});

test("shutdown settles while an acceptance callback ignores its aborted signal", async () => {
  const runtime = new ManualRuntime();
  const never = deferred();
  const supervisor = makeSupervisor(
    runtime,
    ({ generation }) => new FakeClient(`client-${generation}`, runtime.log),
    { acceptanceTimeoutMs: 50 },
  );
  const run = supervisor.run({
    idempotencyKey: "shutdown-during-acceptance",
    runAttempt: () => ({ artifact: "candidate" }),
    accept: () => never.promise,
  });
  const result = captureCode(run, "ACCEPTANCE_ABORTED_UNCERTAIN");
  const task = await runtime.waitForDelay(50);

  await supervisor.shutdown();
  await result;
  assert.equal(task.cancelled, true);
  assert.equal(supervisor.snapshot().uncertainKeyCount, 1);
  assert.equal(supervisor.snapshot().lifecycle, "shutdown");
});

test("abort during acceptance fences a completed commit but does not poison other keys", async () => {
  const runtime = new ManualRuntime();
  const controller = new AbortController();
  const accepting = deferred();
  const acceptanceStarted = deferred();
  let acceptanceCalls = 0;
  const supervisor = makeSupervisor(
    runtime,
    ({ generation }) => new FakeClient(`client-${generation}`, runtime.log),
  );
  const run = supervisor.run({
    idempotencyKey: "abort-during-accept",
    signal: controller.signal,
    runAttempt: () => ({ artifact: "candidate" }),
    accept: async () => {
      acceptanceCalls += 1;
      acceptanceStarted.resolve();
      return accepting.promise;
    },
  });
  await acceptanceStarted.promise;
  controller.abort();
  accepting.resolve({ committed: true });

  await expectCode(run, "ACCEPTANCE_ABORTED_UNCERTAIN");
  assert.equal(acceptanceCalls, 1);
  assert.equal(supervisor.snapshot().uncertainKeyCount, 1);
  assert.equal(supervisor.snapshot().lifecycle, "open");
  await expectCode(
    supervisor.run({
      idempotencyKey: "abort-during-accept",
      runAttempt: () => "duplicate",
      accept: () => { acceptanceCalls += 1; },
    }),
    "IDEMPOTENCY_KEY_FENCED",
  );
  const other = await supervisor.run({
    idempotencyKey: "other-after-accept-abort",
    runAttempt: () => ({ artifact: "other" }),
    accept: ({ candidate }) => candidate,
  });
  assert.deepEqual(other, { artifact: "other" });
});

test("bounded acceptance fences fail closed without eviction", async () => {
  const runtime = new ManualRuntime();
  let factoryCalls = 0;
  const supervisor = makeSupervisor(
    runtime,
    ({ generation }) => {
      factoryCalls += 1;
      return new FakeClient(`client-${generation}`, runtime.log);
    },
    { maxAcceptanceKeys: 2 },
  );
  for (const key of ["capacity-1", "capacity-2"]) {
    await supervisor.run({
      idempotencyKey: key,
      runAttempt: () => ({ artifact: key }),
      accept: ({ candidate }) => candidate,
    });
  }
  const capacity = await captureCode(
    supervisor.run({
      idempotencyKey: "capacity-3",
      runAttempt: () => assert.fail("capacity failure must precede launch"),
      accept: () => assert.fail("capacity failure must precede acceptance"),
    }),
    "ACCEPTANCE_FENCE_CAPACITY",
  );
  assert.equal(capacity.details.capacity, 2);
  assert.equal(factoryCalls, 2);
  assert.equal(supervisor.snapshot().fencedKeyCount, 2);
  assert.equal(supervisor.snapshot().acceptanceKeyCapacity, 2);
  await expectCode(
    supervisor.run({
      idempotencyKey: "capacity-1",
      runAttempt: () => "duplicate",
      accept: () => "duplicate",
    }),
    "IDEMPOTENCY_KEY_FENCED",
  );
});

test("validates bounded acceptance capacity and timeout configuration", () => {
  const runtime = new ManualRuntime();
  const createClient = ({ generation }) => new FakeClient(`client-${generation}`, runtime.log);
  for (const options of [
    { maxAcceptanceKeys: 0 },
    { maxAcceptanceKeys: 100_001 },
    { acceptanceTimeoutMs: 0 },
    { acceptanceTimeoutMs: 120_001 },
  ]) {
    assert.throws(() => makeSupervisor(runtime, createClient, options), TypeError);
  }
});

test("inconclusive close permanently disables replacement and acceptance", async () => {
  const runtime = new ManualRuntime();
  let acceptanceCalls = 0;
  const supervisor = makeSupervisor(
    runtime,
    ({ generation }) => new FakeClient(`client-${generation}`, runtime.log, {
      stopBehavior: () => { throw new Error("sk-secret-close"); },
    }),
  );
  const error = await captureCode(
    supervisor.run({
      idempotencyKey: "close-failure",
      runAttempt: () => ({ artifact: "must-not-commit" }),
      accept: () => { acceptanceCalls += 1; },
    }),
    "CLIENT_CLOSE_FAILED",
  );
  assert.equal(acceptanceCalls, 0);
  assert.equal(JSON.stringify(error.details).includes("sk-secret"), false);
  await waitFor(() => supervisor.snapshot().lifecycle === "shutdown");
  await expectCode(
    supervisor.run({
      idempotencyKey: "after-close-failure",
      runAttempt: () => "never",
      accept: () => "never",
    }),
    "SUPERVISOR_SHUTDOWN",
  );
});

class StopTrackedAppServerClient extends AppServerClient {
  /**
   * @param {ConstructorParameters<typeof AppServerClient>[0]} options
   * @param {() => void} onStopped
   */
  constructor(options, onStopped) {
    super(options);
    this._onStopped = onStopped;
  }

  async stop() {
    await super.stop();
    this._onStopped();
  }
}

/** @param {AppServerClient} client @param {AbortSignal} signal */
async function runRealFixtureTurn(client, signal) {
  await client.request("initialize", {
    clientInfo: { name: "marketpilot-process-supervisor-test", version: "1.0.0" },
  }, { signal });
  await client.notify("initialized", {});
  const response = await client.request("thread/start", {
    model: "gpt-5.6-sol",
    reasoningEffort: "ultra",
    ephemeral: true,
  }, { signal });
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new TypeError("fixture thread/start response is invalid");
  }
  const thread = Reflect.get(response, "thread");
  if (!thread || typeof thread !== "object" || Array.isArray(thread)) {
    throw new TypeError("fixture thread/start thread is invalid");
  }
  const threadId = Reflect.get(thread, "id");
  if (typeof threadId !== "string" || threadId.length === 0) {
    throw new TypeError("fixture thread/start thread id is invalid");
  }
  return runStructuredTurn({
    client,
    threadId,
    input: [{ type: "text", text: "Use the fixture and return the required artifact." }],
    outputSchema: PROBE_OUTPUT_SCHEMA,
    parseFinal: parseProbeArtifact,
    deadlineMs: 1_000,
    signal,
    allowedMcpTools: new Set(),
    requiredMcpTools: new Set(),
  });
}

/** @template T @param {Promise<T>} promise @param {number} timeoutMs @param {string} message */
async function within(promise, timeoutMs, message) {
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * @param {ManualRuntime} runtime
 * @param {(context: {generation: number, signal: AbortSignal}) => FakeClient} createClient
 * @param {{maxAcceptanceKeys?: number, acceptanceTimeoutMs?: number}} [options]
 */
function makeSupervisor(runtime, createClient, options = {}) {
  return new CodexProcessSupervisor({
    createClient,
    clock: { nowMs: () => runtime.nowMs },
    scheduler: { schedule: (delayMs, callback) => runtime.schedule(delayMs, callback) },
    ...options,
  });
}

class FakeClient extends EventEmitter {
  /**
   * @param {string} name
   * @param {string[]} log
   * @param {{startBehavior?: (client: FakeClient) => unknown, stopBehavior?: (client: FakeClient) => unknown}} [options]
   */
  constructor(name, log, { startBehavior, stopBehavior } = {}) {
    super();
    this.name = name;
    this.log = log;
    this.startBehavior = startBehavior;
    this.stopBehavior = stopBehavior;
    this.state = "idle";
    this.closed = false;
    this.startCalls = 0;
    this.stopCalls = 0;
  }

  async start() {
    this.startCalls += 1;
    this.log.push(`${this.name}:start`);
    await this.startBehavior?.(this);
    if (this.state === "idle") this.state = "running";
  }

  async stop() {
    this.stopCalls += 1;
    this.log.push(`${this.name}:stop`);
    if (this.closed || this.state === "stopped" || this.state === "failed") return;
    await this.stopBehavior?.(this);
    if (this.closed || this.state === "stopped" || this.state === "failed") return;
    this.closed = true;
    this.state = "stopped";
    this.emit("exit", { expected: true, error: null });
  }

  /** @param {Error} error */
  crash(error) {
    if (this.closed) return;
    this.closed = true;
    this.state = "failed";
    this.log.push(`${this.name}:close`);
    this.emit("exit", { expected: false, error });
  }
}

class ProcessFailure extends Error {
  constructor(message, code = "APP_SERVER_UNAVAILABLE") {
    super(message);
    this.kind = "process";
    this.code = code;
  }
}

class ServiceFailure extends Error {
  constructor(code, message) {
    super(message);
    this.kind = "service";
    this.code = code;
  }
}

class ManualRuntime {
  constructor() {
    this.nowMs = 0;
    this.log = [];
    this.scheduledDelays = [];
    /** @type {{delayMs: number, callback: () => void, cancelled: boolean, fired: boolean}[]} */
    this.tasks = [];
  }

  schedule(delayMs, callback) {
    const task = { delayMs, callback, cancelled: false, fired: false };
    this.tasks.push(task);
    this.scheduledDelays.push(delayMs);
    this.log.push(`schedule:${delayMs}`);
    return Object.freeze({
      cancel: () => { task.cancelled = true; },
    });
  }

  async waitForPending(count) {
    await waitFor(() => this.pendingTasks().length >= count);
    return this.pendingTasks()[count - 1];
  }

  async waitForDelay(delayMs) {
    await waitFor(() => this.pendingTasks().some((task) => task.delayMs === delayMs));
    return this.pendingTasks().find((task) => task.delayMs === delayMs);
  }

  async fireDelay(delayMs) {
    const task = await this.waitForDelay(delayMs);
    assert(task, `expected a pending ${delayMs} ms callback`);
    task.fired = true;
    this.nowMs += task.delayMs;
    task.callback();
    await flushTurns();
  }

  async fireNext() {
    const task = this.pendingTasks()[0];
    assert(task, "expected a pending scheduled callback");
    task.fired = true;
    this.nowMs += task.delayMs;
    task.callback();
    await flushTurns();
  }

  pendingTasks() {
    return this.tasks.filter((task) => !task.fired && !task.cancelled);
  }

  retryDelays() {
    return this.scheduledDelays.filter((delayMs) => [1_000, 5_000, 30_000].includes(delayMs));
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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
      assert(error instanceof CodexProcessSupervisorError);
      assert.equal(error.code, code);
      captured = error;
      return true;
    },
  );
  return captured;
}

/** @param {unknown} error @param {string} code */
function hasCode(error, code) {
  return error instanceof CodexProcessSupervisorError && error.code === code;
}

/** @param {Readonly<Record<string, unknown>>} snapshot */
function pickSnapshot(snapshot) {
  return {
    lifecycle: snapshot.lifecycle,
    runActive: snapshot.runActive,
    circuit: snapshot.circuit,
    crashCount: snapshot.crashCount,
    acceptedKeyCount: snapshot.acceptedKeyCount,
    uncertainKeyCount: snapshot.uncertainKeyCount,
    fencedKeyCount: snapshot.fencedKeyCount,
  };
}

/** @param {string[]} log @param {string} first @param {string} second */
function assertOrder(log, first, second) {
  const firstIndex = log.indexOf(first);
  const secondIndex = log.indexOf(second);
  assert.notEqual(firstIndex, -1, `missing log entry ${first}`);
  assert.notEqual(secondIndex, -1, `missing log entry ${second}`);
  assert(firstIndex < secondIndex, `${first} must precede ${second}`);
}

/** @param {() => boolean} predicate */
async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("condition did not become true");
}

async function flushTurns() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}
