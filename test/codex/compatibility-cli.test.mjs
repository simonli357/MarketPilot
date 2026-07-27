// @ts-check

import assert from "node:assert/strict";
import { lstat } from "node:fs/promises";
import test from "node:test";

import {
  CompatibilityProbeError,
} from "../../src/codex/compatibility-probe.mjs";
import { RuntimeQualificationError } from "../../src/codex/runtime-qualification.mjs";
import {
  parseArguments,
  runCompatibilityCli,
} from "../../scripts/codex-compatibility.mjs";

test("compatibility CLI arguments are exact and bounded", () => {
  assert.deepEqual(parseArguments([]), { help: false, requestTimeoutMs: 15_000 });
  assert.deepEqual(parseArguments(["--timeout-ms", "30000"]), {
    help: false,
    requestTimeoutMs: 30_000,
  });
  assert.deepEqual(parseArguments(["--help"]), { help: true, requestTimeoutMs: 15_000 });
  assert.throws(() => parseArguments(["--timeout-ms", "999"]), /must be an integer/u);
  assert.throws(() => parseArguments(["--timeout-ms", "1000", "--timeout-ms", "2000"]), /only once/u);
  assert.throws(() => parseArguments(["--help", "--timeout-ms", "1000"]), /cannot be combined/u);
  assert.throws(() => parseArguments(["--unknown"]), /unsupported argument/u);
});

test("compatibility CLI never reflects a secret-shaped unsupported argument", async () => {
  const secret = "sk-this-must-not-appear-in-cli-evidence";
  let emitted = "";

  const exitCode = await runCompatibilityCli({
    argv: [`--api-key=${secret}`],
    stdout: { write: (value) => (emitted += String(value), true) },
  });

  const report = JSON.parse(emitted);
  assert.equal(exitCode, 1);
  assert.equal(report.error.code, "INVALID_ARGUMENT");
  assert.match(report.error.message, /tokens and custom input are not accepted/u);
  assert.doesNotMatch(emitted, /this-must-not-appear-in-cli-evidence/u);
});

test("compatibility CLI removes its private runtime before emitting success", async () => {
  let runtimePath;
  let emitted = "";
  const exitCode = await runCompatibilityCli({
    argv: ["--timeout-ms", "1000"],
    stdout: { write: (value) => (emitted += String(value), true) },
    runProbe: async ({ baseDir, requestTimeoutMs }) => {
      runtimePath = baseDir;
      assert.equal((await lstat(baseDir)).mode & 0o7777, 0o700);
      assert.equal(requestTimeoutMs, 1_000);
      return { schemaVersion: 1, mode: "automated-metadata", passed: true };
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(JSON.parse(emitted).passed, true);
  await assert.rejects(lstat(runtimePath), (error) => error?.code === "ENOENT");
});

test("compatibility CLI redacts typed failures and exits nonzero", async () => {
  let emitted = "";
  const projectRoot = process.cwd();
  const exitCode = await runCompatibilityCli({
    projectRoot,
    stdout: { write: (value) => (emitted += String(value), true) },
    runProbe: async () => {
      throw new CompatibilityProbeError(
        "FIXTURE_FAILURE",
        `failure under ${projectRoot}/private for person@example.com`,
      );
    },
  });

  const report = JSON.parse(emitted);
  assert.equal(exitCode, 1);
  assert.equal(report.passed, false);
  assert.equal(report.error.code, "FIXTURE_FAILURE");
  assert.match(report.error.message, /<project>\/private/u);
  assert.match(report.error.message, /<email>/u);
  assert.doesNotMatch(report.error.message, /person@example\.com|\/private$/u);
});

test("compatibility CLI preserves safe qualification codes without reflecting details", async () => {
  let emitted = "";
  const exitCode = await runCompatibilityCli({
    stdout: { write: (value) => (emitted += String(value), true) },
    runProbe: async () => {
      throw new RuntimeQualificationError(
        "SCHEMA_MISMATCH",
        "Authorization: Bearer qualification-secret /attacker/state/path",
      );
    },
  });

  const report = JSON.parse(emitted);
  assert.equal(exitCode, 1);
  assert.equal(report.error.code, "SCHEMA_MISMATCH");
  assert.match(report.error.message, /committed qualification contract/u);
  assert.doesNotMatch(emitted, /qualification-secret|attacker\/state/u);
});
