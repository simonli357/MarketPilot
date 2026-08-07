// @ts-check

import assert from "node:assert/strict";
import { constants as fsConstants } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { after, before, test } from "node:test";

import {
  AuthorityAdapterError,
  invokePaperAuthority,
} from "../../src/paper-fixture/authority-client.mjs";
import {
  acceptedFixtureRequest,
  fixtureRequestBytes,
} from "../../src/paper-fixture/fixtures.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FAKE_AUTHORITY = path.join(ROOT, "test", "fixtures", "fake-paper-authority.py");
const WORK_ARTIFACTS = path.join(ROOT, "artifacts", "work");

/** @type {string[]|null} */
let artifactBaseline;

async function artifactInventory() {
  try {
    return (await readdir(WORK_ARTIFACTS, { recursive: true })).sort();
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

function requestBytes(scenario) {
  const request = acceptedFixtureRequest();
  request.requestId = `req_transport_${scenario}`;
  return fixtureRequestBytes(request);
}

before(async () => {
  await access(FAKE_AUTHORITY, fsConstants.X_OK);
  artifactBaseline = await artifactInventory();
});

after(async () => {
  assert.deepEqual(
    await artifactInventory(),
    artifactBaseline,
    "hostile authority outcomes must not persist work artifacts",
  );
});

const CASES = Object.freeze([
  ["timeout", "AUTHORITY_TIMEOUT", "Python authority exceeded its deadline", 100],
  ["stdout_limit", "AUTHORITY_OUTPUT_INVALID", "Python authority exceeded the bounded output"],
  ["stderr_limit", "AUTHORITY_OUTPUT_INVALID", "Python authority exceeded the bounded output"],
  ["stderr", "AUTHORITY_PROCESS_FAILED", "Python authority wrote unexpected stderr"],
  ["internal_exit", "AUTHORITY_PROCESS_FAILED", "Python authority returned an internal failure"],
  ["signal", "AUTHORITY_PROCESS_FAILED", "Python authority returned an internal failure"],
  ["malformed_json", "AUTHORITY_OUTPUT_INVALID", "Python authority returned invalid JSON"],
  ["empty_output", "AUTHORITY_OUTPUT_INVALID", "Python authority framing is invalid"],
  ["missing_lf", "AUTHORITY_OUTPUT_INVALID", "Python authority framing is invalid"],
  ["extra_line", "AUTHORITY_OUTPUT_INVALID", "Python authority framing is invalid"],
  ["protocol_error", "AUTHORITY_INPUT_ERROR", "Python rejected the authority request contract"],
  ["forged_protocol", "AUTHORITY_OUTPUT_INVALID", "Python authority protocol envelope is invalid"],
  ["forged_hash", "AUTHORITY_OUTPUT_INVALID", "Python authority protocol envelope is invalid"],
]);

test("authority timeout overrides cannot exceed the frozen two-second cap", async () => {
  await assert.rejects(
    invokePaperAuthority({
      requestBytes: requestBytes("timeout"),
      python: FAKE_AUTHORITY,
      timeoutMs: 2_001,
    }),
    error => {
      assert.ok(error instanceof TypeError);
      assert.equal(error.message, "timeoutMs must be an integer from 1 through 2000");
      return true;
    },
  );
});

test("the Node adapter fails closed for every hostile process-envelope outcome", async t => {
  for (const [scenario, expectedCode, expectedMessage, timeoutMs = 1_000] of CASES) {
    await t.test(scenario, async () => {
      await assert.rejects(
        invokePaperAuthority({
          requestBytes: requestBytes(scenario),
          python: FAKE_AUTHORITY,
          timeoutMs,
        }),
        error => {
          assert.ok(error instanceof AuthorityAdapterError);
          assert.equal(error.code, expectedCode);
          assert.equal(error.message, expectedMessage);
          assert.deepEqual(Object.keys(error).sort(), ["code", "name"]);
          for (const key of ["artifacts", "request", "response", "stderr", "stdout"]) {
            assert.equal(key in error, false, `adapter error must not expose ${key}`);
          }
          assert.doesNotMatch(
            `${error.code}:${error.message}`,
            /req_transport|untrusted child detail|fake-paper-authority|\/home\//,
          );
          return true;
        },
      );
    });
  }
});
