#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { findProjectRoot, loadProject, renderStatus } from "./lib/project-model.mjs";

try {
  const root = await findProjectRoot();
  const model = await loadProject(root);
  const destination = path.join(root, "docs", "status.md");
  await fs.writeFile(destination, renderStatus(model), "utf8");
  process.stdout.write("Updated docs/status.md from canonical state.\n");
} catch (error) {
  process.stderr.write(`ERROR ${error.message}\n`);
  process.exitCode = 1;
}
