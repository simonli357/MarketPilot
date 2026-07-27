#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { findProjectRoot, loadProject, renderStatus, validateProject } from "./lib/project-model.mjs";

try {
  const root = await findProjectRoot();
  const model = await loadProject(root);
  const result = await validateProject(model);
  const expectedStatus = renderStatus(model);
  const currentStatus = await fs.readFile(path.join(root, "docs", "status.md"), "utf8").catch(() => "");
  if (currentStatus.replaceAll("\r\n", "\n") !== expectedStatus) result.errors.push("docs/status.md: stale; run npm run project:status");

  for (const warning of result.warnings) process.stderr.write(`WARN ${warning}\n`);
  for (const error of result.errors) process.stderr.write(`ERROR ${error}\n`);
  if (result.errors.length) {
    process.stderr.write(`Project check failed with ${result.errors.length} error(s) and ${result.warnings.length} warning(s).\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`Project check passed with ${result.warnings.length} warning(s).\n`);
  }
} catch (error) {
  process.stderr.write(`ERROR ${error.message}\n`);
  process.exitCode = 1;
}
