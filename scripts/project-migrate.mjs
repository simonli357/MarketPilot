#!/usr/bin/env node
import { promises as fs } from "node:fs";
import { constants } from "node:fs";
import path from "node:path";
import { exists, findProjectRoot, readJson } from "./lib/project-model.mjs";

async function copyWithoutOverwrite(source, destination) {
  const stat = await fs.stat(source);
  if (stat.isDirectory()) {
    await fs.mkdir(destination, { recursive: true });
    const entries = await fs.readdir(source, { withFileTypes: true });
    for (const entry of entries) await copyWithoutOverwrite(path.join(source, entry.name), path.join(destination, entry.name));
    return;
  }
  if (await exists(destination)) throw new Error(`archive destination already exists: ${destination}`);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination, constants.COPYFILE_EXCL);
}

try {
  const root = await findProjectRoot();
  const apply = process.argv.includes("--apply");
  const migration = await readJson(path.join(root, "project", "migrations", "v1-to-v2.json"), "v1-to-v2 migration map");
  const detected = [];
  for (const entry of migration.legacyPaths) {
    if (entry.path === "human.md" || entry.path.startsWith("human.md/")) continue;
    if (await exists(path.join(root, entry.path))) detected.push(entry);
  }

  if (!detected.length) {
    process.stdout.write("No v1 paths detected. Nothing to migrate.\n");
    process.exit(0);
  }

  process.stdout.write(`${apply ? "Applying" : "Dry run for"} v1-to-v2 archive migration:\n`);
  for (const entry of detected) process.stdout.write(`- ${entry.path} -> ${entry.owner}\n`);
  if (!apply) {
    process.stdout.write("No files changed. Re-run with --apply to create docs/legacy-v1/.\n");
    process.exit(0);
  }

  const archiveRoot = path.join(root, "docs", "legacy-v1");
  for (const entry of detected) await copyWithoutOverwrite(path.join(root, entry.path), path.join(archiveRoot, entry.path));
  const report = {
    schemaVersion: 1,
    migration: `${migration.from}-to-${migration.to}`,
    archived: detected,
    note: "Original files were not modified or deleted. Move durable facts into v2 canonical owners before reviewed cleanup."
  };
  await fs.writeFile(path.join(archiveRoot, "migration-report.json"), `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  process.stdout.write(`Archived ${detected.length} path(s) under docs/legacy-v1/. Originals remain unchanged.\n`);
} catch (error) {
  process.stderr.write(`ERROR ${error.message}\n`);
  process.exitCode = 1;
}
