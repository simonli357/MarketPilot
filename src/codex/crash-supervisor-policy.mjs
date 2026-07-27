// @ts-check

export const CRASH_WINDOW_MS = 10 * 60 * 1_000;
export const STABLE_RUN_RESET_MS = CRASH_WINDOW_MS;
export const CRASH_BACKOFF_MS = Object.freeze([1_000, 5_000, 30_000]);

/** @typedef {"closed" | "open"} CircuitState */

/**
 * A typed policy error. The process-owning supervisor can map these codes to
 * incidents without parsing text.
 */
export class CrashSupervisorPolicyError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {Readonly<Record<string, unknown>>} [details]
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CrashSupervisorPolicyError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

/**
 * Timer-free app-server restart policy. Callers supply a monotonic millisecond
 * timestamp for every observation and own the actual timer/process lifecycle.
 *
 * The circuit is deliberately latched after the third unexpected crash in the
 * rolling ten-minute window. The third crash reaches the 30-second backoff
 * tier, but that delay is only the earliest permitted operator reset; it never
 * schedules an automatic fourth attempt.
 *
 * A spawn, successful initialization, or successful turn is not sufficient to
 * reset a crash loop. `recordStableRun` resets the history only after one
 * attempt has remained alive continuously for ten minutes. An expected stop
 * neither counts as a crash nor erases prior unexpected crashes.
 */
export class CrashSupervisorPolicy {
  constructor() {
    /** @type {CircuitState} */
    this._circuit = "closed";
    /** @type {number[]} */
    this._crashTimestampsMs = [];
    /** @type {number | null} */
    this._attemptStartedAtMs = null;
    /** @type {number | null} */
    this._startNotBeforeMs = null;
    /** @type {number | null} */
    this._lastObservedAtMs = null;
  }

  /**
   * Returns whether the supervisor may begin a process attempt now. Querying
   * the decision has no timer side effect, but timestamps must remain monotonic.
   *
   * @param {number} nowMs
   */
  getStartDecision(nowMs) {
    this._observeTime(nowMs);

    if (this._attemptStartedAtMs !== null) {
      return Object.freeze({
        allowed: false,
        reason: "attempt-active",
        waitMs: null,
      });
    }

    if (this._circuit === "open") {
      return Object.freeze({
        allowed: false,
        reason: "circuit-open",
        waitMs:
          this._startNotBeforeMs === null
            ? null
            : Math.max(0, this._startNotBeforeMs - nowMs),
      });
    }

    if (this._startNotBeforeMs !== null && nowMs < this._startNotBeforeMs) {
      return Object.freeze({
        allowed: false,
        reason: "backoff",
        waitMs: this._startNotBeforeMs - nowMs,
      });
    }

    return Object.freeze({ allowed: true, reason: "ready", waitMs: 0 });
  }

  /**
   * Begins one process attempt. Call this immediately before spawn so a spawn
   * failure can be recorded as that attempt's unexpected crash.
   *
   * @param {number} nowMs
   */
  beginAttempt(nowMs) {
    const decision = this.getStartDecision(nowMs);
    if (!decision.allowed) {
      throw new CrashSupervisorPolicyError(
        "START_NOT_ALLOWED",
        `App-server start is blocked by ${decision.reason}`,
        { reason: decision.reason, waitMs: decision.waitMs },
      );
    }

    this._attemptStartedAtMs = nowMs;
    return this.snapshot();
  }

  /**
   * Records an unexpected exit or spawn failure for the active attempt.
   *
   * @param {number} nowMs
   */
  recordUnexpectedCrash(nowMs) {
    this._observeTime(nowMs);
    this._requireActiveAttempt();

    const windowStartMs = nowMs - CRASH_WINDOW_MS;
    this._crashTimestampsMs = this._crashTimestampsMs.filter(
      (timestampMs) => timestampMs >= windowStartMs,
    );
    this._crashTimestampsMs.push(nowMs);
    this._attemptStartedAtMs = null;

    const crashCount = this._crashTimestampsMs.length;
    const backoffMs = CRASH_BACKOFF_MS[Math.min(crashCount - 1, CRASH_BACKOFF_MS.length - 1)];
    this._startNotBeforeMs = nowMs + backoffMs;
    this._circuit = crashCount >= CRASH_BACKOFF_MS.length ? "open" : "closed";

    return Object.freeze({
      automaticRestart: this._circuit === "closed",
      backoffMs,
      circuit: this._circuit,
      crashCount,
      startNotBeforeMs: this._startNotBeforeMs,
    });
  }

  /**
   * Records an intentional lifecycle stop. It is not a crash and does not
   * clear crash-loop evidence.
   *
   * @param {number} nowMs
   */
  recordExpectedStop(nowMs) {
    this._observeTime(nowMs);
    this._requireActiveAttempt();
    this._attemptStartedAtMs = null;
    return this.snapshot();
  }

  /**
   * Resets crash history after the active attempt has remained continuously
   * alive for ten minutes. Earlier readiness or turn success must not call this
   * method as a substitute for stability.
   *
   * @param {number} nowMs
   */
  recordStableRun(nowMs) {
    this._observeTime(nowMs);
    this._requireActiveAttempt();

    const runDurationMs = nowMs - this._attemptStartedAtMs;
    if (runDurationMs < STABLE_RUN_RESET_MS) {
      throw new CrashSupervisorPolicyError(
        "RUN_NOT_STABLE",
        `App-server run has not reached the ${STABLE_RUN_RESET_MS} ms stability threshold`,
        { runDurationMs, requiredMs: STABLE_RUN_RESET_MS },
      );
    }

    this._crashTimestampsMs = [];
    this._startNotBeforeMs = null;
    this._circuit = "closed";
    return this.snapshot();
  }

  /**
   * Clears a latched circuit after explicit operator acknowledgement. The
   * third-crash 30-second cooldown must elapse first.
   *
   * @param {number} nowMs
   */
  resetOpenCircuit(nowMs) {
    this._observeTime(nowMs);
    if (this._circuit !== "open") {
      throw new CrashSupervisorPolicyError(
        "CIRCUIT_NOT_OPEN",
        "App-server crash circuit is not open",
      );
    }
    if (this._startNotBeforeMs !== null && nowMs < this._startNotBeforeMs) {
      throw new CrashSupervisorPolicyError(
        "CIRCUIT_COOLDOWN",
        "App-server crash circuit cooldown has not elapsed",
        { waitMs: this._startNotBeforeMs - nowMs },
      );
    }

    this._crashTimestampsMs = [];
    this._startNotBeforeMs = null;
    this._circuit = "closed";
    return this.snapshot();
  }

  snapshot() {
    return Object.freeze({
      attemptActive: this._attemptStartedAtMs !== null,
      attemptStartedAtMs: this._attemptStartedAtMs,
      circuit: this._circuit,
      crashCount: this._crashTimestampsMs.length,
      crashTimestampsMs: Object.freeze([...this._crashTimestampsMs]),
      startNotBeforeMs: this._startNotBeforeMs,
    });
  }

  /** @param {number} nowMs */
  _observeTime(nowMs) {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw new TypeError("nowMs must be a non-negative safe integer");
    }
    if (this._lastObservedAtMs !== null && nowMs < this._lastObservedAtMs) {
      throw new CrashSupervisorPolicyError(
        "CLOCK_MOVED_BACKWARD",
        "Crash-supervisor timestamps must be monotonic",
        { lastObservedAtMs: this._lastObservedAtMs, nowMs },
      );
    }
    this._lastObservedAtMs = nowMs;
  }

  _requireActiveAttempt() {
    if (this._attemptStartedAtMs === null) {
      throw new CrashSupervisorPolicyError(
        "NO_ACTIVE_ATTEMPT",
        "No active app-server attempt can receive this transition",
      );
    }
  }
}
