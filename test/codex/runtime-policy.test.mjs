// @ts-check

import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  APP_SERVER_ARGS,
  BUNDLED_SYSTEM_SKILL_NAMES,
  FIXTURE_MCP_NAME,
  FIXTURE_MCP_READ_TOOL,
  INHERITED_ENV_ALLOWLIST,
  PINNED_CODEX_VERSION,
  REQUIRED_CODEX_MODEL,
  REQUIRED_REASONING_EFFORT,
  assertSecureRuntimeDirectory,
  buildMinimalEnvironment,
  bundledSystemSkillPaths,
  prepareIsolatedRuntimeDirectories,
  renderHardenedConfig,
  resolvePackagedCodexBinary,
  resolvePackagedCodexInstallation,
  sha256,
  sha256File,
} from "../../src/codex/runtime-policy.mjs";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..", "..");

test("resolves the exact packaged native Codex binary without PATH", () => {
  const installation = resolvePackagedCodexInstallation({ projectRoot: PROJECT_ROOT });

  assert.equal(installation.packageVersion, PINNED_CODEX_VERSION);
  assert.equal(installation.platformPackageVersion, `${PINNED_CODEX_VERSION}-linux-x64`);
  assert.equal(installation.targetTriple, "x86_64-unknown-linux-musl");
  assert.equal(installation.binaryPath, resolvePackagedCodexBinary({ projectRoot: PROJECT_ROOT }));
  assert.ok(path.isAbsolute(installation.binaryPath));
  assert.match(
    installation.binaryPath,
    /node_modules\/@openai\/codex-linux-x64\/vendor\/x86_64-unknown-linux-musl\/bin\/codex$/u,
  );
  assert.deepEqual(APP_SERVER_ARGS, [
    "app-server",
    "--strict-config",
    "--listen",
    "stdio://",
  ]);
});

test("rejects an unsupported packaged Codex target", () => {
  assert.throws(
    () =>
      resolvePackagedCodexInstallation({
        projectRoot: PROJECT_ROOT,
        platform: "aix",
        arch: "ppc64",
      }),
    /Unsupported packaged Codex target/u,
  );
});

test("creates private non-symlink CODEX_HOME and work directories", async (t) => {
  const baseDir = await privateTemporaryDirectory(t);
  const originalUmask = process.umask();
  const runtime = prepareIsolatedRuntimeDirectories({ baseDir });

  assert.equal(process.umask(), originalUmask);
  assert.equal(runtime.codexHome, path.join(baseDir, "codex-home"));
  assert.equal(runtime.workDir, path.join(baseDir, "work"));
  assert.equal(assertSecureRuntimeDirectory(runtime.codexHome, { baseDir }), runtime.codexHome);
  assert.equal(assertSecureRuntimeDirectory(runtime.workDir, { baseDir }), runtime.workDir);

  const { mode: homeMode } = await lstat(runtime.codexHome);
  const { mode: workMode } = await lstat(runtime.workDir);
  assert.equal(homeMode & 0o7777, 0o700);
  assert.equal(workMode & 0o7777, 0o700);

  assert.deepEqual(prepareIsolatedRuntimeDirectories({ baseDir }), runtime);
});

test("rejects broad permissions, symlinks, traversal, and a shared directory name", async (t) => {
  const insecureBase = await privateTemporaryDirectory(t);
  await chmod(insecureBase, 0o755);
  assert.throws(
    () => prepareIsolatedRuntimeDirectories({ baseDir: insecureBase }),
    /runtime base must have mode 0700/u,
  );

  const baseDir = await privateTemporaryDirectory(t);
  const outside = await privateTemporaryDirectory(t);
  await symlink(outside, path.join(baseDir, "codex-home"));
  assert.throws(
    () => prepareIsolatedRuntimeDirectories({ baseDir }),
    /non-symlink directory/u,
  );
  assert.throws(
    () => prepareIsolatedRuntimeDirectories({ baseDir: outside, codexHomeName: "../escape" }),
    /one direct child name/u,
  );
  assert.throws(
    () => prepareIsolatedRuntimeDirectories({ baseDir: outside, workDirName: "codex-home", codexHomeName: "codex-home" }),
    /must be distinct/u,
  );
});

test("renders an exact hardened Sol Ultra config with one read-only MCP", async (t) => {
  const baseDir = await privateTemporaryDirectory(t);
  const { codexHome, workDir } = prepareIsolatedRuntimeDirectories({ baseDir });
  const fixtureScript = path.join(workDir, "fixture server.mjs");
  const appSkill = path.join(workDir, "marketpilot-fixture", "SKILL.md");
  const extraSkill = path.join(workDir, "retired-skill", "SKILL.md");
  const config = renderHardenedConfig({
    codexHome,
    enabledSkillPath: appSkill,
    fixtureMcpCommand: process.execPath,
    fixtureMcpArgs: [fixtureScript, "quoted\"argument"],
    fixtureMcpCwd: workDir,
    additionalDisabledSkillPaths: [extraSkill],
  });

  assert.match(config, new RegExp(`model = "${escapeRegExp(REQUIRED_CODEX_MODEL)}"`, "u"));
  assert.match(
    config,
    new RegExp(`model_reasoning_effort = "${REQUIRED_REASONING_EFFORT}"`, "u"),
  );
  assert.match(config, /approval_policy = "never"/u);
  assert.match(config, /sandbox_mode = "read-only"/u);
  assert.match(config, /forced_login_method = "chatgpt"/u);
  assert.match(config, /cli_auth_credentials_store = "keyring"/u);
  assert.match(config, /web_search = "disabled"/u);
  assert.match(config, /\[history\]\npersistence = "none"/u);
  assert.match(config, /inherit = "none"/u);
  assert.match(config, /max_concurrent_threads_per_session = 2/u);
  assert.match(config, /shell_tool = false/u);
  assert.match(config, /browser_use = false/u);
  assert.match(config, /hooks = false/u);
  assert.match(config, /goals = false/u);
  assert.match(config, /memories = false/u);
  assert.match(config, /remote_plugin = false/u);
  assert.match(config, /multi_agent = true/u);

  assert.equal(count(config, `\n[mcp_servers.${FIXTURE_MCP_NAME}]\n`), 1);
  assert.match(config, /required = true/u);
  assert.ok(config.includes(`enabled_tools = ["${FIXTURE_MCP_READ_TOOL}"]`));
  assert.match(config, /disabled_tools = \[\]/u);
  assert.match(config, new RegExp(`command = ${escapeRegExp(JSON.stringify(process.execPath))}`, "u"));
  assert.match(config, /quoted\\"argument/u);
  assert.doesNotMatch(config, /experimentalApi|API_KEY|TOKEN|SECRET|bearer_token/u);

  const expectedSystemPaths = bundledSystemSkillPaths(codexHome);
  assert.deepEqual(BUNDLED_SYSTEM_SKILL_NAMES, [
    "imagegen",
    "openai-docs",
    "plugin-creator",
    "review-agent",
    "skill-creator",
    "skill-installer",
  ]);
  assert.equal(expectedSystemPaths.length, BUNDLED_SYSTEM_SKILL_NAMES.length);
  for (const skillPath of [...expectedSystemPaths, extraSkill]) {
    assert.ok(
      config.includes(`[[skills.config]]\npath = ${JSON.stringify(skillPath)}\nenabled = false`),
    );
  }
  assert.ok(
    config.includes(`[[skills.config]]\npath = ${JSON.stringify(appSkill)}\nenabled = true`),
  );
  assert.equal(count(config, "enabled = true"), 3);
  assert.equal(count(config, "[[skills.config]]"), BUNDLED_SYSTEM_SKILL_NAMES.length + 2);
});

test("rejects relative executable and skill paths in hardened config", async (t) => {
  const baseDir = await privateTemporaryDirectory(t);
  const { codexHome } = prepareIsolatedRuntimeDirectories({ baseDir });

  assert.throws(
    () =>
      renderHardenedConfig({
        codexHome,
        enabledSkillPath: path.join(baseDir, "skill", "SKILL.md"),
        fixtureMcpCommand: "node",
      }),
    /fixture MCP command must be an absolute path/u,
  );
  assert.throws(
    () =>
      renderHardenedConfig({
        codexHome,
        enabledSkillPath: path.join(baseDir, "skill", "SKILL.md"),
        fixtureMcpCommand: process.execPath,
        additionalDisabledSkillPaths: ["relative/SKILL.md"],
      }),
    /additional disabled skill path 0 must be an absolute path/u,
  );
  const appSkillPath = path.join(baseDir, "skill", "SKILL.md");
  assert.throws(
    () =>
      renderHardenedConfig({
        codexHome,
        enabledSkillPath: appSkillPath,
        fixtureMcpCommand: process.execPath,
        additionalDisabledSkillPaths: [appSkillPath],
      }),
    /must not also be disabled/u,
  );
});

test("builds a secret-free environment from an explicit allowlist", async (t) => {
  const baseDir = await privateTemporaryDirectory(t);
  const { codexHome, workDir } = prepareIsolatedRuntimeDirectories({ baseDir });
  const sourceEnv = {
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    XDG_RUNTIME_DIR: "/run/user/1000",
    LANG: "en_CA.UTF-8",
    TZ: "America/Toronto",
    PATH: "/malicious/bin",
    NODE_PATH: "/malicious/modules",
    OPENAI_API_KEY: "must-not-leak",
    HTTPS_PROXY: "https://name:password@example.invalid",
    CODEX_HOME: "/user/home/.codex",
    HOME: "/user/home",
  };
  const environment = buildMinimalEnvironment({ codexHome, workDir, sourceEnv });

  assert.deepEqual(environment, {
    CODEX_HOME: codexHome,
    HOME: codexHome,
    PWD: workDir,
    NO_COLOR: "1",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    XDG_RUNTIME_DIR: "/run/user/1000",
    LANG: "en_CA.UTF-8",
    TZ: "America/Toronto",
  });
  assert.deepEqual(INHERITED_ENV_ALLOWLIST, [
    "DBUS_SESSION_BUS_ADDRESS",
    "XDG_RUNTIME_DIR",
    "LANG",
    "LC_ALL",
    "TZ",
  ]);
  assert.equal(environment.PATH, undefined);
  assert.equal(environment.OPENAI_API_KEY, undefined);
  assert.equal(environment.HTTPS_PROXY, undefined);

  assert.deepEqual(buildMinimalEnvironment({ codexHome, workDir, sourceEnv: {} }), {
    CODEX_HOME: codexHome,
    HOME: codexHome,
    PWD: workDir,
    NO_COLOR: "1",
    LANG: "C.UTF-8",
  });
});

test("rejects unsafe allowed environment values", async (t) => {
  const baseDir = await privateTemporaryDirectory(t);
  const { codexHome, workDir } = prepareIsolatedRuntimeDirectories({ baseDir });

  assert.throws(
    () =>
      buildMinimalEnvironment({
        codexHome,
        workDir,
        sourceEnv: { DBUS_SESSION_BUS_ADDRESS: "safe\nINJECTED=value" },
      }),
    /Unsafe inherited environment value/u,
  );
  assert.throws(
    () =>
      buildMinimalEnvironment({
        codexHome,
        workDir,
        sourceEnv: { XDG_RUNTIME_DIR: "relative/runtime" },
      }),
    /XDG_RUNTIME_DIR must be absolute/u,
  );
});

test("computes reproducible SHA-256 digests and rejects symlink inputs", async (t) => {
  const baseDir = await privateTemporaryDirectory(t);
  const fixture = path.join(baseDir, "fixture.txt");
  const link = path.join(baseDir, "fixture-link.txt");
  await writeFile(fixture, "MarketPilot\n", { mode: 0o600 });
  await symlink(fixture, link);

  const expected = "3b51125d1547a88f337957ed7a8ceca9d162b0ecf0a326f3bda8e0ab071a0f17";
  assert.equal(sha256("MarketPilot\n"), expected);
  assert.equal(sha256(Buffer.from("MarketPilot\n")), expected);
  assert.equal(await sha256File(fixture), expected);
  await assert.rejects(sha256File(link), /not a regular non-symlink file/u);
});

/** @param {import("node:test").TestContext} t */
async function privateTemporaryDirectory(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "marketpilot-runtime-policy-"));
  await chmod(directory, 0o700);
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

/** @param {string} value @param {string} fragment */
function count(value, fragment) {
  return value.split(fragment).length - 1;
}

/** @param {string} value */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
