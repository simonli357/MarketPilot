// @ts-check

import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  QUALIFIED_LINUX_X64_BASELINE,
  createDiagnosticRedactor,
  runAutomatedCompatibilityProbe,
  sha256DirectoryManifest,
  summarizeObservedNotifications,
  validateEffectiveConfig,
  validateMcpInventory,
  validateThreadPolicy,
} from "../../src/codex/compatibility-probe.mjs";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..", "..");

test("schema directory hashing canonicalizes JSON object-key order", async (t) => {
  const first = await privateTemporaryDirectory(t, "marketpilot-schema-first-");
  const second = await privateTemporaryDirectory(t, "marketpilot-schema-second-");
  await writeFile(
    path.join(first, "schema.json"),
    '{"definitions":{"Beta":{"type":"string"},"Alpha":{"type":"number"}},"type":"object"}\n',
    { mode: 0o600 },
  );
  await writeFile(
    path.join(second, "schema.json"),
    '{"type":"object","definitions":{"Alpha":{"type":"number"},"Beta":{"type":"string"}}}\n',
    { mode: 0o600 },
  );

  assert.equal(
    await sha256DirectoryManifest(first),
    await sha256DirectoryManifest(second),
  );
});

test("schema directory hashing rejects symlink roots and entries", async (t) => {
  const root = await privateTemporaryDirectory(t, "marketpilot-schema-safe-");
  const outside = await privateTemporaryDirectory(t, "marketpilot-schema-outside-");
  await writeFile(path.join(outside, "schema.json"), "{}\n", { mode: 0o600 });
  const linkedRoot = path.join(os.tmpdir(), `marketpilot-schema-link-${process.pid}`);
  await symlink(root, linkedRoot);
  t.after(async () => rm(linkedRoot, { force: true }));
  await symlink(path.join(outside, "schema.json"), path.join(root, "schema.json"));

  await assert.rejects(
    sha256DirectoryManifest(linkedRoot),
    /manifest root must be a non-symlink directory/u,
  );
  await assert.rejects(
    sha256DirectoryManifest(root),
    /schema manifest contains a symlink/u,
  );
});

test("thread policy requires a non-persistent OpenAI ephemeral thread", () => {
  const cwd = "/private/runtime/work";
  const thread = {
    model: "gpt-5.6-sol",
    modelProvider: "openai",
    reasoningEffort: "ultra",
    approvalPolicy: "never",
    cwd,
    sandbox: { type: "readOnly", networkAccess: false },
    thread: {
      ephemeral: true,
      path: null,
      cwd,
      modelProvider: "openai",
    },
  };

  assert.equal(validateThreadPolicy(thread, cwd), true);
  assert.equal(validateThreadPolicy({ ...thread, modelProvider: "other" }, cwd), false);
  assert.equal(
    validateThreadPolicy({ ...thread, thread: { ...thread.thread, path: "/persisted/thread" } }, cwd),
    false,
  );
  assert.equal(
    validateThreadPolicy({ ...thread, thread: { ...thread.thread, modelProvider: "other" } }, cwd),
    false,
  );
});

test("effective config validation covers every hardened field and rejects capability drift", () => {
  const cwd = "/private/runtime/work";
  const command = "/private/node";
  const fixturePath = "/private/fixture-mcp-server.mjs";
  const expectation = {
    fixtureMcpCommand: command,
    fixtureMcpArgs: [fixturePath],
    fixtureMcpCwd: cwd,
  };
  const config = effectiveConfigFixture({ cwd, command, fixturePath });

  assert.equal(validateEffectiveConfig(config, expectation), true);

  const mutations = [
    (value) => (value.model_provider = "unexpected"),
    (value) => (value.mcp_oauth_credentials_store = "file"),
    (value) => (value.analytics.enabled = true),
    (value) => (value.file_opener = "vscode"),
    (value) => (value.hide_agent_reasoning = false),
    (value) => (value.show_raw_agent_reasoning = true),
    (value) => (value.agents.interrupt_message = false),
    (value) => (value.features.unreviewed_capability = true),
    (value) => (value.features.unreviewed_capability = "disabled"),
    (value) => (value.features.mentions_v2 = "true"),
    (value) => (value.shell_environment_policy.inherit = "all"),
    (value) => (value.shell_environment_policy.set.SECRET = "inherited"),
    (value) => (value.shell_environment_policy.unreviewed = false),
    (value) => (value.mcp_servers.marketpilot_fixture.command = "/other/node"),
    (value) => value.mcp_servers.marketpilot_fixture.args.push("--unexpected"),
    (value) => (value.mcp_servers.marketpilot_fixture.cwd = "/other"),
    (value) => (value.mcp_servers.marketpilot_fixture.env.SECRET = "value"),
    (value) => (value.mcp_servers.marketpilot_fixture.env_vars = []),
    (value) => (value.mcp_servers.marketpilot_fixture.startup_timeout_sec = 6),
    (value) => (value.mcp_servers.marketpilot_fixture.tool_timeout_sec = 6),
    (value) => value.mcp_servers.marketpilot_fixture.disabled_tools.push("research_read"),
    (value) => (value.mcp_servers.marketpilot_fixture.unreviewed = false),
  ];

  for (const mutate of mutations) {
    const candidate = structuredClone(config);
    mutate(candidate);
    assert.equal(validateEffectiveConfig(candidate, expectation), false);
  }
});

test("MCP inventory validation proves the exact public read contract", () => {
  const inventory = [{
    name: "marketpilot_fixture",
    authStatus: "unsupported",
    resourceTemplates: [],
    resources: [],
    tools: {
      research_read: {
        name: "research_read",
        inputSchema: {
          type: "object",
          properties: {
            fixtureId: { type: "string", const: "public-event-001" },
          },
          required: ["fixtureId"],
          additionalProperties: false,
        },
      },
    },
  }];

  assert.equal(validateMcpInventory(inventory, null), true);
  assert.equal(validateMcpInventory(inventory, undefined), true);

  const mutations = [
    (value) => (value[0].authStatus = "oauth"),
    (value) => value[0].resources.push({ uri: "file:///private" }),
    (value) => (value[0].tools.research_read = null),
    (value) => (value[0].tools.research_read.name = "dangerous_mutation"),
    (value) => (value[0].tools.research_read.inputSchema.additionalProperties = true),
    (value) => (value[0].tools.research_read.inputSchema.properties.fixtureId.const = "other"),
    (value) => (value[0].tools.research_read.inputSchema.properties.extra = { type: "string" }),
  ];
  for (const mutate of mutations) {
    const candidate = structuredClone(inventory);
    mutate(candidate);
    assert.equal(validateMcpInventory(candidate, null), false);
  }
  assert.equal(validateMcpInventory(inventory, "next-page"), false);
});

test("diagnostic evidence redacts authorization forms and hashes unknown notifications", () => {
  const redact = createDiagnosticRedactor({
    runtimeRoot: "/private/runtime",
    projectRoot: "/private/project",
  });
  const secrets = [
    "Authorization: Bearer opaque-header-secret",
    '"authorization":"Bearer opaque-json-secret"',
    "Bearer opaque-standalone-secret",
    "authorization=Basic opaque-basic-secret",
  ];
  const redacted = secrets.map(redact).join("\n");

  assert.doesNotMatch(redacted, /opaque-|basic-secret/u);
  assert.match(redacted, /<redacted>/u);

  const unknownMethod = "attacker/secret-notification-name";
  const notifications = summarizeObservedNotifications(["thread/started", unknownMethod]);
  assert.equal(notifications.length, 2);
  assert.ok(notifications.includes("thread/started"));
  assert.ok(notifications.some((value) => /^unknown:[a-f0-9]{16}$/u.test(value)));
  assert.doesNotMatch(JSON.stringify(notifications), /secret-notification-name/u);
});

test("credential-free probe qualifies the real pinned app-server", async (t) => {
  const baseDir = await privateTemporaryDirectory(t, "marketpilot-compatibility-real-");
  const report = await runAutomatedCompatibilityProbe({
    projectRoot: PROJECT_ROOT,
    baseDir,
    requestTimeoutMs: 15_000,
  });

  assert.equal(report.passed, true);
  assert.equal(report.runtime.codexVersion, "0.145.0");
  assert.equal(
    report.runtime.binarySha256,
    QUALIFIED_LINUX_X64_BASELINE.binarySha256,
  );
  assert.equal(
    report.runtime.stableSchemaSha256,
    QUALIFIED_LINUX_X64_BASELINE.stableSchemaSha256,
  );
  assert.equal(
    report.runtime.stableSchemaManifestSha256,
    QUALIFIED_LINUX_X64_BASELINE.stableSchemaManifestSha256,
  );
  assert.equal(report.authentication.state, "signed-out");
  assert.equal(report.authentication.entitlementProven, false);
  assert.ok(report.checks.every(({ passed }) => passed));
  assert.ok(report.storage.some(({ classification }) => classification === "sqlite"));
  assert.ok(
    report.storage.every(({ classification }) =>
      ["credential", "sqlite", "transcript", "log"].includes(classification),
    ),
  );
  assert.ok(report.storage.every(({ pathSha256 }) => /^[a-f0-9]{64}$/u.test(pathSha256)));
  assert.equal(JSON.stringify(report.storage).includes("relativePath"), false);
  assert.doesNotMatch(JSON.stringify(report), /@example|access[_-]?token|bearer\s/u);
});

function effectiveConfigFixture({ cwd, command, fixturePath }) {
  const disabledFeatures = [
    "apps",
    "auth_elicitation",
    "browser_use",
    "browser_use_external",
    "browser_use_full_cdp_access",
    "code_mode_host",
    "computer_use",
    "fast_mode",
    "goals",
    "guardian_approval",
    "hooks",
    "image_generation",
    "in_app_browser",
    "memories",
    "network_proxy",
    "plugin_sharing",
    "plugins",
    "personality",
    "remote_plugin",
    "shell_snapshot",
    "shell_tool",
    "skill_mcp_dependency_install",
    "skill_search",
    "tool_call_mcp_elicitation",
    "tool_suggest",
    "unified_exec",
    "workspace_dependencies",
  ];
  return {
    model: "gpt-5.6-sol",
    model_provider: "openai",
    model_reasoning_effort: "ultra",
    personality: "none",
    approval_policy: "never",
    sandbox_mode: "read-only",
    allow_login_shell: false,
    cli_auth_credentials_store: "keyring",
    mcp_oauth_credentials_store: "keyring",
    forced_login_method: "chatgpt",
    web_search: "disabled",
    check_for_update_on_startup: false,
    file_opener: "none",
    hide_agent_reasoning: true,
    show_raw_agent_reasoning: false,
    analytics: { enabled: false },
    history: { persistence: "none" },
    agents: {
      enabled: true,
      max_concurrent_threads_per_session: 2,
      default_subagent_model: "gpt-5.6-sol",
      default_subagent_reasoning_effort: "ultra",
      interrupt_message: true,
    },
    features: {
      ...Object.fromEntries(disabledFeatures.map((name) => [name, false])),
      mentions_v2: true,
      multi_agent: true,
      remote_control: false,
    },
    shell_environment_policy: {
      inherit: "none",
      ignore_default_excludes: false,
      exclude: ["*"],
      include_only: [],
      set: {},
      experimental_use_profile: false,
    },
    mcp_servers: {
      marketpilot_fixture: {
        command,
        args: [fixturePath],
        env: {},
        cwd,
        environment_id: "local",
        enabled: true,
        required: true,
        startup_timeout_sec: 5,
        tool_timeout_sec: 5,
        enabled_tools: ["research_read"],
        disabled_tools: [],
      },
    },
  };
}

/** @param {import("node:test").TestContext} t @param {string} prefix */
async function privateTemporaryDirectory(t, prefix) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  await chmod(directory, 0o700);
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}
