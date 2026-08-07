// @ts-check

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";

import Ajv2020 from "ajv/dist/2020.js";

const PROFILE = "marketpilot.paper-intent-fixture.v1";
const META_ID = "urn:marketpilot:paper-intent-fixture:v1:meta";
const VOCABULARY_ID = "urn:marketpilot:paper-intent-fixture:v1:vocabulary";
const SCHEMA_ID_PREFIX = "urn:marketpilot:paper-intent-fixture:v1:";
const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";

const REQUIRED_VOCABULARIES = new Set([
  "https://json-schema.org/draft/2020-12/vocab/core",
  "https://json-schema.org/draft/2020-12/vocab/applicator",
  "https://json-schema.org/draft/2020-12/vocab/validation",
  "https://json-schema.org/draft/2020-12/vocab/format-assertion",
  VOCABULARY_ID,
]);
const SUPPORTED_VOCABULARIES = new Set([
  ...REQUIRED_VOCABULARIES,
  "https://json-schema.org/draft/2020-12/vocab/unevaluated",
  "https://json-schema.org/draft/2020-12/vocab/meta-data",
  "https://json-schema.org/draft/2020-12/vocab/format-annotation",
  "https://json-schema.org/draft/2020-12/vocab/content",
]);
const OFFICIAL_META_REFERENCES = new Set([
  "https://json-schema.org/draft/2020-12/meta/core",
  "https://json-schema.org/draft/2020-12/meta/applicator",
  "https://json-schema.org/draft/2020-12/meta/unevaluated",
  "https://json-schema.org/draft/2020-12/meta/validation",
  "https://json-schema.org/draft/2020-12/meta/meta-data",
  "https://json-schema.org/draft/2020-12/meta/format-annotation",
  "https://json-schema.org/draft/2020-12/meta/format-assertion",
  "https://json-schema.org/draft/2020-12/meta/content",
]);
const FORMAT_ASSERTION_META_SCHEMA = Object.freeze({
  $schema: DRAFT_2020_12,
  $id: "https://json-schema.org/draft/2020-12/meta/format-assertion",
  $dynamicAnchor: "meta",
  type: ["object", "boolean"],
  properties: { format: { type: "string" } },
});
const CONTRACT_FILE_LIMIT = 1_048_576;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const EXPECTED_RULES = Object.freeze({
  maxObjectBytes: 131_072,
  maxCollectionItems: 16,
  maxReasonCodes: 26,
  maxTextScalars: 1_024,
  unicodeVersion: "17.0",
  timestamp: "YYYY-MM-DDTHH:MM:SS.mmmZ",
});

const EXPECTED_SCHEMAS = Object.freeze({
  Primitives: ["primitives.schema.json", "primitives"],
  Producer: ["producer.schema.json", "producer"],
  Fact: ["fact.schema.json", "fact"],
  Provenance: ["provenance.schema.json", "provenance"],
  Policy: ["policy.schema.json", "policy"],
  ResearchEvent: ["research-event.schema.json", "research-event"],
  CandidateManifest: ["candidate-manifest.schema.json", "candidate-manifest"],
  ManagerSemanticDraft: ["manager-semantic-draft.schema.json", "manager-semantic-draft"],
  TradeIntent: ["trade-intent.schema.json", "trade-intent"],
  CriticSemanticDraft: ["critic-semantic-draft.schema.json", "critic-semantic-draft"],
  CriticVerdict: ["critic-verdict.schema.json", "critic-verdict"],
  GateDecision: ["gate-decision.schema.json", "gate-decision"],
  OrderPlan: ["order-plan.schema.json", "order-plan"],
  ExecutionEvent: ["execution-event.schema.json", "execution-event"],
  AuditEvent: ["audit-event.schema.json", "audit-event"],
  AppIncidentEvent: ["app-incident-event.schema.json", "app-incident-event"],
  FixtureAuthorityRequest: ["authority-request.schema.json", "authority-request"],
  FixtureAuthorityResponse: ["authority-response.schema.json", "authority-response"],
  ProtocolError: ["protocol-error.schema.json", "protocol-error"],
});

const SUPPORT_FILES = Object.freeze([
  "registry.json",
  "fixture-meta.schema.json",
  "custom-vocabulary-vectors.json",
]);

const registryDirectory = realpathSync(path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "contracts",
  "paper-intent",
  "fixture-l1",
  "v1",
));

export class PaperSchemaValidationError extends Error {
  /**
   * @param {"PAPER_SCHEMA_UNKNOWN"|"PAPER_SCHEMA_INVALID"} code
   * @param {string} message
   * @param {{schemaName?: string|null, issues?: ReadonlyArray<Record<string, string>>}} [options]
   */
  constructor(code, message, { schemaName = null, issues = [] } = {}) {
    super(message);
    this.name = "PaperSchemaValidationError";
    this.code = code;
    this.schemaName = schemaName;
    this.issues = Object.freeze(issues.map((issue) => Object.freeze({ ...issue })));
  }
}

function registryFailure(message) {
  throw new Error(`paper fixture registry invalid: ${message}`);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected, label) {
  if (!isRecord(value)) registryFailure(`${label} must be an object`);
  const actual = Object.keys(value).toSorted();
  const wanted = [...expected].toSorted();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    registryFailure(`${label} keys do not match the frozen contract`);
  }
}

function readRegularFile(relative) {
  if (typeof relative !== "string" || relative.length === 0 || path.isAbsolute(relative) || path.basename(relative) !== relative) {
    registryFailure(`non-local file path ${String(relative)}`);
  }
  const absolute = path.join(registryDirectory, relative);
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || path.dirname(realpathSync(absolute)) !== registryDirectory) {
    registryFailure(`file is not a local regular file: ${relative}`);
  }
  if (stat.size > CONTRACT_FILE_LIMIT) registryFailure(`file is too large: ${relative}`);
  return readFileSync(absolute);
}

function parseJsonFile(relative, bytes = readRegularFile(relative)) {
  try {
    const text = UTF8_DECODER.decode(bytes);
    if (text.startsWith("\ufeff")) registryFailure(`${relative} contains a BOM`);
    return parseJsonNoDuplicates(text);
  } catch {
    registryFailure(`${relative} is not valid JSON`);
  }
}

function parseJsonNoDuplicates(text) {
  let index = 0;
  const peek = () => text[index];
  const whitespace = () => { while (/[ \t\n\r]/u.test(peek() ?? "")) index += 1; };
  const parseString = () => {
    if (peek() !== '"') throw new SyntaxError("string expected");
    const start = index;
    index += 1;
    while (index < text.length) {
      const character = text[index++];
      if (character === "\\") index += 1;
      else if (character === '"') return JSON.parse(text.slice(start, index));
    }
    throw new SyntaxError("unterminated string");
  };
  const parseValue = () => {
    whitespace();
    const character = peek();
    if (character === '"') return parseString();
    if (character === "{") {
      index += 1;
      const result = {};
      const keys = new Set();
      whitespace();
      if (peek() === "}") { index += 1; return result; }
      while (true) {
        whitespace();
        const key = parseString();
        if (keys.has(key)) throw new SyntaxError("duplicate key");
        keys.add(key);
        whitespace();
        if (peek() !== ":") throw new SyntaxError("colon expected");
        index += 1;
        result[key] = parseValue();
        whitespace();
        if (peek() === "}") { index += 1; return result; }
        if (peek() !== ",") throw new SyntaxError("comma expected");
        index += 1;
      }
    }
    if (character === "[") {
      index += 1;
      const result = [];
      whitespace();
      if (peek() === "]") { index += 1; return result; }
      while (true) {
        result.push(parseValue());
        whitespace();
        if (peek() === "]") { index += 1; return result; }
        if (peek() !== ",") throw new SyntaxError("comma expected");
        index += 1;
      }
    }
    const match = text.slice(index).match(/^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/u);
    if (!match) throw new SyntaxError("value expected");
    index += match[0].length;
    return JSON.parse(match[0]);
  };
  const result = parseValue();
  whitespace();
  if (index !== text.length) throw new SyntaxError("trailing content");
  return result;
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function verifyInventory() {
  const inventory = parseJsonFile("inventory.json");
  exactKeys(inventory, ["schemaVersion", "algorithm", "files"], "inventory");
  if (inventory.schemaVersion !== 1 || inventory.algorithm !== "sha256" || !isRecord(inventory.files)) {
    registryFailure("inventory identity is invalid");
  }
  const expectedFiles = [
    ...SUPPORT_FILES,
    ...Object.values(EXPECTED_SCHEMAS).map(([relative]) => relative),
  ];
  exactKeys(inventory.files, expectedFiles, "inventory.files");
  const bytesByFile = new Map();
  for (const relative of expectedFiles) {
    const expectedDigest = inventory.files[relative];
    if (typeof expectedDigest !== "string" || !/^[0-9a-f]{64}$/.test(expectedDigest)) {
      registryFailure(`inventory digest is invalid for ${relative}`);
    }
    const bytes = readRegularFile(relative);
    if (digest(bytes) !== expectedDigest) registryFailure(`inventory digest mismatch for ${relative}`);
    bytesByFile.set(relative, bytes);
  }
  return { inventory, bytesByFile };
}

function visitSchema(value, callback) {
  if (Array.isArray(value)) {
    for (const item of value) visitSchema(item, callback);
    return;
  }
  if (!isRecord(value)) return;
  callback(value);
  for (const item of Object.values(value)) visitSchema(item, callback);
}

function baseReference(reference) {
  const index = reference.indexOf("#");
  return index === -1 ? reference : reference.slice(0, index);
}

function assertLocalReferences(schema, knownIds, label) {
  visitSchema(schema, (node) => {
    for (const keyword of ["$ref", "$dynamicRef"]) {
      if (!Object.hasOwn(node, keyword)) continue;
      const reference = node[keyword];
      if (typeof reference === "string" && reference.startsWith("#")) continue;
      const target = typeof reference === "string" ? baseReference(reference) : null;
      if (!knownIds.has(target)) {
        registryFailure(`${label} contains a non-local or unknown ${keyword}`);
      }
    }
  });
}

function schemaReferences(schema) {
  const result = new Set();
  visitSchema(schema, (node) => {
    for (const keyword of ["$ref", "$dynamicRef"]) {
      if (typeof node[keyword] === "string") result.add(node[keyword]);
    }
  });
  return result;
}

function assertOnlyDateTimeFormat(schema, label) {
  visitSchema(schema, (node) => {
    if (Object.hasOwn(node, "format") && node.format !== "date-time") {
      registryFailure(`${label} uses an unsupported format`);
    }
  });
}

function isUnicodeScalarString(value) {
  if (typeof value !== "string") return false;
  for (let index = 0; index < value.length; index += 1) {
    const first = value.charCodeAt(index);
    if (first >= 0xd800 && first <= 0xdbff) {
      const second = value.charCodeAt(index + 1);
      if (!(second >= 0xdc00 && second <= 0xdfff)) return false;
      index += 1;
    } else if (first >= 0xdc00 && first <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function scalarLength(value) {
  return isUnicodeScalarString(value) ? Array.from(value).length : -1;
}

function compareUnicodeScalars(left, right) {
  const a = Array.from(left, (character) => character.codePointAt(0));
  const b = Array.from(right, (character) => character.codePointAt(0));
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index] < b[index]) return -1;
    if (a[index] > b[index]) return 1;
  }
  return Math.sign(a.length - b.length);
}

function validProfileDateTime(value) {
  if (typeof value !== "string") return true;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.\d{3}Z$/u);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (year < 1 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [0, 31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= days[month];
}

function addMarketPilotVocabulary(ajv) {
  ajv.addKeyword({
    keyword: "mpNfc",
    schemaType: "boolean",
    type: "string",
    modifying: false,
    errors: false,
    compile(enabled) {
      return (value) => !enabled || (isUnicodeScalarString(value) && value.normalize("NFC") === value);
    },
  });
  ajv.addKeyword({
    keyword: "mpScalarLength",
    schemaType: "object",
    type: "string",
    modifying: false,
    errors: false,
    metaSchema: {
      type: "object",
      additionalProperties: false,
      required: ["min", "max"],
      properties: {
        min: { type: "integer", minimum: 0 },
        max: { type: "integer", minimum: 0 },
      },
    },
    compile(rule) {
      if (!isRecord(rule) || !Number.isSafeInteger(rule.min) || !Number.isSafeInteger(rule.max) || rule.min < 0 || rule.max < rule.min) {
        registryFailure("mpScalarLength schema is invalid");
      }
      return (value) => {
        const length = scalarLength(value);
        return length >= rule.min && length <= rule.max;
      };
    },
  });
  ajv.addKeyword({
    keyword: "mpSortedUniqueBy",
    schemaType: "string",
    type: "array",
    modifying: false,
    errors: false,
    compile(key) {
      if (key.length === 0) registryFailure("mpSortedUniqueBy schema is invalid");
      return (items) => {
        let previous = null;
        for (const item of items) {
          const value = key === "$value"
            ? item
            : isRecord(item) && Object.hasOwn(item, key)
              ? item[key]
              : null;
          if (!isUnicodeScalarString(value)) return false;
          if (previous !== null && compareUnicodeScalars(previous, value) >= 0) return false;
          previous = value;
        }
        return true;
      };
    },
  });
}

function validatorIssues(errors) {
  return (errors ?? []).map((error) => Object.freeze({
    instancePath: typeof error.instancePath === "string" ? error.instancePath : "",
    schemaPath: typeof error.schemaPath === "string" ? error.schemaPath : "",
    keyword: typeof error.keyword === "string" ? error.keyword : "unknown",
  }));
}

function deepFreeze(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const item of Object.values(value)) deepFreeze(item, seen);
  return Object.freeze(value);
}

function readOnlyMap(source) {
  const inventory = {
    get size() { return source.size; },
    get(key) { return source.get(key); },
    has(key) { return source.has(key); },
    keys() { return source.keys(); },
    values() { return source.values(); },
    entries() { return source.entries(); },
    forEach(callback, thisArg) {
      for (const [key, value] of source) callback.call(thisArg, value, key, inventory);
    },
    [Symbol.iterator]() { return source[Symbol.iterator](); },
  };
  return Object.freeze(inventory);
}

export function loadPaperRegistry() {
  if (process.versions.unicode !== "17.0") registryFailure("Node Unicode data must be exactly 17.0");
  const { inventory, bytesByFile } = verifyInventory();
  const registry = parseJsonFile("registry.json", bytesByFile.get("registry.json"));
  exactKeys(registry, ["$schema", "$id", "schemaVersion", "profile", "policyId", "localOnly", "formatAssertion", "schemas", "rules"], "registry");
  if (!isRecord(registry) || registry.$schema !== DRAFT_2020_12 || registry.$id !== `${SCHEMA_ID_PREFIX}registry` || registry.schemaVersion !== 1 || registry.profile !== PROFILE || registry.policyId !== "FIXTURE_LONG_US_EQUITY_100_V1" || registry.localOnly !== true || registry.formatAssertion !== true || !isRecord(registry.schemas) || !isRecord(registry.rules)) {
    registryFailure("registry identity is invalid");
  }
  exactKeys(registry.rules, Object.keys(EXPECTED_RULES), "registry.rules");
  for (const [name, value] of Object.entries(EXPECTED_RULES)) {
    if (registry.rules[name] !== value) registryFailure(`registry rule is invalid for ${name}`);
  }
  exactKeys(registry.schemas, Object.keys(EXPECTED_SCHEMAS), "registry.schemas");
  for (const [name, [relative]] of Object.entries(EXPECTED_SCHEMAS)) {
    if (registry.schemas[name] !== relative) registryFailure(`registry path is invalid for ${name}`);
  }

  const meta = parseJsonFile("fixture-meta.schema.json", bytesByFile.get("fixture-meta.schema.json"));
  if (!isRecord(meta) || meta.$schema !== DRAFT_2020_12 || meta.$id !== META_ID || !isRecord(meta.$vocabulary)) {
    registryFailure("fixture meta-schema identity is invalid");
  }
  if (Object.values(meta.$vocabulary).some((value) => typeof value !== "boolean") || [...REQUIRED_VOCABULARIES].some((uri) => meta.$vocabulary[uri] !== true) || Object.entries(meta.$vocabulary).some(([uri, required]) => required === true && !SUPPORTED_VOCABULARIES.has(uri))) {
    registryFailure("fixture meta-schema vocabulary declaration is unsupported");
  }
  if (!isRecord(meta.properties)) registryFailure("fixture meta-schema properties are missing");
  const customKeywords = Object.keys(meta.properties).filter((key) => key.startsWith("mp")).toSorted();
  if (customKeywords.join("\u0000") !== ["mpNfc", "mpScalarLength", "mpSortedUniqueBy"].toSorted().join("\u0000")) registryFailure("fixture custom vocabulary is not exact");
  const metaReferences = schemaReferences(meta);
  if (metaReferences.size === 0 || [...metaReferences].some((reference) => !OFFICIAL_META_REFERENCES.has(reference))) registryFailure("fixture meta-schema references are not the closed official set");

  const schemas = new Map();
  const knownIds = new Set();
  for (const [name, [relative, suffix]] of Object.entries(EXPECTED_SCHEMAS)) {
    const schema = parseJsonFile(relative, bytesByFile.get(relative));
    const expectedId = `${SCHEMA_ID_PREFIX}${suffix}`;
    if (!isRecord(schema) || schema.$schema !== META_ID || schema.$id !== expectedId || schema.type !== "object" || schema.additionalProperties !== false || schema.unevaluatedProperties !== false) {
      registryFailure(`${name} schema identity or closure is invalid`);
    }
    knownIds.add(expectedId);
    schemas.set(name, schema);
  }
  for (const [name, schema] of schemas) {
    assertLocalReferences(schema, knownIds, name);
    assertOnlyDateTimeFormat(schema, name);
  }

  const vocabularyVectorsDocument = parseJsonFile("custom-vocabulary-vectors.json", bytesByFile.get("custom-vocabulary-vectors.json"));
  exactKeys(vocabularyVectorsDocument, ["schemaVersion", "vocabulary", "vectors"], "custom-vocabulary-vectors");
  if (vocabularyVectorsDocument.schemaVersion !== 1 || vocabularyVectorsDocument.vocabulary !== VOCABULARY_ID || !Array.isArray(vocabularyVectorsDocument.vectors) || vocabularyVectorsDocument.vectors.length === 0) {
    registryFailure("custom vocabulary vectors identity is invalid");
  }

  const ajv = new Ajv2020({
    strict: true,
    // Draft 2020-12 allows type-constraining keywords in a conditional or
    // composition branch while the parent schema establishes the instance
    // type. `strictTypes` is an Ajv lint that rejects that valid profile style,
    // so disable only this lint and retain every other strict schema check.
    strictTypes: false,
    allErrors: false,
    validateFormats: true,
    validateSchema: true,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
    unicodeRegExp: true,
  });
  ajv.addFormat("date-time", { type: "string", validate: validProfileDateTime });
  addMarketPilotVocabulary(ajv);
  if (!ajv.getSchema(FORMAT_ASSERTION_META_SCHEMA.$id)) ajv.addMetaSchema(FORMAT_ASSERTION_META_SCHEMA);
  ajv.addMetaSchema(meta);
  ajv.addSchema([...schemas.values()]);

  const validators = new Map();
  for (const [name, schema] of schemas) {
    const validate = ajv.getSchema(schema.$id);
    if (typeof validate !== "function") registryFailure(`${name} did not compile`);
    validators.set(name, validate);
  }

  const vectorIds = new Set();
  const coveredKeywords = new Set();
  for (const vector of vocabularyVectorsDocument.vectors) {
    exactKeys(vector, ["id", "keyword", "schema", "value", "valid"], "custom vocabulary vector");
    if (typeof vector.id !== "string" || !/^[a-z][a-z0-9-]{2,63}$/.test(vector.id) || vectorIds.has(vector.id)) registryFailure("custom vocabulary vector id is invalid or duplicated");
    vectorIds.add(vector.id);
    const customUsage = new Set();
    visitSchema(vector.schema, (node) => {
      for (const keyword of ["mpNfc", "mpScalarLength", "mpSortedUniqueBy"]) if (Object.hasOwn(node, keyword)) customUsage.add(keyword);
    });
    if (!["mpNfc", "mpScalarLength", "mpSortedUniqueBy"].includes(vector.keyword) || !isRecord(vector.schema) || (vector.schema.$schema !== undefined && vector.schema.$schema !== META_ID) || customUsage.size !== 1 || !customUsage.has(vector.keyword) || typeof vector.valid !== "boolean") {
      registryFailure(`custom vocabulary vector ${vector.id} is malformed`);
    }
    assertLocalReferences(vector.schema, knownIds, `custom vocabulary vector ${vector.id}`);
    assertOnlyDateTimeFormat(vector.schema, `custom vocabulary vector ${vector.id}`);
    const validate = ajv.compile(vector.schema);
    if (validate(vector.value) !== vector.valid) registryFailure(`custom vocabulary vector ${vector.id} failed`);
    coveredKeywords.add(vector.keyword);
  }
  if (coveredKeywords.size !== 3) registryFailure("custom vocabulary vectors lack keyword coverage");

  for (const schema of schemas.values()) deepFreeze(schema);
  deepFreeze(registry);
  deepFreeze(inventory);
  deepFreeze(vocabularyVectorsDocument);

  const validate = (name, value) => {
    const validator = validators.get(name);
    if (!validator) {
      throw new PaperSchemaValidationError("PAPER_SCHEMA_UNKNOWN", "Unknown paper fixture schema", { schemaName: typeof name === "string" ? name : null });
    }
    if (!validator(value)) {
      throw new PaperSchemaValidationError("PAPER_SCHEMA_INVALID", "Paper fixture schema validation failed", {
        schemaName: name,
        issues: validatorIssues(validator.errors),
      });
    }
    return value;
  };

  return Object.freeze({
    registry,
    schemas: readOnlyMap(schemas),
    vocabularyVectors: vocabularyVectorsDocument.vectors,
    validate,
  });
}

export const PAPER_REGISTRY = loadPaperRegistry();
