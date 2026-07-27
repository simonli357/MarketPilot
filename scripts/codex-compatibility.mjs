#!/usr/bin/env node
// @ts-check

import { chmod, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  CompatibilityProbeError,
  createDiagnosticRedactor,
  runAutomatedCompatibilityProbe,
} from "../src/codex/compatibility-probe.mjs";
import { RuntimeQualificationError } from "../src/codex/runtime-qualification.mjs";

const DEFAULT_TIMEOUT_MS = 15_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Run the credential-free WI-001 probe. The temporary Codex home is removed
 * before any report is emitted, so a passing invocation also proves cleanup.
 *
 * @param {{
 *   argv?: readonly string[],
 *   stdout?: Pick<NodeJS.WriteStream, "write">,
 *   projectRoot?: string,
 *   runProbe?: typeof runAutomatedCompatibilityProbe,
 * }} [options]
 */
export async function runCompatibilityCli({
  argv = process.argv.slice(2),
  stdout = process.stdout,
  projectRoot = PROJECT_ROOT,
  runProbe = runAutomatedCompatibilityProbe,
} = {}) {
  let parsed;
  try {
    parsed = parseArguments(argv);
  } catch (error) {
    stdout.write(`${JSON.stringify(errorReport(error, (value) => String(value)), null, 2)}\n`);
    return 1;
  }

  if (parsed.help) {
    stdout.write(helpText());
    return 0;
  }

  let baseDir;
  let report;
  let failure;
  try {
    baseDir = await mkdtemp(path.join(os.tmpdir(), "marketpilot-codex-probe-"));
    await chmod(baseDir, 0o700);
    const redactor = createDiagnosticRedactor({ runtimeRoot: baseDir, projectRoot });
    try {
      const candidate = await runProbe({
        projectRoot,
        baseDir,
        requestTimeoutMs: parsed.requestTimeoutMs,
      });
      if (
        candidate === null ||
        typeof candidate !== "object" ||
        Array.isArray(candidate) ||
        typeof candidate.passed !== "boolean"
      ) {
        throw new CompatibilityProbeError(
          "INVALID_PROBE_REPORT",
          "the compatibility probe returned an invalid report",
        );
      }
      report = candidate;
    } catch (error) {
      failure = errorReport(error, redactor);
    }
  } catch (error) {
    failure = errorReport(error, createDiagnosticRedactor({
      runtimeRoot: os.tmpdir(),
      projectRoot,
    }));
  } finally {
    if (baseDir !== undefined) {
      try {
        await rm(baseDir, { recursive: true, force: true, maxRetries: 2 });
      } catch (error) {
        failure = errorReport(
          new CompatibilityProbeError(
            "RUNTIME_CLEANUP_FAILED",
            "the private compatibility runtime could not be removed",
            error,
          ),
          createDiagnosticRedactor({ runtimeRoot: baseDir, projectRoot }),
        );
        report = undefined;
      }
    }
  }

  const output = failure ?? report;
  if (output === undefined) throw new Error("compatibility CLI reached an impossible empty result");
  stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  return "passed" in output && output.passed === true ? 0 : 1;
}

/** @param {readonly string[]} argv */
export function parseArguments(argv) {
  let help = false;
  let requestTimeoutMs = DEFAULT_TIMEOUT_MS;
  let timeoutSeen = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (argument === "--timeout-ms") {
      if (timeoutSeen) throw invalidArgument("--timeout-ms may be supplied only once");
      timeoutSeen = true;
      const raw = argv[index + 1];
      if (raw === undefined) throw invalidArgument("--timeout-ms requires an integer value");
      index += 1;
      const value = Number(raw);
      if (!Number.isSafeInteger(value) || value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) {
        throw invalidArgument(
          `--timeout-ms must be an integer from ${MIN_TIMEOUT_MS} through ${MAX_TIMEOUT_MS}`,
        );
      }
      requestTimeoutMs = value;
      continue;
    }
    // Never reflect an unsupported argument: it may itself contain a token or
    // other credential pasted into the wrong command.
    throw invalidArgument("unsupported argument; tokens and custom input are not accepted");
  }

  if (help && argv.some((argument) => argument !== "--help" && argument !== "-h")) {
    throw invalidArgument("--help cannot be combined with probe options");
  }
  return Object.freeze({ help, requestTimeoutMs });
}

/** @param {string} message */
function invalidArgument(message) {
  return new CompatibilityProbeError("INVALID_ARGUMENT", message);
}

/** @param {unknown} error @param {(value: string) => string} redact */
function errorReport(error, redact) {
  const safeQualificationCodes = new Set([
    "BINARY_DIGEST_MISMATCH",
    "EXECUTABLE_CHANGED",
    "HOST_MISMATCH",
    "INVALID_QUALIFICATION",
    "PACKAGE_MISMATCH",
    "QUALIFICATION_EXECUTION_FAILED",
    "SCHEMA_MISMATCH",
    "UNSAFE_EXECUTABLE",
    "UNSAFE_SCHEMA_DIRECTORY",
    "UNSAFE_SCHEMA_PATH",
    "VERSION_MISMATCH",
  ]);
  const qualifiedCode = error instanceof RuntimeQualificationError &&
    safeQualificationCodes.has(error.code)
    ? error.code
    : undefined;
  const code = error instanceof CompatibilityProbeError
    ? error.code
    : qualifiedCode ?? "COMPATIBILITY_PROBE_FAILED";
  const message = error instanceof RuntimeQualificationError
    ? "The packaged Codex runtime did not satisfy the committed qualification contract."
    : redact(error instanceof Error ? error.message : String(error));
  return Object.freeze({
    schemaVersion: 1,
    mode: "automated-metadata",
    passed: false,
    completedAt: new Date().toISOString(),
    error: { code, message },
  });
}

function helpText() {
  return [
    "Usage: npm run codex:compatibility -- [--timeout-ms N]",
    "",
    "Runs the credential-free WI-001 metadata/configuration probe against the",
    "exact packaged Codex app-server. It never logs in or starts a model turn.",
    "The JSON report is written to stdout and the private runtime is removed.",
    "",
  ].join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCompatibilityCli();
}
