// @ts-check

import assert from "node:assert/strict";
import test from "node:test";
import { parseProbeArtifact, ProbeArtifactError } from "../../src/codex/probe-artifact.mjs";

test("parseProbeArtifact accepts the exact artifact contract", () => {
  const artifact = parseProbeArtifact(JSON.stringify({
    status: "ok",
    summary: "Fixture contract is intact.",
    checks: [{ name: "source", passed: true, detail: "The source is PUBLIC_OFFICIAL." }],
  }));
  assert.equal(artifact.status, "ok");
});

test("parseProbeArtifact rejects additional properties", () => {
  assert.throws(
    () => parseProbeArtifact(JSON.stringify({ status: "ok", summary: "x", checks: [], secret: "no" })),
    ProbeArtifactError,
  );
});
test("parseProbeArtifact rejects malformed JSON and ambiguous empty checks", () => {
  assert.throws(() => parseProbeArtifact("not-json"), /not valid JSON/);
  assert.throws(
    () => parseProbeArtifact(JSON.stringify({ status: "ok", summary: "x", checks: [] })),
    /between 1 and 12/,
  );
});
