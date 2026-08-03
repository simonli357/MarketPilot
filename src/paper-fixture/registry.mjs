// @ts-check

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const registryDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "contracts", "paper-intent", "fixture-l1", "v1");

export function loadPaperRegistry() {
  const registry = JSON.parse(readFileSync(path.join(registryDirectory, "registry.json"), "utf8"));
  if (registry.$schema !== "https://json-schema.org/draft/2020-12/schema" || registry.profile !== "marketpilot.paper-intent-fixture.v1" || registry.localOnly !== true || registry.formatAssertion !== true) throw new Error("paper fixture registry identity is invalid");
  const ids = new Set(); const schemas = new Map();
  for (const [name, relative] of Object.entries(registry.schemas)) {
    if (typeof relative !== "string" || path.isAbsolute(relative) || relative.includes("..")) throw new Error(`paper fixture registry path is not local: ${name}`);
    const schema = JSON.parse(readFileSync(path.join(registryDirectory, relative), "utf8"));
    if (schema.additionalProperties !== false || schema.unevaluatedProperties !== false || typeof schema.$id !== "string") throw new Error(`paper fixture schema is not closed: ${name}`);
    if (ids.has(schema.$id)) throw new Error(`paper fixture schema id is duplicated: ${schema.$id}`);
    ids.add(schema.$id); schemas.set(name, schema);
  }
  for (const schema of schemas.values()) {
    for (const ref of JSON.stringify(schema).matchAll(/urn:marketpilot:paper-intent-fixture:v1:[a-z-]+/g)) if (!ids.has(ref[0])) throw new Error(`paper fixture schema reference is not local: ${ref[0]}`);
  }
  return Object.freeze({ registry, schemas });
}

export const PAPER_REGISTRY = loadPaperRegistry();
