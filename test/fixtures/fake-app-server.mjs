#!/usr/bin/env node

import { createInterface } from "node:readline";

const SCENARIO_ENV = "MARKETPILOT_FAKE_APP_SERVER_SCENARIO";
const OVERSIZED_BYTES_ENV = "MARKETPILOT_FAKE_APP_SERVER_OVERSIZED_BYTES";
const FIXTURE_MCP_NAME = "marketpilot_fixture";
const FIXTURE_MCP_READ_TOOL = "research_read";

const scenarios = new Set([
  "happy",
  "malformed-json",
  "malformed-start-response",
  "malformed-item",
  "oversized-line",
  "unexpected-server-request",
  "forbidden-tool",
  "forbidden-item",
  "interrupted",
  "invalid-output-json",
  "schema-mismatch",
  "mismatched-terminal",
  "conflicting-terminal-item",
  "missing-final",
  "notification-flood",
  "rate-limit",
  "auth-error",
  "remote-rate-limit",
  "remote-auth-error",
  "required-tool-success",
  "required-tool-failed",
  "required-tool-malformed",
  "pre-response-ordered",
  "item-before-turn-started",
  "terminal-before-turn-started",
  "post-terminal-item",
  "slow-stop",
  "conflicting-terminal-mcp",
  "conflicting-terminal-mcp-result",
  "conflicting-terminal-mcp-is-error",
  "secret-duplicate-item",
  "secret-mcp-status",
  "bounded-delegation-success",
  "delegation-over-limit",
  "delegation-wrong-model",
  "delegation-unknown-receiver",
  "reroute",
  "ambiguous-final",
  "crash",
  "timeout",
  "duplicate-response",
]);

const scenario = process.env[SCENARIO_ENV] ?? "happy";

if (!scenarios.has(scenario)) {
  process.stderr.write(`Unknown fake app-server scenario: ${scenario}\n`);
  process.exitCode = 64;
} else {
  run();
}

function run() {
  let initializeSeen = false;
  let initializedSeen = false;
  let activeTurn = null;
  let currentThreadId = "fixture-thread-1";
  let turnSequence = 0;

  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });

  input.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      writeError(null, -32700, "Parse error");
      return;
    }

    if (!isObject(message)) {
      writeError(null, -32600, "Invalid Request");
      return;
    }

    if (!("method" in message)) {
      // A test client can respond to a deliberately injected server request.
      return;
    }

    if (message.method === "initialize") {
      if (initializeSeen) {
        writeError(message.id ?? null, -32600, "Already initialized");
        return;
      }

      initializeSeen = true;
      writeResult(message.id, {
        userAgent: "marketpilot-fake-app-server/0.145.0",
        platformFamily: "unix",
        platformOs: "linux",
      });
      return;
    }

    if (message.method === "initialized") {
      if (!initializeSeen) {
        if ("id" in message) {
          writeError(message.id, -32002, "Not initialized");
        }
        return;
      }
      initializedSeen = true;
      return;
    }

    if (!initializeSeen || !initializedSeen) {
      writeError(message.id ?? null, -32002, "Not initialized");
      return;
    }

    switch (message.method) {
      case "model/list":
        writeResult(message.id, modelList());
        break;
      case "config/read":
        writeResult(message.id, configRead());
        break;
      case "account/read":
        writeResult(message.id, {
          account: { type: "chatgpt", email: null, planType: "plus" },
          requiresOpenaiAuth: true,
        });
        break;
      case "skills/list":
        writeResult(message.id, skillsList());
        break;
      case "mcpServerStatus/list":
        writeResult(message.id, mcpServerStatusList());
        break;
      case "thread/start": {
        currentThreadId = "fixture-thread-1";
        const thread = makeThread(currentThreadId, message.params?.cwd);
        writeResult(message.id, threadResponse(thread));
        writeNotification("thread/started", { thread });
        break;
      }
      case "thread/resume": {
        currentThreadId = message.params?.threadId ?? currentThreadId;
        const thread = makeThread(currentThreadId, message.params?.cwd);
        writeResult(message.id, threadResponse(thread));
        break;
      }
      case "turn/start": {
        if (scenario === "remote-rate-limit") {
          writeError(message.id, 429, "Fixture remote usage limit reached");
          break;
        }
        if (scenario === "remote-auth-error") {
          writeError(message.id, 401, "Fixture remote authentication expired");
          break;
        }
        turnSequence += 1;
        const threadId = message.params?.threadId ?? currentThreadId;
        const turnId = `fixture-turn-${turnSequence}`;
        activeTurn = { threadId, turnId };
        startTurn(message.id, activeTurn);
        if (scenario !== "timeout" && scenario !== "crash") {
          activeTurn = null;
        }
        break;
      }
      case "turn/interrupt": {
        writeResult(message.id, {});
        if (activeTurn !== null) {
          writeNotification("turn/completed", {
            threadId: activeTurn.threadId,
            turn: makeTurn(activeTurn.turnId, "interrupted", []),
          });
          activeTurn = null;
        }
        break;
      }
      default:
        writeError(message.id ?? null, -32601, "Method not found");
    }
  });
}

function startTurn(requestId, { threadId, turnId }) {
  if (scenario === "crash") {
    process.exit(70);
  }

  const inProgress = makeTurn(turnId, "inProgress", []);
  if (scenario === "malformed-start-response") {
    writeResult(requestId, { turn: { status: "inProgress", items: [] } });
    return;
  }
  if (scenario === "notification-flood") {
    for (let index = 0; index <= 128; index += 1) {
      writeNotification(
        "item/started",
        itemNotification(threadId, turnId, {
          id: `fixture-flood-item-${index}`,
          type: "reasoning",
          summary: [],
          content: [],
        }),
      );
    }
    writeResult(requestId, { turn: inProgress });
    return;
  }
  if (scenario === "pre-response-ordered") {
    writeNotification("turn/started", { threadId, turn: inProgress });
    completeSuccessfully(threadId, turnId);
    writeResult(requestId, { turn: inProgress });
    return;
  }
  if (scenario === "item-before-turn-started") {
    const item = makeAgentMessage(1);
    writeNotification("item/completed", itemNotification(threadId, turnId, item));
    writeResult(requestId, { turn: inProgress });
    writeNotification("turn/started", { threadId, turn: inProgress });
    writeNotification("turn/completed", {
      threadId,
      turn: makeTurn(turnId, "completed", [item]),
    });
    return;
  }
  if (scenario === "terminal-before-turn-started") {
    writeNotification("turn/completed", {
      threadId,
      turn: makeTurn(turnId, "completed", []),
    });
    writeResult(requestId, { turn: inProgress });
    writeNotification("turn/started", { threadId, turn: inProgress });
    return;
  }
  writeResult(requestId, { turn: inProgress });

  if (scenario === "duplicate-response") {
    writeResult(requestId, { turn: inProgress });
  }

  writeNotification("turn/started", { threadId, turn: inProgress });

  switch (scenario) {
    case "malformed-json":
      process.stdout.write('{"method":"item/completed","params":\n');
      return;
    case "malformed-item":
      writeNotification(
        "item/completed",
        itemNotification(threadId, turnId, {
          type: "agentMessage",
          text: "fixture item has no identifier",
        }),
      );
      return;
    case "oversized-line": {
      const requestedBytes = Number.parseInt(
        process.env[OVERSIZED_BYTES_ENV] ?? String(1024 * 1024 + 1),
        10,
      );
      const bytes = Number.isSafeInteger(requestedBytes) && requestedBytes > 0
        ? requestedBytes
        : 1024 * 1024 + 1;
      writeNotification("fixture/oversized", { padding: "x".repeat(bytes) });
      return;
    }
    case "unexpected-server-request":
      write({
        id: 9001,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId,
          turnId,
          itemId: "fixture-forbidden-request",
          reason: "fixture-only approval request",
        },
      });
      return;
    case "forbidden-tool":
      writeNotification(
        "item/completed",
        itemNotification(
          threadId,
          turnId,
          {
            id: "fixture-forbidden-tool",
            type: "mcpToolCall",
            server: "forbidden_server",
            tool: "write_fixture",
            arguments: {},
            status: "completed",
            result: { content: [] },
          },
        ),
      );
      completeSuccessfully(threadId, turnId);
      return;
    case "forbidden-item":
      writeNotification(
        "item/completed",
        itemNotification(
          threadId,
          turnId,
          {
            id: "fixture-forbidden-item",
            type: "commandExecution",
            command: "fixture-command-never-executed",
            commandActions: [],
            cwd: "/tmp/marketpilot-fixture-work",
            status: "completed",
          },
        ),
      );
      completeSuccessfully(threadId, turnId);
      return;
    case "interrupted":
      writeNotification("turn/completed", {
        threadId,
        turn: makeTurn(turnId, "interrupted", []),
      });
      return;
    case "invalid-output-json":
      completeSuccessfully(threadId, turnId, 1, ["not-json"]);
      return;
    case "schema-mismatch":
      completeSuccessfully(threadId, turnId, 1, [JSON.stringify({
        status: "ok",
        summary: "Fixture compatibility contract is intact.",
        checks: [{
          name: "fixture-source",
          passed: true,
          detail: "The fixture contains public, non-sensitive evidence.",
        }],
        unexpected: true,
      })]);
      return;
    case "mismatched-terminal":
      writeNotification(
        "item/completed",
        itemNotification(threadId, turnId, makeAgentMessage(1)),
      );
      writeNotification("turn/completed", {
        threadId: "fixture-thread-other",
        turn: makeTurn(turnId, "completed", [makeAgentMessage(1)]),
      });
      return;
    case "conflicting-terminal-item": {
      const completed = makeAgentMessage(1);
      const changed = makeAgentMessage(1, JSON.stringify({
        status: "abstain",
        summary: "Terminal text differs from item/completed.",
        checks: [{
          name: "fixture-source",
          passed: false,
          detail: "This conflicting fixture must never be accepted.",
        }],
      }));
      writeNotification(
        "item/completed",
        itemNotification(threadId, turnId, completed),
      );
      writeNotification("turn/completed", {
        threadId,
        turn: makeTurn(turnId, "completed", [changed]),
      });
      return;
    }
    case "missing-final":
      completeSuccessfully(threadId, turnId, 0);
      return;
    case "required-tool-success":
      completeWithRequiredMcp(threadId, turnId, "completed");
      return;
    case "required-tool-failed":
      completeWithRequiredMcp(threadId, turnId, "failed");
      return;
    case "required-tool-malformed": {
      const malformed = { ...makeRequiredMcp("completed"), result: null };
      writeNotification("item/completed", itemNotification(threadId, turnId, malformed));
      return;
    }
    case "post-terminal-item":
      completeSuccessfully(threadId, turnId);
      setTimeout(() => {
        writeNotification(
          "item/completed",
          itemNotification(threadId, turnId, makeAgentMessage(2)),
        );
      }, 20);
      return;
    case "slow-stop":
      completeSuccessfully(threadId, turnId);
      setTimeout(() => {}, 300);
      return;
    case "conflicting-terminal-mcp": {
      const completed = makeRequiredMcp("completed");
      const changed = {
        ...completed,
        arguments: { fixtureId: "public-event-changed" },
      };
      const agentMessage = makeAgentMessage(1);
      writeNotification("item/completed", itemNotification(threadId, turnId, completed));
      writeNotification("item/completed", itemNotification(threadId, turnId, agentMessage));
      writeNotification("turn/completed", {
        threadId,
        turn: makeTurn(turnId, "completed", [changed, agentMessage]),
      });
      return;
    }
    case "conflicting-terminal-mcp-result": {
      const completed = makeRequiredMcp("completed");
      const changed = {
        ...completed,
        result: {
          ...completed.result,
          structuredContent: {
            fixtureId: "public-event-001",
            sourceClass: "PRIVATE",
          },
        },
      };
      completeWithConflictingMcp(threadId, turnId, completed, changed);
      return;
    }
    case "conflicting-terminal-mcp-is-error": {
      const completed = makeRequiredMcp("completed");
      const changed = {
        ...completed,
        result: { ...completed.result, isError: true },
      };
      completeWithConflictingMcp(threadId, turnId, completed, changed);
      return;
    }
    case "secret-duplicate-item": {
      const item = {
        id: "sk-secret-item-identifier-never-report",
        type: "reasoning",
        summary: [],
        content: [],
      };
      writeNotification("item/completed", itemNotification(threadId, turnId, item));
      writeNotification("item/completed", itemNotification(threadId, turnId, item));
      return;
    }
    case "secret-mcp-status":
      writeNotification(
        "item/completed",
        itemNotification(threadId, turnId, {
          ...makeRequiredMcp("completed"),
          status: "sk-secret-status-never-report",
        }),
      );
      return;
    case "bounded-delegation-success":
      completeWithItems(threadId, turnId, [
        makeSpawnItem("fixture-agent-1", "gpt-5.6-sol", "ultra"),
        makeSubAgentActivity("fixture-agent-1"),
        makeAgentMessage(1),
      ]);
      return;
    case "delegation-over-limit":
      for (const sequence of [1, 2, 3]) {
        const item = makeSpawnItem(`fixture-agent-${sequence}`, null, null, sequence);
        writeNotification("item/completed", itemNotification(threadId, turnId, item));
      }
      return;
    case "delegation-wrong-model":
      writeNotification(
        "item/completed",
        itemNotification(threadId, turnId, makeSpawnItem("fixture-agent-1", "gpt-other", "ultra")),
      );
      return;
    case "delegation-unknown-receiver":
      writeNotification(
        "item/completed",
        itemNotification(threadId, turnId, {
          id: "fixture-send-input",
          type: "collabAgentToolCall",
          tool: "sendInput",
          status: "completed",
          senderThreadId: threadId,
          receiverThreadIds: ["fixture-unknown-agent"],
          agentsStates: {},
          model: null,
          reasoningEffort: null,
        }),
      );
      return;
    case "rate-limit":
      completeWithError(
        threadId,
        turnId,
        "Fixture usage limit reached",
        "usageLimitExceeded",
      );
      return;
    case "auth-error":
      completeWithError(
        threadId,
        turnId,
        "Fixture authentication expired",
        "unauthorized",
      );
      return;
    case "reroute":
      writeNotification("model/rerouted", {
        threadId,
        turnId,
        fromModel: "gpt-5.6-sol",
        toModel: "gpt-5.6-terra",
        reason: "highRiskCyberActivity",
      });
      completeSuccessfully(threadId, turnId);
      return;
    case "ambiguous-final":
      completeSuccessfully(threadId, turnId, 2);
      return;
    case "timeout":
      return;
    case "duplicate-response":
    case "happy":
      completeSuccessfully(threadId, turnId);
      return;
    default:
      throw new Error(`Unhandled fake app-server scenario: ${scenario}`);
  }
}

function completeSuccessfully(threadId, turnId, messageCount = 1, messageTexts = []) {
  const items = Array.from({ length: messageCount }, (_, index) =>
    makeAgentMessage(index + 1, messageTexts[index]),
  );

  for (const item of items) {
    writeNotification(
      "item/completed",
      itemNotification(threadId, turnId, item),
    );
  }

  writeNotification("turn/completed", {
    threadId,
    turn: makeTurn(turnId, "completed", items),
  });
}

function completeWithError(threadId, turnId, message, codexErrorInfo) {
  writeNotification("turn/completed", {
    threadId,
    turn: {
      ...makeTurn(turnId, "failed", []),
      error: { message, codexErrorInfo },
    },
  });
}

function completeWithRequiredMcp(threadId, turnId, status) {
  const toolItem = makeRequiredMcp(status);
  completeWithItems(threadId, turnId, [toolItem, makeAgentMessage(1)]);
}

function makeRequiredMcp(status) {
  return {
    id: "fixture-required-mcp",
    type: "mcpToolCall",
    server: FIXTURE_MCP_NAME,
    tool: FIXTURE_MCP_READ_TOOL,
    arguments: { fixtureId: "public-event-001" },
    status,
    result: status === "completed" ? {
      content: [{ type: "text", text: "public fixture" }],
      structuredContent: {
        fixtureId: "public-event-001",
        sourceClass: "PUBLIC_OFFICIAL",
      },
      isError: false,
    } : null,
  };
}

function completeWithItems(threadId, turnId, items) {
  for (const item of items) {
    writeNotification(
      "item/completed",
      itemNotification(threadId, turnId, item),
    );
  }
  writeNotification("turn/completed", {
    threadId,
    turn: makeTurn(turnId, "completed", items),
  });
}

function completeWithConflictingMcp(threadId, turnId, completed, changed) {
  const agentMessage = makeAgentMessage(1);
  writeNotification("item/completed", itemNotification(threadId, turnId, completed));
  writeNotification("item/completed", itemNotification(threadId, turnId, agentMessage));
  writeNotification("turn/completed", {
    threadId,
    turn: makeTurn(turnId, "completed", [changed, agentMessage]),
  });
}

function makeSpawnItem(receiverThreadId, model, reasoningEffort, sequence = 1) {
  return {
    id: `fixture-spawn-${sequence}`,
    type: "collabAgentToolCall",
    tool: "spawnAgent",
    status: "completed",
    senderThreadId: "fixture-thread-1",
    receiverThreadIds: [receiverThreadId],
    agentsStates: {
      [receiverThreadId]: { status: "completed", message: null },
    },
    model,
    reasoningEffort,
    prompt: "Use only the fixed public fixture.",
  };
}

function makeSubAgentActivity(agentThreadId) {
  return {
    id: "fixture-sub-agent-activity",
    type: "subAgentActivity",
    agentThreadId,
    agentPath: "/root/fixture-agent-1",
    kind: "started",
  };
}

function makeAgentMessage(sequence, text) {
  return {
    id: `fixture-agent-message-${sequence}`,
    type: "agentMessage",
    text: text ?? JSON.stringify({
      status: "ok",
      summary: "Fixture compatibility contract is intact.",
      checks: [{
        name: "fixture-source",
        passed: true,
        detail: "The fixture contains public, non-sensitive evidence.",
      }],
    }),
  };
}

function makeTurn(id, status, items) {
  return {
    id,
    status,
    items,
    startedAt: 1_700_000_000,
    completedAt: status === "inProgress" ? null : 1_700_000_001,
  };
}

function itemNotification(threadId, turnId, item) {
  return {
    threadId,
    turnId,
    item,
    completedAtMs: 1_700_000_001_000,
  };
}

function makeThread(id, requestedCwd) {
  const cwd = typeof requestedCwd === "string"
    ? requestedCwd
    : "/tmp/marketpilot-fixture-work";

  return {
    id,
    preview: "",
    ephemeral: true,
    modelProvider: "openai",
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_000,
    status: { type: "idle" },
    cwd,
    cliVersion: "0.145.0",
    source: "appServer",
    sessionId: "fixture-session-1",
    turns: [],
  };
}

function threadResponse(thread) {
  return {
    thread,
    model: "gpt-5.6-sol",
    modelProvider: "openai",
    reasoningEffort: "ultra",
    cwd: thread.cwd,
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "readOnly", networkAccess: false },
    instructionSources: [],
  };
}

function modelList() {
  return {
    data: [
      {
        id: "gpt-5.6-sol",
        model: "gpt-5.6-sol",
        displayName: "GPT-5.6 Sol",
        description: "Fixture-only model metadata",
        hidden: false,
        isDefault: true,
        defaultReasoningEffort: "ultra",
        supportedReasoningEfforts: [
          {
            reasoningEffort: "ultra",
            description: "Fixture-only Ultra effort",
          },
        ],
      },
    ],
    nextCursor: null,
  };
}

function configRead() {
  return {
    config: {
      model: "gpt-5.6-sol",
      model_reasoning_effort: "ultra",
      approval_policy: "never",
      sandbox_mode: "read-only",
      web_search: "disabled",
      cli_auth_credentials_store: "keyring",
      forced_login_method: "chatgpt",
      agents: {
        max_concurrent_threads_per_session: 2,
        default_model: "gpt-5.6-sol",
        default_reasoning_effort: "ultra",
      },
      mcp_servers: {
        [FIXTURE_MCP_NAME]: {
          enabled: true,
          required: true,
          enabled_tools: [FIXTURE_MCP_READ_TOOL],
        },
      },
    },
    origins: {},
    layers: [],
  };
}

function skillsList() {
  return {
    data: [
      {
        cwd: "/tmp/marketpilot-fixture-work",
        errors: [],
        skills: [
          {
            name: "marketpilot-compatibility",
            description: "Reads rights-safe MarketPilot fixture research.",
            enabled: true,
            path: "/tmp/marketpilot-fixture-work/.codex/skills/marketpilot-compatibility/SKILL.md",
            scope: "repo",
          },
        ],
      },
    ],
  };
}

function mcpServerStatusList() {
  return {
    data: [
      {
        name: FIXTURE_MCP_NAME,
        authStatus: "unsupported",
        resourceTemplates: [],
        resources: [],
        tools: {
          [FIXTURE_MCP_READ_TOOL]: {
            name: FIXTURE_MCP_READ_TOOL,
            description: "Read one public, non-sensitive test fixture.",
            inputSchema: {
              type: "object",
              properties: { fixtureId: { type: "string" } },
              required: ["fixtureId"],
              additionalProperties: false,
            },
          },
        },
      },
    ],
    nextCursor: null,
  };
}

function writeNotification(method, params) {
  write({ method, params });
}

function writeResult(id, result) {
  write({ id, result });
}

function writeError(id, code, message) {
  write({ id, error: { code, message } });
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
