// @ts-check

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  AppServerClient,
  AppServerProcessError,
  AppServerProtocolError,
  AppServerRemoteError,
  AppServerRequestAbortedError,
  AppServerRequestTimeoutError,
  createExactServerRequestHandler,
} from "../../src/codex/app-server-client.mjs";

const READLINE_PREAMBLE = String.raw`
  import { createInterface } from "node:readline";
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
`;
const PROCESS_TREE_FIXTURE = path.resolve(
  import.meta.dirname,
  "..",
  "fixtures",
  "process-group-tree.mjs",
);
const execFileAsync = promisify(execFile);

/**
 * @param {import("node:test").TestContext} context
 * @param {string} body
 * @param {Partial<ConstructorParameters<typeof AppServerClient>[0]>} [options]
 */
async function startInlineServer(context, body, options = {}) {
  const client = new AppServerClient({
    command: process.execPath,
    args: ["--input-type=module", "--eval", `${READLINE_PREAMBLE}\n${body}`],
    requestTimeoutMs: 500,
    stopTimeoutMs: 200,
    ...options,
  });
  context.after(async () => {
    await client.stop();
  });
  await client.start();
  return client;
}

test("correlates concurrent numeric requests, sends notifications, and emits notifications", async (context) => {
  const client = await startInlineServer(
    context,
    String.raw`
      const requests = [];
      let clientNotification;
      for await (const line of lines) {
        const message = JSON.parse(line);
        if (!("id" in message)) {
          clientNotification = message;
          continue;
        }
        requests.push(message);
        if (requests.length === 2) {
          send({ method: "server/ready", params: { observed: clientNotification.method } });
          for (const request of requests.toReversed()) {
            send({ id: request.id, result: { method: request.method, id: request.id } });
          }
        }
      }
    `,
  );
  assert.equal(client.serverRequestsForbidden, true);

  /** @type {unknown[]} */
  const notifications = [];
  client.on("notification", (notification) => notifications.push(notification));

  await client.notify("client/initialized", { version: 1 });
  const first = client.request("first/read", { key: "a" });
  const second = client.request("second/read", { key: "b" });

  assert.deepEqual(await first, { method: "first/read", id: 1 });
  assert.deepEqual(await second, { method: "second/read", id: 2 });
  assert.deepEqual(notifications, [
    { method: "server/ready", params: { observed: "client/initialized" } },
  ]);
  assert.equal(client.state, "running");
});

test("answers an explicitly allowed server-initiated request", async (context) => {
  const handler = createExactServerRequestHandler({
    "fixture/read": ({ id, params }) => ({ approved: id === 700, echo: params }),
  });
  const client = await startInlineServer(
    context,
    String.raw`
      let callerRequest;
      for await (const line of lines) {
        const message = JSON.parse(line);
        if (message.method === "begin") {
          callerRequest = message;
          send({ id: 700, method: "fixture/read", params: { value: 42 } });
        } else if (message.id === 700) {
          send({ id: callerRequest.id, result: message.result });
        }
      }
    `,
    { serverRequestHandler: handler },
  );
  assert.equal(client.serverRequestsForbidden, false);

  assert.deepEqual(await client.request("begin"), {
    approved: true,
    echo: { value: 42 },
  });
});

test("an exact handler rejects an unexpected server-initiated request and fails closed", async (context) => {
  const client = await startInlineServer(
    context,
    String.raw`
      for await (const line of lines) {
        const message = JSON.parse(line);
        if (message.method === "begin") {
          send({ id: 701, method: "dangerous/approval", params: { allow: true } });
        }
      }
    `,
    { serverRequestHandler: createExactServerRequestHandler({ "fixture/read": () => null }) },
  );

  await assert.rejects(
    client.request("begin"),
    (error) =>
      error instanceof AppServerProtocolError && error.code === "UNEXPECTED_SERVER_REQUEST",
  );
  assert.equal(client.lastError?.code, "UNEXPECTED_SERVER_REQUEST");
});

test("rejects malformed JSON without including its content in the error", async (context) => {
  const client = await startInlineServer(
    context,
    String.raw`
      for await (const _line of lines) {
        process.stdout.write('{"secret":"do-not-copy"\n');
      }
    `,
  );

  await assert.rejects(
    client.request("trigger"),
    (error) => {
      assert(error instanceof AppServerProtocolError);
      assert.equal(error.code, "INVALID_JSON");
      assert.doesNotMatch(error.message, /do-not-copy/);
      return true;
    },
  );
});

test("enforces inbound and outbound JSONL byte limits", async (context) => {
  const inbound = await startInlineServer(
    context,
    String.raw`
      for await (const _line of lines) {
        send({ method: "oversized/event", params: "x".repeat(200) });
      }
    `,
    { maxLineBytes: 96 },
  );

  await assert.rejects(
    inbound.request("go"),
    (error) => error instanceof AppServerProtocolError && error.code === "LINE_TOO_LARGE",
  );

  const outbound = await startInlineServer(
    context,
    String.raw`
      for await (const _line of lines) {}
    `,
    { maxLineBytes: 96 },
  );
  assert.throws(
    () => outbound.notify("large", { payload: "x".repeat(200) }),
    (error) =>
      error instanceof AppServerProtocolError && error.code === "OUTBOUND_LINE_TOO_LARGE",
  );
  assert.equal(outbound.state, "running");
});

test("rejects duplicate response IDs and every still-pending request", async (context) => {
  const client = await startInlineServer(
    context,
    String.raw`
      const requests = [];
      for await (const line of lines) {
        requests.push(JSON.parse(line));
        if (requests.length === 2) {
          send({ id: requests[0].id, result: "first-result" });
          send({ id: requests[0].id, result: "duplicate-result" });
        }
      }
    `,
  );

  const first = client.request("one");
  const second = client.request("two");
  const rejectedSecond = assert.rejects(
    second,
    (error) => error instanceof AppServerProtocolError && error.code === "DUPLICATE_RESPONSE_ID",
  );
  assert.equal(await first, "first-result");
  await rejectedSecond;
});

test("rejects an unknown response ID", async (context) => {
  const client = await startInlineServer(
    context,
    String.raw`
      for await (const line of lines) {
        const message = JSON.parse(line);
        send({ id: message.id + 99, result: null });
      }
    `,
  );

  await assert.rejects(
    client.request("one"),
    (error) => error instanceof AppServerProtocolError && error.code === "UNKNOWN_RESPONSE_ID",
  );
});

test("times out and aborts individual requests with typed errors", async (context) => {
  const client = await startInlineServer(
    context,
    String.raw`
      for await (const _line of lines) {}
    `,
    { requestTimeoutMs: 40 },
  );

  await assert.rejects(
    client.request("never/responds"),
    (error) => error instanceof AppServerRequestTimeoutError && error.timeoutMs === 40,
  );
  assert.equal(client.state, "running");

  const controller = new AbortController();
  const aborted = client.request("abort/me", undefined, { signal: controller.signal });
  controller.abort(new Error("fixture cancellation"));
  await assert.rejects(aborted, AppServerRequestAbortedError);
  assert.equal(client.state, "running");
});

test("surfaces valid remote errors without failing the transport", async (context) => {
  const client = await startInlineServer(
    context,
    String.raw`
      for await (const line of lines) {
        const message = JSON.parse(line);
        send({
          id: message.id,
          error: {
            code: 429,
            message: "rate limited Bearer abcdefghijklmnop",
            data: { access_token: "secret-token-value", retryAfterMs: 10 },
          },
        });
      }
    `,
  );

  await assert.rejects(
    client.request("limited"),
    (error) => {
      assert(error instanceof AppServerRemoteError);
      assert.equal(error.remoteCode, 429);
      assert.match(error.message, /Bearer \[REDACTED\]/);
      assert.deepEqual(error.remoteData, {
        access_token: "[REDACTED]",
        retryAfterMs: 10,
      });
      return true;
    },
  );
  assert.equal(client.state, "running");
});

test("unexpected process exit carries bounded, redacted stderr", async (context) => {
  const client = await startInlineServer(
    context,
    String.raw`
      for await (const _line of lines) {
        process.stderr.write("Authorization: Bearer abcdefgh");
        setTimeout(() => {
          process.stderr.write("ijklmnop OPENAI_API_KEY=sk-abcdefghijklmno\n" + "z".repeat(300));
          process.exit(7);
        }, 5);
      }
    `,
    { stderrMaxBytes: 180 },
  );

  await assert.rejects(
    client.request("crash"),
    (error) => {
      assert(error instanceof AppServerProcessError);
      assert.equal(error.code, "PROCESS_EXIT");
      assert.equal(error.exitCode, 7);
      assert.doesNotMatch(error.stderr, /abcdefghijklmnop|abcdefghijklmno/);
      assert.ok(Buffer.byteLength(error.stderr) <= 180);
      return true;
    },
  );
  assert.equal(client.stderrTruncated, true);
  assert.match(client.stderr, /^\[stderr truncated\]/);
});

test("spawn failure is typed and does not expose command arguments", async () => {
  const client = new AppServerClient({
    command: "/definitely/not/a/marketpilot-app-server",
    args: ["--secret", "do-not-report"],
    stopTimeoutMs: 50,
  });

  await assert.rejects(
    client.start(),
    (error) => {
      assert(error instanceof AppServerProcessError);
      assert.equal(error.code, "SPAWN_FAILED");
      assert.doesNotMatch(error.message, /do-not-report/);
      return true;
    },
  );
  assert.equal(client.state, "failed");
});

test("a failed pre-spawn qualification never launches the command", async () => {
  let qualificationCalls = 0;
  const client = new AppServerClient({
    command: process.execPath,
    args: ["--eval", "process.exitCode = 99"],
    beforeSpawn: async () => {
      qualificationCalls += 1;
      throw new Error("unqualified executable /secret/binary/path");
    },
  });

  await assert.rejects(client.start(), (error) => {
    assert(error instanceof AppServerProcessError);
    assert.equal(error.code, "SPAWN_QUALIFICATION_FAILED");
    assert.doesNotMatch(error.message, /unqualified executable|secret|binary\/path/u);
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(qualificationCalls, 1);
  assert.equal(client.state, "failed");
});

test("stopping during pre-spawn qualification cannot launch an orphan process", async () => {
  /** @type {() => void} */
  let releaseQualification = () => {};
  const qualificationStarted = Promise.withResolvers();
  const client = new AppServerClient({
    command: "/definitely/not/a/marketpilot-app-server",
    beforeSpawn: async () => {
      qualificationStarted.resolve();
      await new Promise((resolve) => {
        releaseQualification = resolve;
      });
    },
  });

  const startResult = assert.rejects(client.start(), (error) => {
    assert(error instanceof AppServerProcessError);
    assert.equal(error.code, "CLIENT_STOPPED");
    return true;
  });
  await qualificationStarted.promise;
  await client.stop();
  releaseQualification();
  await startResult;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(client.state, "stopped");
  assert.equal(client.pid, null);
  assert.equal(client.lastError, null);
});

test("a retained detached leader owns its grandchild until stop proves group ESRCH", async (t) => {
  let esrchObserved = false;
  const { client, tree } = await startProcessTreeFixture(t, "hold", {
    processGroupControl: {
      signal(pgid, signal) {
        try {
          return process.kill(-pgid, signal);
        } catch (error) {
          if (nodeErrorCode(error) === "ESRCH") esrchObserved = true;
          throw error;
        }
      },
    },
  });

  assert.equal(tree.leaderPgid, tree.leaderPid);
  assert.equal(tree.leaderSession, tree.leaderPid);
  assert.equal(tree.descendantPgid, tree.leaderPgid);
  assert.equal(tree.descendantSession, tree.leaderSession);
  assert.equal(await processGroupExists(tree.leaderPgid), true);

  await client.stop();

  assert.equal(client.state, "stopped");
  assert.equal(esrchObserved, true);
  assert.equal(await processGroupExists(tree.leaderPgid), false);
  assert.equal(await processExists(tree.descendantPid), false);
});

test("leader exit cleans a descendant that inherited pipes before close can settle", async (t) => {
  const { client, tree, exit } = await startProcessTreeFixture(t, "leader-exit-inherited");

  const event = await withDeadline(exit, 10_000, "leader exit cleanup did not settle");

  assert.equal(event.exitCode, 17);
  assert.equal(event.error?.code, "PROCESS_EXIT");
  assert.equal(client.state, "failed");
  assert.equal(await processGroupExists(tree.leaderPgid), false);
  assert.equal(await processExists(tree.descendantPid), false);
});

test("unexpected leader crash cleans its surviving controlled descendant", async (t) => {
  const { client, tree, exit } = await startProcessTreeFixture(t, "crash");

  const event = await withDeadline(exit, 10_000, "crash cleanup did not settle");

  assert.equal(event.exitCode, 70);
  assert.equal(event.error?.code, "PROCESS_EXIT");
  assert.equal(await processGroupExists(tree.leaderPgid), false);
  assert.equal(await processExists(tree.descendantPid), false);
});

test("normal stop preserves EOF grace, then cleans descendants after leader exit", async (t) => {
  const signals = [];
  const { client, tree, exit } = await startProcessTreeFixture(t, "eof-clean", {
    stopTimeoutMs: 100,
    processGroupControl: recordingRealProcessGroupControl(signals),
  });

  const stopping = client.stop();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(signals.some((entry) => entry.signal === "SIGTERM"), false);
  await stopping;
  const event = await exit;

  assert.equal(event.exitCode, 0);
  assert.equal(event.signal, null);
  assert.ok(signals.some((entry) => entry.signal === "SIGTERM"));
  assert.equal(await processGroupExists(tree.leaderPgid), false);
});

test("a TERM-ignoring descendant receives bounded group KILL and waits for ESRCH", async (t) => {
  const signals = [];
  const cleanupObservation = delayedEsrchProcessGroupControl(signals, 8);
  const { client, tree } = await startProcessTreeFixture(t, "term-ignore", {
    stopTimeoutMs: 100,
    processGroupControl: cleanupObservation.control,
  });

  await client.stop();

  const termIndex = signals.findIndex((entry) => entry.signal === "SIGTERM");
  const killIndex = signals.findIndex((entry) => entry.signal === "SIGKILL");
  assert.ok(termIndex >= 0);
  assert.ok(killIndex > termIndex);
  assert.equal(cleanupObservation.remainingDelayedProbes, 0);
  assert.equal(cleanupObservation.esrchObserved, true);
  assert.equal(await processGroupExists(tree.leaderPgid), false);
  assert.equal(await processExists(tree.descendantPid), false);
});

test("referenced cleanup timers retain a no-keepalive harness through KILL and ESRCH", async (t) => {
  const marker = processFixtureMarker();
  const observedTrees = [];
  t.after(async () => {
    await cleanupObservedTrees(observedTrees);
    await cleanupMarkedFixtureProcesses(marker);
  });
  let stdout = "";
  try {
    const result = await execFileAsync(process.execPath, [
      PROCESS_TREE_FIXTURE,
      "client-harness",
      marker,
    ], {
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });
    stdout = result.stdout;
  } catch (error) {
    stdout = typeof error?.stdout === "string" ? error.stdout : "";
    throw error;
  } finally {
    for (const line of stdout.trim().split(/\r?\n/u).filter(Boolean)) {
      const entry = JSON.parse(line);
      if (entry.type === "started") observedTrees.push(entry.tree);
    }
  }
  const events = stdout.trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));

  assert.deepEqual(events.map((entry) => entry.type), ["started", "cleaned"]);
  assert.equal(await processGroupExists(events[0].tree.leaderPgid), false);
});

test("concurrent and repeated stop calls share cleanup and block start while stopping", async (t) => {
  const { client, tree } = await startProcessTreeFixture(t, "hold");

  const first = client.stop();
  const second = client.stop();
  await assert.rejects(
    client.start(),
    (error) => error?.code === "CLIENT_STOPPING",
  );
  await Promise.all([first, second]);
  await client.stop();

  assert.equal(client.state, "stopped");
  assert.equal(await processGroupExists(tree.leaderPgid), false);
});

test("canceled timers from an old generation cannot signal a restarted group", async (t) => {
  const scheduler = createRecordingScheduler();
  const signals = [];
  const marker = processFixtureMarker();
  const client = new AppServerClient({
    command: process.execPath,
    args: [PROCESS_TREE_FIXTURE, "eof-clean", marker],
    stopTimeoutMs: 80,
    processGroupControl: recordingRealProcessGroupControl(signals),
    cleanupScheduler: scheduler,
  });
  const observedTrees = [];
  t.after(async () => {
    await withDeadline(client.stop(), 5_000, "bounded stale-timer stop timed out").catch(() => {});
    await cleanupObservedTrees(observedTrees);
    await cleanupMarkedFixtureProcesses(marker);
  });
  const firstReady = waitForTreeReady(client);
  await client.start();
  const firstTree = await firstReady;
  observedTrees.push(firstTree);
  await client.stop();
  const oldTimers = [...scheduler.entries];

  const secondReady = waitForTreeReady(client);
  await client.start();
  const secondTree = await secondReady;
  observedTrees.push(secondTree);
  const callsBeforeStaleTimers = signals.length;
  for (const timer of oldTimers) timer.callback();
  assert.equal(signals.length, callsBeforeStaleTimers);
  assert.equal(await processGroupExists(secondTree.leaderPgid), true);

  await client.stop();
});

test("EPERM, EINVAL, and unknown process-group failures reject cleanup and prevent reuse", async (t) => {
  for (const [errno, expectedCode] of [
    ["EPERM", "PROCESS_GROUP_CLEANUP_EPERM"],
    ["EINVAL", "PROCESS_GROUP_CLEANUP_EINVAL"],
    ["EIO", "PROCESS_GROUP_CONTROL_FAILED"],
  ]) {
    await t.test(errno, async (subtest) => {
      const { client, tree } = await startProcessTreeFixture(subtest, "hold", {
        stopTimeoutMs: 20,
        processGroupControl: {
          signal() {
            const error = new Error("injected process-group failure");
            Object.assign(error, { code: errno });
            throw error;
          },
        },
      });

      await assert.rejects(
        client.stop(),
        (error) => error instanceof AppServerProcessError && error.code === expectedCode,
      );
      await assert.rejects(
        client.start(),
        (error) => error instanceof AppServerProcessError && error.code === expectedCode,
      );
      assert.equal(client.state, "failed");
      assert.equal(await processGroupExists(tree.leaderPgid), true);
      await cleanupObservedTrees([tree]);
    });
  }
});

test("a setsid-escaping descendant is explicitly outside the controlled PGID boundary", async (t) => {
  const { client, tree } = await startProcessTreeFixture(t, "setsid-escape");

  assert.equal(tree.escaped, true);
  assert.notEqual(tree.descendantPgid, tree.leaderPgid);
  assert.notEqual(tree.descendantSession, tree.leaderSession);
  await client.stop();

  assert.equal(await processGroupExists(tree.leaderPgid), false);
  assert.equal(await processExists(tree.descendantPid), true);
  // PGID ownership is not durable containment and makes no parent-SIGKILL
  // guarantee. The outer test owner must explicitly clean this escaped child.
  const escapedIdentity = await readProcessIdentity(tree.descendantPid);
  assert.equal(escapedIdentity?.startTicks, tree.descendantStartTicks);
  process.kill(tree.descendantPid, "SIGKILL");
  await waitForProcessAbsence({
    pid: tree.descendantPid,
    startTicks: tree.descendantStartTicks,
  });
});

/**
 * @param {import("node:test").TestContext} t
 * @param {string} scenario
 * @param {Partial<ConstructorParameters<typeof AppServerClient>[0]>} [options]
 */
async function startProcessTreeFixture(t, scenario, options = {}) {
  const marker = processFixtureMarker();
  const client = new AppServerClient({
    command: process.execPath,
    args: [PROCESS_TREE_FIXTURE, scenario, marker],
    requestTimeoutMs: 500,
    stopTimeoutMs: 100,
    ...options,
  });
  const observedTrees = [];
  t.after(async () => {
    await withDeadline(client.stop(), 5_000, "bounded fixture stop timed out").catch(() => {});
    await cleanupObservedTrees(observedTrees);
    await cleanupMarkedFixtureProcesses(marker);
  });
  const ready = waitForTreeReady(client);
  const exit = Promise.withResolvers();
  client.once("exit", exit.resolve);
  await client.start();
  const tree = await ready;
  observedTrees.push(tree);
  return { client, tree, exit: exit.promise };
}

/** @param {AppServerClient} client */
function waitForTreeReady(client) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off("notification", onNotification);
      reject(new Error("process-tree fixture did not become ready"));
    }, 10_000);
    const onNotification = (notification) => {
      if (notification.method !== "fixture/process-tree-ready") return;
      clearTimeout(timer);
      client.off("notification", onNotification);
      resolve(notification.params);
    };
    client.on("notification", onNotification);
  });
}

/** @param {Array<{pgid: number, signal: NodeJS.Signals | 0}>} calls */
function recordingRealProcessGroupControl(calls) {
  return {
    signal(pgid, signal) {
      calls.push({ pgid, signal });
      return process.kill(-pgid, signal);
    },
  };
}

/**
 * Simulate a kernel that continues to report the killed group for several
 * probes before ESRCH. The real signal calls still own the fixture lifecycle.
 *
 * @param {Array<{pgid: number, signal: NodeJS.Signals | 0}>} calls
 * @param {number} delayedProbeCount
 */
function delayedEsrchProcessGroupControl(calls, delayedProbeCount) {
  let remainingDelayedProbes = delayedProbeCount;
  let killSent = false;
  let esrchObserved = false;
  return {
    control: {
      signal(pgid, signal) {
        calls.push({ pgid, signal });
        if (signal === "SIGKILL") killSent = true;
        if (signal === 0 && killSent && remainingDelayedProbes > 0) {
          remainingDelayedProbes -= 1;
          return true;
        }
        try {
          return process.kill(-pgid, signal);
        } catch (error) {
          if (nodeErrorCode(error) === "ESRCH") esrchObserved = true;
          throw error;
        }
      },
    },
    get remainingDelayedProbes() {
      return remainingDelayedProbes;
    },
    get esrchObserved() {
      return esrchObserved;
    },
  };
}

function createRecordingScheduler() {
  const entries = [];
  return {
    entries,
    schedule(callback, delayMs) {
      const entry = { callback, timer: undefined, canceled: false };
      entry.timer = setTimeout(callback, delayMs);
      entries.push(entry);
      return entry;
    },
    cancel(entry) {
      entry.canceled = true;
      clearTimeout(entry.timer);
    },
  };
}

/** @param {Promise<unknown>} promise @param {number} timeoutMs @param {string} message */
async function withDeadline(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** @param {Array<any>} trees */
async function cleanupObservedTrees(trees) {
  const identities = trees.flatMap((tree) => [
    {
      pid: tree.leaderPid,
      pgid: tree.leaderPgid,
      startTicks: tree.leaderStartTicks,
    },
    {
      pid: tree.descendantPid,
      pgid: tree.descendantPgid,
      startTicks: tree.descendantStartTicks,
    },
  ]);
  for (const pgid of new Set(identities.map((identity) => identity.pgid))) {
    let verifiedMember = false;
    for (const identity of identities.filter((entry) => entry.pgid === pgid)) {
      const current = await readProcessIdentity(identity.pid);
      if (current?.startTicks === identity.startTicks && current.pgid === pgid) {
        verifiedMember = true;
        break;
      }
    }
    if (!verifiedMember) continue;
    try {
      process.kill(-pgid, "SIGKILL");
    } catch (error) {
      if (nodeErrorCode(error) !== "ESRCH") throw error;
    }
  }
  // Direct-PID fallback is allowed only after revalidating the immutable proc
  // start identity, so teardown cannot signal a reused PID.
  for (const identity of identities) {
    const current = await readProcessIdentity(identity.pid);
    if (current?.startTicks !== identity.startTicks) continue;
    try {
      process.kill(identity.pid, "SIGKILL");
    } catch (error) {
      if (nodeErrorCode(error) !== "ESRCH") throw error;
    }
  }
}

function processFixtureMarker() {
  return `marketpilot-pg-test-${randomUUID()}`;
}

/** @param {string} marker */
async function cleanupMarkedFixtureProcesses(marker) {
  for (let round = 0; round < 4; round += 1) {
    const marked = await findMarkedFixtureProcesses(marker);
    if (marked.length === 0) return;

    // A negative-PGID signal is used only when the exact marked process is
    // itself the group leader. This avoids signaling the test runner's group
    // when cleaning the non-detached outer harness process.
    for (const identity of marked.filter((entry) => entry.pid === entry.pgid)) {
      if (!(await markedIdentityStillMatches(identity, marker))) continue;
      try {
        process.kill(-identity.pgid, "SIGKILL");
      } catch (error) {
        if (nodeErrorCode(error) !== "ESRCH") throw error;
      }
    }
    for (const identity of marked) {
      if (!(await markedIdentityStillMatches(identity, marker))) continue;
      try {
        process.kill(identity.pid, "SIGKILL");
      } catch (error) {
        if (nodeErrorCode(error) !== "ESRCH") throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal((await findMarkedFixtureProcesses(marker)).length, 0);
}

/** @param {string} marker */
async function findMarkedFixtureProcesses(marker) {
  const uid = process.getuid?.();
  if (!Number.isSafeInteger(uid)) throw new Error("fixture cleanup requires a POSIX uid");
  const matches = [];
  for (const entry of await readdir("/proc", { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[1-9][0-9]*$/u.test(entry.name)) continue;
    const pid = Number(entry.name);
    const directory = `/proc/${entry.name}`;
    let metadata;
    try {
      metadata = await lstat(directory);
    } catch (error) {
      if (nodeErrorCode(error) === "ENOENT") continue;
      throw error;
    }
    if (metadata.uid !== uid) continue;
    let argumentsBuffer;
    try {
      argumentsBuffer = await readFile(`${directory}/cmdline`);
    } catch (error) {
      if (["ENOENT", "ESRCH"].includes(nodeErrorCode(error))) continue;
      throw error;
    }
    const argumentsList = argumentsBuffer.toString("utf8").split("\0").filter(Boolean);
    if (!argumentsList.includes(marker)) continue;
    const identity = await readProcessIdentity(pid);
    if (identity !== null) matches.push({ pid, ...identity });
  }
  return matches;
}

/** @param {{pid: number, pgid: number, startTicks: string}} identity @param {string} marker */
async function markedIdentityStillMatches(identity, marker) {
  const current = await readProcessIdentity(identity.pid);
  if (
    current?.startTicks !== identity.startTicks ||
    current.pgid !== identity.pgid
  ) {
    return false;
  }
  try {
    const cmdline = (await readFile(`/proc/${identity.pid}/cmdline`))
      .toString("utf8")
      .split("\0")
      .filter(Boolean);
    return cmdline.includes(marker);
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes(nodeErrorCode(error))) return false;
    throw error;
  }
}

/** @param {{pid: number, startTicks: string}} identity */
async function waitForProcessAbsence(identity) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const current = await readProcessIdentity(identity.pid);
    if (current?.startTicks !== identity.startTicks) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("fixture process did not exit");
}

/** @param {number} pid */
async function readProcessIdentity(pid) {
  let stat;
  try {
    stat = await readFile(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes(nodeErrorCode(error))) return null;
    throw error;
  }
  const closingParenthesis = stat.lastIndexOf(")");
  if (closingParenthesis < 0) return null;
  const fields = stat.slice(closingParenthesis + 1).trim().split(/\s+/u);
  return { pgid: Number(fields[2]), startTicks: fields[19] };
}

/** @param {number} pid */
async function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (nodeErrorCode(error) === "ESRCH") return false;
    throw error;
  }
}

/** @param {number} pgid */
async function processGroupExists(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    if (nodeErrorCode(error) === "ESRCH") return false;
    throw error;
  }
}

/** @param {unknown} error */
function nodeErrorCode(error) {
  return error instanceof Error && "code" in error ? error.code : undefined;
}
