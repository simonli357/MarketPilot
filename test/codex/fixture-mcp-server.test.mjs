// @ts-check

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  AppServerClient,
  AppServerRemoteError,
} from "../../src/codex/app-server-client.mjs";

const FIXTURE_ID = "public-event-001";
const FIXTURE_PATH = fileURLToPath(
  new URL("../fixtures/fixture-mcp-server.mjs", import.meta.url),
);
const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));

test("fixture MCP exposes one public read contract and denies every mutation surface", async () => {
  const client = new AppServerClient({
    command: process.execPath,
    args: [FIXTURE_PATH],
    cwd: PROJECT_ROOT,
    env: { NO_COLOR: "1" },
    requestTimeoutMs: 2_000,
    stderrMaxBytes: 8 * 1024,
  });

  try {
    await client.start();
    const initialized = await client.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "marketpilot_fixture_test", version: "0.1.0" },
    });
    assert.deepEqual(initialized, {
      protocolVersion: "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "marketpilot-fixture", version: "1.0.0" },
    });
    await client.notify("notifications/initialized", {});

    const inventory = await client.request("tools/list", {});
    assert.equal(inventory.tools.length, 2);
    const readTool = inventory.tools.find(({ name }) => name === "research_read");
    assert.deepEqual(readTool.inputSchema, {
      type: "object",
      properties: { fixtureId: { type: "string", const: FIXTURE_ID } },
      required: ["fixtureId"],
      additionalProperties: false,
    });

    const result = await client.request("tools/call", {
      name: "research_read",
      arguments: { fixtureId: FIXTURE_ID },
    });
    assert.equal(result.isError, false);
    assert.equal(result.structuredContent.fixtureId, FIXTURE_ID);
    assert.equal(result.structuredContent.sourceClass, "PUBLIC_OFFICIAL");
    assert.deepEqual(
      JSON.parse(result.content[0].text),
      result.structuredContent,
    );

    await assertRemoteCode(
      client.request("tools/call", { name: "dangerous_mutation", arguments: {} }),
      -32601,
    );
    await assertRemoteCode(
      client.request("tools/call", {
        name: "research_read",
        arguments: { fixtureId: "not-the-public-fixture" },
      }),
      -32602,
    );
    await assertRemoteCode(client.request("resources/list", {}), -32601);
    await assertRemoteCode(client.request("resources/templates/list", {}), -32601);
    await assertRemoteCode(client.request("prompts/list", {}), -32601);
  } finally {
    await client.stop();
  }
});

/** @param {Promise<unknown>} operation @param {number} expectedCode */
async function assertRemoteCode(operation, expectedCode) {
  await assert.rejects(operation, (error) => {
    assert(error instanceof AppServerRemoteError);
    assert.equal(error.remoteCode, expectedCode);
    return true;
  });
}
