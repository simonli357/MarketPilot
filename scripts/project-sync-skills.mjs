#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { findProjectRoot } from "./lib/project-model.mjs";

try {
  const root = await findProjectRoot();
  const canonical = path.join(root, "agent-workflows", "skills");
  const destinations = [".agents/skills", ".claude/skills", ".codex/skills"];
  const stat = await fs.stat(canonical);
  if (!stat.isDirectory()) throw new Error("agent-workflows/skills is not a directory");

  for (const relativeDestination of destinations) {
    const destination = path.join(root, relativeDestination);
    await fs.rm(destination, { recursive: true, force: true });
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.cp(canonical, destination, { recursive: true, force: false, errorOnExist: true });
  }
  process.stdout.write(`Published canonical skills to ${destinations.join(", ")}.\n`);
} catch (error) {
  process.stderr.write(`ERROR ${error.message}\n`);
  process.exitCode = 1;
}
