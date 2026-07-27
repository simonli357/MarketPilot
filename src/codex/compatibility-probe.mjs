// @ts-check

import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AppServerClient,
  AppServerError,
  createExactServerRequestHandler,
} from "./app-server-client.mjs";
import { classifyNotification } from "./protocol-policy.mjs";
import {
  APP_SERVER_ARGS,
  FIXTURE_MCP_NAME,
  FIXTURE_MCP_READ_TOOL,
  INHERITED_ENV_ALLOWLIST,
  PUBLIC_FIXTURE_ID,
  REQUIRED_CODEX_MODEL,
  REQUIRED_REASONING_EFFORT,
  buildMinimalEnvironment,
  prepareIsolatedRuntimeDirectories,
  renderHardenedConfig,
  sha256,
  sha256File,
} from "./runtime-policy.mjs";
import {
  QUALIFIED_LINUX_X64_BASELINE,
  assertQualifiedCodexExecutable,
  qualifyPackagedCodexRuntime,
} from "./runtime-qualification.mjs";

export { QUALIFIED_LINUX_X64_BASELINE, sha256DirectoryManifest } from "./runtime-qualification.mjs";
const CLIENT_INFO = Object.freeze({
  name: "marketpilot_compatibility_probe",
  title: "MarketPilot Compatibility Probe",
  version: "0.1.0",
});
/** @typedef {{id: string, passed: boolean, detail: string}} ProbeCheck */

export class CompatibilityProbeError extends Error {
  /** @param {string} code @param {string} message @param {unknown} [cause] */
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CompatibilityProbeError";
    this.code = code;
  }
}

/**
 * Run the credential-free part of WI-001 against the exact packaged app-server.
 * The caller owns and may delete baseDir after consuming the redacted report.
 *
 * @param {{projectRoot: string, baseDir: string, requestTimeoutMs?: number}} options
 */
export async function runAutomatedCompatibilityProbe({
  projectRoot,
  baseDir,
  requestTimeoutMs = 15_000,
}) {
  const startedAt = new Date().toISOString();
  /** @type {ProbeCheck[]} */
  const checks = [];
  const root = path.resolve(projectRoot);
  const runtime = prepareIsolatedRuntimeDirectories({ baseDir });
  const environment = buildMinimalEnvironment({
    codexHome: runtime.codexHome,
    workDir: runtime.workDir,
  });
  const qualification = await qualifyPackagedCodexRuntime({
    projectRoot: root,
    schemaDir: path.join(runtime.baseDir, "stable-schema"),
    cwd: runtime.workDir,
    env: environment,
    timeoutMs: requestTimeoutMs,
  });
  const { installation, host } = qualification;
  const fixtureMcpPath = path.join(root, "test", "fixtures", "fixture-mcp-server.mjs");
  const sourceSkillPath = path.join(
    root,
    "runtime",
    "codex",
    "skills",
    "marketpilot-compatibility",
    "SKILL.md",
  );
  await requireRegularFile(fixtureMcpPath, "fixture MCP server");
  await requireRegularFile(sourceSkillPath, "compatibility skill");
  const effectiveConfigExpectation = Object.freeze({
    fixtureMcpCommand: process.execPath,
    fixtureMcpArgs: Object.freeze([fixtureMcpPath]),
    fixtureMcpCwd: runtime.workDir,
  });
  const enabledSkillPath = await stageCompatibilitySkill({
    sourceSkillPath,
    codexHome: runtime.codexHome,
  });

  const redactor = createDiagnosticRedactor({ runtimeRoot: runtime.baseDir, projectRoot: root });

  checks.push(
    check(
      "qualified-host",
      true,
      `${host.distributionId} ${host.distributionVersion}, ${host.platform}/${host.arch}, Node ${host.nodeVersion}`,
    ),
  );
  checks.push(
    check(
      "minimal-environment",
      validateMinimalEnvironment(environment, runtime),
      "The process environment contains only app paths, locale/session routing, and NO_COLOR.",
    ),
  );

  checks.push(check("pinned-version", true, qualification.codexVersion));
  const binarySha256 = qualification.binarySha256;
  checks.push(
    check(
      "packaged-binary",
      process.platform === "linux" &&
        process.arch === "x64" &&
        binarySha256 === QUALIFIED_LINUX_X64_BASELINE.binarySha256,
      "The packaged Linux x64 executable matches the committed 0.145.0 digest.",
    ),
  );

  const schemaSha256 = qualification.stableSchemaSha256;
  const schemaManifestSha256 = qualification.stableSchemaManifestSha256;
  checks.push(
    check(
      "stable-schema",
      true,
      "The default v2 schema and complete schema manifest match committed canonical digests.",
    ),
  );

  let disabledSkillPaths = [];
  await writeRuntimeConfig({
    runtime,
    enabledSkillPath,
    fixtureMcpPath,
    disabledSkillPaths,
  });
  const bootstrap = await inspectAppServer({
    installation,
    qualification,
    runtime,
    environment,
    requestTimeoutMs,
    redactor,
    effectiveConfigExpectation,
  });
  disabledSkillPaths = bootstrap.skills
    .filter((skill) => skill.enabled === true && skill.name !== "marketpilot-compatibility")
    .map((skill) => skill.path)
    .filter((skillPath) => typeof skillPath === "string" && path.isAbsolute(skillPath));

  if (disabledSkillPaths.length > 0) {
    await writeRuntimeConfig({
      runtime,
      enabledSkillPath,
      fixtureMcpPath,
      disabledSkillPaths,
    });
  }

  let inspection = bootstrap;
  if (disabledSkillPaths.length > 0) {
    const finalInspection = await inspectAppServer({
      installation,
      qualification,
      runtime,
      environment,
      requestTimeoutMs,
      redactor,
      effectiveConfigExpectation,
    });
    inspection = {
      ...finalInspection,
      notifications: [...bootstrap.notifications, ...finalInspection.notifications],
      incidents: [...bootstrap.incidents, ...finalInspection.incidents],
    };
  }

  const model = findModel(inspection.models, REQUIRED_CODEX_MODEL);
  const efforts = Array.isArray(model?.supportedReasoningEfforts)
    ? model.supportedReasoningEfforts.map((entry) => entry?.reasoningEffort)
    : [];
  checks.push(
    check(
      "sol-ultra-catalog",
      model !== undefined && efforts.includes(REQUIRED_REASONING_EFFORT),
      "The runtime catalog advertises gpt-5.6-sol with ultra; authenticated entitlement is manual evidence.",
    ),
  );

  checks.push(
    check(
      "effective-config",
      validateEffectiveConfig(inspection.config, effectiveConfigExpectation),
      "Effective config is Sol Ultra, never-approval, read-only, non-persistent, keyring/ChatGPT, and capability-disabled.",
    ),
  );

  const enabledSkills = inspection.skills.filter((skill) => skill.enabled === true);
  checks.push(
    check(
      "exact-skill-inventory",
      inspection.skillErrors.length === 0 &&
        enabledSkills.length === 1 &&
        enabledSkills[0]?.name === "marketpilot-compatibility" &&
        enabledSkills[0]?.path === enabledSkillPath,
      inspection.skillErrors.length > 0
        ? `${inspection.skillErrors.length} skill inventory error(s) occurred.`
        : enabledSkills.length === 1
          ? enabledSkills[0]?.name === "marketpilot-compatibility"
            ? "Only the expected compatibility skill is enabled."
            : "One unexpected skill remains enabled."
          : `${enabledSkills.length} skills remain enabled.`,
    ),
  );

  checks.push(
    check(
      "exact-mcp-inventory",
      validateMcpInventory(inspection.mcpServers, inspection.mcpNextCursor),
      `Only ${FIXTURE_MCP_NAME}.${FIXTURE_MCP_READ_TOOL} is exposed.`,
    ),
  );

  checks.push(
    check(
      "effective-thread-policy",
      validateThreadPolicy(inspection.thread, runtime.workDir),
      "An ephemeral thread resolves to Sol Ultra, never approvals, and read-only/no-network sandboxing.",
    ),
  );

  const forbiddenNotifications = inspection.notifications.filter((method) => {
    try {
      return classifyNotification(method) === "fail-closed";
    } catch {
      return true;
    }
  });
  checks.push(
    check(
      "notification-allowlist",
      forbiddenNotifications.length === 0,
      forbiddenNotifications.length === 0
        ? "All observed notifications are explicitly allowed and non-rerouted."
        : `${forbiddenNotifications.length} forbidden notification(s) occurred; identifiers were withheld.`,
    ),
  );

  checks.push(
    check(
      "server-request-denial",
      inspection.incidents.length === 0,
      inspection.incidents.length === 0
        ? "No server-initiated request or transport incident occurred."
        : `${inspection.incidents.length} fail-closed incident(s) occurred.`,
    ),
  );

  const storage = await inventoryCodexState(runtime.codexHome);
  checks.push(
    check(
      "no-plaintext-auth-file",
      !storage.some((entry) => entry.relativePath === "auth.json"),
      "No auth.json exists in the dedicated home; authenticated keyring proof remains manual.",
    ),
  );
  checks.push(
    check(
      "codex-storage-inventoried",
      storage.some((entry) => entry.classification === "sqlite"),
      "Codex-owned state is inventoried by path class only; its content is never included in evidence.",
    ),
  );

  const passed = checks.every((entry) => entry.passed);
  const persistedStateClasses = new Set(["credential", "sqlite", "transcript", "log"]);
  return Object.freeze({
    schemaVersion: 1,
    mode: "automated-metadata",
    passed,
    startedAt,
    completedAt: new Date().toISOString(),
    host,
    runtime: {
      codexVersion: installation.packageVersion,
      platformPackage: installation.platformPackage,
      platformPackageVersion: installation.platformPackageVersion,
      targetTriple: installation.targetTriple,
      binarySha256,
      stableSchemaSha256: schemaSha256,
      stableSchemaManifestSha256: schemaManifestSha256,
    },
    authentication: {
      state: summarizeAccountState(inspection.account),
      entitlementProven: false,
      requiredManualAction: "Dedicated keyring login and authenticated structured-turn smoke",
    },
    storageSummary: summarizeStorage(storage),
    storage: storage
      .filter(({ classification }) => persistedStateClasses.has(classification))
      .map(({ relativePath, classification, mode, size }) => ({
        pathSha256: sha256(relativePath),
        classification,
        mode,
        size,
      })),
    observedNotifications: summarizeObservedNotifications(inspection.notifications),
    checks,
  });
}

/**
 * @param {{runtime: {codexHome: string, workDir: string}, enabledSkillPath: string, fixtureMcpPath: string, disabledSkillPaths: string[]}} options
 */
async function writeRuntimeConfig({
  runtime,
  enabledSkillPath,
  fixtureMcpPath,
  disabledSkillPaths,
}) {
  const config = renderHardenedConfig({
    codexHome: runtime.codexHome,
    enabledSkillPath,
    fixtureMcpCommand: process.execPath,
    fixtureMcpArgs: [fixtureMcpPath],
    fixtureMcpCwd: runtime.workDir,
    additionalDisabledSkillPaths: disabledSkillPaths,
  });
  const configPath = path.join(runtime.codexHome, "config.toml");
  await writeFile(configPath, config, { mode: 0o600 });
  const metadata = await lstat(configPath);
  if (metadata.isSymbolicLink() || !metadata.isFile() || (metadata.mode & 0o7777) !== 0o600) {
    throw new CompatibilityProbeError("UNSAFE_CONFIG", "config.toml is not a mode-0600 regular file");
  }
}

/**
 * Codex discovers user skills below CODEX_HOME/skills. A skills.config entry
 * controls an already-discovered skill; it does not add an arbitrary external
 * path to the inventory. Stage the immutable fixture into the private home so
 * the real inventory can prove the exact enabled skill.
 *
 * @param {{sourceSkillPath: string, codexHome: string}} options
 */
async function stageCompatibilitySkill({ sourceSkillPath, codexHome }) {
  const skillDirectory = path.join(codexHome, "skills", "marketpilot-compatibility");
  await mkdir(skillDirectory, { recursive: true, mode: 0o700 });
  const directoryMetadata = await lstat(skillDirectory);
  if (
    directoryMetadata.isSymbolicLink() ||
    !directoryMetadata.isDirectory() ||
    (directoryMetadata.mode & 0o7777) !== 0o700
  ) {
    throw new CompatibilityProbeError(
      "UNSAFE_SKILL_DIRECTORY",
      "staged compatibility skill directory is not a mode-0700 non-symlink directory",
    );
  }

  const stagedSkillPath = path.join(skillDirectory, "SKILL.md");
  await copyFile(sourceSkillPath, stagedSkillPath);
  await chmod(stagedSkillPath, 0o600);
  await requireRegularFile(stagedSkillPath, "staged compatibility skill");
  const [sourceDigest, stagedDigest] = await Promise.all([
    sha256File(sourceSkillPath),
    sha256File(stagedSkillPath),
  ]);
  if (sourceDigest !== stagedDigest) {
    throw new CompatibilityProbeError(
      "SKILL_STAGE_MISMATCH",
      "staged compatibility skill does not match its repository source",
    );
  }
  return stagedSkillPath;
}

/** @param {object} options */
async function inspectAppServer({
  installation,
  qualification,
  runtime,
  environment,
  requestTimeoutMs,
  redactor,
  effectiveConfigExpectation,
}) {
  /** @type {string[]} */
  const notifications = [];
  /** @type {string[]} */
  const incidents = [];
  const client = new AppServerClient({
    command: installation.binaryPath,
    args: APP_SERVER_ARGS,
    env: environment,
    cwd: runtime.workDir,
    requestTimeoutMs,
    maxLineBytes: 2 * 1024 * 1024,
    stderrMaxBytes: 32 * 1024,
    redact: redactor,
    serverRequestHandler: createExactServerRequestHandler({}),
    beforeSpawn: () => assertQualifiedCodexExecutable(qualification),
  });
  client.on("notification", (message) => {
    notifications.push(String(message.method));
  });
  client.on("incident", (error) => {
    incidents.push(error instanceof AppServerError ? error.code : "UNKNOWN_INCIDENT");
  });

  try {
    await client.start();
    const initialized = await client.request("initialize", { clientInfo: CLIENT_INFO });
    requireRecord(initialized, "initialize response");
    await client.notify("initialized", {});

    // Validate the effective boundary before explicitly asking Codex to
    // inventory skills or MCP processes. A required MCP may be started by the
    // server during initialization, but no later inspection request is made
    // unless the effective config is exactly the hardened projection.
    const configResult = await client.request("config/read", {
      cwd: runtime.workDir,
      includeLayers: true,
    });
    const configEnvelope = requireRecord(configResult, "config/read response");
    if (!validateEffectiveConfig(configEnvelope.config, effectiveConfigExpectation)) {
      throw new CompatibilityProbeError(
        "UNSAFE_EFFECTIVE_CONFIG",
        "effective Codex configuration does not match the hardened compatibility contract",
      );
    }

    const [accountResult, modelsResult, skillsResult, mcpResult] = await Promise.all([
      client.request("account/read", { refreshToken: false }),
      client.request("model/list", { includeHidden: false }),
      client.request("skills/list", { cwds: [runtime.workDir], forceReload: true }),
      client.request("mcpServerStatus/list", { detail: "full" }),
    ]);
    const modelsEnvelope = requireRecord(modelsResult, "model/list response");
    const skillsEnvelope = requireRecord(skillsResult, "skills/list response");
    const mcpEnvelope = requireRecord(mcpResult, "mcpServerStatus/list response");

    const threadResult = await client.request("thread/start", {
      model: REQUIRED_CODEX_MODEL,
      approvalPolicy: "never",
      sandbox: "read-only",
      cwd: runtime.workDir,
      ephemeral: true,
      config: { model_reasoning_effort: REQUIRED_REASONING_EFFORT },
      developerInstructions:
        "Compatibility metadata probe only. Do not call tools or use data outside the fixture contract.",
    });

    return {
      config: configEnvelope.config,
      account: accountResult,
      models: Array.isArray(modelsEnvelope.data) ? modelsEnvelope.data : [],
      skills: flattenSkills(skillsEnvelope.data),
      skillErrors: flattenSkillErrors(skillsEnvelope.data),
      mcpServers: Array.isArray(mcpEnvelope.data) ? mcpEnvelope.data : [],
      mcpNextCursor: mcpEnvelope.nextCursor,
      thread: threadResult,
      notifications,
      incidents,
    };
  } catch (error) {
    if (error instanceof CompatibilityProbeError) throw error;
    throw new CompatibilityProbeError(
      error instanceof AppServerError ? error.code : "APP_SERVER_INSPECTION_FAILED",
      "app-server inspection did not satisfy the compatibility contract",
      error,
    );
  } finally {
    await client.stop().catch(() => {});
  }
}

/** @param {unknown} models @param {string} id */
function findModel(models, id) {
  if (!Array.isArray(models)) return undefined;
  return models.find((entry) => entry && typeof entry === "object" && (entry.id === id || entry.model === id));
}

/**
 * @param {unknown} value
 * @param {{fixtureMcpCommand: string, fixtureMcpArgs: readonly string[], fixtureMcpCwd: string}} expectation
 */
export function validateEffectiveConfig(value, expectation) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (!isRecord(expectation)) return false;
  const agents = value.agents;
  const analytics = value.analytics;
  const features = value.features;
  const history = value.history;
  const shellEnvironmentPolicy = value.shell_environment_policy;
  const mcpServers = value.mcp_servers;
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
  const disabledFeatureSet = new Set(disabledFeatures);
  const featureValuesAreSafe =
    isRecord(features) &&
    Object.entries(features).every(([feature, enabled]) => {
      if (feature === "multi_agent") return enabled === true;
      if (feature === "mentions_v2") return typeof enabled === "boolean";
      if (disabledFeatureSet.has(feature)) return enabled === false;
      // Additive disabled flags are harmless. Any other future capability
      // representation requires an explicit compatibility review.
      return enabled === false;
    });
  const fixtureMcp = isRecord(mcpServers) ? mcpServers[FIXTURE_MCP_NAME] : undefined;
  return (
    value.model === REQUIRED_CODEX_MODEL &&
    value.model_provider === "openai" &&
    value.model_reasoning_effort === REQUIRED_REASONING_EFFORT &&
    value.approval_policy === "never" &&
    value.sandbox_mode === "read-only" &&
    value.allow_login_shell === false &&
    value.check_for_update_on_startup === false &&
    value.personality === "none" &&
    value.cli_auth_credentials_store === "keyring" &&
    value.mcp_oauth_credentials_store === "keyring" &&
    value.forced_login_method === "chatgpt" &&
    value.web_search === "disabled" &&
    value.file_opener === "none" &&
    value.hide_agent_reasoning === true &&
    value.show_raw_agent_reasoning === false &&
    isRecord(analytics) &&
    analytics.enabled === false &&
    isRecord(history) &&
    history.persistence === "none" &&
    isRecord(agents) &&
    agents.enabled === true &&
    agents.max_concurrent_threads_per_session === 2 &&
    agents.default_subagent_model === REQUIRED_CODEX_MODEL &&
    agents.default_subagent_reasoning_effort === REQUIRED_REASONING_EFFORT &&
    agents.interrupt_message === true &&
    isRecord(features) &&
    features.multi_agent === true &&
    featureValuesAreSafe &&
    disabledFeatures.every((feature) => features[feature] === false) &&
    isRecord(shellEnvironmentPolicy) &&
    hasExactKeys(shellEnvironmentPolicy, [
      "exclude",
      "experimental_use_profile",
      "ignore_default_excludes",
      "include_only",
      "inherit",
      "set",
    ]) &&
    shellEnvironmentPolicy.inherit === "none" &&
    shellEnvironmentPolicy.ignore_default_excludes === false &&
    Array.isArray(shellEnvironmentPolicy.exclude) &&
    shellEnvironmentPolicy.exclude.length === 1 &&
    shellEnvironmentPolicy.exclude[0] === "*" &&
    Array.isArray(shellEnvironmentPolicy.include_only) &&
    shellEnvironmentPolicy.include_only.length === 0 &&
    isRecord(shellEnvironmentPolicy.set) &&
    Object.keys(shellEnvironmentPolicy.set).length === 0 &&
    shellEnvironmentPolicy.experimental_use_profile === false &&
    isRecord(mcpServers) &&
    Object.keys(mcpServers).length === 1 &&
    isRecord(fixtureMcp) &&
    hasExactKeys(fixtureMcp, [
      "args",
      "command",
      "cwd",
      "disabled_tools",
      "enabled",
      "enabled_tools",
      "env",
      "environment_id",
      "required",
      "startup_timeout_sec",
      "tool_timeout_sec",
    ]) &&
    fixtureMcp.enabled === true &&
    fixtureMcp.required === true &&
    fixtureMcp.command === expectation.fixtureMcpCommand &&
    exactStringArray(fixtureMcp.args, expectation.fixtureMcpArgs) &&
    fixtureMcp.cwd === expectation.fixtureMcpCwd &&
    isRecord(fixtureMcp.env) &&
    Object.keys(fixtureMcp.env).length === 0 &&
    // Codex 0.145 canonicalizes an explicit empty env_vars array by omitting
    // it from config/read. Any present value is therefore a projection drift.
    fixtureMcp.env_vars === undefined &&
    fixtureMcp.environment_id === "local" &&
    fixtureMcp.startup_timeout_sec === 5 &&
    fixtureMcp.tool_timeout_sec === 5 &&
    exactStringArray(fixtureMcp.enabled_tools, [FIXTURE_MCP_READ_TOOL]) &&
    exactStringArray(fixtureMcp.disabled_tools, [])
  );
}

/** @param {unknown} servers @param {unknown} nextCursor */
export function validateMcpInventory(servers, nextCursor) {
  if (!Array.isArray(servers) || servers.length !== 1) return false;
  if (nextCursor !== undefined && nextCursor !== null) return false;
  const server = servers[0];
  if (!server || typeof server !== "object" || server.name !== FIXTURE_MCP_NAME) return false;
  if (!server.tools || typeof server.tools !== "object" || Array.isArray(server.tools)) return false;
  const tool = server.tools[FIXTURE_MCP_READ_TOOL];
  if (!isRecord(tool)) return false;
  const inputSchema = tool.inputSchema;
  if (!isRecord(inputSchema) || !isRecord(inputSchema.properties)) return false;
  const fixtureId = inputSchema.properties.fixtureId;
  return (
    server.authStatus === "unsupported" &&
    Array.isArray(server.resourceTemplates) &&
    server.resourceTemplates.length === 0 &&
    Array.isArray(server.resources) &&
    server.resources.length === 0 &&
    Object.keys(server.tools).length === 1 &&
    tool.name === FIXTURE_MCP_READ_TOOL &&
    inputSchema.type === "object" &&
    inputSchema.additionalProperties === false &&
    Array.isArray(inputSchema.required) &&
    inputSchema.required.length === 1 &&
    inputSchema.required[0] === "fixtureId" &&
    Object.keys(inputSchema.properties).length === 1 &&
    isRecord(fixtureId) &&
    fixtureId.type === "string" &&
    fixtureId.const === PUBLIC_FIXTURE_ID
  );
}

/** @param {unknown} value @param {string} expectedCwd */
export function validateThreadPolicy(value, expectedCwd) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const sandbox = value.sandbox;
  const thread = value.thread;
  return (
    value.model === REQUIRED_CODEX_MODEL &&
    value.modelProvider === "openai" &&
    value.reasoningEffort === REQUIRED_REASONING_EFFORT &&
    value.approvalPolicy === "never" &&
    value.cwd === expectedCwd &&
    sandbox &&
    typeof sandbox === "object" &&
    sandbox.type === "readOnly" &&
    sandbox.networkAccess === false &&
    thread &&
    typeof thread === "object" &&
    !Array.isArray(thread) &&
    thread.ephemeral === true &&
    thread.path === null &&
    thread.cwd === expectedCwd &&
    thread.modelProvider === "openai"
  );
}

/** @param {unknown} data */
function flattenSkills(data) {
  if (!Array.isArray(data)) return [];
  return data.flatMap((entry) =>
    entry && typeof entry === "object" && Array.isArray(entry.skills) ? entry.skills : [],
  );
}

/** @param {unknown} data */
function flattenSkillErrors(data) {
  if (!Array.isArray(data)) return ["invalid skills/list data"];
  return data.flatMap((entry) =>
    entry && typeof entry === "object" && Array.isArray(entry.errors) ? entry.errors : [],
  );
}

/** @param {unknown} account */
function summarizeAccountState(account) {
  if (!account || typeof account !== "object" || Array.isArray(account)) return "unknown";
  const value = account.account;
  if (value === null || value === undefined) return "signed-out";
  if (typeof value === "object" && value !== null && value.type === "chatgpt") return "chatgpt-present";
  return "unsupported-auth-type";
}

/** @param {string} codexHome */
async function inventoryCodexState(codexHome) {
  /** @type {Array<{relativePath: string, classification: string, mode: string, size: number}>} */
  const inventory = [];
  await visit(codexHome, "");
  return inventory.sort((left, right) => left.relativePath.localeCompare(right.relativePath));

  /** @param {string} directory @param {string} relativeDirectory */
  async function visit(directory, relativeDirectory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.posix.join(relativeDirectory.split(path.sep).join(path.posix.sep), entry.name);
      const metadata = await lstat(absolutePath);
      if (metadata.isSymbolicLink()) {
        throw new CompatibilityProbeError(
          "UNSAFE_STATE_PATH",
          "Codex state contains a symlink; the path identifier was withheld",
        );
      }
      if (metadata.isDirectory()) {
        await visit(absolutePath, path.join(relativeDirectory, entry.name));
        continue;
      }
      if (!metadata.isFile()) {
        throw new CompatibilityProbeError(
          "UNSAFE_STATE_PATH",
          "Codex state contains an unsupported file type; the path identifier was withheld",
        );
      }
      inventory.push({
        relativePath,
        classification: classifyStatePath(relativePath),
        mode: (metadata.mode & 0o7777).toString(8).padStart(4, "0"),
        size: metadata.size,
      });
    }
  }
}

/** @param {string} relativePath */
function classifyStatePath(relativePath) {
  const lower = relativePath.toLowerCase();
  if (lower === "auth.json") return "credential";
  if (/\.(?:db|sqlite|sqlite3)(?:-(?:shm|wal))?$/u.test(lower)) return "sqlite";
  if (lower.includes("session") || lower.endsWith(".jsonl")) return "transcript";
  if (lower.includes("log")) return "log";
  if (lower === "config.toml") return "config";
  if (lower.includes("skill")) return "skill";
  return "runtime-metadata";
}

/** @param {Array<{classification: string}>} storage */
function summarizeStorage(storage) {
  /** @type {Record<string, number>} */
  const byClassification = {};
  for (const { classification } of storage) {
    byClassification[classification] = (byClassification[classification] ?? 0) + 1;
  }
  return Object.freeze({ fileCount: storage.length, byClassification });
}

/**
 * @param {Readonly<Record<string, string>>} environment
 * @param {{codexHome: string, workDir: string}} runtime
 */
function validateMinimalEnvironment(environment, runtime) {
  const allowedKeys = new Set([
    "CODEX_HOME",
    "HOME",
    "PWD",
    "NO_COLOR",
    ...INHERITED_ENV_ALLOWLIST,
  ]);
  return (
    Object.keys(environment).every((key) => allowedKeys.has(key)) &&
    environment.CODEX_HOME === runtime.codexHome &&
    environment.HOME === runtime.codexHome &&
    environment.PWD === runtime.workDir &&
    environment.NO_COLOR === "1" &&
    environment.PATH === undefined &&
    environment.OPENAI_API_KEY === undefined
  );
}

/** @param {{runtimeRoot: string, projectRoot: string}} options */
export function createDiagnosticRedactor({ runtimeRoot, projectRoot }) {
  const replacements = [
    [path.resolve(runtimeRoot), "<runtime>"],
    [path.resolve(projectRoot), "<project>"],
    [os.homedir(), "<home>"],
  ].sort((left, right) => right[0].length - left[0].length);
  return (value) => {
    let redacted = String(value);
    for (const [needle, replacement] of replacements) {
      redacted = redacted.split(needle).join(replacement);
    }
    redacted = redacted
      .replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/gu, "<jwt>")
      .replace(/\b(?:sk|sess)-[A-Za-z0-9_-]{16,}\b/gu, "<secret>")
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "<email>")
      .replace(
        /(["']?authorization["']?\s*[:=]\s*["']?)(?:bearer\s+)?[^"',;\r\n}\]]+/giu,
        "$1<redacted>",
      )
      .replace(/\b(bearer\s+)[^\s"',;}\]]+/giu, "$1<redacted>");
    return redacted;
  };
}

/** @param {readonly string[]} methods */
export function summarizeObservedNotifications(methods) {
  return [...new Set(methods.map((method) => summarizeNotificationMethod(method)))].sort();
}

/** @param {string} method */
function summarizeNotificationMethod(method) {
  try {
    classifyNotification(method);
    // A successfully classified method comes from the static protocol
    // allowlist and is safe to include verbatim.
    return method;
  } catch {
    return `unknown:${sha256(method).slice(0, 16)}`;
  }
}

/** @param {string} id @param {boolean} passed @param {string} detail */
function check(id, passed, detail) {
  return Object.freeze({ id, passed, detail });
}

/** @param {unknown} value @param {string} label */
function requireRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CompatibilityProbeError("INVALID_RESPONSE", `${label} must be an object`);
  }
  return value;
}

/** @param {unknown} value */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {Record<string, unknown>} value @param {readonly string[]} expected */
function hasExactKeys(value, expected) {
  const observed = Object.keys(value).sort();
  const canonicalExpected = [...expected].sort();
  return (
    observed.length === canonicalExpected.length &&
    observed.every((key, index) => key === canonicalExpected[index])
  );
}

/** @param {unknown} value @param {readonly string[]} expected */
function exactStringArray(value, expected) {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((entry, index) => entry === expected[index])
  );
}

/** @param {string} filePath @param {string} label */
async function requireRegularFile(filePath, label) {
  const metadata = await lstat(filePath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new CompatibilityProbeError("UNSAFE_FILE", `${label} must be a regular non-symlink file`);
  }
}
