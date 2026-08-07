#!/usr/bin/env node
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { acceptedFixtureRequest, fixtureRequestBytes, rejectedFixtureRequest } from "../src/paper-fixture/fixtures.mjs";
import { invokePaperAuthority } from "../src/paper-fixture/authority-client.mjs";
import { canonicalJson, DOMAIN_REASON_CODES, PAPER_PROFILE, validateRequestContract, validateResponseContract } from "../src/paper-fixture/contract-validation.mjs";
import { PAPER_REGISTRY } from "../src/paper-fixture/registry.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const registryPath = path.join(root, "contracts/paper-intent/fixture-l1/v1/registry.json");

async function runPythonTests() {
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(root, ".venv-paper", "bin", "python"), ["-m", "unittest", "discover", "-s", "test/paper_python", "-p", "test_authority*.py", "-v"], { cwd: root, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", PYTHONPATH: path.join(root, "src"), PYTHONNOUSERSITE: "1", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" }, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; let error = "";
    child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { error += chunk; });
    child.once("error", reject); child.once("close", code => code === 0 ? resolve({ output, error }) : reject(new Error(`Python focused tests failed (${code})\n${output}\n${error}`)));
  });
}

const registry = JSON.parse(await fs.readFile(registryPath, "utf8"));
assert.equal(registry.profile, PAPER_PROFILE);
assert.equal(PAPER_REGISTRY.schemas.size, 19);
assert.equal(PAPER_REGISTRY.vocabularyVectors.length, 22);
assert.equal(DOMAIN_REASON_CODES.length, 26);
for (const [name, relative] of Object.entries(registry.schemas)) {
  const schema = JSON.parse(await fs.readFile(path.join(path.dirname(registryPath), relative), "utf8"));
  assert.equal(schema.$schema, "urn:marketpilot:paper-intent-fixture:v1:meta", `${name} dialect`);
  assert.match(schema.$id, /^urn:marketpilot:paper-intent-fixture:v1:/, `${name} id`);
  assert.equal(schema.additionalProperties, false, `${name} closed`);
  assert.equal(schema.unevaluatedProperties, false, `${name} unevaluated closed`);
}

const accepted = acceptedFixtureRequest();
const rejected = rejectedFixtureRequest();
const acceptedBefore = canonicalJson(accepted);
const rejectedBefore = canonicalJson(rejected);
validateRequestContract(accepted); validateRequestContract(rejected);
assert.equal(canonicalJson(accepted), acceptedBefore);
assert.equal(canonicalJson(rejected), rejectedBefore);
const acceptedResponse = await invokePaperAuthority({ requestBytes: fixtureRequestBytes(accepted) });
const rejectedResponse = await invokePaperAuthority({ requestBytes: fixtureRequestBytes(rejected) });
validateResponseContract(acceptedResponse, { request: accepted });
validateResponseContract(rejectedResponse, { request: rejected });
assert.equal(acceptedResponse.status, "ACCEPTED");
assert.deepEqual(acceptedResponse.reasonCodes, ["ACCEPTED"]);
assert.equal(acceptedResponse.orderPlan.limitPrice, "99.4950");
assert.equal(acceptedResponse.executionEvent.fillPrice, "99.2500");
assert.equal(acceptedResponse.auditEvents.length, 7);
assert.equal(rejectedResponse.status, "REJECTED");
assert.deepEqual(rejectedResponse.reasonCodes, ["QUANTITY_LIMIT_EXCEEDED", "NOTIONAL_LIMIT_EXCEEDED"]);
assert.equal(rejectedResponse.orderPlan, null);
assert.equal(rejectedResponse.executionEvent, null);
assert.equal(rejectedResponse.auditEvents.length, 5);
await runPythonTests();
process.stdout.write("paper-core checks passed: 19 schemas, 22 vocabulary vectors, 26 domain codes, cross-runtime golden parity, audit verification, and Python focused suites\n");
