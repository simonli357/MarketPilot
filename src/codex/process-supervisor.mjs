// @ts-check

import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import {
  CrashSupervisorPolicy,
  CrashSupervisorPolicyError,
  STABLE_RUN_RESET_MS,
} from "./crash-supervisor-policy.mjs";

const MAX_IDEMPOTENCY_KEY_BYTES = 256;
const DEFAULT_ACCEPTANCE_KEY_CAPACITY = 1_024;
const MAX_ACCEPTANCE_KEY_CAPACITY = 100_000;
const DEFAULT_ACCEPTANCE_TIMEOUT_MS = 20_000;
const MAX_ACCEPTANCE_TIMEOUT_MS = 120_000;
const CLOSED_CLIENT_STATES = new Set(["failed", "idle", "stopped"]);
const KEY_STATES = new Set(["accepted", "accepting", "uncertain"]);
const RETRYABLE_PROCESS_CODES = new Set([
  "APP_SERVER_UNAVAILABLE",
  "PROCESS_ERROR",
  "PROCESS_EXIT",
  "PROCESS_STREAM_ERROR",
  "PROCESS_WRITE_FAILED",
  "SPAWN_FAILED",
]);

const DEFAULT_CLOCK = Object.freeze({
  nowMs: () => Math.floor(performance.now()),
});

const DEFAULT_SCHEDULER = Object.freeze({
  schedule(delayMs, callback) {
    const timer = setTimeout(callback, delayMs);
    return Object.freeze({ cancel: () => clearTimeout(timer) });
  },
});

/** @typedef {"open" | "shuttingDown" | "shutdown"} SupervisorLifecycle */
/** @typedef {"accepted" | "accepting" | "uncertain"} AcceptanceState */

/**
 * A typed, content-free process-supervisor failure. Neither causes nor details
 * retain client stderr, candidate artifacts, idempotency keys, or arbitrary
 * caller errors.
 */
export class CodexProcessSupervisorError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{kind?: string, details?: Readonly<Record<string, unknown>>}} [options]
   */
  constructor(code, message, { kind = "supervisor", details = {} } = {}) {
    super(message);
    this.name = "CodexProcessSupervisorError";
    this.code = code;
    this.kind = kind;
    this.details = Object.freeze({ ...details });
  }
}

/**
 * Owns one logical Codex operation and one physical app-server attempt at a
 * time. Retry state and acceptance fences are intentionally process-local;
 * callers remain responsible for durable, cross-application idempotency.
 */
export class CodexProcessSupervisor {
  /**
   * @param {object} options
   * @param {(context: {generation: number, signal: AbortSignal}) => SupervisorClient} options.createClient
   * @param {{nowMs: () => number}} [options.clock]
   * @param {{schedule: (delayMs: number, callback: () => void) => {cancel: () => void}}} [options.scheduler]
   * @param {CrashSupervisorPolicy} [options.policy]
   * @param {number} [options.maxAcceptanceKeys]
   * @param {number} [options.acceptanceTimeoutMs]
   */
  constructor({
    createClient,
    clock = DEFAULT_CLOCK,
    scheduler = DEFAULT_SCHEDULER,
    policy = new CrashSupervisorPolicy(),
    maxAcceptanceKeys = DEFAULT_ACCEPTANCE_KEY_CAPACITY,
    acceptanceTimeoutMs = DEFAULT_ACCEPTANCE_TIMEOUT_MS,
  }) {
    if (typeof createClient !== "function") {
      throw new TypeError("createClient must be a function");
    }
    if (!clock || typeof clock !== "object" || typeof clock.nowMs !== "function") {
      throw new TypeError("clock.nowMs must be a function");
    }
    if (!scheduler || typeof scheduler !== "object" || typeof scheduler.schedule !== "function") {
      throw new TypeError("scheduler.schedule must be a function");
    }
    assertPolicy(policy);
    if (
      !Number.isSafeInteger(maxAcceptanceKeys) ||
      maxAcceptanceKeys <= 0 ||
      maxAcceptanceKeys > MAX_ACCEPTANCE_KEY_CAPACITY
    ) {
      throw new TypeError(
        `maxAcceptanceKeys must be between 1 and ${MAX_ACCEPTANCE_KEY_CAPACITY}`,
      );
    }
    if (
      !Number.isSafeInteger(acceptanceTimeoutMs) ||
      acceptanceTimeoutMs <= 0 ||
      acceptanceTimeoutMs > MAX_ACCEPTANCE_TIMEOUT_MS
    ) {
      throw new TypeError(
        `acceptanceTimeoutMs must be between 1 and ${MAX_ACCEPTANCE_TIMEOUT_MS}`,
      );
    }

    this._createClient = createClient;
    this._clock = clock;
    this._scheduler = scheduler;
    this._policy = policy;
    this._maxAcceptanceKeys = maxAcceptanceKeys;
    this._acceptanceTimeoutMs = acceptanceTimeoutMs;

    /** @type {SupervisorLifecycle} */
    this._lifecycle = "open";
    this._generation = 0;
    this._runActive = false;
    /** @type {Promise<unknown> | null} */
    this._activeRunPromise = null;
    /** @type {AbortController | null} */
    this._operationController = null;
    /** @type {AttemptRecord | null} */
    this._activeAttempt = null;
    /** @type {BackoffRecord | null} */
    this._pendingBackoff = null;
    /** @type {Map<string, AcceptanceState>} */
    this._acceptanceKeys = new Map();
    /** @type {Promise<void> | null} */
    this._shutdownCorePromise = null;
  }

  /**
   * Run one retryable process operation and cross the caller's acceptance
   * boundary exactly once. The returned value is the acceptance callback's
   * value, not an uncommitted candidate.
   *
   * @template Candidate, Accepted
   * @param {object} options
   * @param {string} options.idempotencyKey
   * @param {(context: {
   *   client: SupervisorClient,
   *   generation: number,
   *   signal: AbortSignal
   * }) => Candidate | Promise<Candidate>} options.runAttempt
   * @param {(context: {
   *   idempotencyKey: string,
   *   candidate: Candidate,
   *   signal: AbortSignal
   * }) => Accepted | Promise<Accepted>} options.accept
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<Accepted>}
   */
  run({ idempotencyKey, runAttempt, accept, signal }) {
    try {
      this._assertOpen();
      if (this._runActive) {
        throw new CodexProcessSupervisorError(
          "RUN_ALREADY_ACTIVE",
          "Only one Codex supervisor operation may run at a time",
          { kind: "state" },
        );
      }
      if (typeof runAttempt !== "function") {
        throw new TypeError("runAttempt must be a function");
      }
      if (typeof accept !== "function") {
        throw new TypeError("accept must be a function");
      }
      if (signal !== undefined && !isAbortSignal(signal)) {
        throw new TypeError("signal must be an AbortSignal");
      }
      const keyDigest = digestIdempotencyKey(idempotencyKey);
      const priorState = this._acceptanceKeys.get(keyDigest);
      if (priorState !== undefined) {
        throw fencedKeyError(keyDigest, priorState);
      }
      if (this._acceptanceKeys.size >= this._maxAcceptanceKeys) {
        throw new CodexProcessSupervisorError(
          "ACCEPTANCE_FENCE_CAPACITY",
          "In-memory acceptance fence capacity is exhausted",
          {
            kind: "acceptance",
            details: { capacity: this._maxAcceptanceKeys },
          },
        );
      }
      if (signal?.aborted) {
        throw operationAbortedError();
      }

      const controller = new AbortController();
      this._operationController = controller;
      this._runActive = true;
      const onAbort = () => {
        this._abortOperation(controller);
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      const operation = this._runLoop({
        idempotencyKey,
        keyDigest,
        runAttempt,
        accept,
        signal: controller.signal,
      });
      const tracked = operation.finally(() => {
        signal?.removeEventListener("abort", onAbort);
        if (this._operationController === controller) this._operationController = null;
        this._runActive = false;
        if (this._activeRunPromise === tracked) this._activeRunPromise = null;
      });
      this._activeRunPromise = tracked;
      return tracked;
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /** Permanently stop this supervisor and await the active client and run. */
  async shutdown() {
    const activeRun = this._activeRunPromise;
    const shutdownCore = this._requestPermanentStop();
    const [shutdownResult] = await Promise.allSettled([
      shutdownCore,
      activeRun ?? Promise.resolve(),
    ]);
    if (shutdownResult.status === "rejected") throw shutdownResult.reason;
  }

  /** Explicit operator reset; permitted only while fully idle and still open. */
  resetOpenCircuit() {
    this._assertOpen();
    if (this._runActive || this._activeAttempt !== null || this._pendingBackoff !== null) {
      throw new CodexProcessSupervisorError(
        "CIRCUIT_RESET_BUSY",
        "Crash circuit can be reset only while the supervisor is idle",
        { kind: "state" },
      );
    }
    try {
      this._policy.resetOpenCircuit(this._nowMs());
    } catch (error) {
      if (error instanceof CrashSupervisorPolicyError) {
        throw new CodexProcessSupervisorError(
          error.code === "CIRCUIT_COOLDOWN" ? "CIRCUIT_RESET_COOLDOWN" : "CIRCUIT_RESET_REJECTED",
          "Crash circuit reset was rejected by policy",
          {
            kind: "circuit",
            details: {
              waitMs: safeNonNegativeInteger(error.details.waitMs),
            },
          },
        );
      }
      throw new CodexProcessSupervisorError(
        "CIRCUIT_RESET_REJECTED",
        "Crash circuit reset failed",
        { kind: "circuit" },
      );
    }
    return this.snapshot();
  }

  /** Redaction-safe, immutable process-local observability. */
  snapshot() {
    const policy = this._policy.snapshot();
    let acceptedKeyCount = 0;
    let acceptingKeyCount = 0;
    let uncertainKeyCount = 0;
    for (const state of this._acceptanceKeys.values()) {
      if (state === "accepted") acceptedKeyCount += 1;
      if (state === "accepting") acceptingKeyCount += 1;
      if (state === "uncertain") uncertainKeyCount += 1;
    }
    return Object.freeze({
      lifecycle: this._lifecycle,
      generation: this._generation,
      runActive: this._runActive,
      activeAttemptGeneration: this._activeAttempt?.generation ?? null,
      pendingBackoff: this._pendingBackoff !== null,
      circuit: policy.circuit,
      crashCount: policy.crashCount,
      startNotBeforeMs: policy.startNotBeforeMs,
      acceptedKeyCount,
      acceptingKeyCount,
      uncertainKeyCount,
      acceptanceKeyCapacity: this._maxAcceptanceKeys,
      acceptanceTimeoutMs: this._acceptanceTimeoutMs,
      fencedKeyCount: this._acceptanceKeys.size,
    });
  }

  /** @private */
  async _runLoop({ idempotencyKey, keyDigest, runAttempt, accept, signal }) {
    while (true) {
      this._throwIfStopping(signal);
      const decision = this._getStartDecision();
      if (decision.reason === "circuit-open") {
        throw circuitOpenError(this._policy.snapshot(), decision.waitMs);
      }
      if (!decision.allowed) {
        if (decision.reason !== "backoff" || !Number.isSafeInteger(decision.waitMs)) {
          throw new CodexProcessSupervisorError(
            "START_STATE_INVALID",
            "Crash policy returned an unsupported start state",
            { kind: "state" },
          );
        }
        await this._waitForBackoff(/** @type {number} */ (decision.waitMs), signal);
        continue;
      }

      const outcome = await this._executeGeneration(runAttempt, signal);
      this._throwIfStopping(signal);
      if (outcome.type === "crash") {
        if (!outcome.transition.automaticRestart) {
          throw circuitOpenError(this._policy.snapshot(), outcome.transition.backoffMs);
        }
        continue;
      }
      if (outcome.type === "failure") {
        throw attemptFailureError(outcome.error);
      }

      this._throwIfStopping(signal);
      this._acceptanceKeys.set(keyDigest, "accepting");
      let accepted;
      try {
        accepted = await this._runAcceptance({
          accept,
          idempotencyKey,
          candidate: outcome.candidate,
          signal,
        });
      } catch (error) {
        this._acceptanceKeys.set(keyDigest, "uncertain");
        const code = error instanceof CodexProcessSupervisorError
          ? error.code
          : "ACCEPTANCE_UNCERTAIN";
        throw new CodexProcessSupervisorError(
          code,
          "Caller acceptance outcome is uncertain and its key is permanently fenced",
          {
            kind: "acceptance",
            details: { idempotencyKeySha256: keyDigest },
          },
        );
      }
      this._acceptanceKeys.set(keyDigest, "accepted");
      if (this._lifecycle !== "open" || signal.aborted) {
        throw new CodexProcessSupervisorError(
          "ACCEPTANCE_COMPLETED_AFTER_ABORT",
          "Acceptance completed after operation abort or shutdown and cannot be returned",
          {
            kind: "acceptance",
            details: { idempotencyKeySha256: keyDigest },
          },
        );
      }
      return accepted;
    }
  }

  /** @private */
  _runAcceptance({ accept, idempotencyKey, candidate, signal }) {
    return new Promise((resolve, reject) => {
      let settled = false;
      /** @type {{cancel: () => void} | null} */
      let timeoutHandle = null;
      const settle = (error, value) => {
        if (settled) return;
        settled = true;
        try {
          timeoutHandle?.cancel();
        } catch {
          // The settled fence remains authoritative if cancellation fails.
        }
        signal.removeEventListener("abort", onAbort);
        if (error === undefined) resolve(value);
        else reject(error);
      };
      const onAbort = () => settle(new CodexProcessSupervisorError(
        "ACCEPTANCE_ABORTED_UNCERTAIN",
        "Acceptance was aborted before its outcome became conclusive",
        { kind: "acceptance" },
      ));
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }

      const acceptance = Promise.resolve().then(() => {
        if (settled || signal.aborted) return undefined;
        return accept({ idempotencyKey, candidate, signal });
      });
      void acceptance.catch(() => {});
      acceptance.then(
        (value) => settle(undefined, value),
        () => settle(new CodexProcessSupervisorError(
          "ACCEPTANCE_UNCERTAIN",
          "Caller acceptance rejected with an uncertain outcome",
          { kind: "acceptance" },
        )),
      );

      try {
        const handle = this._scheduler.schedule(this._acceptanceTimeoutMs, () => {
          settle(new CodexProcessSupervisorError(
            "ACCEPTANCE_TIMEOUT_UNCERTAIN",
            "Acceptance exceeded its bounded deadline",
            { kind: "acceptance", details: { timeoutMs: this._acceptanceTimeoutMs } },
          ));
        });
        if (!handle || typeof handle !== "object" || typeof handle.cancel !== "function") {
          throw new TypeError("scheduler handle must expose cancel");
        }
        timeoutHandle = handle;
        if (settled) timeoutHandle.cancel();
      } catch {
        settle(new CodexProcessSupervisorError(
          "ACCEPTANCE_SCHEDULER_UNCERTAIN",
          "Acceptance timeout could not be scheduled",
          { kind: "acceptance" },
        ));
      }
    });
  }

  /** @private */
  async _executeGeneration(runAttempt, operationSignal) {
    let generation;
    try {
      this._policy.beginAttempt(this._nowMs());
      generation = ++this._generation;
    } catch {
      throw new CodexProcessSupervisorError(
        "POLICY_TRANSITION_FAILED",
        "Crash policy could not begin a process attempt",
        { kind: "state" },
      );
    }

    const controller = new AbortController();
    /** @type {SupervisorClient} */
    let client;
    try {
      client = this._createClient({ generation, signal: controller.signal });
      assertClient(client);
    } catch (error) {
      controller.abort();
      if (isTypedProcessFailure(error)) {
        return Object.freeze({
          type: "crash",
          transition: this._recordUnexpectedCrash(),
        });
      }
      this._recordExpectedStop();
      return Object.freeze({ type: "failure", error });
    }

    /** @type {AttemptRecord} */
    const attempt = {
      generation,
      client,
      controller,
      crashExitObserved: false,
      failureExitObserved: false,
      settled: false,
      exitListener: () => {},
      operationAbortListener: () => {},
      operationSignal,
      stableTimer: null,
    };
    this._activeAttempt = attempt;

    const outcomePromise = new Promise((resolve) => {
      const settle = (outcome) => {
        if (attempt.settled) return;
        attempt.settled = true;
        cancelAttemptStableTimer(attempt);
        resolve(outcome);
      };
      attempt.exitListener = (event) => {
        const disposition = classifyExit(event);
        if (disposition === "crash") {
          attempt.crashExitObserved = true;
          settle(Object.freeze({ type: "crash" }));
        } else if (disposition === "failure") {
          attempt.failureExitObserved = true;
          settle(Object.freeze({ type: "failure", error: exitFailureMarker() }));
        }
      };
      attempt.operationAbortListener = () => {
        controller.abort();
        settle(Object.freeze({ type: "aborted" }));
      };
      client.on("exit", attempt.exitListener);
      operationSignal.addEventListener("abort", attempt.operationAbortListener, { once: true });

      Promise.resolve()
        .then(() => client.start())
        .then(() => {
          if (
            attempt.settled ||
            attempt.crashExitObserved ||
            !this._isCurrentAttempt(attempt) ||
            operationSignal.aborted
          ) {
            settle(Object.freeze({ type: "aborted" }));
            return;
          }
          try {
            const handle = this._scheduler.schedule(STABLE_RUN_RESET_MS, () => {
              attempt.stableTimer = null;
              if (
                attempt.settled ||
                attempt.crashExitObserved ||
                !this._isCurrentAttempt(attempt) ||
                operationSignal.aborted ||
                client.state !== "running"
              ) {
                return;
              }
              try {
                this._policy.recordStableRun(this._nowMs());
              } catch {
                settle(Object.freeze({
                  type: "failure",
                  error: new CodexProcessSupervisorError(
                    "STABLE_RUN_TRANSITION_FAILED",
                    "Crash policy could not record a stable process generation",
                    { kind: "state" },
                  ),
                }));
              }
            });
            if (!handle || typeof handle !== "object" || typeof handle.cancel !== "function") {
              throw new TypeError("scheduler handle must expose cancel");
            }
            attempt.stableTimer = handle;
            if (attempt.settled) cancelAttemptStableTimer(attempt);
          } catch {
            settle(Object.freeze({
              type: "failure",
              error: new CodexProcessSupervisorError(
                "STABLE_RUN_SCHEDULER_FAILED",
                "Stable-run reset timer could not be scheduled",
                { kind: "state" },
              ),
            }));
            return;
          }
          if (attempt.settled) return;
          Promise.resolve()
            .then(() => runAttempt({ client, generation, signal: controller.signal }))
            .then(
              (candidate) => settle(Object.freeze({ type: "candidate", candidate })),
              (error) => settle(Object.freeze({
                type: isTypedProcessFailure(error) ? "crash" : "failure",
                error,
              })),
            );
        }, (error) => {
          settle(Object.freeze({
            type: isTypedProcessFailure(error) ? "crash" : "failure",
            error,
          }));
        });
    });

    const outcome = await outcomePromise;
    controller.abort();
    const stopping = this._lifecycle !== "open" || operationSignal.aborted;
    await this._closeAttempt(attempt);

    if (stopping || outcome.type === "aborted") {
      this._recordExpectedStop();
      throw this._lifecycle === "open" ? operationAbortedError() : shutdownError();
    }
    if (outcome.type === "crash" || attempt.crashExitObserved) {
      return Object.freeze({
        type: "crash",
        transition: this._recordUnexpectedCrash(),
      });
    }

    this._recordExpectedStop();
    if (outcome.type === "candidate" && attempt.failureExitObserved) {
      return Object.freeze({ type: "failure", error: exitFailureMarker() });
    }
    return outcome;
  }

  /** @private */
  async _closeAttempt(attempt) {
    let closeFailed = false;
    cancelAttemptStableTimer(attempt);
    try {
      await attempt.client.stop();
      if (!CLOSED_CLIENT_STATES.has(attempt.client.state)) closeFailed = true;
    } catch {
      closeFailed = true;
    } finally {
      attempt.client.off("exit", attempt.exitListener);
      attempt.operationSignal.removeEventListener("abort", attempt.operationAbortListener);
      if (this._activeAttempt === attempt) this._activeAttempt = null;
    }
    if (closeFailed) {
      void this._requestPermanentStop();
      throw new CodexProcessSupervisorError(
        "CLIENT_CLOSE_FAILED",
        "App-server client did not reach a conclusive closed state",
        { kind: "process", details: { generation: attempt.generation } },
      );
    }
  }

  /** @private */
  _recordUnexpectedCrash() {
    try {
      return this._policy.recordUnexpectedCrash(this._nowMs());
    } catch {
      void this._requestPermanentStop();
      throw new CodexProcessSupervisorError(
        "POLICY_TRANSITION_FAILED",
        "Crash policy could not record an unexpected process exit",
        { kind: "state" },
      );
    }
  }

  /** @private */
  _recordExpectedStop() {
    try {
      this._policy.recordExpectedStop(this._nowMs());
    } catch {
      void this._requestPermanentStop();
      throw new CodexProcessSupervisorError(
        "POLICY_TRANSITION_FAILED",
        "Crash policy could not record an expected process stop",
        { kind: "state" },
      );
    }
  }

  /** @private */
  _getStartDecision() {
    try {
      return this._policy.getStartDecision(this._nowMs());
    } catch {
      throw new CodexProcessSupervisorError(
        "POLICY_DECISION_FAILED",
        "Crash policy could not produce a start decision",
        { kind: "state" },
      );
    }
  }

  /** @private */
  _waitForBackoff(delayMs, signal) {
    if (!Number.isSafeInteger(delayMs) || delayMs < 0) {
      return Promise.reject(new CodexProcessSupervisorError(
        "BACKOFF_INVALID",
        "Crash policy produced an invalid retry delay",
        { kind: "state" },
      ));
    }
    if (delayMs === 0) return Promise.resolve();
    if (this._pendingBackoff !== null) {
      return Promise.reject(new CodexProcessSupervisorError(
        "BACKOFF_ALREADY_PENDING",
        "Only one restart backoff may be active",
        { kind: "state" },
      ));
    }

    return new Promise((resolve, reject) => {
      const generationFence = this._generation;
      /** @type {BackoffRecord} */
      const record = {
        delayMs,
        handle: null,
        settled: false,
        reject,
        cancel: () => {},
      };
      const settle = (error) => {
        if (record.settled) return;
        record.settled = true;
        try {
          record.handle?.cancel();
        } catch {
          // Generation and signal fences still prevent a canceled callback
          // from launching a replacement.
        }
        signal.removeEventListener("abort", onAbort);
        if (this._pendingBackoff === record) this._pendingBackoff = null;
        if (error === undefined) resolve();
        else reject(error);
      };
      record.cancel = settle;
      const onAbort = () => settle(this._stopError());
      signal.addEventListener("abort", onAbort, { once: true });
      this._pendingBackoff = record;
      try {
        const handle = this._scheduler.schedule(delayMs, () => {
          if (
            this._lifecycle !== "open" ||
            signal.aborted ||
            this._generation !== generationFence
          ) {
            settle(this._stopError());
            return;
          }
          settle();
        });
        if (!handle || typeof handle !== "object" || typeof handle.cancel !== "function") {
          throw new TypeError("scheduler handle must expose cancel");
        }
        record.handle = handle;
      } catch {
        settle(new CodexProcessSupervisorError(
          "SCHEDULER_FAILED",
          "Restart backoff could not be scheduled",
          { kind: "state", details: { delayMs } },
        ));
      }
    });
  }

  /** @private */
  _cancelPendingBackoff() {
    const record = this._pendingBackoff;
    if (record === null || record.settled) return;
    record.cancel(this._stopError());
  }

  /** @private */
  _abortOperation(controller) {
    if (this._operationController !== controller || controller.signal.aborted) return;
    this._generation += 1;
    controller.abort();
    this._cancelPendingBackoff();
    const attempt = this._activeAttempt;
    if (attempt !== null) {
      attempt.controller.abort();
      void Promise.resolve(attempt.client.stop()).catch(() => {});
    }
  }

  /** @private */
  _requestPermanentStop() {
    if (this._shutdownCorePromise !== null) return this._shutdownCorePromise;
    this._lifecycle = "shuttingDown";
    this._generation += 1;
    this._cancelPendingBackoff();
    this._operationController?.abort();
    this._activeAttempt?.controller.abort();
    const client = this._activeAttempt?.client ?? null;
    this._shutdownCorePromise = (async () => {
      let closeFailed = false;
      if (client !== null) {
        try {
          await client.stop();
          if (!CLOSED_CLIENT_STATES.has(client.state)) closeFailed = true;
        } catch {
          closeFailed = true;
        }
      }
      this._lifecycle = "shutdown";
      if (closeFailed) {
        throw new CodexProcessSupervisorError(
          "SHUTDOWN_CLOSE_FAILED",
          "Supervisor shutdown could not conclusively close the app-server client",
          { kind: "process" },
        );
      }
    })();
    void this._shutdownCorePromise.catch(() => {});
    return this._shutdownCorePromise;
  }

  /** @private */
  _isCurrentAttempt(attempt) {
    return (
      this._lifecycle === "open" &&
      this._activeAttempt === attempt &&
      this._generation === attempt.generation
    );
  }

  /** @private */
  _throwIfStopping(signal) {
    if (this._lifecycle !== "open") throw shutdownError();
    if (signal.aborted) throw operationAbortedError();
  }

  /** @private */
  _stopError() {
    return this._lifecycle === "open" ? operationAbortedError() : shutdownError();
  }

  /** @private */
  _assertOpen() {
    if (this._lifecycle !== "open") {
      throw new CodexProcessSupervisorError(
        "SUPERVISOR_SHUTDOWN",
        "Codex process supervisor is permanently shut down",
        { kind: "state" },
      );
    }
  }

  /** @private */
  _nowMs() {
    let nowMs;
    try {
      nowMs = this._clock.nowMs();
    } catch {
      throw new CodexProcessSupervisorError(
        "CLOCK_INVALID",
        "Supervisor clock failed",
        { kind: "state" },
      );
    }
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw new CodexProcessSupervisorError(
        "CLOCK_INVALID",
        "Supervisor clock must return a non-negative safe integer",
        { kind: "state" },
      );
    }
    return nowMs;
  }
}

/** @param {unknown} policy */
function assertPolicy(policy) {
  if (!policy || typeof policy !== "object") throw new TypeError("policy must be an object");
  for (const method of [
    "beginAttempt",
    "getStartDecision",
    "recordExpectedStop",
    "recordStableRun",
    "recordUnexpectedCrash",
    "resetOpenCircuit",
    "snapshot",
  ]) {
    if (typeof Reflect.get(policy, method) !== "function") {
      throw new TypeError(`policy.${method} must be a function`);
    }
  }
}

/** @param {unknown} client */
function assertClient(client) {
  if (!client || typeof client !== "object") throw new TypeError("client must be an object");
  for (const method of ["on", "off", "start", "stop"]) {
    if (typeof Reflect.get(client, method) !== "function") {
      throw new TypeError(`client.${method} must be a function`);
    }
  }
  if (typeof Reflect.get(client, "state") !== "string") {
    throw new TypeError("client.state must be text");
  }
}

/** @param {AttemptRecord} attempt */
function cancelAttemptStableTimer(attempt) {
  const handle = attempt.stableTimer;
  attempt.stableTimer = null;
  if (handle === null) return;
  try {
    handle.cancel();
  } catch {
    // Attempt settlement and generation checks remain authoritative if the
    // scheduler cannot cancel an already-fenced callback.
  }
}

/** @param {unknown} error */
function isTypedProcessFailure(error) {
  try {
    if (!(error instanceof Error)) return false;
  } catch {
    return false;
  }
  const kind = readProperty(error, "kind");
  if (!kind.ok || kind.value !== "process") return false;
  const code = readProperty(error, "code");
  return code.ok && RETRYABLE_PROCESS_CODES.has(code.value);
}

/** @param {unknown} event @returns {"crash" | "expected" | "failure"} */
function classifyExit(event) {
  if (!event || typeof event !== "object") return "failure";
  const error = readProperty(event, "error");
  if (!error.ok) return "failure";
  if (error.value != null) return isTypedProcessFailure(error.value) ? "crash" : "failure";
  const expected = readProperty(event, "expected");
  if (!expected.ok) return "failure";
  return expected.value === true ? "expected" : "crash";
}

/** @param {unknown} error */
function attemptFailureError(error) {
  return new CodexProcessSupervisorError(
    "ATTEMPT_FAILED",
    "Codex process attempt failed without an automatic retry",
    {
      kind: "attempt",
      details: { failureClass: classifyFailure(error) },
    },
  );
}

function exitFailureMarker() {
  return new CodexProcessSupervisorError(
    "EXIT_NOT_RETRYABLE",
    "App-server exit was not classified as retryable process unavailability",
    { kind: "attempt" },
  );
}

/** @param {unknown} error */
function classifyFailure(error) {
  if (!error || typeof error !== "object") return "unknown";
  const code = readProperty(error, "code");
  const kind = readProperty(error, "kind");
  if (!code.ok || !kind.ok) return "unknown";
  if (code.value === "AUTH_REQUIRED") return "auth";
  if (code.value === "RATE_LIMITED") return "rate-limit";
  if (code.value === "OUTPUT_INVALID" || code.value === "OUTPUT_AMBIGUOUS") return "schema";
  if (code.value === "MODEL_REROUTED" || kind.value === "policy") return "policy";
  if (kind.value === "protocol") return "protocol";
  if (kind.value === "aborted") return "aborted";
  if (kind.value === "service") return "service";
  return "unknown";
}

/**
 * Property classification accepts objects supplied by process and caller
 * boundaries. Accessor and Proxy traps must therefore fail closed instead of
 * escaping a promise callback and leaving its attempt unsettled.
 * @param {object} value
 * @param {string} property
 * @returns {{ok: true, value: unknown} | {ok: false, value: undefined}}
 */
function readProperty(value, property) {
  try {
    return { ok: true, value: Reflect.get(value, property) };
  } catch {
    return { ok: false, value: undefined };
  }
}

/** @param {ReturnType<CrashSupervisorPolicy["snapshot"]>} policy @param {unknown} waitMs */
function circuitOpenError(policy, waitMs) {
  return new CodexProcessSupervisorError(
    "CRASH_CIRCUIT_OPEN",
    "Codex process crash circuit is open",
    {
      kind: "circuit",
      details: {
        crashCount: policy.crashCount,
        waitMs: safeNonNegativeInteger(waitMs),
      },
    },
  );
}

/** @param {string} keyDigest @param {AcceptanceState} state */
function fencedKeyError(keyDigest, state) {
  return new CodexProcessSupervisorError(
    "IDEMPOTENCY_KEY_FENCED",
    "Idempotency key has already crossed or entered the acceptance boundary",
    {
      kind: "acceptance",
      details: {
        idempotencyKeySha256: keyDigest,
        acceptanceState: KEY_STATES.has(state) ? state : "uncertain",
      },
    },
  );
}

function operationAbortedError() {
  return new CodexProcessSupervisorError(
    "OPERATION_ABORTED",
    "Codex supervisor operation was aborted",
    { kind: "aborted" },
  );
}

function shutdownError() {
  return new CodexProcessSupervisorError(
    "SUPERVISOR_SHUTDOWN",
    "Codex process supervisor is permanently shut down",
    { kind: "state" },
  );
}

/** @param {unknown} value */
function safeNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && /** @type {number} */ (value) >= 0 ? value : null;
}

/** @param {unknown} value */
function digestIdempotencyKey(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("idempotencyKey must be non-empty text");
  }
  if (Buffer.byteLength(value, "utf8") > MAX_IDEMPOTENCY_KEY_BYTES) {
    throw new TypeError(`idempotencyKey exceeds ${MAX_IDEMPOTENCY_KEY_BYTES} bytes`);
  }
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** @param {unknown} value */
function isAbortSignal(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof Reflect.get(value, "aborted") === "boolean" &&
      typeof Reflect.get(value, "addEventListener") === "function" &&
      typeof Reflect.get(value, "removeEventListener") === "function",
  );
}

/**
 * @typedef {object} SupervisorClient
 * @property {string} state
 * @property {() => Promise<void>} start
 * @property {() => Promise<void>} stop
 * @property {(event: "exit", listener: (event: unknown) => void) => unknown} on
 * @property {(event: "exit", listener: (event: unknown) => void) => unknown} off
 */

/**
 * @typedef {object} AttemptRecord
 * @property {number} generation
 * @property {SupervisorClient} client
 * @property {AbortController} controller
 * @property {boolean} crashExitObserved
 * @property {boolean} failureExitObserved
 * @property {boolean} settled
 * @property {(event: unknown) => void} exitListener
 * @property {() => void} operationAbortListener
 * @property {AbortSignal} operationSignal
 * @property {{cancel: () => void} | null} stableTimer
 */

/**
 * @typedef {object} BackoffRecord
 * @property {number} delayMs
 * @property {{cancel: () => void} | null} handle
 * @property {boolean} settled
 * @property {(error: unknown) => void} reject
 * @property {(error?: unknown) => void} cancel
 */
