// @ts-check

export const PROBE_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  required: ["status", "summary", "checks"],
  properties: {
    status: { type: "string", enum: ["ok", "abstain"] },
    summary: { type: "string", minLength: 1, maxLength: 240 },
    checks: {
      type: "array",
      minItems: 1,
      maxItems: 12,
      items: {
        type: "object",
        required: ["name", "passed", "detail"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 80 },
          passed: { type: "boolean" },
          detail: { type: "string", minLength: 1, maxLength: 240 },
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
});

export class ProbeArtifactError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "ProbeArtifactError";
  }
}

/** @param {unknown} value @param {string} label @param {number} maxLength */
function requireText(value, label, maxLength) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new ProbeArtifactError(`${label} must be non-empty text no longer than ${maxLength} characters`);
  }
  return value;
}
/**
 * Parse and independently validate the exact compatibility artifact. This is
 * intentionally separate from app-server's outputSchema enforcement.
 * @param {string} text
 */
export function parseProbeArtifact(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ProbeArtifactError("final agent message is not valid JSON");
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProbeArtifactError("artifact must be an object");
  }
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "checks,status,summary") {
    throw new ProbeArtifactError("artifact contains missing or additional properties");
  }
  if (value.status !== "ok" && value.status !== "abstain") {
    throw new ProbeArtifactError("status must be ok or abstain");
  }
  requireText(value.summary, "summary", 240);
  if (!Array.isArray(value.checks) || value.checks.length < 1 || value.checks.length > 12) {
    throw new ProbeArtifactError("checks must contain between 1 and 12 entries");
  }
  for (const [index, check] of value.checks.entries()) {
    if (!check || typeof check !== "object" || Array.isArray(check)) {
      throw new ProbeArtifactError(`checks[${index}] must be an object`);
    }
    if (Object.keys(check).sort().join(",") !== "detail,name,passed") {
      throw new ProbeArtifactError(`checks[${index}] contains missing or additional properties`);
    }
    requireText(check.name, `checks[${index}].name`, 80);
    requireText(check.detail, `checks[${index}].detail`, 240);
    if (typeof check.passed !== "boolean") {
      throw new ProbeArtifactError(`checks[${index}].passed must be boolean`);
    }
  }
  return value;
}
