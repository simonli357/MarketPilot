#!/usr/bin/env node
// @ts-check

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  AuthenticatedSmokeError,
  parseAuthenticatedSmokeArguments,
  runAuthenticatedSmoke,
} from "../src/codex/authenticated-smoke.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * @param {{
 *   argv?: readonly string[],
 *   stdout?: Pick<NodeJS.WriteStream, "write">,
 *   projectRoot?: string,
 *   sourceEnv?: NodeJS.ProcessEnv,
 *   signal?: AbortSignal,
 *   runSmoke?: typeof runAuthenticatedSmoke,
 * }} [options]
 */
export async function runAuthenticatedSmokeCli({
  argv = process.argv.slice(2),
  stdout = process.stdout,
  projectRoot = PROJECT_ROOT,
  sourceEnv = process.env,
  signal,
  runSmoke = runAuthenticatedSmoke,
} = {}) {
  let parsed;
  try {
    parsed = parseAuthenticatedSmokeArguments(argv);
  } catch (error) {
    stdout.write(`${JSON.stringify(argumentFailureReport(error), null, 2)}\n`);
    return 1;
  }

  if (parsed.help) {
    stdout.write(helpText());
    return 0;
  }

  let report;
  try {
    report = await runSmoke({
      projectRoot,
      login: parsed.login,
      requestTimeoutMs: parsed.requestTimeoutMs,
      loginTimeoutMs: parsed.loginTimeoutMs,
      sourceEnv,
      signal,
    });
    assertReport(report);
  } catch (error) {
    report = executionFailureReport(error);
  }
  stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report.status === "passed" ? 0 : report.status === "incomplete" ? 2 : 1;
}

/** @param {unknown} error */
function argumentFailureReport(error) {
  return Object.freeze({
    schemaVersion: 1,
    mode: "authenticated-manual",
    status: "failed",
    automatedCorePassed: false,
    completedAt: new Date().toISOString(),
    failure: { code: safeCode(error, "INVALID_ARGUMENT") },
    checks: [{
      id: "cli-arguments",
      status: "failed",
      detail: "Arguments were rejected; API tokens and custom fixture input are unsupported.",
    }],
  });
}

/** @param {unknown} error */
function executionFailureReport(error) {
  return Object.freeze({
    schemaVersion: 1,
    mode: "authenticated-manual",
    status: "failed",
    automatedCorePassed: false,
    completedAt: new Date().toISOString(),
    failure: { code: safeCode(error, "AUTHENTICATED_SMOKE_FAILED") },
    checks: [{
      id: "smoke-execution",
      status: "failed",
      detail: "The authenticated smoke failed closed before producing its checklist.",
    }],
  });
}

/** @param {unknown} value */
function assertReport(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !["passed", "failed", "incomplete"].includes(Reflect.get(value, "status")) ||
    !Array.isArray(Reflect.get(value, "checks"))
  ) {
    throw new AuthenticatedSmokeError(
      "INVALID_SMOKE_REPORT",
      "Authenticated smoke returned an invalid report",
    );
  }
}

/** @param {unknown} error @param {string} fallback */
function safeCode(error, fallback) {
  const candidate = error && typeof error === "object" ? Reflect.get(error, "code") : undefined;
  return typeof candidate === "string" && /^[A-Z0-9_]{1,80}$/u.test(candidate)
    ? candidate
    : fallback;
}

function helpText() {
  return [
    "Usage: node scripts/codex-authenticated-smoke.mjs [--login] [--timeout-ms N] [--login-timeout-ms N]",
    "",
    "Runs the opt-in WI-001 browser/keyring and public-fixture structured-turn smoke.",
    "--login is the only operation that may open a browser. API tokens, custom",
    "prompts, and non-public fixture input are never accepted. Output is a",
    "redacted JSON checklist; unresolved manual checks remain incomplete.",
    "",
  ].join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController();
  const onSignal = () => controller.abort(new Error("operator interruption"));
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    process.exitCode = await runAuthenticatedSmokeCli({ signal: controller.signal });
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}
