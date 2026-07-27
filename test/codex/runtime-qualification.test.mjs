// @ts-check

import assert from "node:assert/strict";
import { chmod, link, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  RuntimeQualificationError,
  qualifyPackagedCodexRuntime,
} from "../../src/codex/runtime-qualification.mjs";

const SUPPORTED_HOST = Object.freeze({
  platform: "linux",
  arch: "x64",
  release: "test",
  distributionId: "ubuntu",
  distributionVersion: "24.04",
  nodeVersion: "22.0.0",
});

test("host mismatch aborts before package resolution or executable invocation", async (t) => {
  const root = await privateTemporaryDirectory(t, "marketpilot-host-mismatch-");
  let resolveCalls = 0;
  let executeCalls = 0;

  await assert.rejects(
    qualifyPackagedCodexRuntime({
      projectRoot: root,
      schemaDir: path.join(root, "schema"),
      cwd: root,
      env: {},
      dependencies: {
        readHost: async () => ({ ...SUPPORTED_HOST, arch: "arm64" }),
        resolveInstallation: () => {
          resolveCalls += 1;
          throw new Error("must not resolve");
        },
        execute: async () => {
          executeCalls += 1;
          throw new Error("must not execute");
        },
      },
    }),
    (error) => {
      assert(error instanceof RuntimeQualificationError);
      assert.equal(error.code, "HOST_MISMATCH");
      return true;
    },
  );
  assert.equal(resolveCalls, 0);
  assert.equal(executeCalls, 0);
});

test("package mismatch aborts before executable invocation", async (t) => {
  const root = await privateTemporaryDirectory(t, "marketpilot-package-mismatch-");
  let executeCalls = 0;

  await assert.rejects(
    qualifyPackagedCodexRuntime({
      projectRoot: root,
      schemaDir: path.join(root, "schema"),
      cwd: root,
      env: {},
      dependencies: {
        readHost: async () => SUPPORTED_HOST,
        resolveInstallation: () => {
          throw new Error("wrong package version");
        },
        execute: async () => {
          executeCalls += 1;
          throw new Error("must not execute");
        },
      },
    }),
    (error) => {
      assert(error instanceof RuntimeQualificationError);
      assert.equal(error.code, "PACKAGE_MISMATCH");
      return true;
    },
  );
  assert.equal(executeCalls, 0);
});

test("binary digest mismatch aborts before version or schema execution", async (t) => {
  const root = await privateTemporaryDirectory(t, "marketpilot-binary-mismatch-");
  const binaryPath = path.join(root, "codex");
  await writeFile(binaryPath, "#!/bin/sh\necho must-not-run > invoked\n", { mode: 0o700 });
  let executeCalls = 0;

  await assert.rejects(
    qualifyPackagedCodexRuntime({
      projectRoot: root,
      schemaDir: path.join(root, "schema"),
      cwd: root,
      env: {},
      dependencies: {
        readHost: async () => SUPPORTED_HOST,
        resolveInstallation: () => ({ binaryPath }),
        execute: async () => {
          executeCalls += 1;
          throw new Error("must not execute");
        },
      },
    }),
    (error) => {
      assert(error instanceof RuntimeQualificationError);
      assert.equal(error.code, "BINARY_DIGEST_MISMATCH");
      return true;
    },
  );
  assert.equal(executeCalls, 0);
});

test("multiply-linked executable substitution is rejected before invocation", async (t) => {
  const root = await privateTemporaryDirectory(t, "marketpilot-binary-link-");
  const binaryPath = path.join(root, "codex");
  await writeFile(binaryPath, "not the qualified binary", { mode: 0o700 });
  await link(binaryPath, path.join(root, "replacement-handle"));
  let executeCalls = 0;

  await assert.rejects(
    qualifyPackagedCodexRuntime({
      projectRoot: root,
      schemaDir: path.join(root, "schema"),
      cwd: root,
      env: {},
      dependencies: {
        readHost: async () => SUPPORTED_HOST,
        resolveInstallation: () => ({ binaryPath }),
        execute: async () => {
          executeCalls += 1;
          throw new Error("must not execute");
        },
      },
    }),
    (error) => {
      assert(error instanceof RuntimeQualificationError);
      assert.equal(error.code, "UNSAFE_EXECUTABLE");
      return true;
    },
  );
  assert.equal(executeCalls, 0);
});

/** @param {import("node:test").TestContext} t @param {string} prefix */
async function privateTemporaryDirectory(t, prefix) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  await chmod(directory, 0o700);
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return directory;
}
