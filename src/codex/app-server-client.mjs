// @ts-check

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";

const DEFAULT_MAX_LINE_BYTES = 4 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_TIMEOUT_MS = 1_000;
const DEFAULT_STDERR_MAX_BYTES = 64 * 1024;
const EXACT_SERVER_REQUEST_METHODS = Symbol("exactServerRequestMethods");

/** @typedef {"idle" | "starting" | "running" | "stopping" | "stopped" | "failed"} AppServerClientState */

/**
 * @typedef {object} ServerRequest
 * @property {number} id
 * @property {string} method
 * @property {unknown} [params]
 */

/** @typedef {(request: ServerRequest) => unknown | Promise<unknown>} ServerRequestHandler */

/**
 * The common base for errors that callers may safely classify without parsing
 * human-readable messages.
 */
export class AppServerError extends Error {
  /**
   * @param {string} message
   * @param {{kind: string, code: string, details?: Readonly<Record<string, unknown>>, cause?: unknown}} options
   */
  constructor(message, { kind, code, details = {}, cause } = /** @type {never} */ ({})) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = new.target.name;
    this.kind = kind;
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export class AppServerStateError extends AppServerError {
  /**
   * @param {string} code
   * @param {string} message
   * @param {Readonly<Record<string, unknown>>} [details]
   */
  constructor(code, message, details = {}) {
    super(message, { kind: "state", code, details });
  }
}

export class AppServerProtocolError extends AppServerError {
  /**
   * @param {string} code
   * @param {string} message
   * @param {Readonly<Record<string, unknown>>} [details]
   * @param {unknown} [cause]
   */
  constructor(code, message, details = {}, cause) {
    super(message, { kind: "protocol", code, details, cause });
  }
}

export class AppServerProcessError extends AppServerError {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{exitCode?: number | null, signal?: NodeJS.Signals | null, stderr?: string}} [details]
   * @param {unknown} [cause]
   */
  constructor(code, message, details = {}, cause) {
    super(message, { kind: "process", code, details, cause });
    this.exitCode = details.exitCode ?? null;
    this.signal = details.signal ?? null;
    this.stderr = details.stderr ?? "";
  }
}

export class AppServerRequestTimeoutError extends AppServerError {
  /**
   * @param {number} id
   * @param {string} method
   * @param {number} timeoutMs
   */
  constructor(id, method, timeoutMs) {
    super(`App-server request ${method} timed out after ${timeoutMs} ms`, {
      kind: "timeout",
      code: "REQUEST_TIMEOUT",
      details: { id, method, timeoutMs },
    });
    this.id = id;
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}

export class AppServerRequestAbortedError extends AppServerError {
  /**
   * @param {number} id
   * @param {string} method
   * @param {unknown} [cause]
   */
  constructor(id, method, cause) {
    super(`App-server request ${method} was aborted`, {
      kind: "aborted",
      code: "REQUEST_ABORTED",
      details: { id, method },
      cause,
    });
    this.id = id;
    this.method = method;
  }
}

export class AppServerRemoteError extends AppServerError {
  /**
   * @param {number} id
   * @param {string} method
   * @param {{code: string | number, message: string, data?: unknown}} remote
   * @param {(text: string) => string} redact
   */
  constructor(id, method, remote, redact) {
    const remoteMessage = safelyRedact(redact, remote.message);
    super(`App-server request ${method} failed: ${remoteMessage}`, {
      kind: "remote",
      code: "REMOTE_ERROR",
      details: {
        id,
        method,
        remoteCode: remote.code,
        remoteData: redactValue(remote.data, redact),
      },
    });
    this.id = id;
    this.method = method;
    this.remoteCode = remote.code;
    this.remoteData = redactValue(remote.data, redact);
  }
}

/**
 * Builds a server-request handler whose accepted method set is explicit. An
 * unlisted method throws a typed protocol error; there is no wildcard path.
 *
 * @param {ReadonlyMap<string, ServerRequestHandler> | Readonly<Record<string, ServerRequestHandler>>} handlers
 * @returns {ServerRequestHandler}
 */
export function createExactServerRequestHandler(handlers) {
  const entries = handlers instanceof Map ? [...handlers.entries()] : Object.entries(handlers);
  /** @type {Map<string, ServerRequestHandler>} */
  const exactHandlers = new Map();

  for (const [method, handler] of entries) {
    assertMethod(method, "server request handler method");
    if (typeof handler !== "function") {
      throw new TypeError(`Handler for ${method} must be a function`);
    }
    if (exactHandlers.has(method)) {
      throw new TypeError(`Duplicate server request handler for ${method}`);
    }
    exactHandlers.set(method, handler);
  }

  const exactHandler = (request) => {
    const handler = exactHandlers.get(request.method);
    if (handler === undefined) {
      throw new AppServerProtocolError(
        "UNEXPECTED_SERVER_REQUEST",
        `Server-initiated request ${request.method} is not allowed`,
        { id: request.id, method: request.method },
      );
    }
    return handler(request);
  };
  Object.defineProperty(exactHandler, EXACT_SERVER_REQUEST_METHODS, {
    value: Object.freeze([...exactHandlers.keys()]),
    enumerable: false,
    writable: false,
  });
  return exactHandler;
}

/**
 * A bounded JSONL transport for Codex app-server. This class intentionally
 * interprets only request/response/notification envelopes; product-level
 * method and payload allowlists belong to the supervisor above it.
 */
export class AppServerClient extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.command Exact executable to launch; no shell is used.
   * @param {readonly string[]} [options.args]
   * @param {NodeJS.ProcessEnv} [options.env]
   * @param {string | URL} [options.cwd]
   * @param {number} [options.maxLineBytes]
   * @param {number} [options.requestTimeoutMs]
   * @param {number} [options.stopTimeoutMs]
   * @param {number} [options.stderrMaxBytes]
   * @param {(text: string) => string} [options.redact]
   * @param {ServerRequestHandler} [options.serverRequestHandler]
   * @param {() => void | Promise<void>} [options.beforeSpawn]
   */
  constructor({
    command,
    args = [],
    env,
    cwd,
    maxLineBytes = DEFAULT_MAX_LINE_BYTES,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS,
    stderrMaxBytes = DEFAULT_STDERR_MAX_BYTES,
    redact = defaultRedact,
    serverRequestHandler = createExactServerRequestHandler({}),
    beforeSpawn = () => {},
  }) {
    super();

    if (typeof command !== "string" || command.length === 0) {
      throw new TypeError("command must be a non-empty string");
    }
    if (!Array.isArray(args) || args.some((argument) => typeof argument !== "string")) {
      throw new TypeError("args must contain only strings");
    }
    assertPositiveInteger(maxLineBytes, "maxLineBytes");
    assertPositiveInteger(requestTimeoutMs, "requestTimeoutMs");
    assertPositiveInteger(stopTimeoutMs, "stopTimeoutMs");
    assertPositiveInteger(stderrMaxBytes, "stderrMaxBytes");
    if (typeof redact !== "function") {
      throw new TypeError("redact must be a function");
    }
    if (typeof serverRequestHandler !== "function") {
      throw new TypeError("serverRequestHandler must be a function");
    }
    if (typeof beforeSpawn !== "function") {
      throw new TypeError("beforeSpawn must be a function");
    }

    this._command = command;
    this._args = Object.freeze([...args]);
    this._env = env;
    this._cwd = cwd;
    this._maxLineBytes = maxLineBytes;
    this._requestTimeoutMs = requestTimeoutMs;
    this._stopTimeoutMs = stopTimeoutMs;
    this._stderrMaxBytes = stderrMaxBytes;
    this._redact = redact;
    this._serverRequestHandler = serverRequestHandler;
    this._beforeSpawn = beforeSpawn;
    const exactServerRequestMethods = Reflect.get(
      serverRequestHandler,
      EXACT_SERVER_REQUEST_METHODS,
    );
    this._serverRequestsForbidden =
      Array.isArray(exactServerRequestMethods) && exactServerRequestMethods.length === 0;

    /** @type {AppServerClientState} */
    this._state = "idle";
    /** @type {import("node:child_process").ChildProcessWithoutNullStreams | null} */
    this._child = null;
    /** @type {Promise<void> | null} */
    this._startPromise = null;
    this._startAttemptId = 0;
    /** @type {((value?: void | PromiseLike<void>) => void) | null} */
    this._resolveStart = null;
    /** @type {((reason?: unknown) => void) | null} */
    this._rejectStart = null;
    /** @type {Promise<void> | null} */
    this._closePromise = null;
    /** @type {((value?: void | PromiseLike<void>) => void) | null} */
    this._resolveClose = null;
    /** @type {NodeJS.Timeout | null} */
    this._killTimer = null;
    this._expectedStop = false;
    this._spawned = false;
    this._nextRequestId = 1;
    /** @type {Map<number, PendingRequest>} */
    this._pending = new Map();
    /** @type {Set<number>} */
    this._seenResponseIds = new Set();
    /** @type {Set<number>} */
    this._activeServerRequestIds = new Set();
    /** @type {Set<number>} */
    this._handledServerRequestIds = new Set();
    this._stdoutBuffer = Buffer.alloc(0);
    this._stderrDecoder = new StringDecoder("utf8");
    this._stderrRaw = "";
    this._stderrTruncated = false;
    this._stderrEnded = false;
    /** @type {AppServerError | null} */
    this._lastError = null;
  }

  /** @returns {AppServerClientState} */
  get state() {
    return this._state;
  }

  /** @returns {number | null} */
  get pid() {
    return this._child?.pid ?? null;
  }

  /** @returns {string} */
  get stderr() {
    const redacted = safelyRedact(this._redact, this._stderrRaw);
    const needsTruncation =
      this._stderrTruncated || Buffer.byteLength(redacted, "utf8") > this._stderrMaxBytes;
    if (!needsTruncation) {
      return redacted;
    }
    this._stderrTruncated = true;
    const marker = "[stderr truncated]\n";
    const markerBytes = Buffer.byteLength(marker, "utf8");
    if (markerBytes >= this._stderrMaxBytes) {
      return utf8Prefix(marker, this._stderrMaxBytes);
    }
    return marker + utf8Prefix(redacted, this._stderrMaxBytes - markerBytes);
  }

  /** @returns {boolean} */
  get stderrTruncated() {
    return this._stderrTruncated;
  }

  /** @returns {AppServerError | null} */
  get lastError() {
    return this._lastError;
  }

  /**
   * True only when the transport was constructed with an exact empty
   * server-request allowlist. Higher layers can require this invariant before
   * sending work; observing the event after dispatch would be too late to veto
   * a permissive handler.
   * @returns {boolean}
   */
  get serverRequestsForbidden() {
    return this._serverRequestsForbidden;
  }

  /** Launches the configured process and resolves after the OS spawn event. */
  async start() {
    if (this._state === "running") {
      return;
    }
    if (this._state === "starting" && this._startPromise !== null) {
      return this._startPromise;
    }
    if (this._state === "stopping") {
      throw new AppServerStateError("CLIENT_STOPPING", "Cannot start app-server while it is stopping");
    }
    if (this._state === "failed" && this._child !== null) {
      await this._closePromise;
    }

    this._resetConnection();
    this._setState("starting");
    const startAttemptId = ++this._startAttemptId;
    const startPromise = new Promise((resolve, reject) => {
      this._resolveStart = resolve;
      this._rejectStart = reject;
    });
    this._startPromise = startPromise;
    this._closePromise = new Promise((resolve) => {
      this._resolveClose = resolve;
    });

    try {
      // Security-sensitive callers use this hook to re-open and hash the exact
      // executable immediately before spawn. A pathname can still change in
      // the final OS scheduling window, but no asynchronous application work
      // is placed between this check and spawn.
      await this._beforeSpawn();
    } catch {
      if (this._state !== "starting" || this._startAttemptId !== startAttemptId) {
        return startPromise;
      }
      // Do not retain the qualification error as a cause: low-level filesystem
      // errors can contain an executable path. The typed code is sufficient for
      // the supervisor, while the original value remains outside diagnostics.
      const error = new AppServerProcessError(
        "SPAWN_QUALIFICATION_FAILED",
        "App-server executable qualification failed before launch",
      );
      this._failBeforeSpawn(error);
      return startPromise;
    }

    // stop() may complete while qualification is running, and a later start
    // may replace this attempt. Only the current starting attempt may spawn.
    if (this._state !== "starting" || this._startAttemptId !== startAttemptId) {
      return startPromise;
    }

    let child;
    try {
      child = spawn(this._command, this._args, {
        cwd: this._cwd,
        env: this._env,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (cause) {
      const error = new AppServerProcessError(
        "SPAWN_FAILED",
        "Could not launch the configured app-server executable",
        { stderr: this.stderr },
        cause,
      );
      this._failBeforeSpawn(error);
      return startPromise;
    }

    this._child = child;
    child.once("spawn", () => this._onSpawn(child));
    child.once("error", (cause) => this._onChildError(child, cause));
    child.once("close", (code, signal) => this._onClose(child, code, signal));
    child.stdin.on("error", (cause) => this._onStreamError(child, "stdin", cause));
    child.stdout.on("error", (cause) => this._onStreamError(child, "stdout", cause));
    child.stderr.on("error", (cause) => this._onStreamError(child, "stderr", cause));
    child.stdout.on("data", (chunk) => this._onStdoutData(child, chunk));
    child.stderr.on("data", (chunk) => this._onStderrData(child, chunk));
    child.stderr.once("end", () => this._finishStderr());

    return startPromise;
  }

  /**
   * Sends a numeric-ID request and resolves with the response result.
   *
   * @param {string} method
   * @param {unknown} [params]
   * @param {{timeoutMs?: number, signal?: AbortSignal}} [options]
   * @returns {Promise<unknown>}
   */
  request(method, params, { timeoutMs = this._requestTimeoutMs, signal } = {}) {
    this._assertRunning();
    assertMethod(method, "request method");
    assertPositiveInteger(timeoutMs, "timeoutMs");

    const id = this._nextRequestId;
    this._nextRequestId += 1;
    if (!Number.isSafeInteger(this._nextRequestId)) {
      throw new AppServerStateError("REQUEST_ID_EXHAUSTED", "App-server request ID space is exhausted");
    }

    const message = params === undefined ? { id, method } : { id, method, params };
    let line;
    try {
      line = this._serializeMessage(message);
    } catch (error) {
      return Promise.reject(error);
    }

    if (signal?.aborted) {
      return Promise.reject(new AppServerRequestAbortedError(id, method, signal.reason));
    }

    /** @type {(value: unknown) => void} */
    let resolveResponse;
    /** @type {(reason?: unknown) => void} */
    let rejectResponse;
    const response = new Promise((resolve, reject) => {
      resolveResponse = resolve;
      rejectResponse = reject;
    });

    const timer = setTimeout(() => {
      const pending = this._pending.get(id);
      if (pending === undefined) {
        return;
      }
      this._pending.delete(id);
      this._disposePending(pending);
      pending.reject(new AppServerRequestTimeoutError(id, method, timeoutMs));
    }, timeoutMs);
    timer.unref?.();

    /** @type {(() => void) | undefined} */
    let abortListener;
    if (signal !== undefined) {
      abortListener = () => {
        const pending = this._pending.get(id);
        if (pending === undefined) {
          return;
        }
        this._pending.delete(id);
        this._disposePending(pending);
        pending.reject(new AppServerRequestAbortedError(id, method, signal.reason));
      };
      signal.addEventListener("abort", abortListener, { once: true });
    }

    const pending = {
      id,
      method,
      resolve: resolveResponse,
      reject: rejectResponse,
      timer,
      signal,
      abortListener,
    };
    this._pending.set(id, pending);

    this._writeLine(line).catch((cause) => {
      const current = this._pending.get(id);
      if (current !== undefined) {
        this._pending.delete(id);
        this._disposePending(current);
        const error = this._asWriteError(cause);
        current.reject(error);
        this._fatal(error);
      }
    });

    return response;
  }

  /**
   * Sends a notification. Resolution means the complete JSONL record was
   * accepted by the child-process stream, not that the server acted on it.
   *
   * @param {string} method
   * @param {unknown} [params]
   * @returns {Promise<void>}
   */
  notify(method, params) {
    this._assertRunning();
    assertMethod(method, "notification method");
    const message = params === undefined ? { method } : { method, params };
    const line = this._serializeMessage(message);
    return this._writeLine(line).catch((cause) => {
      const error = this._asWriteError(cause);
      this._fatal(error);
      throw error;
    });
  }

  /** Stops the process, rejecting every outstanding request. */
  async stop() {
    if (this._state === "idle" || this._state === "stopped") {
      return;
    }
    if (this._state === "stopping") {
      return this._closePromise ?? undefined;
    }
    if (this._state === "failed") {
      return this._closePromise ?? undefined;
    }

    this._expectedStop = true;
    this._setState("stopping");
    const error = new AppServerProcessError("CLIENT_STOPPED", "App-server client was stopped", {
      stderr: this.stderr,
    });
    this._rejectStart?.(error);
    this._rejectAllPending(error);

    const child = this._child;
    if (child === null) {
      this._setState("stopped");
      this._resolveClose?.();
      return;
    }

    if (!child.stdin.destroyed) {
      child.stdin.end();
    }
    this._scheduleKill(child);
    return this._closePromise ?? undefined;
  }

  _resetConnection() {
    this._clearKillTimer();
    this._expectedStop = false;
    this._spawned = false;
    this._nextRequestId = 1;
    this._pending.clear();
    this._seenResponseIds.clear();
    this._activeServerRequestIds.clear();
    this._handledServerRequestIds.clear();
    this._stdoutBuffer = Buffer.alloc(0);
    this._stderrDecoder = new StringDecoder("utf8");
    this._stderrRaw = "";
    this._stderrTruncated = false;
    this._stderrEnded = false;
    this._lastError = null;
    this._startPromise = null;
    this._resolveStart = null;
    this._rejectStart = null;
    this._closePromise = null;
    this._resolveClose = null;
  }

  /** @param {AppServerClientState} state */
  _setState(state) {
    if (this._state === state) {
      return;
    }
    this._state = state;
    this.emit("state", state);
  }

  _assertRunning() {
    if (this._state !== "running" || this._child === null) {
      throw new AppServerStateError("CLIENT_NOT_RUNNING", "App-server client is not running", {
        state: this._state,
      });
    }
    if (this._lastError !== null) {
      throw this._lastError;
    }
  }

  /** @param {import("node:child_process").ChildProcessWithoutNullStreams} child */
  _onSpawn(child) {
    if (child !== this._child || this._state !== "starting") {
      return;
    }
    this._spawned = true;
    this._setState("running");
    this._resolveStart?.();
    this._resolveStart = null;
    this._rejectStart = null;
  }

  /**
   * @param {import("node:child_process").ChildProcessWithoutNullStreams} child
   * @param {Error} cause
   */
  _onChildError(child, cause) {
    if (child !== this._child) {
      return;
    }
    const error = new AppServerProcessError(
      this._spawned ? "PROCESS_ERROR" : "SPAWN_FAILED",
      this._spawned
        ? "The app-server process reported an operating-system error"
        : "Could not launch the configured app-server executable",
      { stderr: this.stderr },
      cause,
    );
    this._fatal(error);
  }

  /**
   * @param {import("node:child_process").ChildProcessWithoutNullStreams} child
   * @param {"stdin" | "stdout" | "stderr"} stream
   * @param {Error} cause
   */
  _onStreamError(child, stream, cause) {
    if (child !== this._child || this._expectedStop) {
      return;
    }
    const error = new AppServerProcessError(
      "PROCESS_STREAM_ERROR",
      `The app-server ${stream} stream failed`,
      { stderr: this.stderr },
      cause,
    );
    this._fatal(error);
  }

  /**
   * @param {import("node:child_process").ChildProcessWithoutNullStreams} child
   * @param {Buffer | string} chunk
   */
  _onStdoutData(child, chunk) {
    if (child !== this._child || this._lastError !== null) {
      return;
    }
    try {
      this._consumeStdout(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    } catch (cause) {
      const error =
        cause instanceof AppServerProtocolError
          ? cause
          : new AppServerProtocolError(
              "PROTOCOL_FAILURE",
              "App-server stdout could not be processed",
              {},
              cause,
            );
      this._fatal(error);
    }
  }

  /** @param {Buffer} chunk */
  _consumeStdout(chunk) {
    this._stdoutBuffer =
      this._stdoutBuffer.length === 0 ? chunk : Buffer.concat([this._stdoutBuffer, chunk]);

    let newlineIndex = this._stdoutBuffer.indexOf(0x0a);
    while (newlineIndex !== -1) {
      const rawLine = this._stdoutBuffer.subarray(0, newlineIndex);
      this._stdoutBuffer = this._stdoutBuffer.subarray(newlineIndex + 1);
      if (rawLine.length > this._maxLineBytes) {
        throw new AppServerProtocolError(
          "LINE_TOO_LARGE",
          `App-server output exceeded the ${this._maxLineBytes}-byte line limit`,
          { maxLineBytes: this._maxLineBytes, observedBytes: rawLine.length },
        );
      }
      this._consumeLine(rawLine);
      newlineIndex = this._stdoutBuffer.indexOf(0x0a);
    }

    if (this._stdoutBuffer.length > this._maxLineBytes) {
      throw new AppServerProtocolError(
        "LINE_TOO_LARGE",
        `App-server output exceeded the ${this._maxLineBytes}-byte line limit`,
        { maxLineBytes: this._maxLineBytes, observedBytes: this._stdoutBuffer.length },
      );
    }
  }

  /** @param {Buffer} rawLine */
  _consumeLine(rawLine) {
    const line = rawLine.at(-1) === 0x0d ? rawLine.subarray(0, -1) : rawLine;
    if (line.length === 0) {
      throw new AppServerProtocolError("EMPTY_LINE", "App-server emitted an empty JSONL record");
    }

    let message;
    try {
      message = JSON.parse(line.toString("utf8"));
    } catch (cause) {
      throw new AppServerProtocolError(
        "INVALID_JSON",
        "App-server emitted malformed JSON",
        { lineBytes: line.length },
        cause,
      );
    }
    if (!isRecord(message)) {
      throw new AppServerProtocolError(
        "INVALID_MESSAGE",
        "App-server JSONL records must be objects",
      );
    }
    this._dispatchMessage(message);
  }

  /** @param {Record<string, unknown>} message */
  _dispatchMessage(message) {
    const hasId = Object.hasOwn(message, "id");
    const hasMethod = Object.hasOwn(message, "method");
    const hasResult = Object.hasOwn(message, "result");
    const hasError = Object.hasOwn(message, "error");

    if (hasId) {
      assertNumericId(message.id);
      if (hasMethod) {
        if (hasResult || hasError) {
          throw new AppServerProtocolError(
            "INVALID_MESSAGE",
            "An app-server record cannot be both a request and a response",
            { id: message.id },
          );
        }
        if (typeof message.method !== "string" || message.method.length === 0) {
          throw new AppServerProtocolError(
            "INVALID_METHOD",
            "Server-initiated request method must be a non-empty string",
            { id: message.id },
          );
        }
        void this._handleServerRequest(/** @type {number} */ (message.id), message.method, message.params);
        return;
      }
      this._handleResponse(/** @type {number} */ (message.id), message, hasResult, hasError);
      return;
    }

    if (hasMethod) {
      if (hasResult || hasError) {
        throw new AppServerProtocolError(
          "INVALID_NOTIFICATION",
          "An app-server notification cannot contain response fields",
        );
      }
      if (typeof message.method !== "string" || message.method.length === 0) {
        throw new AppServerProtocolError(
          "INVALID_METHOD",
          "App-server notification method must be a non-empty string",
        );
      }
      this.emit("notification", {
        method: message.method,
        ...(Object.hasOwn(message, "params") ? { params: message.params } : {}),
      });
      return;
    }

    throw new AppServerProtocolError(
      "INVALID_MESSAGE",
      "App-server record is neither a response, request, nor notification",
    );
  }

  /**
   * @param {number} id
   * @param {Record<string, unknown>} message
   * @param {boolean} hasResult
   * @param {boolean} hasError
   */
  _handleResponse(id, message, hasResult, hasError) {
    if (this._seenResponseIds.has(id)) {
      throw new AppServerProtocolError(
        "DUPLICATE_RESPONSE_ID",
        `App-server repeated response ID ${id}`,
        { id },
      );
    }
    const pending = this._pending.get(id);
    if (pending === undefined) {
      throw new AppServerProtocolError(
        "UNKNOWN_RESPONSE_ID",
        `App-server returned unknown response ID ${id}`,
        { id },
      );
    }
    if (hasResult === hasError) {
      throw new AppServerProtocolError(
        "INVALID_RESPONSE",
        "App-server response must contain exactly one of result or error",
        { id },
      );
    }

    this._pending.delete(id);
    this._seenResponseIds.add(id);
    this._disposePending(pending);

    if (hasError) {
      if (!isRemoteError(message.error)) {
        const error = new AppServerProtocolError(
          "INVALID_REMOTE_ERROR",
          "App-server response error has an invalid shape",
          { id },
        );
        pending.reject(error);
        throw error;
      }
      pending.reject(new AppServerRemoteError(id, pending.method, message.error, this._redact));
      return;
    }
    pending.resolve(message.result);
  }

  /**
   * @param {number} id
   * @param {string} method
   * @param {unknown} params
   */
  async _handleServerRequest(id, method, params) {
    if (this._activeServerRequestIds.has(id) || this._handledServerRequestIds.has(id)) {
      this._fatal(
        new AppServerProtocolError(
          "DUPLICATE_SERVER_REQUEST_ID",
          `App-server repeated server-request ID ${id}`,
          { id, method },
        ),
      );
      return;
    }

    this._activeServerRequestIds.add(id);
    this.emit("serverRequest", { id, method, ...(params === undefined ? {} : { params }) });

    try {
      const result = await this._serverRequestHandler({
        id,
        method,
        ...(params === undefined ? {} : { params }),
      });
      if (this._lastError !== null || this._state !== "running") {
        return;
      }
      await this._writeMessage({ id, result: result === undefined ? null : result });
    } catch (cause) {
      const error =
        cause instanceof AppServerProtocolError
          ? cause
          : new AppServerProtocolError(
              "SERVER_REQUEST_HANDLER_FAILED",
              `Handler rejected server-initiated request ${method}`,
              { id, method },
              cause,
            );
      this._fatal(error);
    } finally {
      this._activeServerRequestIds.delete(id);
      this._handledServerRequestIds.add(id);
    }
  }

  /**
   * @param {import("node:child_process").ChildProcessWithoutNullStreams} child
   * @param {Buffer | string} chunk
   */
  _onStderrData(child, chunk) {
    if (child !== this._child || this._stderrEnded) {
      return;
    }
    const text = this._stderrDecoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    this._appendStderr(text);
  }

  /** @param {string} text */
  _appendStderr(text) {
    if (text.length === 0) {
      return;
    }
    const buffer = Buffer.from(this._stderrRaw + text, "utf8");
    if (buffer.length <= this._stderrMaxBytes) {
      this._stderrRaw = buffer.toString("utf8");
      return;
    }
    this._stderrRaw = utf8Prefix(this._stderrRaw + text, this._stderrMaxBytes);
    this._stderrTruncated = true;
  }

  _finishStderr() {
    if (this._stderrEnded) {
      return;
    }
    this._stderrEnded = true;
    this._appendStderr(this._stderrDecoder.end());
  }

  /**
   * @param {import("node:child_process").ChildProcessWithoutNullStreams} child
   * @param {number | null} code
   * @param {NodeJS.Signals | null} signal
   */
  _onClose(child, code, signal) {
    if (child !== this._child) {
      return;
    }
    this._finishStderr();
    this._clearKillTimer();

    if (this._stdoutBuffer.length > 0 && this._lastError === null) {
      this._lastError = new AppServerProtocolError(
        "UNTERMINATED_LINE",
        "App-server exited with an unterminated JSONL record",
        { lineBytes: this._stdoutBuffer.length },
      );
    }

    if (!this._expectedStop && this._lastError === null) {
      this._lastError = new AppServerProcessError(
        "PROCESS_EXIT",
        "App-server process exited unexpectedly",
        { exitCode: code, signal, stderr: this.stderr },
      );
    }

    if (!this._spawned && this._lastError === null) {
      this._lastError = new AppServerProcessError(
        "SPAWN_FAILED",
        "Could not launch the configured app-server executable",
        { exitCode: code, signal, stderr: this.stderr },
      );
    }

    if (this._lastError !== null) {
      this._rejectStart?.(this._lastError);
      this._rejectAllPending(this._lastError);
    }

    this._child = null;
    this._setState(this._expectedStop && this._lastError === null ? "stopped" : "failed");
    this.emit("exit", {
      expected: this._expectedStop,
      exitCode: code,
      signal,
      stderr: this.stderr,
      error: this._lastError,
    });
    this._resolveClose?.();
    this._resolveClose = null;
    this._resolveStart = null;
    this._rejectStart = null;
  }

  /** @param {AppServerError} error */
  _failBeforeSpawn(error) {
    this._lastError = error;
    this._setState("failed");
    this._rejectStart?.(error);
    this._resolveClose?.();
  }

  /** @param {AppServerError} error */
  _fatal(error) {
    if (this._lastError !== null) {
      return;
    }
    this._lastError = error;
    this._rejectStart?.(error);
    this._rejectAllPending(error);
    this._setState("failed");
    this.emit("incident", error);

    const child = this._child;
    if (child !== null) {
      if (!child.stdin.destroyed) {
        child.stdin.end();
      }
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        this._scheduleKill(child);
      }
    }
  }

  /** @param {AppServerError} error */
  _rejectAllPending(error) {
    for (const pending of this._pending.values()) {
      this._disposePending(pending);
      pending.reject(error);
    }
    this._pending.clear();
  }

  /** @param {PendingRequest} pending */
  _disposePending(pending) {
    clearTimeout(pending.timer);
    if (pending.signal !== undefined && pending.abortListener !== undefined) {
      pending.signal.removeEventListener("abort", pending.abortListener);
    }
  }

  /** @param {unknown} message */
  _serializeMessage(message) {
    let serialized;
    try {
      serialized = JSON.stringify(message);
    } catch (cause) {
      throw new AppServerProtocolError(
        "OUTBOUND_NOT_JSON",
        "Outbound app-server message is not JSON-serializable",
        {},
        cause,
      );
    }
    if (serialized === undefined) {
      throw new AppServerProtocolError(
        "OUTBOUND_NOT_JSON",
        "Outbound app-server message is not JSON-serializable",
      );
    }
    const bytes = Buffer.byteLength(serialized, "utf8");
    if (bytes > this._maxLineBytes) {
      throw new AppServerProtocolError(
        "OUTBOUND_LINE_TOO_LARGE",
        `Outbound app-server message exceeded the ${this._maxLineBytes}-byte line limit`,
        { maxLineBytes: this._maxLineBytes, observedBytes: bytes },
      );
    }
    return `${serialized}\n`;
  }

  /** @param {unknown} message */
  _writeMessage(message) {
    return this._writeLine(this._serializeMessage(message));
  }

  /** @param {string} line */
  _writeLine(line) {
    const child = this._child;
    if (child === null || this._state !== "running" || child.stdin.destroyed) {
      return Promise.reject(
        new AppServerStateError("CLIENT_NOT_RUNNING", "App-server client is not writable", {
          state: this._state,
        }),
      );
    }
    return new Promise((resolve, reject) => {
      child.stdin.write(line, "utf8", (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  /** @param {unknown} cause */
  _asWriteError(cause) {
    if (cause instanceof AppServerError) {
      return cause;
    }
    return new AppServerProcessError(
      "PROCESS_WRITE_FAILED",
      "Could not write to app-server stdin",
      { stderr: this.stderr },
      cause,
    );
  }

  /** @param {import("node:child_process").ChildProcessWithoutNullStreams} child */
  _scheduleKill(child) {
    this._clearKillTimer();
    this._killTimer = setTimeout(() => {
      if (this._child === child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }, this._stopTimeoutMs);
    this._killTimer.unref?.();
  }

  _clearKillTimer() {
    if (this._killTimer !== null) {
      clearTimeout(this._killTimer);
      this._killTimer = null;
    }
  }
}

/**
 * @typedef {object} PendingRequest
 * @property {number} id
 * @property {string} method
 * @property {(value: unknown) => void} resolve
 * @property {(reason?: unknown) => void} reject
 * @property {NodeJS.Timeout} timer
 * @property {AbortSignal | undefined} signal
 * @property {(() => void) | undefined} abortListener
 */

/** @param {unknown} value */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {unknown} value */
function isRemoteError(value) {
  if (!isRecord(value)) {
    return false;
  }
  return (
    (typeof value.code === "number" || typeof value.code === "string") &&
    typeof value.message === "string"
  );
}

/**
 * @param {unknown} value
 * @returns {asserts value is number}
 */
function assertNumericId(value) {
  if (!Number.isSafeInteger(value) || /** @type {number} */ (value) < 0) {
    throw new AppServerProtocolError(
      "INVALID_ID",
      "App-server message ID must be a non-negative safe integer",
    );
  }
}

/** @param {string} method @param {string} label */
function assertMethod(method, label) {
  if (typeof method !== "string" || method.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

/** @param {number} value @param {string} label */
function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

/** @param {(text: string) => string} redact @param {string} text */
function safelyRedact(redact, text) {
  try {
    const result = redact(text);
    return typeof result === "string" ? result : "[REDACTED: invalid redactor result]";
  } catch {
    return "[REDACTED: redactor failure]";
  }
}

/** @param {string} text @param {number} maxBytes */
function utf8Prefix(text, maxBytes) {
  if (maxBytes <= 0) {
    return "";
  }
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) {
    return text;
  }
  let result = buffer.subarray(0, maxBytes).toString("utf8");
  while (Buffer.byteLength(result, "utf8") > maxBytes) {
    result = result.slice(0, -1);
  }
  return result;
}

/** @param {unknown} value @param {(text: string) => string} redact @param {WeakSet<object>} [seen] */
function redactValue(value, redact, seen = new WeakSet()) {
  if (typeof value === "string") {
    return safelyRedact(redact, value);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return "[REDACTED: circular]";
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, redact, seen));
  }
  /** @type {Record<string, unknown>} */
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = SECRET_KEY_PATTERN.test(key)
      ? "[REDACTED]"
      : redactValue(item, redact, seen);
    SECRET_KEY_PATTERN.lastIndex = 0;
  }
  return result;
}

const SECRET_KEY_PATTERN = /(?:api.?key|access.?token|auth.?token|authorization|credential|password|refresh.?token|secret|session.?token)/i;

/** @param {string} text */
function defaultRedact(text) {
  return text
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]+/g, "sk-[REDACTED]")
    .replace(
      /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|authorization|password|secret|session[_-]?token)\s*["']?\s*[:=]\s*["']?)[^"'\s,;}]+/gi,
      "$1[REDACTED]",
    )
    .replace(/(https?:\/\/[^\s/:@]+:)[^\s/@]+@/gi, "$1[REDACTED]@");
}
