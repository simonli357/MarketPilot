#!/usr/bin/env node
// @ts-check

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PAPER_REGISTRY } from "../src/paper-fixture/registry.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimePython = path.join(root, ".venv-paper", "bin", "python");
const auditPython = path.join(root, ".venv-paper-audit", "bin", "python");
const coreLock = path.join(root, "requirements", "paper-core.lock");
const auditLock = path.join(root, "requirements", "paper-audit.lock");

function run(command, args, { allowStatus = [0] } = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", PYTHONNOUSERSITE: "1" },
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (!allowStatus.includes(result.status ?? -1)) throw new Error(`${command} exited ${result.status}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const packageLock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
assert.deepEqual(Object.keys(packageJson.dependencies).toSorted(), ["@openai/codex", "ajv"]);
assert.equal(packageJson.dependencies.ajv, "8.20.0");
const nodeExpected = new Map([
  ["ajv", ["8.20.0", "MIT"]],
  ["fast-deep-equal", ["3.1.3", "MIT"]],
  ["fast-uri", ["3.1.5", "BSD-3-Clause"]],
  ["json-schema-traverse", ["1.0.0", "MIT"]],
  ["require-from-string", ["2.0.2", "MIT"]],
]);
for (const [name, [version, license]] of nodeExpected) {
  const metadata = JSON.parse(readFileSync(path.join(root, "node_modules", name, "package.json"), "utf8"));
  assert.equal(metadata.version, version, `${name} version`);
  assert.equal(metadata.license, license, `${name} license`);
  const lockedMetadata = packageLock.packages[`node_modules/${name}`];
  assert.equal(lockedMetadata?.version, version, `${name} locked version`);
  assert.match(lockedMetadata?.integrity ?? "", /^sha512-[A-Za-z0-9+/]+={0,2}$/, `${name} lock integrity`);
}
assert.deepEqual(Object.keys(packageLock.packages["node_modules/ajv"].dependencies).toSorted(), ["fast-deep-equal", "fast-uri", "json-schema-traverse", "require-from-string"]);
assert.equal(process.versions.unicode, "17.0", "Node Unicode normalization data");

const pythonExpected = new Map([
  ["attrs", ["26.1.0", "MIT"]],
  ["jsonschema", ["4.26.0", "MIT"]],
  ["jsonschema-specifications", ["2025.9.1", "MIT"]],
  ["referencing", ["0.37.0", "MIT"]],
  ["rpds-py", ["2026.6.3", "MIT"]],
  ["typing-extensions", ["4.16.0", "PSF-2.0"]],
  ["unicodedata2", ["17.0.1", "Apache License 2.0"]],
]);
const lockText = readFileSync(coreLock, "utf8");
const locked = new Map([...lockText.matchAll(/^([a-z0-9-]+)==([^ \\\n]+) \\/gm)].map(match => [match[1], match[2]]));
assert.deepEqual(locked, new Map([...pythonExpected].map(([name, [version]]) => [name, version])), "Python lock graph");
assert.match(lockText, /--hash=sha256:[0-9a-f]{64}/, "Python lock must contain hashes");
assert(existsSync(runtimePython), "run `npm run paper:setup` before auditing");
assert.equal(run(runtimePython, ["-c", "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"]).trim(), "3.12", "paper runtime Python version");
assert.equal(run(runtimePython, ["-c", "import unicodedata2; print(unicodedata2.unidata_version)"]).trim(), "17.0.0", "paper runtime Unicode normalization data");
const metadataProgram = [
  "import json",
  "from importlib.metadata import metadata",
  `names=${JSON.stringify([...pythonExpected.keys()])}`,
  "print(json.dumps([{\"name\": n, \"version\": metadata(n)[\"Version\"], \"license\": metadata(n).get(\"License-Expression\") or metadata(n).get(\"License\")} for n in names], sort_keys=True))",
].join(";");
const installed = JSON.parse(run(runtimePython, ["-c", metadataProgram]));
for (const entry of installed) assert.deepEqual([entry.version, entry.license], pythonExpected.get(entry.name), `${entry.name} installed metadata`);
const inventoryProgram = excluded => `import json,re; from importlib.metadata import distributions; excluded=${JSON.stringify(excluded)}; print(json.dumps(sorted((re.sub(r'[-_.]+','-',d.metadata['Name'].lower()), d.version) for d in distributions() if d.metadata['Name'].lower() not in excluded)))`;
assert.deepEqual(JSON.parse(run(runtimePython, ["-c", inventoryProgram(["pip", "setuptools"]) ])), [...pythonExpected].map(([name, [version]]) => [name, version]).toSorted((left, right) => left[0].localeCompare(right[0])), "Python runtime environment inventory");

const npmAudit = JSON.parse(run("npm", ["audit", "--omit=dev", "--json"]));
assert.equal(npmAudit.metadata.vulnerabilities.total, 0, "npm production dependency vulnerabilities");

if (!existsSync(auditPython)) run(process.execPath, [path.join(root, "scripts", "setup-paper-audit.mjs")]);
assert.equal(run(auditPython, ["-c", "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"]).trim(), "3.12", "paper audit Python version");
const auditLockText = readFileSync(auditLock, "utf8");
const auditLocked = new Map([...auditLockText.matchAll(/^([a-z0-9-]+)==([^ \\\n]+) \\/gm)].map(match => [match[1], match[2]]));
assert.match(auditLockText, /--hash=sha256:[0-9a-f]{64}/, "Python audit lock must contain hashes");
assert.deepEqual(JSON.parse(run(auditPython, ["-c", inventoryProgram(["setuptools"]) ])), [...auditLocked].toSorted((left, right) => left[0].localeCompare(right[0])), "Python audit environment inventory; rerun `node scripts/setup-paper-audit.mjs` when the lock changes");
const pipAuditOutput = run(auditPython, ["-m", "pip_audit", "--require-hashes", "--disable-pip", "--format", "json", "-r", coreLock]);
const pipAudit = JSON.parse(pipAuditOutput);
assert.equal(pipAudit.dependencies.length, pythonExpected.size, "pip audit dependency count");
assert(pipAudit.dependencies.every(entry => Array.isArray(entry.vulns) && entry.vulns.length === 0), "Python runtime graph has a known vulnerability");

assert.equal(PAPER_REGISTRY.schemas.size, 19);
process.stdout.write(JSON.stringify({
  schemaCount: PAPER_REGISTRY.schemas.size,
  nodeDependencies: Object.fromEntries([...nodeExpected].map(([name, [version, license]]) => [name, { version, license }])),
  pythonDependencies: Object.fromEntries([...pythonExpected].map(([name, [version, license]]) => [name, { version, license }])),
  knownVulnerabilities: 0,
  runtimeNetworkAccess: false,
  auditRegistryAccess: true,
  productionState: false,
  audit: "passed",
}) + "\n");
