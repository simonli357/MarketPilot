// @ts-check

import assert from "node:assert/strict";
import test from "node:test";

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
