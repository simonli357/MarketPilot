#!/usr/bin/env node
// @ts-check

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { runAuthenticatedSmoke } from "../src/codex/authenticated-smoke.mjs";
import { acceptedFixtureRequest } from "../src/paper-fixture/fixtures.mjs";
import {
  createHostedPaperSessionFactory,
  preparePaperAgentRuntime,
  qualifyPaperAgentRuntime,
  runPaperAgentSlice,
} from "../src/paper-fixture/paper-agent-slice.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Opt-in real manager/critic walkthrough. Login is delegated to the already
 * qualified WI-001 browser/keyring flow; no API token or custom fixture input
 * is accepted. The printed report contains only typed statuses and IDs/hashes.
 */
export async function runHostedPaperSlice({ login = false, sourceEnv = process.env, stdout = process.stdout } = {}) {
  let smoke = null;
  if (login) {
    smoke = await runAuthenticatedSmoke({ projectRoot: PROJECT_ROOT, login: true, sourceEnv, turnTimeoutMs: 300_000 });
    if (smoke.status !== "passed") {
      stdout.write(`${JSON.stringify({ schemaVersion: 1, mode: "paper-agent-hosted", status: "failed", failure: { code: "AUTHENTICATED_RUNTIME_NOT_PROVEN" }, smokeStatus: smoke.status }, null, 2)}\n`);
      return 1;
    }
  }

  let prepared = null;
  try {
    prepared = await preparePaperAgentRuntime({ projectRoot: PROJECT_ROOT, sourceEnv });
    const qualification = await qualifyPaperAgentRuntime({ projectRoot: PROJECT_ROOT, prepared, requestTimeoutMs: 120_000 });
    const createSession = createHostedPaperSessionFactory({ projectRoot: PROJECT_ROOT, prepared, qualification, requestTimeoutMs: 120_000 });
    const reports = [];
    for (const scenario of ["accepted", "rejected"]) {
      const report = await runPaperAgentSlice({ request: acceptedFixtureRequest(), scenario, createSession, turnTimeoutMs: 300_000, authorityTimeoutMs: 2_000 });
      reports.push(redactedReport(report));
    }
    const passed = reports.every((report) => (report.scenario === "accepted" && report.status === "ACCEPTED" && report.planId !== null) || (report.scenario === "rejected" && report.status === "REJECTED" && report.planId === null));
    stdout.write(`${JSON.stringify({ schemaVersion: 1, mode: "paper-agent-hosted", status: passed ? "passed" : "failed", smokeStatus: smoke?.status ?? "reused-keyring", reports }, null, 2)}\n`);
    return passed ? 0 : 1;
  } catch (error) {
    stdout.write(`${JSON.stringify({ schemaVersion: 1, mode: "paper-agent-hosted", status: "failed", failure: { code: safeCode(error, "HOSTED_PAPER_SLICE_FAILED") }, smokeStatus: smoke?.status ?? "reused-keyring" }, null, 2)}\n`);
    return 1;
  } finally {
    try { await prepared?.releaseRuntime?.(); } catch { /* fail closed in report above */ }
  }
}

/** @param {any} report */
function redactedReport(report) {
  return {
    scenario: report.scenario,
    status: report.status,
    exposure: report.exposure,
    failure: report.failure ?? null,
    managerRunId: report.manager?.runId ?? null,
    criticRunId: report.critic?.runId ?? null,
    primaryReasonCode: report.authority?.primaryReasonCode ?? null,
    reasonCodes: report.authority?.reasonCodes ?? [],
    planId: report.authority?.planId ?? null,
    executionId: report.authority?.executionId ?? null,
    responseHash: report.authority?.responseHash ?? null,
    auditEventCount: report.authority?.auditEventCount ?? 0,
  };
}

function safeCode(error, fallback) {
  const value = error && typeof error === "object" ? error.code : undefined;
  return typeof value === "string" && /^[A-Z0-9_]{1,80}$/u.test(value) ? value : fallback;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    process.stdout.write("Usage: npm run paper:agent-hosted [-- --login]\nRuns the real manager/critic only against the committed public fixture.\n");
    process.exitCode = 0;
  } else if (args.some((arg) => arg !== "--login")) {
    process.stdout.write(JSON.stringify({ schemaVersion: 1, mode: "paper-agent-hosted", status: "failed", failure: { code: "INVALID_ARGUMENT" } }) + "\n");
    process.exitCode = 1;
  } else {
    process.exitCode = await runHostedPaperSlice({ login: args.includes("--login") });
  }
}
