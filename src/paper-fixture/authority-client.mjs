// @ts-check

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  MAX_MESSAGE_BYTES,
  PaperContractError,
  PAPER_PROFILE,
  PAPER_POLICY_ID,
  canonicalJson,
  parseJsonNoDuplicates,
  responseHash,
  requestHash,
  validateRequestContract,
  validateProtocolError,
  validateResponseContract,
} from "./contract-validation.mjs";

const DEFAULT_TIMEOUT_MS = 2_000;
const MAX_OUTPUT_BYTES = MAX_MESSAGE_BYTES;
const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_PYTHON = path.join(SOURCE_ROOT, ".venv-paper", "bin", "python");

export class AuthorityAdapterError extends Error {
  /** @param {"AUTHORITY_INPUT_ERROR"|"AUTHORITY_TIMEOUT"|"AUTHORITY_PROCESS_FAILED"|"AUTHORITY_OUTPUT_INVALID"|"AUTHORITY_RESPONSE_MISMATCH"} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = "AuthorityAdapterError";
    this.code = code;
  }
}

function inputError(message = "Authority input failed local contract validation") {
  return new AuthorityAdapterError("AUTHORITY_INPUT_ERROR", message);
}

function asBytes(value) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") return Buffer.from(value, "utf8");
  throw inputError("Authority request bytes are required");
}

function collectBounded(stream, limit, onLimit) {
  let buffer = Buffer.alloc(0);
  stream.on("data", chunk => {
    const next = Buffer.concat([buffer, Buffer.from(chunk)]);
    if (next.length > limit) onLimit();
    else buffer = next;
  });
  return () => buffer;
}

/**
 * Send exactly one already-encoded request to the Python authority. The
 * original bytes are passed unchanged after a local, non-authoritative
 * contract check; Python remains the only domain/policy authority.
 * @param {{requestBytes: Buffer|Uint8Array|string, timeoutMs?: number, python?: string}} options
 */
export async function invokePaperAuthority({ requestBytes, timeoutMs = DEFAULT_TIMEOUT_MS, python = DEFAULT_PYTHON }) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > DEFAULT_TIMEOUT_MS) throw new TypeError("timeoutMs must be an integer from 1 through 2000");
  const bytes = asBytes(requestBytes);
  if (bytes.length > MAX_MESSAGE_BYTES) throw inputError("Authority request exceeds the bounded message size");
  if (bytes.length === 0 || !bytes.subarray(-1).equals(Buffer.from("\n")) || bytes.subarray(0, -1).includes(0x0a) || bytes.includes(0x0d) || bytes.includes(0x00) || bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) throw inputError("Authority request framing is invalid");
  const text = bytes.subarray(0, -1).toString("utf8");
  if (Buffer.from(text, "utf8").compare(bytes.subarray(0, -1)) !== 0) throw inputError("Authority request encoding is invalid");
  let request;
  try {
    request = parseJsonNoDuplicates(text);
    validateRequestContract(request);
  } catch (error) {
    if (error instanceof PaperContractError) throw inputError(error.code);
    throw inputError();
  }

  const child = spawn(python, ["-m", "marketpilot.paper_fixture_authority"], {
    cwd: SOURCE_ROOT,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      PYTHONPATH: path.join(SOURCE_ROOT, "src"),
      PYTHONNOUSERSITE: "1",
      PYTHONUNBUFFERED: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let overOutput = false;
  const stdout = collectBounded(child.stdout, MAX_OUTPUT_BYTES, () => { overOutput = true; child.kill("SIGKILL"); });
  const stderr = collectBounded(child.stderr, MAX_OUTPUT_BYTES, () => { overOutput = true; child.kill("SIGKILL"); });
  // A short-lived or hostile child may close stdin before the request bytes
  // are flushed. Absorb EPIPE/ERR_STREAM_DESTROYED and classify the eventual
  // process close through the typed adapter path instead of crashing Node.
  child.stdin.on("error", () => {});
  let timedOut = false;
  const deadline = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
  const result = await new Promise(resolve => {
    let settled = false;
    const settle = value => { if (settled) return; settled = true; resolve(value); };
    child.once("error", error => settle({ kind: "error", error }));
    child.once("close", (code, signal) => settle({ kind: "close", code, signal }));
    child.stdin.end(bytes);
  });
  clearTimeout(deadline);
  if (result.kind === "error") throw new AuthorityAdapterError("AUTHORITY_PROCESS_FAILED", "Python authority process failed to start");
  if (overOutput) throw new AuthorityAdapterError("AUTHORITY_OUTPUT_INVALID", "Python authority exceeded the bounded output");
  if (timedOut) throw new AuthorityAdapterError("AUTHORITY_TIMEOUT", "Python authority exceeded its deadline");
  if (result.code !== 0 && result.code !== 2) throw new AuthorityAdapterError("AUTHORITY_PROCESS_FAILED", "Python authority returned an internal failure");
  if (stderr().length !== 0) throw new AuthorityAdapterError("AUTHORITY_PROCESS_FAILED", "Python authority wrote unexpected stderr");
  const output = stdout();
  if (output.length === 0 || output[output.length - 1] !== 0x0a || output.subarray(0, -1).includes(0x0a) || output.length > MAX_OUTPUT_BYTES) throw new AuthorityAdapterError("AUTHORITY_OUTPUT_INVALID", "Python authority framing is invalid");
  let envelope;
  try { envelope = parseJsonNoDuplicates(output.subarray(0, -1).toString("utf8")); } catch { throw new AuthorityAdapterError("AUTHORITY_OUTPUT_INVALID", "Python authority returned invalid JSON"); }
  if (!output.equals(Buffer.from(`${canonicalJson(envelope)}\n`, "utf8"))) {
    throw new AuthorityAdapterError("AUTHORITY_OUTPUT_INVALID", "Python authority output is not canonical JSON");
  }
  if (result.code === 2) {
    try { validateProtocolError(envelope); if (envelope.messageType !== "FIXTURE_AUTHORITY_PROTOCOL_ERROR" || responseHash(envelope) !== envelope.responseHash) throw new Error(); } catch { throw new AuthorityAdapterError("AUTHORITY_OUTPUT_INVALID", "Python authority protocol envelope is invalid"); }
    throw new AuthorityAdapterError("AUTHORITY_INPUT_ERROR", "Python rejected the authority request contract");
  }
  try {
    validateResponseContract(envelope, { request });
  } catch (error) {
    throw new AuthorityAdapterError(error instanceof PaperContractError && error.code === "AUTHORITY_RESPONSE_MISMATCH" ? "AUTHORITY_RESPONSE_MISMATCH" : "AUTHORITY_OUTPUT_INVALID", "Python authority response failed independent validation");
  }
  if (envelope.requestId !== request.requestId || envelope.operationId !== request.operationId || envelope.requestHash !== requestHash(request)) throw new AuthorityAdapterError("AUTHORITY_RESPONSE_MISMATCH", "Python authority response does not match the request");
  return envelope;
}

/** Encode a request without changing its object values. */
export function encodeAuthorityRequest(request) {
  validateRequestContract(request);
  return Buffer.from(`${canonicalJson(request)}\n`, "utf8");
}

export { PAPER_PROFILE, PAPER_POLICY_ID };
