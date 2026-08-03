#!/usr/bin/env node
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { acceptedFixtureRequest, fixtureRequestBytes, rejectedFixtureRequest } from "../src/paper-fixture/fixtures.mjs";
import { invokePaperAuthority } from "../src/paper-fixture/authority-client.mjs";
import { canonicalJson, PAPER_PROFILE, validateRequestContract, validateResponseContract } from "../src/paper-fixture/contract-validation.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const registryPath = path.join(root, "contracts/paper-intent/fixture-l1/v1/registry.json");

async function runPythonTests() {
  return new Promise((resolve, reject) => {
    const child = spawn("python3.12", ["-m", "unittest", "discover", "-s", "test/paper_python", "-v"], { cwd: root, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", PYTHONPATH: path.join(root, "src"), PYTHONNOUSERSITE: "1", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" }, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; let error = "";
    child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { error += chunk; });
    child.once("error", reject); child.once("close", code => code === 0 ? resolve({ output, error }) : reject(new Error(`Python focused tests failed (${code})\n${output}\n${error}`)));
  });
}

const registry = JSON.parse(await fs.readFile(registryPath, "utf8"));
assert.equal(registry.profile, PAPER_PROFILE);
for (const [name, relative] of Object.entries(registry.schemas)) {
  const schema = JSON.parse(await fs.readFile(path.join(path.dirname(registryPath), relative), "utf8"));
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema", `${name} draft`);
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
const [acceptedResponse, rejectedResponse] = await Promise.all([
  invokePaperAuthority({ requestBytes: fixtureRequestBytes(accepted) }),
  invokePaperAuthority({ requestBytes: fixtureRequestBytes(rejected) }),
]);
validateResponseContract(acceptedResponse); validateResponseContract(rejectedResponse);
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
process.stdout.write("paper-core checks passed: registry, cross-runtime golden parity, audit verification, and Python focused suite\n");
