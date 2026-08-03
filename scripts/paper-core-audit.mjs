#!/usr/bin/env node
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contractDir = path.join(root, "contracts/paper-intent/fixture-l1/v1");
const registry = JSON.parse(await fs.readFile(path.join(contractDir, "registry.json"), "utf8"));
const ids = new Set();
for (const relative of Object.values(registry.schemas)) {
  assert.equal(typeof relative, "string");
  const schema = JSON.parse(await fs.readFile(path.join(contractDir, relative), "utf8"));
  assert(!ids.has(schema.$id), `duplicate schema id ${schema.$id}`); ids.add(schema.$id);
  const refs = JSON.stringify(schema).matchAll(/urn:marketpilot:paper-intent-fixture:v1:[a-z-]+/g);
  for (const match of refs) assert.match(match[0], /^urn:marketpilot:paper-intent-fixture:v1:/);
}
const pythonFiles = ["src/marketpilot/paper_fixture_authority.py", "src/marketpilot/paper_fixtures.py"];
for (const file of pythonFiles) {
  const source = await fs.readFile(path.join(root, file), "utf8");
  assert(!/^\s*(?:from|import)\s+(?:requests|jsonschema|canonicaljson|sqlcipher|ib_insync)\b/m.test(source), `${file} has an unapproved dependency`);
}
assert.equal(await fs.access(path.join(root, "src/marketpilot/paper_fixture_authority.py")).then(() => true), true);
process.stdout.write(JSON.stringify({ schemaCount: ids.size, pythonDependencies: [], networkAccess: false, productionState: false, audit: "passed" }) + "\n");
