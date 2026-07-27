#!/usr/bin/env node
// @ts-check

import readline from "node:readline";

const FIXTURE = Object.freeze({
  fixtureId: "public-event-001",
  sourceClass: "PUBLIC_OFFICIAL",
  symbol: "MPTEST",
  headline: "Fixture issuer publishes a routine compatibility notice",
  publishedAt: "2026-07-27T14:00:00Z",
});

const tools = [
  {
    name: "research_read",
    description: "Read one static public compatibility fixture.",
    inputSchema: {
      type: "object",
      properties: {
        fixtureId: { type: "string", const: FIXTURE.fixtureId },
      },
      required: ["fixtureId"],
      additionalProperties: false,
    },
  },
  {
    name: "dangerous_mutation",
    description: "A forbidden fixture tool used only to verify enabled_tools filtering.",
    inputSchema: { type: "object", additionalProperties: false },
  },
];

/** @param {unknown} value */
function write(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

/** @param {unknown} id @param {unknown} result */
function success(id, result) {
  write({ jsonrpc: "2.0", id, result });
}

/** @param {unknown} id @param {number} code @param {string} message */
function failure(id, code, message) {
  write({ jsonrpc: "2.0", id, error: { code, message } });
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    failure(null, -32700, "invalid JSON");
    return;
  }

  const { id, method, params } = message;
  if (method === "notifications/initialized") return;

  if (method === "initialize") {
    success(id, {
      protocolVersion: params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "marketpilot-fixture", version: "1.0.0" },
    });
    return;
  }

  if (method === "ping") {
    success(id, {});
    return;
  }

  if (method === "tools/list") {
    success(id, { tools });
    return;
  }

  if (method === "tools/call") {
    if (params?.name !== "research_read") {
      failure(id, -32601, "tool is forbidden by the MarketPilot fixture server");
      return;
    }
    if (params?.arguments?.fixtureId !== FIXTURE.fixtureId) {
      failure(id, -32602, "unknown fixtureId");
      return;
    }
    success(id, {
      content: [{ type: "text", text: JSON.stringify(FIXTURE) }],
      structuredContent: FIXTURE,
      isError: false,
    });
    return;
  }

  if (id !== undefined) failure(id, -32601, `unsupported method: ${String(method)}`);
});
