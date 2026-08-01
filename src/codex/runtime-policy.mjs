// @ts-check

import { createHash } from "node:crypto";
import {
  accessSync,
  constants as fsConstants,
  createReadStream,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

export const PINNED_CODEX_VERSION = "0.145.0";
export const REQUIRED_CODEX_MODEL = "gpt-5.6-sol";
export const REQUIRED_REASONING_EFFORT = "ultra";
export const FIXTURE_MCP_NAME = "marketpilot_fixture";
export const FIXTURE_MCP_READ_TOOL = "research_read";
export const PUBLIC_FIXTURE_ID = "public-event-001";

export const BUNDLED_SYSTEM_SKILL_NAMES = Object.freeze([
  "imagegen",
  "openai-docs",
  "plugin-creator",
  "review-agent",
  "skill-creator",
  "skill-installer",
]);

export const INHERITED_ENV_ALLOWLIST = Object.freeze([
  "DBUS_SESSION_BUS_ADDRESS",
  "XDG_RUNTIME_DIR",
  "LANG",
  "LC_ALL",
  "TZ",
]);

export const APP_SERVER_ARGS = Object.freeze([
  "app-server",
  "--strict-config",
  "--listen",
  "stdio://",
]);

const TARGETS = Object.freeze({
  "linux:x64": Object.freeze({
    packageName: "@openai/codex-linux-x64",
    packageSuffix: "linux-x64",
    targetTriple: "x86_64-unknown-linux-musl",
    executable: "codex",
  }),
  "linux:arm64": Object.freeze({
    packageName: "@openai/codex-linux-arm64",
    packageSuffix: "linux-arm64",
    targetTriple: "aarch64-unknown-linux-musl",
    executable: "codex",
  }),
  "darwin:x64": Object.freeze({
    packageName: "@openai/codex-darwin-x64",
    packageSuffix: "darwin-x64",
    targetTriple: "x86_64-apple-darwin",
    executable: "codex",
  }),
  "darwin:arm64": Object.freeze({
    packageName: "@openai/codex-darwin-arm64",
    packageSuffix: "darwin-arm64",
    targetTriple: "aarch64-apple-darwin",
    executable: "codex",
  }),
  "win32:x64": Object.freeze({
    packageName: "@openai/codex-win32-x64",
    packageSuffix: "win32-x64",
    targetTriple: "x86_64-pc-windows-msvc",
    executable: "codex.exe",
  }),
  "win32:arm64": Object.freeze({
    packageName: "@openai/codex-win32-arm64",
    packageSuffix: "win32-arm64",
    targetTriple: "aarch64-pc-windows-msvc",
    executable: "codex.exe",
  }),
});

/**
 * Resolve and verify the native executable shipped by the pinned npm package.
 * This deliberately never consults PATH or a system Codex installation.
 *
 * @param {{ projectRoot?: string, platform?: NodeJS.Platform, arch?: string }} [options]
 */
export function resolvePackagedCodexInstallation(options = {}) {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const target = TARGETS[`${platform}:${arch}`];

  if (!target) {
    throw new Error(`Unsupported packaged Codex target: ${platform} (${arch})`);
  }

  const canonicalProjectRoot = realpathSync(projectRoot);
  const requireFromProject = createRequire(path.join(canonicalProjectRoot, "package.json"));
  const wrapperManifest = requireFromProject.resolve("@openai/codex/package.json");
  const wrapperRoot = realpathSync(path.dirname(wrapperManifest));
  assertPathWithin(canonicalProjectRoot, wrapperRoot, "@openai/codex package");

  const wrapperPackage = readPackageManifest(wrapperManifest);
  if (wrapperPackage.version !== PINNED_CODEX_VERSION) {
    throw new Error(
      `Expected @openai/codex ${PINNED_CODEX_VERSION}, found ${String(wrapperPackage.version)}`,
    );
  }

  const platformManifest = requireFromProject.resolve(`${target.packageName}/package.json`);
  const platformRoot = realpathSync(path.dirname(platformManifest));
  assertPathWithin(canonicalProjectRoot, platformRoot, `${target.packageName} package`);

  const platformPackage = readPackageManifest(platformManifest);
  const expectedPlatformVersion = `${PINNED_CODEX_VERSION}-${target.packageSuffix}`;
  if (platformPackage.version !== expectedPlatformVersion) {
    throw new Error(
      `Expected ${target.packageName} ${expectedPlatformVersion}, found ${String(platformPackage.version)}`,
    );
  }

  const binaryCandidate = path.join(
    platformRoot,
    "vendor",
    target.targetTriple,
    "bin",
    target.executable,
  );
  const binaryMetadata = lstatSync(binaryCandidate);
  if (binaryMetadata.isSymbolicLink() || !binaryMetadata.isFile()) {
    throw new Error(`Packaged Codex binary is not a regular non-symlink file: ${binaryCandidate}`);
  }

  accessSync(binaryCandidate, fsConstants.X_OK);
  const binaryPath = realpathSync(binaryCandidate);
  assertPathWithin(platformRoot, binaryPath, "packaged Codex binary");

  return Object.freeze({
    binaryPath,
    packageRoot: wrapperRoot,
    packageVersion: wrapperPackage.version,
    platformPackage: target.packageName,
    platformPackageRoot: platformRoot,
    platformPackageVersion: platformPackage.version,
    targetTriple: target.targetTriple,
  });
}

/**
 * @param {{ projectRoot?: string, platform?: NodeJS.Platform, arch?: string }} [options]
 */
export function resolvePackagedCodexBinary(options = {}) {
  return resolvePackagedCodexInstallation(options).binaryPath;
}

/**
 * Create and then verify private runtime directories below a private caller-owned base.
 * Directory creation is synchronous so the temporary process umask cannot span an await.
 *
 * @param {{ baseDir: string, codexHomeName?: string, workDirName?: string }} options
 */
export function prepareIsolatedRuntimeDirectories({
  baseDir,
  codexHomeName = "codex-home",
  workDirName = "work",
}) {
  if (process.platform === "win32") {
    throw new Error("The mode-0700 runtime boundary is supported only on POSIX hosts");
  }

  const canonicalBase = validatePrivateDirectory(baseDir, "runtime base");
  const homeName = validateDirectChildName(codexHomeName, "CODEX_HOME directory name");
  const workspaceName = validateDirectChildName(workDirName, "work directory name");
  if (homeName === workspaceName) {
    throw new Error("CODEX_HOME and work directory names must be distinct");
  }

  const codexHome = path.join(canonicalBase, homeName);
  const workDir = path.join(canonicalBase, workspaceName);
  const previousUmask = process.umask(0o077);
  try {
    createPrivateDirectoryIfMissing(codexHome);
    createPrivateDirectoryIfMissing(workDir);
  } finally {
    process.umask(previousUmask);
  }

  return Object.freeze({
    baseDir: canonicalBase,
    codexHome: assertSecureRuntimeDirectory(codexHome, { baseDir: canonicalBase }),
    workDir: assertSecureRuntimeDirectory(workDir, { baseDir: canonicalBase }),
  });
}

export const createSecureRuntimeDirectories = prepareIsolatedRuntimeDirectories;

/**
 * @param {string} directory
 * @param {{ baseDir: string }} options
 */
export function assertSecureRuntimeDirectory(directory, { baseDir }) {
  const canonicalBase = validatePrivateDirectory(baseDir, "runtime base");
  const resolvedDirectory = path.resolve(directory);
  if (resolvedDirectory === canonicalBase) {
    throw new Error("runtime directory must be below, not equal to, the runtime base");
  }
  assertPathWithin(canonicalBase, resolvedDirectory, "runtime directory");
  return validatePrivateDirectory(resolvedDirectory, "runtime directory");
}

/**
 * Return the absolute paths Codex uses for its built-in system skills. They are
 * disabled explicitly because a fresh CODEX_HOME can still expose them.
 *
 * @param {string} codexHome
 */
export function bundledSystemSkillPaths(codexHome) {
  const absoluteHome = requireAbsolutePath(codexHome, "CODEX_HOME");
  return Object.freeze(
    BUNDLED_SYSTEM_SKILL_NAMES.map((name) =>
      path.join(absoluteHome, "skills", ".system", name, "SKILL.md"),
    ),
  );
}

/**
 * Render the only supported WI-001 config. The fixture MCP command must be an
 * absolute executable path so MCP startup also remains independent of PATH.
 *
 * @param {{
 *   codexHome: string,
 *   enabledSkillPath: string,
 *   fixtureMcpCommand: string,
 *   fixtureMcpArgs?: readonly string[],
 *   fixtureMcpCwd?: string,
 *   additionalDisabledSkillPaths?: readonly string[],
 * }} options
 */
export function renderHardenedConfig({
  codexHome,
  enabledSkillPath,
  fixtureMcpCommand,
  fixtureMcpArgs = [],
  fixtureMcpCwd,
  additionalDisabledSkillPaths = [],
}) {
  const absoluteHome = requireAbsolutePath(codexHome, "CODEX_HOME");
  const appSkillPath = requireAbsolutePath(enabledSkillPath, "enabled app skill path");
  const mcpCommand = requireAbsolutePath(fixtureMcpCommand, "fixture MCP command");
  const mcpCwd = fixtureMcpCwd
    ? requireAbsolutePath(fixtureMcpCwd, "fixture MCP working directory")
    : undefined;
  const mcpArgs = fixtureMcpArgs.map((argument, index) =>
    requireSafeString(argument, `fixture MCP argument ${index}`),
  );

  const disabledSkillPaths = [
    ...bundledSystemSkillPaths(absoluteHome),
    ...additionalDisabledSkillPaths.map((skillPath, index) =>
      requireAbsolutePath(skillPath, `additional disabled skill path ${index}`),
    ),
  ].filter((skillPath, index, paths) => paths.indexOf(skillPath) === index);
  if (disabledSkillPaths.includes(appSkillPath)) {
    throw new Error("The enabled app skill must not also be disabled");
  }

  const lines = [
    `model = ${tomlString(REQUIRED_CODEX_MODEL)}`,
    `model_provider = "openai"`,
    `model_reasoning_effort = ${tomlString(REQUIRED_REASONING_EFFORT)}`,
    `personality = "none"`,
    `approval_policy = "never"`,
    `sandbox_mode = "read-only"`,
    `allow_login_shell = false`,
    `cli_auth_credentials_store = "keyring"`,
    `mcp_oauth_credentials_store = "keyring"`,
    `forced_login_method = "chatgpt"`,
    `web_search = "disabled"`,
    `check_for_update_on_startup = false`,
    `file_opener = "none"`,
    `hide_agent_reasoning = true`,
    `show_raw_agent_reasoning = false`,
    "",
    `[tools.experimental_request_user_input]`,
    `enabled = false`,
    "",
    `[analytics]`,
    `enabled = false`,
    "",
    `[history]`,
    `persistence = "none"`,
    "",
    `[shell_environment_policy]`,
    `inherit = "none"`,
    `ignore_default_excludes = false`,
    `exclude = ["*"]`,
    `include_only = []`,
    `set = {}`,
    `experimental_use_profile = false`,
    "",
    `[agents]`,
    `enabled = true`,
    `max_concurrent_threads_per_session = 2`,
    `default_subagent_model = ${tomlString(REQUIRED_CODEX_MODEL)}`,
    `default_subagent_reasoning_effort = ${tomlString(REQUIRED_REASONING_EFFORT)}`,
    `interrupt_message = true`,
    "",
    `[features]`,
    `apps = false`,
    `auth_elicitation = false`,
    `browser_use = false`,
    `browser_use_external = false`,
    `browser_use_full_cdp_access = false`,
    `code_mode_host = false`,
    `computer_use = false`,
    `default_mode_request_user_input = false`,
    `fast_mode = false`,
    `goals = false`,
    `guardian_approval = false`,
    `hooks = false`,
    `image_generation = false`,
    `in_app_browser = false`,
    `memories = false`,
    `multi_agent = true`,
    `network_proxy = false`,
    `personality = false`,
    `plugin_sharing = false`,
    `plugins = false`,
    `remote_plugin = false`,
    `shell_snapshot = false`,
    `shell_tool = false`,
    `skill_mcp_dependency_install = false`,
    `skill_search = false`,
    `tool_call_mcp_elicitation = false`,
    `tool_suggest = false`,
    `unified_exec = false`,
    `workspace_dependencies = false`,
    "",
    `[[skills.config]]`,
    `path = ${tomlString(appSkillPath)}`,
    `enabled = true`,
    "",
  ];

  for (const skillPath of disabledSkillPaths) {
    lines.push(
      `[[skills.config]]`,
      `path = ${tomlString(skillPath)}`,
      `enabled = false`,
      "",
    );
  }

  lines.push(
    `[mcp_servers.${FIXTURE_MCP_NAME}]`,
    `enabled = true`,
    `required = true`,
    `command = ${tomlString(mcpCommand)}`,
    `args = ${tomlStringArray(mcpArgs)}`,
  );
  if (mcpCwd) {
    lines.push(`cwd = ${tomlString(mcpCwd)}`);
  }
  lines.push(
    `env = {}`,
    `env_vars = []`,
    `startup_timeout_sec = 5.0`,
    `tool_timeout_sec = 5.0`,
    `default_tools_approval_mode = "approve"`,
    `enabled_tools = [${tomlString(FIXTURE_MCP_READ_TOOL)}]`,
    `disabled_tools = []`,
    "",
  );

  return `${lines.join("\n")}\n`;
}

export const renderHardenedCodexConfig = renderHardenedConfig;

/**
 * Prove the request-user-input tool is disabled at its registration switch.
 * Codex 0.145 does not project this experimental setting through config/read's
 * typed `config` value, so the raw, ordered config layers are the canonical
 * observable boundary. Only the isolated CODEX_HOME user layer may define it.
 *
 * @param {unknown} value
 * @param {string} expectedConfigPath
 */
export function validateRequestUserInputDisabledLayers(value, expectedConfigPath) {
  const absoluteConfigPath = requireAbsolutePath(expectedConfigPath, "Codex config path");
  if (!Array.isArray(value)) return false;

  const definitions = [];
  for (const candidate of value) {
    if (!isPlainRecord(candidate)) return false;
    const disabledReason = candidate.disabledReason;
    if (disabledReason !== undefined && disabledReason !== null) {
      if (
        typeof disabledReason !== "string" ||
        disabledReason.length === 0 ||
        disabledReason.length > 4096 ||
        /[\0\r\n]/u.test(disabledReason)
      ) {
        return false;
      }
      continue;
    }

    const config = candidate.config;
    if (!isPlainRecord(config)) return false;
    const tools = config.tools;
    if (tools === undefined) continue;
    if (!isPlainRecord(tools)) return false;
    const requestUserInput = tools.experimental_request_user_input;
    if (requestUserInput === undefined) continue;
    if (!isPlainRecord(requestUserInput)) return false;
    if (!Object.hasOwn(requestUserInput, "enabled")) continue;

    definitions.push({ layer: candidate, value: requestUserInput.enabled });
  }

  if (definitions.length !== 1) return false;
  const definition = definitions[0];
  const name = definition.layer.name;
  return (
    definition.value === false &&
    isPlainRecord(name) &&
    name.type === "user" &&
    name.file === absoluteConfigPath &&
    (name.profile === null || name.profile === undefined)
  );
}

/**
 * Construct the complete environment for the native app-server process. Only
 * Linux Secret Service/session routing and non-sensitive locale values can be
 * copied from the parent. PATH, proxies, credentials, and shell state are not.
 *
 * @param {{
 *   codexHome: string,
 *   workDir: string,
 *   sourceEnv?: NodeJS.ProcessEnv,
 * }} options
 */
export function buildMinimalEnvironment({ codexHome, workDir, sourceEnv = process.env }) {
  const absoluteHome = requireAbsolutePath(codexHome, "CODEX_HOME");
  const absoluteWorkDir = requireAbsolutePath(workDir, "work directory");
  /** @type {Record<string, string>} */
  const environment = {
    CODEX_HOME: absoluteHome,
    HOME: absoluteHome,
    PWD: absoluteWorkDir,
    NO_COLOR: "1",
  };

  for (const key of INHERITED_ENV_ALLOWLIST) {
    const value = sourceEnv[key];
    if (value === undefined || value === "") {
      continue;
    }
    environment[key] = requireSafeEnvironmentValue(value, key);
  }

  if (environment.XDG_RUNTIME_DIR && !path.isAbsolute(environment.XDG_RUNTIME_DIR)) {
    throw new Error("XDG_RUNTIME_DIR must be absolute");
  }

  if (!environment.LANG && !environment.LC_ALL) {
    environment.LANG = "C.UTF-8";
  }

  return Object.freeze(environment);
}

export const buildMinimalCodexEnvironment = buildMinimalEnvironment;

/** @param {string | ArrayBuffer | ArrayBufferView} value */
export function sha256(value) {
  const hash = createHash("sha256");
  if (typeof value === "string") {
    hash.update(value, "utf8");
  } else if (value instanceof ArrayBuffer) {
    hash.update(Buffer.from(value));
  } else if (ArrayBuffer.isView(value)) {
    hash.update(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
  } else {
    throw new TypeError("SHA-256 input must be a string, ArrayBuffer, or ArrayBuffer view");
  }
  return hash.digest("hex");
}

export const sha256Buffer = sha256;

/** @param {string} filePath */
export async function sha256File(filePath) {
  const absolutePath = requireAbsolutePath(filePath, "file to hash");
  const metadata = lstatSync(absolutePath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`SHA-256 input is not a regular non-symlink file: ${absolutePath}`);
  }

  const hash = createHash("sha256");
  const input = createReadStream(absolutePath);
  for await (const chunk of input) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

/** @param {string} manifestPath */
function readPackageManifest(manifestPath) {
  const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid package manifest: ${manifestPath}`);
  }
  return parsed;
}

/** @param {string} directory */
function createPrivateDirectoryIfMissing(directory) {
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") {
      throw error;
    }
  }
}

/** @param {string} directory @param {string} label */
function validatePrivateDirectory(directory, label) {
  const resolved = requireAbsolutePath(directory, label);
  const metadata = lstatSync(resolved);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${label} must be a non-symlink directory: ${resolved}`);
  }
  if ((metadata.mode & 0o7777) !== 0o700) {
    throw new Error(`${label} must have mode 0700: ${resolved}`);
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new Error(`${label} must be owned by the current user: ${resolved}`);
  }

  const canonical = realpathSync(resolved);
  if (canonical !== resolved) {
    throw new Error(`${label} must not traverse symbolic links: ${resolved}`);
  }
  return canonical;
}

/** @param {string} root @param {string} candidate @param {string} label */
function assertPathWithin(root, candidate, label) {
  const relative = path.relative(root, candidate);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    return;
  }
  throw new Error(`${label} is outside the approved root: ${candidate}`);
}

/** @param {string} value @param {string} label */
function requireAbsolutePath(value, label) {
  const safeValue = requireSafeString(value, label);
  if (!path.isAbsolute(safeValue)) {
    throw new Error(`${label} must be an absolute path`);
  }
  return path.resolve(safeValue);
}

/** @param {string} value @param {string} label */
function validateDirectChildName(value, label) {
  const safeValue = requireSafeString(value, label);
  if (
    safeValue === "." ||
    safeValue === ".." ||
    path.isAbsolute(safeValue) ||
    path.basename(safeValue) !== safeValue
  ) {
    throw new Error(`${label} must be one direct child name`);
  }
  return safeValue;
}

/** @param {unknown} value @param {string} label */
function requireSafeString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  if (value.includes("\0")) {
    throw new Error(`${label} must not contain a NUL byte`);
  }
  return value;
}

/** @param {string} value @param {string} key */
function requireSafeEnvironmentValue(value, key) {
  if (value.length > 4096 || /[\0\r\n]/u.test(value)) {
    throw new Error(`Unsafe inherited environment value for ${key}`);
  }
  return value;
}

/** @param {string} value */
function tomlString(value) {
  return JSON.stringify(value);
}

/** @param {readonly string[]} values */
function tomlStringArray(values) {
  return `[${values.map(tomlString).join(", ")}]`;
}

/** @param {unknown} value */
function isPlainRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** @param {unknown} error */
function isNodeError(error) {
  return error instanceof Error && "code" in error;
}
