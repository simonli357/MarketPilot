// @ts-check

import assert from "node:assert/strict";
import test from "node:test";

import {
  CRASH_BACKOFF_MS,
  CRASH_WINDOW_MS,
  CrashSupervisorPolicy,
  CrashSupervisorPolicyError,
  STABLE_RUN_RESET_MS,
} from "../../src/codex/crash-supervisor-policy.mjs";

test("applies 1s/5s/30s tiers and latches the circuit on crash three", () => {
  const policy = new CrashSupervisorPolicy();

  policy.beginAttempt(0);
  assert.deepEqual(policy.recordUnexpectedCrash(10), {
    automaticRestart: true,
    backoffMs: 1_000,
    circuit: "closed",
    crashCount: 1,
    startNotBeforeMs: 1_010,
  });
  assert.deepEqual(policy.getStartDecision(1_009), {
    allowed: false,
    reason: "backoff",
    waitMs: 1,
  });

  policy.beginAttempt(1_010);
  assert.deepEqual(policy.recordUnexpectedCrash(1_020), {
    automaticRestart: true,
    backoffMs: 5_000,
    circuit: "closed",
    crashCount: 2,
    startNotBeforeMs: 6_020,
  });

  policy.beginAttempt(6_020);
  assert.deepEqual(policy.recordUnexpectedCrash(6_030), {
    automaticRestart: false,
    backoffMs: 30_000,
    circuit: "open",
    crashCount: 3,
    startNotBeforeMs: 36_030,
  });
  assert.deepEqual(CRASH_BACKOFF_MS, [1_000, 5_000, 30_000]);

  assert.deepEqual(policy.getStartDecision(36_030), {
    allowed: false,
    reason: "circuit-open",
    waitMs: 0,
  });
  assert.throws(
    () => policy.beginAttempt(36_030),
    (error) =>
      error instanceof CrashSupervisorPolicyError && error.code === "START_NOT_ALLOWED",
  );
});

test("three crashes at the inclusive ten-minute boundary open the circuit", () => {
  const policy = new CrashSupervisorPolicy();

  policy.beginAttempt(0);
  policy.recordUnexpectedCrash(0);
  policy.beginAttempt(1_000);
  policy.recordUnexpectedCrash(1_000);
  policy.beginAttempt(6_000);

  const transition = policy.recordUnexpectedCrash(CRASH_WINDOW_MS);

  assert.equal(transition.crashCount, 3);
  assert.equal(transition.circuit, "open");
});

test("crashes older than ten minutes are excluded from the next tier", () => {
  const policy = new CrashSupervisorPolicy();

  policy.beginAttempt(0);
  policy.recordUnexpectedCrash(0);
  policy.beginAttempt(1_000);
  policy.recordUnexpectedCrash(1_000);
  policy.beginAttempt(CRASH_WINDOW_MS + 1_001);

  const transition = policy.recordUnexpectedCrash(CRASH_WINDOW_MS + 1_001);

  assert.deepEqual(transition, {
    automaticRestart: true,
    backoffMs: 1_000,
    circuit: "closed",
    crashCount: 1,
    startNotBeforeMs: CRASH_WINDOW_MS + 2_001,
  });
});

test("only a continuous ten-minute run resets crash history", () => {
  const policy = new CrashSupervisorPolicy();

  policy.beginAttempt(0);
  policy.recordUnexpectedCrash(1);
  policy.beginAttempt(1_001);

  assert.throws(
    () => policy.recordStableRun(1_001 + STABLE_RUN_RESET_MS - 1),
    (error) => error instanceof CrashSupervisorPolicyError && error.code === "RUN_NOT_STABLE",
  );
  assert.equal(policy.snapshot().crashCount, 1);

  const stable = policy.recordStableRun(1_001 + STABLE_RUN_RESET_MS);
  assert.equal(stable.crashCount, 0);
  assert.equal(stable.attemptActive, true);

  const nextCrash = policy.recordUnexpectedCrash(1_001 + STABLE_RUN_RESET_MS + 1);
  assert.equal(nextCrash.backoffMs, 1_000);
  assert.equal(nextCrash.crashCount, 1);
});

test("an expected stop is not a crash and does not erase prior crash evidence", () => {
  const policy = new CrashSupervisorPolicy();

  policy.beginAttempt(0);
  policy.recordUnexpectedCrash(1);
  policy.beginAttempt(1_001);
  const stopped = policy.recordExpectedStop(1_002);

  assert.equal(stopped.attemptActive, false);
  assert.equal(stopped.crashCount, 1);

  policy.beginAttempt(1_002);
  assert.equal(policy.recordUnexpectedCrash(1_003).backoffMs, 5_000);
});

test("operator reset requires the third-crash cooldown and clears the latch", () => {
  const policy = new CrashSupervisorPolicy();

  policy.beginAttempt(0);
  policy.recordUnexpectedCrash(0);
  policy.beginAttempt(1_000);
  policy.recordUnexpectedCrash(1_000);
  policy.beginAttempt(6_000);
  policy.recordUnexpectedCrash(6_000);

  assert.throws(
    () => policy.resetOpenCircuit(35_999),
    (error) => error instanceof CrashSupervisorPolicyError && error.code === "CIRCUIT_COOLDOWN",
  );

  const reset = policy.resetOpenCircuit(36_000);
  assert.equal(reset.circuit, "closed");
  assert.equal(reset.crashCount, 0);
  assert.deepEqual(policy.getStartDecision(36_000), {
    allowed: true,
    reason: "ready",
    waitMs: 0,
  });
});

test("rejects duplicate transitions and non-monotonic clocks", () => {
  const policy = new CrashSupervisorPolicy();

  assert.throws(
    () => policy.recordUnexpectedCrash(0),
    (error) => error instanceof CrashSupervisorPolicyError && error.code === "NO_ACTIVE_ATTEMPT",
  );
  policy.beginAttempt(1);
  policy.recordUnexpectedCrash(2);
  assert.throws(
    () => policy.recordUnexpectedCrash(2),
    (error) => error instanceof CrashSupervisorPolicyError && error.code === "NO_ACTIVE_ATTEMPT",
  );
  assert.throws(
    () => policy.getStartDecision(1),
    (error) =>
      error instanceof CrashSupervisorPolicyError && error.code === "CLOCK_MOVED_BACKWARD",
  );
});
