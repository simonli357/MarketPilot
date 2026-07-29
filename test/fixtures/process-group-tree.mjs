#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

const [scenario = "hold", marker, role, behavior] = process.argv.slice(2);

if (!/^marketpilot-pg-test-[0-9a-f-]{36}$/u.test(marker ?? "")) {
  throw new Error("process-group fixture requires an exact per-test marker");
}

if (scenario === "client-harness") {
  await runClientHarness();
} else if (role === "grandchild") {
  if (behavior === "ignore-term") {
    process.on("SIGTERM", () => {});
  }
  process.send?.({ type: "ready" });
  // Fixture-only containment fallback: even a pre-ready setsid escape cannot
  // survive a failed test indefinitely.
  setTimeout(() => process.exit(0), 15_000);
  setInterval(() => {}, 1_000);
} else {
  await runLeader(scenario);
}

async function runLeader(selectedScenario) {
  const escaped = selectedScenario === "setsid-escape";
  const ignoreTerm = ["term-ignore", "leader-exit-term-ignore"].includes(selectedScenario);
  const inheritPipes = selectedScenario === "leader-exit-inherited";
  const descendant = spawn(
    process.execPath,
    [
      process.argv[1],
      selectedScenario,
      marker,
      "grandchild",
      ignoreTerm ? "ignore-term" : "default",
    ],
    {
      // This fixture intentionally demonstrates the boundary: detached=true
      // calls setsid for the descendant, which escapes the leader's PGID and
      // therefore must be cleaned explicitly by the test's outer owner.
      detached: escaped,
      stdio: inheritPipes
        ? ["ignore", process.stdout, process.stderr, "ipc"]
        : ["ignore", "ignore", "ignore", "ipc"],
    },
  );
  await waitForGrandchildReady(descendant);
  descendant.disconnect();
  descendant.unref();

  const [leaderIdentity, descendantIdentity] = await Promise.all([
    readProcessIdentity(process.pid),
    waitForProcessIdentity(descendant.pid),
  ]);
  process.stdout.write(`${JSON.stringify({
    method: "fixture/process-tree-ready",
    params: {
      scenario: selectedScenario,
      leaderPid: process.pid,
      leaderPgid: leaderIdentity.pgid,
      leaderSession: leaderIdentity.session,
      leaderStartTicks: leaderIdentity.startTicks,
      descendantPid: descendant.pid,
      descendantPgid: descendantIdentity.pgid,
      descendantSession: descendantIdentity.session,
      descendantStartTicks: descendantIdentity.startTicks,
      escaped,
    },
  })}\n`);

  process.stdin.resume();
  process.stdin.on("end", () => {
    if (selectedScenario === "eof-clean") {
      setTimeout(() => process.exit(0), 20);
    }
  });

  if (selectedScenario === "crash") {
    setTimeout(() => process.exit(70), 20);
  } else if (selectedScenario === "leader-exit-inherited") {
    setTimeout(() => process.exit(17), 20);
  } else if (selectedScenario === "leader-exit-term-ignore") {
    setTimeout(() => process.exit(18), 20);
  }

  setInterval(() => {}, 1_000);
}

async function waitForProcessIdentity(pid) {
  let lastError;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      return await readProcessIdentity(pid);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }
  throw lastError;
}

async function readProcessIdentity(pid) {
  const stat = await readFile(`/proc/${pid}/stat`, "utf8");
  const closingParenthesis = stat.lastIndexOf(")");
  if (closingParenthesis < 0) throw new Error("invalid proc stat fixture");
  const fieldsAfterCommand = stat.slice(closingParenthesis + 1).trim().split(/\s+/u);
  const pgid = Number(fieldsAfterCommand[2]);
  const session = Number(fieldsAfterCommand[3]);
  const startTicks = fieldsAfterCommand[19];
  if (
    !Number.isSafeInteger(pgid) ||
    !Number.isSafeInteger(session) ||
    !/^[1-9][0-9]*$/u.test(startTicks)
  ) {
    throw new Error("invalid process identity fixture");
  }
  return { pgid, session, startTicks };
}

/** @param {import("node:child_process").ChildProcess} child */
function waitForGrandchildReady(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("grandchild readiness timed out")),
      10_000,
    );
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("message", (message) => {
      if (message?.type !== "ready") {
        clearTimeout(timer);
        reject(new Error("invalid grandchild readiness message"));
        return;
      }
      clearTimeout(timer);
      resolve();
    });
  });
}

async function runClientHarness() {
  const { AppServerClient } = await import("../../src/codex/app-server-client.mjs");
  const client = new AppServerClient({
    command: process.execPath,
    args: [process.argv[1], "leader-exit-term-ignore", marker],
    stopTimeoutMs: 40,
    requestTimeoutMs: 500,
  });
  const ready = new Promise((resolve) => {
    const onNotification = (notification) => {
      if (notification.method !== "fixture/process-tree-ready") return;
      client.off("notification", onNotification);
      resolve(notification.params);
    };
    client.on("notification", onNotification);
  });
  await client.start();
  const tree = await ready;
  process.stdout.write(`${JSON.stringify({ type: "started", tree })}\n`);
  await client.stop();
  process.stdout.write(`${JSON.stringify({ type: "cleaned", pgid: tree.leaderPgid })}\n`);
}
