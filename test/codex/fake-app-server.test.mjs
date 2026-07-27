import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const fixturePath = fileURLToPath(
  new URL("../fixtures/fake-app-server.mjs", import.meta.url),
);

test("happy server exposes the stable runtime inventories and terminal result", async (t) => {
  const server = startServer();
  t.after(() => server.stop());

  await initialize(server);

  const model = await request(server, 2, "model/list", {});
  assert.equal(model.result.data[0].model, "gpt-5.6-sol");
  assert.deepEqual(
    model.result.data[0].supportedReasoningEfforts.map(
      ({ reasoningEffort }) => reasoningEffort,
    ),
    ["ultra"],
  );

  const config = await request(server, 3, "config/read", {});
  assert.deepEqual(
    {
      model: config.result.config.model,
      effort: config.result.config.model_reasoning_effort,
      approvals: config.result.config.approval_policy,
      sandbox: config.result.config.sandbox_mode,
      credentials: config.result.config.cli_auth_credentials_store,
      auth: config.result.config.forced_login_method,
      web: config.result.config.web_search,
      workers:
        config.result.config.agents.max_concurrent_threads_per_session,
    },
    {
      model: "gpt-5.6-sol",
      effort: "ultra",
      approvals: "never",
      sandbox: "read-only",
      credentials: "keyring",
      auth: "chatgpt",
      web: "disabled",
      workers: 2,
    },
  );

  const account = await request(server, 4, "account/read", {});
  assert.deepEqual(account.result, {
    account: { type: "chatgpt", email: null, planType: "plus" },
    requiresOpenaiAuth: true,
  });

  const skills = await request(server, 5, "skills/list", {
    cwds: ["/tmp/marketpilot-fixture-work"],
  });
  assert.equal(skills.result.data.length, 1);
  assert.deepEqual(
    skills.result.data[0].skills.map(({ name, enabled, scope }) => ({
      name,
      enabled,
      scope,
    })),
    [{ name: "marketpilot-compatibility", enabled: true, scope: "repo" }],
  );

  const mcp = await request(server, 6, "mcpServerStatus/list", {});
  assert.deepEqual(Object.keys(mcp.result.data[0].tools), ["research_read"]);
  assert.equal(mcp.result.data[0].name, "marketpilot_fixture");

  server.send({
    id: 7,
    method: "thread/start",
    params: { model: "gpt-5.6-sol", reasoningEffort: "ultra" },
  });
  const threadResponse = await server.nextMessage();
  assert.equal(threadResponse.id, 7);
  assert.equal(threadResponse.result.thread.id, "fixture-thread-1");
  assert.equal(threadResponse.result.approvalPolicy, "never");
  assert.deepEqual(threadResponse.result.sandbox, {
    type: "readOnly",
    networkAccess: false,
  });
  assert.equal((await server.nextMessage()).method, "thread/started");

  const resumed = await request(server, 8, "thread/resume", {
    threadId: "fixture-thread-resumed",
  });
  assert.equal(resumed.result.thread.id, "fixture-thread-resumed");

  server.send({
    id: 9,
    method: "turn/start",
    params: {
      threadId: "fixture-thread-resumed",
      input: [{ type: "text", text: "fixture input only" }],
      outputSchema: { type: "object" },
    },
  });

  const startedResponse = await server.nextMessage();
  const startedNotification = await server.nextMessage();
  const itemCompleted = await server.nextMessage();
  const turnCompleted = await server.nextMessage();

  assert.equal(startedResponse.id, 9);
  assert.equal(startedResponse.result.turn.status, "inProgress");
  assert.equal(startedNotification.method, "turn/started");
  assert.equal(itemCompleted.method, "item/completed");
  assert.equal(itemCompleted.params.item.type, "agentMessage");
  assert.deepEqual(JSON.parse(itemCompleted.params.item.text), {
    status: "ok",
    summary: "Fixture compatibility contract is intact.",
    checks: [{
      name: "fixture-source",
      passed: true,
      detail: "The fixture contains public, non-sensitive evidence.",
    }],
  });
  assert.equal(turnCompleted.method, "turn/completed");
  assert.equal(turnCompleted.params.threadId, "fixture-thread-resumed");
  assert.equal(turnCompleted.params.turn.status, "completed");
  assert.deepEqual(turnCompleted.params.turn.items, [
    itemCompleted.params.item,
  ]);
});

test("server enforces initialize then initialized ordering", async (t) => {
  const server = startServer();
  t.after(() => server.stop());

  const early = await request(server, 1, "model/list", {});
  assert.deepEqual(early.error, { code: -32002, message: "Not initialized" });

  server.send({
    id: 2,
    method: "initialize",
    params: { clientInfo: { name: "fixture-test", version: "1" } },
  });
  assert.equal((await server.nextMessage()).result.platformOs, "linux");

  const beforeAcknowledgement = await request(server, 3, "config/read", {});
  assert.equal(beforeAcknowledgement.error.code, -32002);

  server.send({ method: "initialized", params: {} });
  const repeated = await request(server, 4, "initialize", {
    clientInfo: { name: "fixture-test", version: "1" },
  });
  assert.deepEqual(repeated.error, {
    code: -32600,
    message: "Already initialized",
  });

  const unknown = await request(server, 5, "fixture/unknown", {});
  assert.deepEqual(unknown.error, {
    code: -32601,
    message: "Method not found",
  });
});

test("timeout scenario remains interruptible", async (t) => {
  const server = startServer("timeout");
  t.after(() => server.stop());

  await prepareTurn(server);
  assert.equal((await server.nextMessage()).result.turn.status, "inProgress");
  assert.equal((await server.nextMessage()).method, "turn/started");
  await server.expectNoLine(75);

  server.send({
    id: 4,
    method: "turn/interrupt",
    params: { threadId: "fixture-thread-1", turnId: "fixture-turn-1" },
  });
  assert.deepEqual(await server.nextMessage(), { id: 4, result: {} });
  const terminal = await server.nextMessage();
  assert.equal(terminal.method, "turn/completed");
  assert.equal(terminal.params.turn.status, "interrupted");
});

test("malformed JSON scenario emits a protocol-invalid line", async (t) => {
  const server = startServer("malformed-json");
  t.after(() => server.stop());

  await prepareTurn(server);
  await server.nextMessage();
  await server.nextMessage();
  const line = await server.nextLine();
  assert.throws(() => JSON.parse(line), SyntaxError);
});

test("oversized line scenario honors its deterministic byte setting", async (t) => {
  const server = startServer("oversized-line", {
    MARKETPILOT_FAKE_APP_SERVER_OVERSIZED_BYTES: "4096",
  });
  t.after(() => server.stop());

  await prepareTurn(server);
  await server.nextMessage();
  await server.nextMessage();
  const line = await server.nextLine();
  assert.ok(Buffer.byteLength(line, "utf8") > 4096);
  assert.equal(JSON.parse(line).method, "fixture/oversized");
});

test("unexpected server request scenario sends a request, not a notification", async (t) => {
  const server = startServer("unexpected-server-request");
  t.after(() => server.stop());

  await prepareTurn(server);
  await server.nextMessage();
  await server.nextMessage();
  const request = await server.nextMessage();
  assert.equal(request.id, 9001);
  assert.equal(request.method, "item/commandExecution/requestApproval");
  assert.equal(request.params.itemId, "fixture-forbidden-request");
});

test("forbidden tool scenario emits an unapproved MCP item", async (t) => {
  const server = startServer("forbidden-tool");
  t.after(() => server.stop());

  await prepareTurn(server);
  await server.nextMessage();
  await server.nextMessage();
  const item = await server.nextMessage();
  assert.equal(item.method, "item/completed");
  assert.equal(item.params.item.type, "mcpToolCall");
  assert.equal(item.params.item.server, "forbidden_server");
  assert.equal(item.params.item.tool, "write_fixture");
});

test("forbidden item scenario emits command execution without executing it", async (t) => {
  const server = startServer("forbidden-item");
  t.after(() => server.stop());

  await prepareTurn(server);
  await server.nextMessage();
  await server.nextMessage();
  const item = await server.nextMessage();
  assert.equal(item.params.item.type, "commandExecution");
  assert.equal(item.params.item.command, "fixture-command-never-executed");
});

for (const [name, expectedInfo] of [
  ["rate-limit", "usageLimitExceeded"],
  ["auth-error", "unauthorized"],
]) {
  test(`${name} scenario emits a typed failed turn`, async (t) => {
    const server = startServer(name);
    t.after(() => server.stop());

    await prepareTurn(server);
    await server.nextMessage();
    await server.nextMessage();
    const terminal = await server.nextMessage();
    assert.equal(terminal.method, "turn/completed");
    assert.equal(terminal.params.turn.status, "failed");
    assert.equal(terminal.params.turn.error.codexErrorInfo, expectedInfo);
    assert.equal(terminal.params.turn.items.length, 0);
  });
}

test("reroute scenario records the model change before completion", async (t) => {
  const server = startServer("reroute");
  t.after(() => server.stop());

  await prepareTurn(server);
  await server.nextMessage();
  await server.nextMessage();
  const reroute = await server.nextMessage();
  assert.equal(reroute.method, "model/rerouted");
  assert.equal(reroute.params.fromModel, "gpt-5.6-sol");
  assert.equal(reroute.params.toModel, "gpt-5.6-terra");
  assert.equal((await server.nextMessage()).method, "item/completed");
  assert.equal((await server.nextMessage()).method, "turn/completed");
});

test("ambiguous final scenario completes with two terminal agent messages", async (t) => {
  const server = startServer("ambiguous-final");
  t.after(() => server.stop());

  await prepareTurn(server);
  await server.nextMessage();
  await server.nextMessage();
  const first = await server.nextMessage();
  const second = await server.nextMessage();
  const terminal = await server.nextMessage();
  assert.equal(first.params.item.type, "agentMessage");
  assert.equal(second.params.item.type, "agentMessage");
  assert.equal(terminal.params.turn.items.length, 2);
});

test("crash scenario exits while starting a turn", async (t) => {
  const server = startServer("crash");
  t.after(() => server.stop());

  await prepareTurn(server);
  const exit = await server.exited;
  assert.equal(exit.code, 70);
  assert.equal(exit.signal, null);
});

test("duplicate response scenario repeats the turn request id", async (t) => {
  const server = startServer("duplicate-response");
  t.after(() => server.stop());

  await prepareTurn(server);
  const first = await server.nextMessage();
  const duplicate = await server.nextMessage();
  assert.equal(first.id, 3);
  assert.equal(duplicate.id, 3);
  assert.deepEqual(duplicate, first);
});

async function initialize(server) {
  server.send({
    id: 1,
    method: "initialize",
    params: {
      clientInfo: { name: "marketpilot-fixture-test", version: "1.0.0" },
    },
  });
  const response = await server.nextMessage();
  assert.equal(response.id, 1);
  assert.equal(response.result.userAgent, "marketpilot-fake-app-server/0.145.0");
  server.send({ method: "initialized", params: {} });
}

async function prepareTurn(server) {
  await initialize(server);
  server.send({ id: 2, method: "thread/start", params: {} });
  await server.nextMessage();
  await server.nextMessage();
  server.send({
    id: 3,
    method: "turn/start",
    params: {
      threadId: "fixture-thread-1",
      input: [{ type: "text", text: "fixture input only" }],
    },
  });
}

async function request(server, id, method, params) {
  server.send({ id, method, params });
  return server.nextMessage();
}

function startServer(scenario = "happy", extraEnv = {}) {
  const child = spawn(process.execPath, [fixturePath], {
    env: {
      PATH: process.env.PATH,
      MARKETPILOT_FAKE_APP_SERVER_SCENARIO: scenario,
      ...extraEnv,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdoutBuffer = "";
  let stderr = "";
  const lines = [];
  const waiters = [];

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    while (true) {
      const newline = stdoutBuffer.indexOf("\n");
      if (newline === -1) {
        break;
      }
      const line = stdoutBuffer.slice(0, newline);
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      const waiter = waiters.shift();
      if (waiter) {
        waiter.resolve(line);
      } else {
        lines.push(line);
      }
    }
  });

  const exited = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  return {
    child,
    exited,
    send(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    async nextLine(timeoutMs = 1_000) {
      if (lines.length > 0) {
        return lines.shift();
      }

      return new Promise((resolve, reject) => {
        const waiter = {
          resolve(line) {
            clearTimeout(timer);
            resolve(line);
          },
        };
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index !== -1) {
            waiters.splice(index, 1);
          }
          reject(
            new Error(
              `Timed out waiting for fake app-server output; stderr=${stderr}`,
            ),
          );
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
    async nextMessage(timeoutMs) {
      return JSON.parse(await this.nextLine(timeoutMs));
    },
    async expectNoLine(durationMs) {
      if (lines.length > 0) {
        assert.fail(`Expected no output, received: ${lines[0]}`);
      }
      await new Promise((resolve) => setTimeout(resolve, durationMs));
      if (lines.length > 0) {
        assert.fail(`Expected no output, received: ${lines[0]}`);
      }
    },
    stop() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    },
  };
}
