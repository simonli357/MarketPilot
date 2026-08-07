#!/usr/bin/env node
// @ts-check

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const environment = path.join(root, ".venv-paper");
const python = path.join(environment, "bin", "python");
const lock = path.join(root, "requirements", "paper-core.lock");

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status ?? "without a status"}`);
}

run("python3.12", ["-m", "venv", "--clear", environment]);
run(python, ["-m", "pip", "install", "--require-hashes", "--only-binary=:all:", "--no-deps", "-r", lock]);
process.stdout.write(`paper Python environment ready: ${path.relative(root, python)}\n`);
