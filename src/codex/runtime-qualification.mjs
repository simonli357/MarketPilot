// @ts-check

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, lstat, mkdir, open, readFile, readdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  PINNED_CODEX_VERSION,
  resolvePackagedCodexInstallation,
  sha256,
} from "./runtime-policy.mjs";

const execFileAsync = promisify(execFile);

export const QUALIFIED_LINUX_X64_BASELINE = Object.freeze({
  binarySha256: "a2a05dafaa1acb002a45eaec0a462de5b13694fcfcd7bc43305f14781ce7be14",
  stableSchemaSha256: "02d8bf6651cd504bff0335f566c011e51ba77c5cc0538cb64ca7ac57739a1597",
  stableSchemaManifestSha256:
    "55b99a08fe6a28214ba9f797484f2f4c06930c44b2b4562f89675eeec3b4cccc",
});

export class RuntimeQualificationError extends Error {
  /** @param {string} code @param {string} message @param {unknown} [cause] */
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "RuntimeQualificationError";
    this.code = code;
  }
}

/**
 * Qualify the exact supported host, npm package, native executable, version,
 * and stable app-server schema. No Codex process is launched until the native
 * file has been opened without following a final symlink and its bytes match
 * the committed digest.
 *
 * The optional dependencies are a narrow test seam. Production callers must
 * omit them.
 *
 * @param {{
 *   projectRoot: string,
 *   schemaDir: string,
 *   cwd: string,
 *   env: NodeJS.ProcessEnv,
 *   timeoutMs?: number,
 *   dependencies?: {
 *     resolveInstallation?: typeof resolvePackagedCodexInstallation,
 *     execute?: typeof execFileAsync,
 *     readHost?: typeof readQualifiedHost,
 *   },
 * }} options
 */
export async function qualifyPackagedCodexRuntime({
  projectRoot,
  schemaDir,
  cwd,
  env,
  timeoutMs = 15_000,
  dependencies = {},
}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("timeoutMs must be a positive integer");
  }
  const resolveInstallation =
    dependencies.resolveInstallation ?? resolvePackagedCodexInstallation;
  const execute = dependencies.execute ?? execFileAsync;
  const readHost = dependencies.readHost ?? readQualifiedHost;

  const host = await readHost();
  assertSupportedHost(host);

  let installation;
  try {
    installation = resolveInstallation({ projectRoot: path.resolve(projectRoot) });
  } catch (cause) {
    throw new RuntimeQualificationError(
      "PACKAGE_MISMATCH",
      "The pinned Codex package installation could not be verified",
      cause,
    );
  }

  const executableFingerprint = await inspectQualifiedExecutable(
    installation.binaryPath,
    QUALIFIED_LINUX_X64_BASELINE.binarySha256,
  );
  const executableQualification = Object.freeze({
    installation,
    executableFingerprint,
    binarySha256: executableFingerprint.sha256,
  });

  const versionResult = await executeQualifiedCodex(
    executableQualification,
    ["--version"],
    { cwd, env, timeout: Math.min(timeoutMs, 10_000), maxBuffer: 64 * 1024 },
    execute,
  );
  const codexVersion = String(versionResult.stdout).trim();
  if (codexVersion !== `codex-cli ${PINNED_CODEX_VERSION}`) {
    throw new RuntimeQualificationError(
      "VERSION_MISMATCH",
      `Expected codex-cli ${PINNED_CODEX_VERSION}, found ${codexVersion}`,
    );
  }

  await createExclusivePrivateDirectory(schemaDir);
  await executeQualifiedCodex(
    executableQualification,
    ["app-server", "generate-json-schema", "--out", schemaDir],
    { cwd, env, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
    execute,
  );

  const schemaPath = path.join(schemaDir, "codex_app_server_protocol.v2.schemas.json");
  await requireRegularFile(schemaPath, "generated stable protocol schema");
  const schemaDocument = JSON.parse(await readFile(schemaPath, "utf8"));
  const schemaText = JSON.stringify(schemaDocument);
  const stableSchemaSha256 = sha256(canonicalJson(schemaDocument));
  const stableSchemaManifestSha256 = await sha256DirectoryManifest(schemaDir);
  if (
    !schemaText.includes('"thread/start"') ||
    !schemaText.includes('"model/list"') ||
    !schemaText.includes('"mcpServerStatus/list"') ||
    stableSchemaSha256 !== QUALIFIED_LINUX_X64_BASELINE.stableSchemaSha256 ||
    stableSchemaManifestSha256 !==
      QUALIFIED_LINUX_X64_BASELINE.stableSchemaManifestSha256
  ) {
    throw new RuntimeQualificationError(
      "SCHEMA_MISMATCH",
      "The generated app-server schema does not match the committed stable baseline",
    );
  }

  // Re-check after the two qualification executions. Callers must also pass
  // assertQualifiedCodexExecutable as AppServerClient.beforeSpawn. This cannot
  // eliminate the OS-level pathname race entirely, but it minimizes the window
  // and makes every spawn contingent on a fresh byte-for-byte verification.
  await assertQualifiedCodexExecutable(executableQualification);

  return Object.freeze({
    ...executableQualification,
    host,
    codexVersion,
    stableSchemaSha256,
    stableSchemaManifestSha256,
  });
}

/**
 * Re-open and hash the executable immediately before each spawn. The identity
 * fields also detect replacement by another copy between qualification steps.
 *
 * @param {{installation: {binaryPath: string}, executableFingerprint: ExecutableFingerprint, binarySha256: string}} qualification
 */
export async function assertQualifiedCodexExecutable(qualification) {
  if (
    !qualification ||
    typeof qualification !== "object" ||
    qualification.binarySha256 !== QUALIFIED_LINUX_X64_BASELINE.binarySha256
  ) {
    throw new RuntimeQualificationError(
      "INVALID_QUALIFICATION",
      "A valid committed Codex executable qualification is required",
    );
  }
  const observed = await inspectQualifiedExecutable(
    qualification.installation.binaryPath,
    qualification.binarySha256,
  );
  if (!sameExecutableIdentity(observed, qualification.executableFingerprint)) {
    throw new RuntimeQualificationError(
      "EXECUTABLE_CHANGED",
      "The packaged Codex executable identity changed after qualification",
    );
  }
}

/**
 * @param {{installation: {binaryPath: string}, executableFingerprint: ExecutableFingerprint, binarySha256: string}} qualification
 * @param {string[]} args
 * @param {{cwd: string, env: NodeJS.ProcessEnv, timeout: number, maxBuffer: number}} options
 * @param {typeof execFileAsync} execute
 */
async function executeQualifiedCodex(qualification, args, options, execute) {
  await assertQualifiedCodexExecutable(qualification);
  try {
    return await execute(qualification.installation.binaryPath, args, options);
  } catch (cause) {
    throw new RuntimeQualificationError(
      "QUALIFICATION_EXECUTION_FAILED",
      `Qualified Codex execution failed during ${args.join(" ")}`,
      cause,
    );
  }
}

/** @typedef {{device: string, inode: string, size: string, mtimeNs: string, ctimeNs: string, mode: string, linkCount: string, sha256: string}} ExecutableFingerprint */

/** @param {string} binaryPath @param {string} expectedSha256 @returns {Promise<Readonly<ExecutableFingerprint>>} */
async function inspectQualifiedExecutable(binaryPath, expectedSha256) {
  let handle;
  try {
    const before = await lstat(binaryPath, { bigint: true });
    if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1n) {
      throw new RuntimeQualificationError(
        "UNSAFE_EXECUTABLE",
        "The packaged Codex executable must be a singly-linked regular non-symlink file",
      );
    }
    await access(binaryPath, fsConstants.X_OK);
    const canonicalPath = await realpath(binaryPath);
    if (canonicalPath !== path.resolve(binaryPath)) {
      throw new RuntimeQualificationError(
        "UNSAFE_EXECUTABLE",
        "The packaged Codex executable path must not traverse a symlink",
      );
    }

    handle = await open(binaryPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const openedBefore = await handle.stat({ bigint: true });
    if (
      !openedBefore.isFile() ||
      openedBefore.nlink !== 1n ||
      !sameStatIdentity(before, openedBefore)
    ) {
      throw new RuntimeQualificationError(
        "EXECUTABLE_CHANGED",
        "The packaged Codex executable changed while it was being opened",
      );
    }

    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(128 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const openedAfter = await handle.stat({ bigint: true });
    const pathAfter = await lstat(binaryPath, { bigint: true });
    if (
      !openedAfter.isFile() ||
      openedAfter.nlink !== 1n ||
      pathAfter.isSymbolicLink() ||
      !pathAfter.isFile() ||
      pathAfter.nlink !== 1n ||
      !sameStatIdentity(openedBefore, openedAfter) ||
      !sameStatIdentity(openedAfter, pathAfter)
    ) {
      throw new RuntimeQualificationError(
        "EXECUTABLE_CHANGED",
        "The packaged Codex executable changed while it was being hashed",
      );
    }
    const digest = hash.digest("hex");
    if (digest !== expectedSha256) {
      throw new RuntimeQualificationError(
        "BINARY_DIGEST_MISMATCH",
        "The packaged Codex executable does not match the committed Linux x64 digest",
      );
    }
    return Object.freeze(fingerprint(openedAfter, digest));
  } catch (cause) {
    if (cause instanceof RuntimeQualificationError) throw cause;
    throw new RuntimeQualificationError(
      "UNSAFE_EXECUTABLE",
      "The packaged Codex executable could not be safely inspected",
      cause,
    );
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** @param {import("node:fs").BigIntStats} metadata @param {string} digest */
function fingerprint(metadata, digest) {
  return {
    device: String(metadata.dev),
    inode: String(metadata.ino),
    size: String(metadata.size),
    mtimeNs: String(metadata.mtimeNs),
    ctimeNs: String(metadata.ctimeNs),
    mode: String(metadata.mode),
    linkCount: String(metadata.nlink),
    sha256: digest,
  };
}

/** @param {import("node:fs").BigIntStats} left @param {import("node:fs").BigIntStats} right */
function sameStatIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.nlink === right.nlink &&
    left.mode === right.mode
  );
}

/** @param {ExecutableFingerprint} left @param {ExecutableFingerprint} right */
function sameExecutableIdentity(left, right) {
  return Object.keys(left).every((key) => left[key] === right[key]);
}

/** @param {unknown} host */
function assertSupportedHost(host) {
  if (
    !host ||
    typeof host !== "object" ||
    host.platform !== "linux" ||
    host.arch !== "x64" ||
    host.distributionId !== "ubuntu" ||
    host.distributionVersion !== "24.04" ||
    Number.parseInt(String(host.nodeVersion).split(".")[0] ?? "", 10) < 22
  ) {
    throw new RuntimeQualificationError(
      "HOST_MISMATCH",
      "Codex runtime qualification requires Ubuntu 24.04 x64 and Node.js 22 or newer",
    );
  }
}

export async function readQualifiedHost() {
  let distributionId = "unknown";
  let distributionVersion = "unknown";
  try {
    const osRelease = await readFile("/etc/os-release", "utf8");
    const values = Object.fromEntries(
      osRelease
        .split(/\r?\n/u)
        .filter((line) => line.includes("="))
        .map((line) => {
          const separator = line.indexOf("=");
          return [
            line.slice(0, separator),
            line.slice(separator + 1).replace(/^["']|["']$/gu, ""),
          ];
        }),
    );
    distributionId = values.ID ?? distributionId;
    distributionVersion = values.VERSION_ID ?? distributionVersion;
  } catch {
    // Unknown values fail closed in assertSupportedHost.
  }
  return Object.freeze({
    platform: process.platform,
    arch: process.arch,
    release: os.release(),
    distributionId,
    distributionVersion,
    nodeVersion: process.versions.node,
  });
}

/** @param {string} directory */
async function createExclusivePrivateDirectory(directory) {
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (cause) {
    throw new RuntimeQualificationError(
      "UNSAFE_SCHEMA_DIRECTORY",
      "The schema output directory must be a new private directory",
      cause,
    );
  }
  const metadata = await lstat(directory);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    (metadata.mode & 0o7777) !== 0o700
  ) {
    throw new RuntimeQualificationError(
      "UNSAFE_SCHEMA_DIRECTORY",
      "The schema output directory must be a mode-0700 non-symlink directory",
    );
  }
}

/** @param {string} filePath @param {string} label */
async function requireRegularFile(filePath, label) {
  const metadata = await lstat(filePath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new RuntimeQualificationError(
      "UNSAFE_SCHEMA_PATH",
      `${label} must be a regular non-symlink file`,
    );
  }
}

/** @param {string} filePath */
export async function sha256DirectoryManifest(filePath) {
  const metadata = await lstat(filePath);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new TypeError("manifest root must be a non-symlink directory");
  }
  const hash = createHash("sha256");
  /** @type {string[]} */
  const files = [];
  await visit(filePath, "");
  for (const relativePath of files.sort()) {
    hash.update(relativePath, "utf8");
    hash.update("\0", "utf8");
    const contents = await readFile(path.join(filePath, relativePath));
    hash.update(
      relativePath.endsWith(".json")
        ? canonicalJson(JSON.parse(contents.toString("utf8")))
        : contents,
    );
    hash.update("\0", "utf8");
  }
  return hash.digest("hex");

  /** @param {string} directory @param {string} relativeDirectory */
  async function visit(directory, relativeDirectory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = path.join(relativeDirectory, entry.name);
      const absolutePath = path.join(directory, entry.name);
      const entryMetadata = await lstat(absolutePath);
      if (entryMetadata.isSymbolicLink()) {
        throw new RuntimeQualificationError(
          "UNSAFE_SCHEMA_PATH",
          `schema manifest contains a symlink: ${relativePath}`,
        );
      }
      if (entryMetadata.isDirectory()) {
        await visit(absolutePath, relativePath);
      } else if (entryMetadata.isFile()) {
        files.push(relativePath.split(path.sep).join(path.posix.sep));
      }
    }
  }
}

/** @param {unknown} value */
function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object") throw new TypeError("value is not representable as JSON");
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}
