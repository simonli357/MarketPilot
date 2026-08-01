// @ts-check

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmod, mkdtemp, rm, symlink } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AuthenticatedSmokeError,
  parseAuthenticatedSmokeArguments,
  prepareAuthenticatedSmokeRuntime,
  PUBLIC_FIXTURE_ID,
  runAuthenticatedSmoke,
} from "../../src/codex/authenticated-smoke.mjs";
import { PROBE_OUTPUT_SCHEMA } from "../../src/codex/probe-artifact.mjs";
import {
  FIXTURE_MCP_NAME,
  FIXTURE_MCP_READ_TOOL,
} from "../../src/codex/runtime-policy.mjs";
import { QUALIFIED_LINUX_X64_BASELINE } from "../../src/codex/runtime-qualification.mjs";
import { runAuthenticatedSmokeCli } from "../../scripts/codex-authenticated-smoke.mjs";

const PROJECT_ROOT = "/test/marketpilot";
const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "..", "..");
const PUBLIC_FIXTURE = Object.freeze({
  fixtureId: PUBLIC_FIXTURE_ID,
  sourceClass: "PUBLIC_OFFICIAL",
  symbol: "MPTEST",
  headline: "Fixture issuer publishes a routine compatibility notice",
  publishedAt: "2026-07-27T14:00:00Z",
});
const RUNTIME = Object.freeze({
  installation: { binaryPath: "/test/marketpilot/node_modules/codex" },
  runtime: {
    codexHome: "/run/user/1000/marketpilot-wi001-auth-smoke/codex-home",
    workDir: "/run/user/1000/marketpilot-wi001-auth-smoke/public-fixture-work",
  },
  enabledSkillPath:
    "/run/user/1000/marketpilot-wi001-auth-smoke/codex-home/skills/marketpilot-compatibility/SKILL.md",
  fixtureMcpPath: "/test/marketpilot/test/fixtures/fixture-mcp-server.mjs",
  qualificationSchemaDir:
    "/run/user/1000/marketpilot-wi001-auth-smoke/qualified-schema-fixture",
  environment: { CODEX_HOME: "/run/user/1000/marketpilot-wi001-auth-smoke/codex-home" },
  reconfigure: async () => {},
  releaseRuntime: async () => {},
});
const QUALIFICATION = Object.freeze({
  installation: RUNTIME.installation,
  executableFingerprint: {},
  binarySha256: QUALIFIED_LINUX_X64_BASELINE.binarySha256,
  codexVersion: "codex-cli 0.145.0",
  stableSchemaSha256: QUALIFIED_LINUX_X64_BASELINE.stableSchemaSha256,
  stableSchemaManifestSha256: QUALIFIED_LINUX_X64_BASELINE.stableSchemaManifestSha256,
});
const SUCCESSFUL_LIFECYCLE_PROOF = Object.freeze({
  schemaVersion: 1,
  materializationPassed: true,
  restartResumePassed: true,
  interruptRecoveryPassed: true,
  delegationPassed: true,
  delegatedAgentCount: 1,
});

test("argument parser exposes only opt-in browser login and bounded deadlines", () => {
  assert.deepEqual(parseAuthenticatedSmokeArguments([]), {
    help: false,
    login: false,
    requestTimeoutMs: 30_000,
    turnTimeoutMs: 180_000,
    loginTimeoutMs: 300_000,
  });
  assert.deepEqual(
    parseAuthenticatedSmokeArguments([
      "--login",
      "--timeout-ms",
      "2000",
      "--turn-timeout-ms",
      "240000",
      "--login-timeout-ms",
      "10000",
    ]),
    {
      help: false,
      login: true,
      requestTimeoutMs: 2_000,
      turnTimeoutMs: 240_000,
      loginTimeoutMs: 10_000,
    },
  );
  assert.throws(
    () => parseAuthenticatedSmokeArguments(["--turn-timeout-ms", "29999"]),
    /must be an integer from 30000 through 300000/u,
  );
  assert.throws(
    () => parseAuthenticatedSmokeArguments(["--turn-timeout-ms", "300001"]),
    /must be an integer from 30000 through 300000/u,
  );
  assert.throws(
    () => parseAuthenticatedSmokeArguments([
      "--turn-timeout-ms",
      "30000",
      "--turn-timeout-ms",
      "30000",
    ]),
    /may be supplied only once/u,
  );
});

test("token and custom-input arguments are rejected without reflecting their values", () => {
  const secret = "sk-this-must-not-appear-anywhere";
  for (const argument of [`--api-key=${secret}`, `--input=${secret}`, secret]) {
    assert.throws(
      () => parseAuthenticatedSmokeArguments([argument]),
      (error) => {
        assert(error instanceof AuthenticatedSmokeError);
        assert.equal(error.code, "INVALID_ARGUMENT");
        assert.doesNotMatch(error.message, /this-must-not-appear/u);
        return true;
      },
    );
  }
});

test("API-token environment fails before runtime or process creation", async () => {
  let prepared = false;
  const report = await runAuthenticatedSmoke({
    projectRoot: PROJECT_ROOT,
    sourceEnv: {
      XDG_RUNTIME_DIR: "/run/user/1000",
      OPENAI_SESSION_TOKEN: "never-consume-this",
    },
    dependencies: {
      prepareRuntime: async () => {
        prepared = true;
        return RUNTIME;
      },
      nowIso: () => "2026-07-27T00:00:00.000Z",
    },
  });

  assert.equal(prepared, false);
  assert.equal(report.status, "failed");
  assert.equal(report.failure.code, "API_TOKEN_ENV_FORBIDDEN");
  assert.equal(check(report, "tokenless-auth-input").status, "failed");
});

test("failed binary/schema qualification prevents app-server construction", async () => {
  let clientCreated = false;
  let releaseCount = 0;
  const report = await runAuthenticatedSmoke({
    projectRoot: PROJECT_ROOT,
    login: true,
    sourceEnv: { XDG_RUNTIME_DIR: "/run/user/1000" },
    dependencies: {
      prepareRuntime: async () => ({
        ...RUNTIME,
        releaseRuntime: async () => {
          releaseCount += 1;
        },
      }),
      qualifyRuntime: async () => {
        throw new AuthenticatedSmokeError(
          "BINARY_DIGEST_MISMATCH",
          "fixture mismatch with sensitive path omitted",
        );
      },
      createClient: () => {
        clientCreated = true;
        return new FakeSmokeClient({ authenticated: false });
      },
      nowIso: () => "2026-07-27T00:00:00.000Z",
    },
  });

  assert.equal(clientCreated, false);
  assert.equal(releaseCount, 1);
  assert.equal(report.status, "failed");
  assert.equal(report.failure.code, "BINARY_DIGEST_MISMATCH");
  assert.equal(check(report, "qualified-binary-schema").status, "failed");
  assert.equal(check(report, "account-read").status, "incomplete");
});

test("signed-out execution without --login never opens a browser or starts a turn", async () => {
  const client = new FakeSmokeClient({ authenticated: false });
  let browserOpened = false;
  let turnStarted = false;
  const report = await runAuthenticatedSmoke({
    projectRoot: PROJECT_ROOT,
    sourceEnv: { XDG_RUNTIME_DIR: "/run/user/1000" },
    dependencies: dependencies(client, {
      openBrowser: async () => {
        browserOpened = true;
      },
      runTurn: async () => {
        turnStarted = true;
        throw new Error("must not run");
      },
    }),
  });

  assert.equal(browserOpened, false);
  assert.equal(turnStarted, false);
  assert.equal(client.stopCount, 1);
  assert.equal(report.status, "incomplete");
  assert.equal(report.automatedCorePassed, false);
  assert.equal(check(report, "browser-chatgpt-login").status, "incomplete");
  assert.equal(check(report, "safe-process-cleanup").status, "passed");
});

test("the final auth.json check runs after process stop and before lease release", async () => {
  const client = new FakeSmokeClient({ authenticated: false });
  const order = [];
  const stop = client.stop.bind(client);
  client.stop = async () => {
    order.push("stop");
    await stop();
  };
  let authChecks = 0;

  const report = await runAuthenticatedSmoke({
    projectRoot: PROJECT_ROOT,
    sourceEnv: { XDG_RUNTIME_DIR: "/run/user/1000" },
    dependencies: dependencies(client, {
      prepareRuntime: async () => ({
        ...RUNTIME,
        releaseRuntime: async () => {
          order.push("release");
        },
      }),
      authJsonExists: async () => {
        authChecks += 1;
        order.push(authChecks === 1 ? "auth-initial" : "auth-final");
        return false;
      },
    }),
  });

  assert.equal(report.status, "incomplete");
  assert.deepEqual(order, ["auth-initial", "stop", "auth-final", "release"]);
});

test("non-ChatGPT account auth is rejected before catalog or turn access", async () => {
  const client = new FakeSmokeClient({ authenticated: true, accountType: "apiKey" });
  const report = await runAuthenticatedSmoke({
    projectRoot: PROJECT_ROOT,
    sourceEnv: { XDG_RUNTIME_DIR: "/run/user/1000" },
    dependencies: dependencies(client),
  });

  assert.equal(report.status, "failed");
  assert.equal(report.failure.code, "ACCOUNT_AUTH_METHOD_FORBIDDEN");
  assert.equal(client.methods.includes("model/list"), false);
  assert.equal(client.methods.includes("thread/start"), false);
  assert.equal(client.stopCount, 1);
});

test("pre-turn runtime guard rejects unknown notifications before account or model access", async () => {
  const client = new FakeSmokeClient({ authenticated: true });
  const request = client.request.bind(client);
  client.request = async (method, params, options) => {
    const result = await request(method, params, options);
    if (method === "config/read") {
      client.emit("notification", {
        method: "future/runtimeCapabilityChanged",
        params: {},
      });
    }
    return result;
  };

  const report = await runAuthenticatedSmoke({
    projectRoot: PROJECT_ROOT,
    sourceEnv: { XDG_RUNTIME_DIR: "/run/user/1000" },
    dependencies: dependencies(client),
  });

  assert.equal(report.status, "failed");
  assert.equal(report.failure.code, "RUNTIME_NOTIFICATION_FORBIDDEN");
  assert.equal(client.methods.includes("account/read"), false);
  assert.equal(client.methods.includes("model/list"), false);
  assert.equal(client.listenerCount("notification"), 0);
});

test("smoke client boundary requires an exact empty server-request allowlist", async () => {
  const client = new FakeSmokeClient({ authenticated: true });
  client.serverRequestsForbidden = false;
  const report = await runAuthenticatedSmoke({
    projectRoot: PROJECT_ROOT,
    sourceEnv: { XDG_RUNTIME_DIR: "/run/user/1000" },
    dependencies: dependencies(client),
  });

  assert.equal(report.status, "failed");
  assert.equal(report.failure.code, "SERVER_REQUEST_POLICY_UNSAFE");
  assert.equal(client.state, "stopped");
  assert.equal(client.stopCount, 1);
});

test("thread/started remains valid outside the structured-turn ownership scope", async () => {
  const client = new FakeSmokeClient({ authenticated: true, emitThreadStarted: true });
  const report = await runAuthenticatedSmoke({
    projectRoot: PROJECT_ROOT,
    sourceEnv: { XDG_RUNTIME_DIR: "/run/user/1000" },
    dependencies: dependencies(client, {
      runTurn: async (options) => {
        emitCompletedFixtureMcp(client, options, "fixture-mcp-item");
        return successfulTurn(options.threadId);
      },
    }),
  });

  assert.equal(report.status, "passed");
  assert.equal(report.automatedCorePassed, true);
});

test("explicit --login proves the fixed public MCP turn without exposing its content", async () => {
  const client = new FakeSmokeClient({ authenticated: false });
  /** @type {string[]} */
  const openedUrls = [];
  let lifecycleInvocations = 0;
  const report = await runAuthenticatedSmoke({
    projectRoot: PROJECT_ROOT,
    login: true,
    requestTimeoutMs: 2_000,
    turnTimeoutMs: 240_000,
    sourceEnv: { XDG_RUNTIME_DIR: "/run/user/1000" },
    dependencies: dependencies(client, {
      openBrowser: async (url) => {
        openedUrls.push(url);
      },
      runTurn: async (options) => {
        assert.equal(options.deadlineMs, 240_000);
        assert.equal(options.outputSchema, PROBE_OUTPUT_SCHEMA);
        assert.equal(options.input.length, 1);
        assert.match(options.input[0].text, /never request user input or clarification/iu);
        assert.match(options.input[0].text, new RegExp(PUBLIC_FIXTURE_ID, "u"));
        assert.match(options.input[0].text, /PUBLIC_OFFICIAL/u);
        assert.deepEqual(
          [...options.allowedMcpTools],
          [`${FIXTURE_MCP_NAME}.${FIXTURE_MCP_READ_TOOL}`],
        );
        assert.deepEqual(
          [...options.requiredMcpTools],
          [`${FIXTURE_MCP_NAME}.${FIXTURE_MCP_READ_TOOL}`],
        );
        assert.equal(typeof options.validateMcpCompletion, "function");
        const item = emitCompletedFixtureMcp(client, options, "fixture-mcp-item");
        const evidence = {
          toolName: `${FIXTURE_MCP_NAME}.${FIXTURE_MCP_READ_TOOL}`,
          arguments: item.arguments,
          result: item.result,
          isError: false,
          item,
        };
        assert.equal(options.validateMcpCompletion(evidence), true);
        assert.equal(
          options.validateMcpCompletion({
            ...evidence,
            arguments: { fixtureId: "non-public-or-custom" },
          }),
          false,
        );
        assert.equal(
          options.validateMcpCompletion({
            ...evidence,
            result: {
              ...item.result,
              structuredContent: { ...PUBLIC_FIXTURE, unknownField: "rejected" },
            },
          }),
          false,
        );
        return {
          threadId: options.threadId,
          turnId: "fixture-turn",
          status: "completed",
          finalMessageId: "fixture-message",
          artifact: {
            status: "ok",
            summary: "sensitive-model-text-that-must-not-be-reported",
            checks: [{
              name: "fixture",
              passed: true,
              detail: "sensitive-artifact-detail-that-must-not-be-reported",
            }],
          },
        };
      },
      runLifecycle: async (options) => {
        lifecycleInvocations += 1;
        assert.equal(options.materializedClient, client);
        assert.equal(options.materialized.threadId, "fixture-thread");
        assert.equal(options.materialized.turnId, "fixture-turn");
        assert.equal(options.materialized.finalMessageId, "fixture-message");
        assert.equal(
          options.materialized.threadPath,
          path.join(RUNTIME.runtime.codexHome, "sessions", "fixture-thread.jsonl"),
        );
        assert.equal(options.codexHome, RUNTIME.runtime.codexHome);
        assert.equal(options.cwd, RUNTIME.runtime.workDir);
        assert.match(options.resumedTurn.input[0].text, /exactly one subagent named auth_probe/iu);
        assert.match(options.resumedTurn.input[0].text, /gpt-5\.6-sol/u);
        assert.match(options.resumedTurn.input[0].text, /ultra/u);
        assert.equal(options.resumedTurn.allowedMcpTools.size, 0);
        assert.equal(options.resumedTurn.requiredMcpTools.size, 0);
        const resumedArtifact = options.resumedTurn.parseFinal(JSON.stringify({
          fixtureId: PUBLIC_FIXTURE_ID,
          priorCheckNames: ["fixture"],
          stage: "restart-resume",
          status: "ok",
        }));
        assert.equal(options.validateContinuity({
          materializedArtifact: options.materialized.artifact,
          resumedArtifact,
        }), true);
        assert.equal(options.validateContinuity({
          materializedArtifact: options.materialized.artifact,
          resumedArtifact: { ...resumedArtifact, priorCheckNames: ["not-from-history"] },
        }), false);
        assert.throws(
          () => options.resumedTurn.parseFinal(JSON.stringify({
            fixtureId: "custom-fixture",
            priorCheckNames: ["fixture"],
            stage: "restart-resume",
            status: "ok",
          })),
          /fixed public contract/u,
        );
        return SUCCESSFUL_LIFECYCLE_PROOF;
      },
    }),
  });

  assert.deepEqual(openedUrls, ["https://auth.openai.com/oauth/authorize?fixture=1"]);
  assert.ok(client.requestCalls.length > 0);
  assert.deepEqual([...new Set(client.requestCalls.map(({ timeoutMs }) => timeoutMs))], [2_000]);
  const threadStart = client.requestCalls.find(({ method }) => method === "thread/start");
  assert.match(
    threadStart?.params?.developerInstructions,
    /Never request user input or clarification/u,
  );
  assert.equal(threadStart?.params?.ephemeral, false);
  assert.equal(lifecycleInvocations, 1);
  assert.equal(client.stopCount, 1);
  assert.equal(report.automatedCorePassed, true);
  assert.equal(report.status, "passed");
  assert.equal(check(report, "browser-chatgpt-login").status, "passed");
  assert.equal(check(report, "sol-ultra-entitlement").status, "passed");
  assert.equal(check(report, "required-mcp-structured-turn").status, "passed");
  assert.equal(check(report, "restart-resume").status, "passed");
  assert.equal(check(report, "interrupt-lifecycle").status, "passed");
  assert.equal(check(report, "bounded-delegation").status, "passed");
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /sensitive-model-text|sensitive-artifact-detail|oauth\/authorize/u);
});

test("turn failure still stops the process and reports controlled evidence", async () => {
  const client = new FakeSmokeClient({ authenticated: true });
  const report = await runAuthenticatedSmoke({
    projectRoot: PROJECT_ROOT,
    sourceEnv: { XDG_RUNTIME_DIR: "/run/user/1000" },
    dependencies: dependencies(client, {
      runTurn: async () => {
        throw Object.assign(new Error("prompt content must not escape"), {
          code: "TURN_TIMEOUT",
        });
      },
    }),
  });

  assert.equal(client.stopCount, 1);
  assert.equal(report.status, "failed");
  assert.equal(report.failure.code, "TURN_TIMEOUT");
  assert.equal(check(report, "required-mcp-structured-turn").status, "failed");
  assert.doesNotMatch(JSON.stringify(report), /prompt content/u);
});

test("an invalid lifecycle proof fails every lifecycle check without exposing dependency text", async () => {
  const client = new FakeSmokeClient({ authenticated: true });
  const report = await runAuthenticatedSmoke({
    projectRoot: PROJECT_ROOT,
    sourceEnv: { XDG_RUNTIME_DIR: "/run/user/1000" },
    dependencies: dependencies(client, {
      runTurn: async (options) => {
        emitCompletedFixtureMcp(client, options, "fixture-mcp-one");
        return successfulTurn(options.threadId);
      },
      runLifecycle: async () => ({
        ...SUCCESSFUL_LIFECYCLE_PROOF,
        delegatedAgentCount: 0,
        secret: "dependency-text-must-not-escape",
      }),
    }),
  });

  assert.equal(report.status, "failed");
  assert.equal(report.failure.code, "LIFECYCLE_PROOF_INVALID");
  assert.equal(check(report, "restart-resume").status, "failed");
  assert.equal(check(report, "interrupt-lifecycle").status, "failed");
  assert.equal(check(report, "bounded-delegation").status, "failed");
  assert.doesNotMatch(JSON.stringify(report), /dependency-text/u);
});

test("two distinct successful fixture MCP calls fail the exactly-once smoke rule", async () => {
  const client = new FakeSmokeClient({ authenticated: true });
  const report = await runAuthenticatedSmoke({
    projectRoot: PROJECT_ROOT,
    sourceEnv: { XDG_RUNTIME_DIR: "/run/user/1000" },
    dependencies: dependencies(client, {
      runTurn: async (options) => {
        emitCompletedFixtureMcp(client, options, "fixture-mcp-one");
        emitCompletedFixtureMcp(client, options, "fixture-mcp-two");
        return successfulTurn(options.threadId);
      },
    }),
  });

  assert.equal(report.status, "failed");
  assert.equal(report.failure.code, "REQUIRED_MCP_CALL_COUNT_INVALID");
  assert.equal(check(report, "required-mcp-structured-turn").status, "failed");
  assert.equal(client.stopCount, 1);
});

test("the materializing fixture turn rejects unrequested delegation", async () => {
  const client = new FakeSmokeClient({ authenticated: true });
  let lifecycleCalled = false;
  const report = await runAuthenticatedSmoke({
    projectRoot: PROJECT_ROOT,
    sourceEnv: { XDG_RUNTIME_DIR: "/run/user/1000" },
    dependencies: dependencies(client, {
      runTurn: async (options) => {
        emitCompletedFixtureMcp(client, options, "fixture-mcp-one");
        client.emit("notification", {
          method: "item/completed",
          params: {
            threadId: options.threadId,
            turnId: "fixture-turn",
            item: {
              id: "fixture-unrequested-delegate",
              type: "subAgentActivity",
              kind: "started",
              agentThreadId: "fixture-child",
              agentPath: "/root/auth_probe",
            },
          },
        });
        return successfulTurn(options.threadId);
      },
      runLifecycle: async () => {
        lifecycleCalled = true;
        return SUCCESSFUL_LIFECYCLE_PROOF;
      },
    }),
  });

  assert.equal(report.status, "failed");
  assert.equal(report.failure.code, "BOOTSTRAP_DELEGATION_FORBIDDEN");
  assert.equal(check(report, "required-mcp-structured-turn").status, "failed");
  assert.equal(lifecycleCalled, false);
});

test("browser login rejects immediately on a transport incident and releases listeners", async () => {
  const client = new FakeSmokeClient({ authenticated: false, loginOutcome: "incident" });
  let browserOpened = false;
  const report = await runAuthenticatedSmoke({
    projectRoot: PROJECT_ROOT,
    login: true,
    loginTimeoutMs: 10_000,
    sourceEnv: { XDG_RUNTIME_DIR: "/run/user/1000" },
    dependencies: dependencies(client, {
      openBrowser: async () => {
        browserOpened = true;
      },
    }),
  });

  assert.equal(browserOpened, false);
  assert.equal(report.status, "failed");
  assert.equal(report.failure.code, "LOGIN_TRANSPORT_FAILURE");
  assert.equal(client.listenerCount("notification"), 0);
  assert.equal(client.listenerCount("incident"), 0);
  assert.equal(client.listenerCount("exit"), 0);
  assert.equal(client.stopCount, 1);
});

test("browser login rejects immediately on process exit and releases listeners", async () => {
  const client = new FakeSmokeClient({ authenticated: false, loginOutcome: "exit" });
  let browserOpened = false;
  const report = await runAuthenticatedSmoke({
    projectRoot: PROJECT_ROOT,
    login: true,
    loginTimeoutMs: 10_000,
    sourceEnv: { XDG_RUNTIME_DIR: "/run/user/1000" },
    dependencies: dependencies(client, {
      openBrowser: async () => {
        browserOpened = true;
      },
    }),
  });

  assert.equal(browserOpened, false);
  assert.equal(report.status, "failed");
  assert.equal(report.failure.code, "LOGIN_PROCESS_EXIT");
  assert.equal(client.listenerCount("notification"), 0);
  assert.equal(client.listenerCount("incident"), 0);
  assert.equal(client.listenerCount("exit"), 0);
  assert.equal(client.stopCount, 1);
});

test("unsafe effective feature config fails before skills, MCP, account, or model access", async () => {
  for (const clientOptions of [
    { authenticated: true, unknownEnabledFeature: true },
    { authenticated: true, requestUserInputEnabled: true },
  ]) {
    const client = new FakeSmokeClient(clientOptions);
    const report = await runAuthenticatedSmoke({
      projectRoot: PROJECT_ROOT,
      sourceEnv: { XDG_RUNTIME_DIR: "/run/user/1000" },
      dependencies: dependencies(client),
    });

    assert.equal(report.status, "failed");
    assert.equal(report.failure.code, "EFFECTIVE_CONFIG_UNSAFE");
    assert.equal(check(report, "exact-runtime-inventory").status, "failed");
    for (const forbiddenMethod of ["skills/list", "mcpServerStatus/list", "account/read", "model/list"]) {
      assert.equal(client.methods.includes(forbiddenMethod), false);
    }
    assert.equal(client.stopCount, 1);
  }
});

test("enabled request-input registration fails before skills, MCP, account, or model access", async () => {
  const client = new FakeSmokeClient({
    authenticated: true,
    requestUserInputRegistrationEnabled: true,
  });
  const report = await runAuthenticatedSmoke({
    projectRoot: PROJECT_ROOT,
    sourceEnv: { XDG_RUNTIME_DIR: "/run/user/1000" },
    dependencies: dependencies(client),
  });

  assert.equal(report.status, "failed");
  assert.equal(report.failure.code, "REQUEST_USER_INPUT_ENABLED");
  assert.equal(check(report, "exact-runtime-inventory").status, "failed");
  for (const forbiddenMethod of ["skills/list", "mcpServerStatus/list", "account/read", "model/list"]) {
    assert.equal(client.methods.includes(forbiddenMethod), false);
  }
  assert.equal(client.stopCount, 1);
});

test("stable authenticated runtime is exclusively leased and releases after every path", async (t) => {
  const sourceEnv = await localSessionBusEnvironment(t);
  const first = await prepareAuthenticatedSmokeRuntime({
    projectRoot: REPOSITORY_ROOT,
    sourceEnv,
  });
  await assert.rejects(
    prepareAuthenticatedSmokeRuntime({ projectRoot: REPOSITORY_ROOT, sourceEnv }),
    (error) => error instanceof AuthenticatedSmokeError && error.code === "RUNTIME_BUSY",
  );
  await first.releaseRuntime();

  await assert.rejects(
    prepareAuthenticatedSmokeRuntime({
      projectRoot: path.join(REPOSITORY_ROOT, "missing-project"),
      sourceEnv,
    }),
  );
  const afterFailure = await prepareAuthenticatedSmokeRuntime({
    projectRoot: REPOSITORY_ROOT,
    sourceEnv,
  });
  await afterFailure.releaseRuntime();
  await afterFailure.releaseRuntime();
});

test("authenticated runtime rejects remote and unknown Secret Service routes", async (t) => {
  const sourceEnv = await localSessionBusEnvironment(t);
  for (const address of [
    "tcp:host=attacker.invalid,port=4444",
    "unix:abstract=/tmp/untrusted-bus",
    `${sourceEnv.DBUS_SESSION_BUS_ADDRESS};tcp:host=attacker.invalid,port=4444`,
  ]) {
    await assert.rejects(
      prepareAuthenticatedSmokeRuntime({
        projectRoot: REPOSITORY_ROOT,
        sourceEnv: { ...sourceEnv, DBUS_SESSION_BUS_ADDRESS: address },
      }),
      (error) =>
        error instanceof AuthenticatedSmokeError && error.code === "UNSAFE_SECRET_SERVICE_ROUTE",
    );
  }
});

test("authenticated runtime rejects broad or symlinked XDG and bus boundaries", async (t) => {
  const sourceEnv = await localSessionBusEnvironment(t);
  await chmod(sourceEnv.XDG_RUNTIME_DIR, 0o755);
  await assert.rejects(
    prepareAuthenticatedSmokeRuntime({ projectRoot: REPOSITORY_ROOT, sourceEnv }),
    (error) =>
      error instanceof AuthenticatedSmokeError && error.code === "UNSAFE_SECRET_SERVICE_ROUTE",
  );
  await chmod(sourceEnv.XDG_RUNTIME_DIR, 0o700);

  const aliasParent = await mkdtemp(path.join(tmpdir(), "marketpilot-auth-alias-"));
  await chmod(aliasParent, 0o700);
  const runtimeAlias = path.join(aliasParent, "runtime-link");
  await symlink(sourceEnv.XDG_RUNTIME_DIR, runtimeAlias);
  t.after(async () => rm(aliasParent, { recursive: true, force: true }));
  await assert.rejects(
    prepareAuthenticatedSmokeRuntime({
      projectRoot: REPOSITORY_ROOT,
      sourceEnv: {
        XDG_RUNTIME_DIR: runtimeAlias,
        DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(runtimeAlias, "bus")}`,
      },
    }),
    (error) =>
      error instanceof AuthenticatedSmokeError && error.code === "UNSAFE_SECRET_SERVICE_ROUTE",
  );

  const linkedBusRuntime = await mkdtemp(path.join(tmpdir(), "marketpilot-auth-bus-link-"));
  await chmod(linkedBusRuntime, 0o700);
  await symlink(
    path.join(sourceEnv.XDG_RUNTIME_DIR, "bus"),
    path.join(linkedBusRuntime, "bus"),
  );
  t.after(async () => rm(linkedBusRuntime, { recursive: true, force: true }));
  await assert.rejects(
    prepareAuthenticatedSmokeRuntime({
      projectRoot: REPOSITORY_ROOT,
      sourceEnv: {
        XDG_RUNTIME_DIR: linkedBusRuntime,
        DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(linkedBusRuntime, "bus")}`,
      },
    }),
    (error) =>
      error instanceof AuthenticatedSmokeError && error.code === "UNSAFE_SECRET_SERVICE_ROUTE",
  );
});

test("unexpected enabled skills are disabled before any account or model access", async () => {
  const futureSkillPath =
    "/run/user/1000/marketpilot-wi001-auth-smoke/codex-home/skills/.system/future/SKILL.md";
  const bootstrapClient = new FakeSmokeClient({
    authenticated: true,
    extraSkillPath: futureSkillPath,
  });
  const finalClient = new FakeSmokeClient({ authenticated: true });
  const clients = [bootstrapClient, finalClient];
  /** @type {readonly string[] | undefined} */
  let disabledPaths;
  const report = await runAuthenticatedSmoke({
    projectRoot: PROJECT_ROOT,
    sourceEnv: { XDG_RUNTIME_DIR: "/run/user/1000" },
    dependencies: {
      prepareRuntime: async () => ({
        ...RUNTIME,
        reconfigure: async (paths) => {
          disabledPaths = [...paths];
        },
      }),
      qualifyRuntime: async () => QUALIFICATION,
      createClient: () => {
        const next = clients.shift();
        assert(next);
        return next;
      },
      authJsonExists: async () => false,
      openBrowser: async () => {
        throw new Error("authenticated fixture must not open browser");
      },
      runTurn: async (options) => {
        emitCompletedFixtureMcp(finalClient, options, "fixture-mcp-item");
        return successfulTurn(options.threadId);
      },
      runLifecycle: async () => SUCCESSFUL_LIFECYCLE_PROOF,
      nowIso: () => "2026-07-27T00:00:00.000Z",
    },
  });

  assert.deepEqual(disabledPaths, [futureSkillPath]);
  assert.equal(bootstrapClient.stopCount, 1);
  assert.equal(finalClient.stopCount, 1);
  assert.equal(bootstrapClient.methods.includes("account/read"), false);
  assert.equal(bootstrapClient.methods.includes("model/list"), false);
  assert.equal(bootstrapClient.methods.includes("thread/start"), false);
  assert.equal(check(report, "exact-runtime-inventory").status, "passed");
  assert.equal(report.automatedCorePassed, true);
});

test("CLI emits one checklist and maps incomplete status to exit code 2", async () => {
  let output = "";
  let receivedOptions;
  const exitCode = await runAuthenticatedSmokeCli({
    argv: ["--timeout-ms", "2000", "--turn-timeout-ms", "240000"],
    stdout: { write: (value) => { output += value; return true; } },
    projectRoot: PROJECT_ROOT,
    sourceEnv: {},
    runSmoke: async (options) => {
      receivedOptions = options;
      return {
        schemaVersion: 1,
        mode: "authenticated-manual",
        status: "incomplete",
        automatedCorePassed: true,
        completedAt: "2026-07-27T00:00:00.000Z",
        checks: [{ id: "restart-resume", status: "incomplete", detail: "Manual check required." }],
      };
    },
  });

  assert.equal(exitCode, 2);
  assert.equal(receivedOptions?.requestTimeoutMs, 2_000);
  assert.equal(receivedOptions?.turnTimeoutMs, 240_000);
  assert.equal(JSON.parse(output).status, "incomplete");
});

class FakeSmokeClient extends EventEmitter {
  /** @param {{authenticated: boolean, accountType?: string, loginOutcome?: "success" | "incident" | "exit", extraSkillPath?: string, unknownEnabledFeature?: boolean, requestUserInputEnabled?: boolean, requestUserInputRegistrationEnabled?: boolean, emitThreadStarted?: boolean}} options */
  constructor({
    authenticated,
    accountType = "chatgpt",
    loginOutcome = "success",
    extraSkillPath,
    unknownEnabledFeature = false,
    requestUserInputEnabled = false,
    requestUserInputRegistrationEnabled = false,
    emitThreadStarted = false,
  }) {
    super();
    this.state = "idle";
    this.serverRequestsForbidden = true;
    this.authenticated = authenticated;
    this.accountType = accountType;
    this.loginOutcome = loginOutcome;
    this.extraSkillPath = extraSkillPath;
    this.unknownEnabledFeature = unknownEnabledFeature;
    this.requestUserInputEnabled = requestUserInputEnabled;
    this.requestUserInputRegistrationEnabled = requestUserInputRegistrationEnabled;
    this.emitThreadStarted = emitThreadStarted;
    this.stopCount = 0;
    /** @type {string[]} */
    this.methods = [];
    /** @type {{method: string, params: any, timeoutMs: number | undefined}[]} */
    this.requestCalls = [];
  }

  async start() {
    this.state = "running";
  }

  async stop() {
    this.stopCount += 1;
    this.state = "stopped";
  }

  async notify(method) {
    this.methods.push(method);
  }

  async request(method, params, options = {}) {
    this.methods.push(method);
    this.requestCalls.push({ method, params, timeoutMs: options.timeoutMs });
    switch (method) {
      case "initialize":
        return { userAgent: "fixture" };
      case "account/read":
        return {
          account: this.authenticated
            ? { type: this.accountType, email: "private@example.invalid", planType: "plus" }
            : null,
          requiresOpenaiAuth: true,
        };
      case "config/read":
        return {
          config: {
            ...effectiveConfig(),
            features: {
              ...effectiveConfig().features,
              ...(this.unknownEnabledFeature ? { future_network_tool: true } : {}),
              ...(this.requestUserInputEnabled
                ? { default_mode_request_user_input: true }
                : {}),
            },
          },
          layers: [{
            name: {
              type: "user",
              file: path.join(RUNTIME.runtime.codexHome, "config.toml"),
              profile: null,
            },
            version: "fixture",
            config: {
              tools: {
                experimental_request_user_input: {
                  enabled: this.requestUserInputRegistrationEnabled,
                },
              },
            },
          }],
        };
      case "skills/list":
        return {
          data: [{
            cwd: RUNTIME.runtime.workDir,
            errors: [],
            skills: [
              {
                name: "marketpilot-compatibility",
                enabled: true,
                path: RUNTIME.enabledSkillPath,
              },
              ...(this.extraSkillPath === undefined
                ? []
                : [{ name: "future-system-skill", enabled: true, path: this.extraSkillPath }]),
            ],
          }],
        };
      case "account/login/start":
        assert.deepEqual(params, { type: "chatgpt" });
        (this.loginOutcome === "success" ? setImmediate : queueMicrotask)(() => {
          if (this.loginOutcome === "incident") {
            this.emit("incident", new Error("fixture transport incident"));
          } else if (this.loginOutcome === "exit") {
            this.state = "failed";
            this.emit("exit", { expected: false, error: new Error("fixture exit") });
          } else {
            this.authenticated = true;
            this.emit("notification", {
              method: "account/login/completed",
              params: { loginId: "fixture-login", success: true, error: null },
            });
          }
        });
        return {
          type: "chatgpt",
          loginId: "fixture-login",
          authUrl: "https://auth.openai.com/oauth/authorize?fixture=1",
        };
      case "model/list":
        return {
          data: [{
            id: "gpt-5.6-sol",
            supportedReasoningEfforts: [{ reasoningEffort: "ultra" }],
          }],
        };
      case "mcpServerStatus/list":
        return {
          data: [{
            name: FIXTURE_MCP_NAME,
            authStatus: "unsupported",
            resourceTemplates: [],
            resources: [],
            tools: {
              [FIXTURE_MCP_READ_TOOL]: {
                name: FIXTURE_MCP_READ_TOOL,
                annotations: {
                  readOnlyHint: true,
                  destructiveHint: false,
                  idempotentHint: true,
                  openWorldHint: false,
                },
                inputSchema: {
                  type: "object",
                  properties: {
                    fixtureId: { type: "string", const: PUBLIC_FIXTURE_ID },
                  },
                  required: ["fixtureId"],
                  additionalProperties: false,
                },
              },
            },
          }],
          nextCursor: null,
        };
      case "thread/start": {
        const response = {
          thread: {
            id: "fixture-thread",
            ephemeral: false,
            cwd: RUNTIME.runtime.workDir,
            modelProvider: "openai",
            path: path.join(
              RUNTIME.runtime.codexHome,
              "sessions",
              "fixture-thread.jsonl",
            ),
          },
          model: "gpt-5.6-sol",
          modelProvider: "openai",
          reasoningEffort: "ultra",
          approvalPolicy: "never",
          cwd: RUNTIME.runtime.workDir,
          sandbox: { type: "readOnly", networkAccess: false },
        };
        if (this.emitThreadStarted) {
          this.emit("notification", {
            method: "thread/started",
            params: { thread: response.thread },
          });
        }
        return response;
      }
      case "account/login/cancel":
        return {};
      default:
        throw new Error(`unexpected fake method ${method}`);
    }
  }
}

/**
 * @param {FakeSmokeClient} client
 * @param {Partial<Record<string, Function>>} [overrides]
 */
function dependencies(client, overrides = {}) {
  let authCheckCount = 0;
  return {
    prepareRuntime: async () => RUNTIME,
    qualifyRuntime: async () => QUALIFICATION,
    createClient: () => client,
    authJsonExists: async () => {
      authCheckCount += 1;
      return false;
    },
    openBrowser: async () => {},
    runTurn: async () => {
      throw new Error("runTurn override required for authenticated test");
    },
    runLifecycle: async () => SUCCESSFUL_LIFECYCLE_PROOF,
    nowIso: () => "2026-07-27T00:00:00.000Z",
    ...overrides,
  };
}

function effectiveConfig() {
  const disabledFeatures = [
    "apps",
    "auth_elicitation",
    "browser_use",
    "browser_use_external",
    "browser_use_full_cdp_access",
    "code_mode_host",
    "computer_use",
    "default_mode_request_user_input",
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
    features: Object.fromEntries([
      ...disabledFeatures.map((name) => [name, false]),
      ["mentions_v2", true],
      ["multi_agent", true],
      ["remote_control", false],
    ]),
    shell_environment_policy: {
      inherit: "none",
      ignore_default_excludes: false,
      exclude: ["*"],
      include_only: [],
      set: {},
      experimental_use_profile: false,
    },
    mcp_servers: {
      [FIXTURE_MCP_NAME]: {
        enabled: true,
        required: true,
        command: process.execPath,
        args: [RUNTIME.fixtureMcpPath],
        cwd: RUNTIME.runtime.workDir,
        env: {},
        environment_id: "local",
        startup_timeout_sec: 5,
        tool_timeout_sec: 5,
        default_tools_approval_mode: "approve",
        enabled_tools: [FIXTURE_MCP_READ_TOOL],
        disabled_tools: [],
      },
    },
  };
}

/** @param {FakeSmokeClient} client @param {any} options @param {string} itemId */
function emitCompletedFixtureMcp(client, options, itemId) {
  const item = {
    id: itemId,
    type: "mcpToolCall",
    server: FIXTURE_MCP_NAME,
    tool: FIXTURE_MCP_READ_TOOL,
    arguments: { fixtureId: PUBLIC_FIXTURE_ID },
    status: "completed",
    result: {
      content: [{ type: "text", text: JSON.stringify(PUBLIC_FIXTURE) }],
      structuredContent: PUBLIC_FIXTURE,
    },
  };
  client.emit("notification", {
    method: "item/completed",
    params: {
      threadId: options.threadId,
      turnId: "fixture-turn",
      item,
    },
  });
  return item;
}

/** @param {string} threadId */
function successfulTurn(threadId) {
  return {
    threadId,
    turnId: "fixture-turn",
    status: "completed",
    finalMessageId: "fixture-message",
    artifact: {
      status: "ok",
      summary: "Fixture qualification succeeded.",
      checks: [{ name: "fixture", passed: true, detail: "Public fixture read completed." }],
    },
  };
}

/** @param {any} report @param {string} id */
function check(report, id) {
  const entry = report.checks.find((candidate) => candidate.id === id);
  assert(entry, `missing check ${id}`);
  return entry;
}

/** @param {import("node:test").TestContext} t */
async function localSessionBusEnvironment(t) {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "marketpilot-auth-smoke-"));
  await chmod(runtimeDir, 0o700);
  const busPath = path.join(runtimeDir, "bus");
  const server = createServer();
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(busPath, () => {
      server.off("error", onError);
      resolve(undefined);
    });
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
    await rm(runtimeDir, { recursive: true, force: true });
  });
  return {
    XDG_RUNTIME_DIR: runtimeDir,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${busPath}`,
  };
}
