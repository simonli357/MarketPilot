// @ts-check

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  cp,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const workRoot = path.join(root, "artifacts", "work");
const sourceContracts = path.join(root, "contracts", "paper-intent", "fixture-l1", "v1");
const sourceNodeRegistry = path.join(root, "src", "paper-fixture", "registry.mjs");
const sourcePythonRegistry = path.join(root, "src", "marketpilot", "paper_contract_schema.py");
const sourcePythonPackage = path.join(root, "src", "marketpilot", "__init__.py");
const python = path.join(root, ".venv-paper", "bin", "python");
const childTimeoutMs = 15_000;
const childOutputLimit = 65_536;
const rejectedExitCode = 23;

const nodeStartupProbe = [
  "try {",
  "  const loaded = await import(process.env.MARKETPILOT_TEST_REGISTRY_URL);",
  "  if (loaded.PAPER_REGISTRY.schemas.size !== 19) throw new Error('unexpected schema count');",
  "  process.stdout.write('startup-ok\\n');",
  "} catch (error) {",
  "  const envelope = {",
  "    status: 'startup-rejected',",
  "    name: typeof error?.name === 'string' ? error.name : 'Error',",
  "    message: typeof error?.message === 'string' ? error.message : 'startup rejected',",
  "  };",
  "  process.stdout.write(`${JSON.stringify(envelope)}\\n`);",
  `  process.exitCode = ${rejectedExitCode};`,
  "}",
].join("\n");

const pythonStartupProbe = [
  "import json",
  "try:",
  "    from marketpilot import paper_contract_schema as schema",
  "    runtime = schema._runtime()",
  "    if len(runtime.validators) != 19:",
  "        raise RuntimeError('unexpected schema count')",
  "except Exception as error:",
  "    print(json.dumps({",
  "        'status': 'startup-rejected',",
  "        'name': type(error).__name__,",
  "        'message': str(error),",
  "    }, separators=(',', ':')))",
  `    raise SystemExit(${rejectedExitCode})`,
  "print('startup-ok')",
].join("\n");

/** @param {string} mirrorRoot */
function contractDirectory(mirrorRoot) {
  return path.join(mirrorRoot, "contracts", "paper-intent", "fixture-l1", "v1");
}

/** @param {string} mirrorRoot */
async function copyRuntimeMirror(mirrorRoot) {
  const nodeDirectory = path.join(mirrorRoot, "src", "paper-fixture");
  const pythonDirectory = path.join(mirrorRoot, "src", "marketpilot");
  await Promise.all([
    mkdir(nodeDirectory, { recursive: true }),
    mkdir(pythonDirectory, { recursive: true }),
    mkdir(path.dirname(contractDirectory(mirrorRoot)), { recursive: true }),
  ]);
  await Promise.all([
    copyFile(sourceNodeRegistry, path.join(nodeDirectory, "registry.mjs")),
    copyFile(sourcePythonRegistry, path.join(pythonDirectory, "paper_contract_schema.py")),
    copyFile(sourcePythonPackage, path.join(pythonDirectory, "__init__.py")),
    cp(sourceContracts, contractDirectory(mirrorRoot), {
      recursive: true,
      errorOnExist: true,
      force: false,
    }),
  ]);
}

/**
 * @param {string} mirrorRoot
 * @param {string} relative
 */
async function repairInventoryHash(mirrorRoot, relative) {
  const directory = contractDirectory(mirrorRoot);
  const bytes = await readFile(path.join(directory, relative));
  const inventoryPath = path.join(directory, "inventory.json");
  const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
  assert.equal(typeof inventory.files?.[relative], "string", `inventory must contain ${relative}`);
  inventory.files[relative] = createHash("sha256").update(bytes).digest("hex");
  await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`, "utf8");
}

/**
 * @param {string} mirrorRoot
 * @param {string} relative
 * @param {(document: Record<string, any>) => void} mutate
 */
async function mutateInventoriedJson(mirrorRoot, relative, mutate) {
  const target = path.join(contractDirectory(mirrorRoot), relative);
  const document = JSON.parse(await readFile(target, "utf8"));
  mutate(document);
  await writeFile(target, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  await repairInventoryHash(mirrorRoot, relative);
}

/** @param {string} mirrorRoot */
function runNodeStartup(mirrorRoot) {
  const registryUrl = pathToFileURL(path.join(mirrorRoot, "src", "paper-fixture", "registry.mjs")).href;
  return spawnSync(process.execPath, ["--input-type=module", "--eval", nodeStartupProbe], {
    cwd: mirrorRoot,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      MARKETPILOT_TEST_REGISTRY_URL: registryUrl,
    },
    encoding: "utf8",
    timeout: childTimeoutMs,
    maxBuffer: childOutputLimit,
    killSignal: "SIGKILL",
  });
}

/** @param {string} mirrorRoot */
function runPythonStartup(mirrorRoot) {
  return spawnSync(python, ["-c", pythonStartupProbe], {
    cwd: mirrorRoot,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      PYTHONPATH: path.join(mirrorRoot, "src"),
      PYTHONNOUSERSITE: "1",
      PYTHONDONTWRITEBYTECODE: "1",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
    },
    encoding: "utf8",
    timeout: childTimeoutMs,
    maxBuffer: childOutputLimit,
    killSignal: "SIGKILL",
  });
}

/**
 * @param {ReturnType<typeof spawnSync>} result
 * @param {string} runtime
 */
function assertStartupAccepted(result, runtime) {
  assert.ifError(result.error);
  assert.equal(result.signal, null, `${runtime} baseline startup must not be killed`);
  assert.equal(result.status, 0, `${runtime} baseline startup failed: ${result.stderr || result.stdout}`);
  assert.equal(result.stderr, "", `${runtime} baseline startup wrote stderr`);
  assert.equal(result.stdout, "startup-ok\n", `${runtime} baseline startup output drifted`);
}

/**
 * @param {ReturnType<typeof spawnSync>} result
 * @param {string} runtime
 */
function assertStartupRejected(result, runtime) {
  assert.ifError(result.error);
  assert.equal(result.signal, null, `${runtime} rejection must not rely on a signal`);
  assert.equal(result.status, rejectedExitCode, `${runtime} did not reject at startup: ${result.stderr || result.stdout}`);
  assert.equal(result.stderr, "", `${runtime} rejection probe wrote stderr`);
  const lines = result.stdout.trimEnd().split("\n");
  assert.equal(lines.length, 1, `${runtime} rejection must remain one bounded line`);
  const envelope = JSON.parse(lines[0]);
  assert.equal(envelope.status, "startup-rejected");
  assert.equal(typeof envelope.name, "string");
  assert.equal(typeof envelope.message, "string");
  assert.ok(envelope.message.length > 0 && envelope.message.length < 1_024, `${runtime} rejection message must be bounded`);
  assert.doesNotMatch(envelope.message, /MODULE_NOT_FOUND|No module named/u, `${runtime} must reject the contract, not the copied runtime`);
}

/** @type {ReadonlyArray<{id: string, title: string, mutate: (mirrorRoot: string) => Promise<void>}>} */
const mutations = Object.freeze([
  {
    id: "unknown-local-ref",
    title: "unknown local $ref",
    mutate: mirrorRoot => mutateInventoriedJson(mirrorRoot, "fact.schema.json", document => {
      document.properties.value = { $ref: "urn:marketpilot:paper-intent-fixture:v1:not-registered" };
    }),
  },
  {
    id: "https-external-ref",
    title: "HTTPS external $ref",
    mutate: mirrorRoot => mutateInventoriedJson(mirrorRoot, "fact.schema.json", document => {
      document.properties.value = { $ref: "https://example.invalid/marketpilot-schema" };
    }),
  },
  {
    id: "file-external-ref",
    title: "file external $ref",
    mutate: mirrorRoot => mutateInventoriedJson(mirrorRoot, "fact.schema.json", document => {
      document.properties.value = { $ref: "file:///tmp/marketpilot-schema.json" };
    }),
  },
  {
    id: "unknown-custom-keyword",
    title: "unknown mp* vocabulary keyword",
    mutate: mirrorRoot => mutateInventoriedJson(mirrorRoot, "fact.schema.json", document => {
      document.properties.value.mpUnknown = true;
    }),
  },
  {
    id: "unsupported-format",
    title: "unsupported asserted format",
    mutate: mirrorRoot => mutateInventoriedJson(mirrorRoot, "primitives.schema.json", document => {
      document.$defs.UtcTimestamp.format = "email";
    }),
  },
  {
    id: "missing-required-vocabulary",
    title: "missing required vocabulary",
    mutate: mirrorRoot => mutateInventoriedJson(mirrorRoot, "fixture-meta.schema.json", document => {
      delete document.$vocabulary["https://json-schema.org/draft/2020-12/vocab/format-assertion"];
    }),
  },
  {
    id: "uninventoried-byte-tamper",
    title: "tampered byte without an inventory update",
    mutate: async mirrorRoot => {
      const target = path.join(contractDirectory(mirrorRoot), "fact.schema.json");
      const bytes = await readFile(target);
      await writeFile(target, Buffer.concat([bytes, Buffer.from("\n", "utf8")]));
    },
  },
  {
    id: "duplicate-schema-id",
    title: "duplicate schema $id",
    mutate: mirrorRoot => mutateInventoriedJson(mirrorRoot, "fact.schema.json", document => {
      document.$id = "urn:marketpilot:paper-intent-fixture:v1:producer";
    }),
  },
  {
    id: "registry-map-mismatch",
    title: "registry schema-path mismatch",
    mutate: mirrorRoot => mutateInventoriedJson(mirrorRoot, "registry.json", document => {
      document.schemas.Fact = "producer.schema.json";
    }),
  },
]);

test("Node and Python reject every startup registry tamper without retrieval fallback", { timeout: 120_000 }, async t => {
  await mkdir(workRoot, { recursive: true });
  const suiteRoot = await mkdtemp(path.join(workRoot, "paper-registry-startup-"));
  assert.equal(path.dirname(suiteRoot), workRoot);

  try {
    const baselineRoot = path.join(suiteRoot, "baseline");
    await copyRuntimeMirror(baselineRoot);
    assertStartupAccepted(runNodeStartup(baselineRoot), "Node");
    assertStartupAccepted(runPythonStartup(baselineRoot), "Python");
    await rm(baselineRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });

    for (const mutation of mutations) {
      await t.test(mutation.title, async () => {
        const mirrorRoot = path.join(suiteRoot, mutation.id);
        try {
          await copyRuntimeMirror(mirrorRoot);
          await mutation.mutate(mirrorRoot);
          assertStartupRejected(runNodeStartup(mirrorRoot), "Node");
          assertStartupRejected(runPythonStartup(mirrorRoot), "Python");
        } finally {
          await rm(mirrorRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
        }
      });
    }
  } finally {
    await rm(suiteRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  }

  await assert.rejects(stat(suiteRoot), error => error?.code === "ENOENT");
});
