import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

export const BLOCK_STATUSES = new Set(["proposed", "planned", "in_progress", "blocked", "done", "deferred"]);
export const WORK_STATUSES = new Set(["proposed", "ready", "in_progress", "blocked", "done", "deferred"]);
export const WORK_TYPES = new Set(["task", "bug", "feature", "spike", "gate"]);
export const MATURITY = ["L0", "L1", "L2", "L3", "L4"];
export const RELEASE_PHASES = new Set(["intake", "planning", "skeleton", "functional", "hardening", "candidate", "released"]);
export const RELEASE_DECISIONS = new Set(["no-go", "conditional", "go"]);
export const GATE_STATUSES = new Set(["open", "pass", "fail", "waived"]);

const BLOCK_FIELDS = new Set(["id", "title", "status", "maturity", "release", "requirements", "depends_on", "ui"]);
const WORK_FIELDS = new Set(["id", "title", "type", "status", "block", "release", "maturity", "requirements", "depends_on", "owner"]);
const REQUIRED_BLOCK_FIELDS = ["id", "title", "status", "maturity", "release", "requirements", "depends_on", "ui"];
const REQUIRED_WORK_FIELDS = ["id", "title", "type", "status", "block", "release", "maturity", "requirements", "depends_on", "owner"];

const CONDITIONAL_GATES = new Map([
  ["ui-fidelity", ["capabilities", "ui"]],
  ["network-reliability", ["capabilities", "network"]],
  ["data-migrations", ["capabilities", "persistence"]],
  ["native-packaging", ["capabilities", "native"]],
  ["hardware-safety", ["risks", "hardware"]],
  ["security-privacy", ["risks", "sensitiveData"]],
  ["money-integrity", ["risks", "money"]],
  ["realtime-performance", ["risks", "realtime"]]
]);

export async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function findProjectRoot(start = process.cwd()) {
  let current = path.resolve(start);
  while (true) {
    if (await exists(path.join(current, "project", "template.json"))) return current;
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`No project/template.json found above ${start}`);
    current = parent;
  }
}

export async function readJson(filePath, label = path.basename(filePath)) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${label}: ${error.message}`);
  }
}

export async function listFiles(directory, predicate = () => true) {
  if (!(await exists(directory))) return [];
  const result = [];
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await listFiles(fullPath, predicate));
    else if (entry.isFile() && predicate(fullPath)) result.push(fullPath);
  }
  return result;
}

function parseValue(value, filePath, lineNumber) {
  const trimmed = value.trim();
  if (trimmed === "") return "";
  if (trimmed.startsWith("[") || trimmed.startsWith("{") || trimmed.startsWith("\"") || ["true", "false", "null"].includes(trimmed) || /^-?\d+(\.\d+)?$/.test(trimmed)) {
    try {
      return JSON.parse(trimmed);
    } catch (error) {
      throw new Error(`${filePath}:${lineNumber}: invalid JSON-style metadata value: ${error.message}`);
    }
  }
  return trimmed;
}

export function parseFrontmatter(markdown, filePath) {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  if (lines[0] !== "---") throw new Error(`${filePath}: missing opening frontmatter delimiter`);
  const closing = lines.indexOf("---", 1);
  if (closing < 0) throw new Error(`${filePath}: missing closing frontmatter delimiter`);

  const metadata = {};
  for (let index = 1; index < closing; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const separator = line.indexOf(":");
    if (separator < 1) throw new Error(`${filePath}:${index + 1}: expected key: value`);
    const key = line.slice(0, separator).trim();
    if (!/^[a-z][a-z0-9_]*$/.test(key)) throw new Error(`${filePath}:${index + 1}: invalid metadata key ${key}`);
    if (Object.hasOwn(metadata, key)) throw new Error(`${filePath}:${index + 1}: duplicate metadata key ${key}`);
    metadata[key] = parseValue(line.slice(separator + 1), filePath, index + 1);
  }

  return { metadata, body: lines.slice(closing + 1).join("\n") };
}

async function loadMarkdownEntities(directory, ignoredNames) {
  const files = await listFiles(directory, filePath => filePath.endsWith(".md") && !ignoredNames.has(path.basename(filePath)));
  const entities = [];
  for (const filePath of files) {
    const markdown = await fs.readFile(filePath, "utf8");
    const parsed = parseFrontmatter(markdown, filePath);
    entities.push({ ...parsed, filePath });
  }
  return entities;
}

export async function loadProject(root) {
  root ??= await findProjectRoot();
  const profile = await readJson(path.join(root, "project", "profile.json"), "project/profile.json");
  const release = await readJson(path.join(root, "project", "release.json"), "project/release.json");
  const provenance = await readJson(path.join(root, "project", "template.json"), "project/template.json");
  const contract = await readJson(path.join(root, "project", "template-contract.json"), "project/template-contract.json");
  const uiManifestPath = path.join(root, "assets", "ui-concepts", "ui-manifest.json");
  const uiManifest = await exists(uiManifestPath) ? await readJson(uiManifestPath, "assets/ui-concepts/ui-manifest.json") : null;
  const blocks = await loadMarkdownEntities(path.join(root, "docs", "blocks"), new Set(["README.md", "BLOCK-template.md"]));
  const workItems = await loadMarkdownEntities(path.join(root, "docs", "work-items"), new Set(["README.md", "ITEM-template.md"]));
  return { root, profile, release, provenance, contract, uiManifest, blocks, workItems };
}

function relative(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join("/");
}

function requireFields(entity, required, allowed, kind, errors, root) {
  const location = relative(root, entity.filePath);
  for (const key of required) {
    if (!Object.hasOwn(entity.metadata, key)) errors.push(`${location}: missing ${kind} field '${key}'`);
  }
  for (const key of Object.keys(entity.metadata)) {
    if (!allowed.has(key)) errors.push(`${location}: unknown ${kind} field '${key}'`);
  }
}

function requireArray(value, label, errors) {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string" || !item.trim())) {
    errors.push(`${label} must be an array of non-empty strings`);
    return false;
  }
  return true;
}

function duplicateIds(entities, kind, errors, root) {
  const seen = new Map();
  for (const entity of entities) {
    const id = entity.metadata.id;
    if (typeof id !== "string") continue;
    if (seen.has(id)) errors.push(`${relative(root, entity.filePath)}: duplicate ${kind} id ${id}; first seen in ${seen.get(id)}`);
    else seen.set(id, relative(root, entity.filePath));
  }
}

function section(markdown, heading) {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  const start = lines.findIndex(line => line.trim() === heading);
  if (start < 0) return "";
  const level = heading.match(/^#+/)?.[0].length || 1;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const nextLevel = lines[index].match(/^(#+)\s/)?.[1].length;
    if (nextLevel && nextLevel <= level) {
      end = index;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n").trim();
}

function hasSubstantiveText(value) {
  const normalized = value
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^- \[(?: |x)\]/gim, "")
    .replace(/^[-*]\s*(Automated|Manual|Environment or fixture):\s*/gim, "")
    .replace(/^[-*]\s*Leave empty unless applicable[^\n]*$/gim, "")
    .replace(/\b(TBD|replace with|none yet)\b/gi, "")
    .replace(/[^a-z0-9]+/gi, "");
  return normalized.length >= 8;
}

function hasSubstantiveCheckbox(value) {
  return [...value.matchAll(/^- \[(?: |x)\]\s*(.+)$/gim)].some(match => hasSubstantiveText(match[1]));
}

function hasLabeledValue(value, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = value.match(new RegExp(`^-\\s*${escaped}:\\s*(.+)$`, "im"));
  return Boolean(match && hasSubstantiveText(match[1]));
}

function validateBlockShape(model, errors, warnings) {
  const ids = new Set(model.blocks.map(block => block.metadata.id));
  duplicateIds(model.blocks, "block", errors, model.root);
  for (const block of model.blocks) {
    requireFields(block, REQUIRED_BLOCK_FIELDS, BLOCK_FIELDS, "block", errors, model.root);
    const m = block.metadata;
    const location = relative(model.root, block.filePath);
    if (typeof m.id !== "string" || !/^BLK-[a-z0-9][a-z0-9-]*$/.test(m.id)) errors.push(`${location}: block id must match BLK-<lowercase-slug>`);
    else if (path.basename(block.filePath, ".md") !== m.id) errors.push(`${location}: filename must be ${m.id}.md`);
    if (typeof m.title !== "string" || !m.title.trim()) errors.push(`${location}: title must be non-empty`);
    if (!BLOCK_STATUSES.has(m.status)) errors.push(`${location}: invalid block status '${m.status}'`);
    if (!MATURITY.includes(m.maturity)) errors.push(`${location}: invalid maturity '${m.maturity}'`);
    if (typeof m.release !== "string" || !m.release.trim()) errors.push(`${location}: release must be non-empty`);
    requireArray(m.requirements, `${location}: requirements`, errors);
    if (requireArray(m.depends_on, `${location}: depends_on`, errors)) {
      for (const dependency of m.depends_on) {
        if (dependency === m.id) errors.push(`${location}: block cannot depend on itself`);
        else if (!ids.has(dependency)) errors.push(`${location}: unknown block dependency ${dependency}`);
      }
    }
    if (typeof m.ui !== "boolean") errors.push(`${location}: ui must be true or false`);
    for (const heading of ["## Outcome", "## Requirements", "## Boundary", "## Contracts And Failure", "## Architecture", "## Implementation Blueprint", "## Maturity Criteria", "## Validation", "## Known Gaps"]) {
      if (!block.body.includes(heading)) errors.push(`${location}: missing section ${heading}`);
    }
    const rank = MATURITY.indexOf(m.maturity);
    for (let level = 1; level <= Math.min(rank, 3); level += 1) {
      const content = section(block.body, `### L${level}${level === 1 ? " Walking Skeleton" : level === 2 ? " Functional" : " Hardened"}`);
      if (!content) errors.push(`${location}: missing L${level} maturity criteria`);
      else if (/- \[ \]/.test(content)) errors.push(`${location}: maturity is ${m.maturity} but L${level} criteria remain unchecked`);
    }
    if (m.status === "done" && rank < 2) warnings.push(`${location}: done block remains below L2`);
  }
  validateDependencyCycles(model.blocks, "block", errors, model.root);
}

function validateWorkShape(model, errors) {
  const blockIds = new Set(model.blocks.map(block => block.metadata.id));
  const itemIds = new Set(model.workItems.map(item => item.metadata.id));
  const itemsById = new Map(model.workItems.map(item => [item.metadata.id, item]));
  duplicateIds(model.workItems, "work item", errors, model.root);

  for (const item of model.workItems) {
    requireFields(item, REQUIRED_WORK_FIELDS, WORK_FIELDS, "work-item", errors, model.root);
    const m = item.metadata;
    const location = relative(model.root, item.filePath);
    if (typeof m.id !== "string" || !/^WI-\d{3,}$/.test(m.id)) errors.push(`${location}: work-item id must match WI-<at-least-three-digits>`);
    else if (!path.basename(item.filePath, ".md").startsWith(`${m.id}-`) && path.basename(item.filePath, ".md") !== m.id) errors.push(`${location}: filename must start with ${m.id}- or equal ${m.id}.md`);
    if (typeof m.title !== "string" || !m.title.trim()) errors.push(`${location}: title must be non-empty`);
    if (!WORK_TYPES.has(m.type)) errors.push(`${location}: invalid work-item type '${m.type}'`);
    if (!WORK_STATUSES.has(m.status)) errors.push(`${location}: invalid work-item status '${m.status}'`);
    if (!MATURITY.includes(m.maturity)) errors.push(`${location}: invalid target maturity '${m.maturity}'`);
    if (typeof m.release !== "string" || !m.release.trim()) errors.push(`${location}: release must be non-empty`);
    if (m.block !== "none" && !blockIds.has(m.block)) errors.push(`${location}: unknown block ${m.block}`);
    requireArray(m.requirements, `${location}: requirements`, errors);
    if (requireArray(m.depends_on, `${location}: depends_on`, errors)) {
      for (const dependency of m.depends_on) {
        if (dependency === m.id) errors.push(`${location}: item cannot depend on itself`);
        else if (!itemIds.has(dependency)) errors.push(`${location}: unknown work-item dependency ${dependency}`);
      }
    }
    if (typeof m.owner !== "string" || !m.owner.trim()) errors.push(`${location}: owner must be non-empty`);
    else if (["ready", "in_progress", "done"].includes(m.status) && m.owner === "unassigned") errors.push(`${location}: ${m.status} item must have an assigned owner`);
    for (const heading of ["## Outcome", "## Success Criteria", "## Validation", "## Execution Contract", "## Evidence", "## Blocked Or Deferred"]) {
      if (!item.body.includes(heading)) errors.push(`${location}: missing section ${heading}`);
    }
    if (["ready", "in_progress", "done"].includes(m.status)) {
      if (!hasSubstantiveText(section(item.body, "## Outcome"))) errors.push(`${location}: ${m.status} item needs a substantive outcome`);
      const criteria = section(item.body, "## Success Criteria");
      if (!hasSubstantiveCheckbox(criteria)) errors.push(`${location}: ${m.status} item needs substantive checkbox success criteria`);
      if (!hasSubstantiveText(section(item.body, "## Validation"))) errors.push(`${location}: ${m.status} item needs a concrete validation plan`);
      const execution = section(item.body, "## Execution Contract");
      for (const label of ["Constraints", "Boundaries", "Iteration policy", "Blocked stop condition"]) {
        if (!hasLabeledValue(execution, label)) errors.push(`${location}: ${m.status} item needs a substantive ${label.toLowerCase()}`);
      }
      const unfinishedDependencies = m.depends_on.filter(dependency => itemsById.get(dependency)?.metadata.status !== "done");
      if (unfinishedDependencies.length) errors.push(`${location}: ${m.status} item has unfinished dependencies: ${unfinishedDependencies.join(", ")}`);
    }
    if (m.status === "done") {
      if (/- \[ \]/.test(section(item.body, "## Success Criteria"))) errors.push(`${location}: done item has unchecked success criteria`);
      if (!hasSubstantiveText(section(item.body, "## Evidence"))) errors.push(`${location}: done item needs concise evidence`);
    }
    if (m.status === "blocked" && !hasSubstantiveText(section(item.body, "## Blocked Or Deferred"))) errors.push(`${location}: blocked item needs an unblock condition`);
    if (m.status === "deferred" && !hasSubstantiveText(section(item.body, "## Blocked Or Deferred"))) errors.push(`${location}: deferred item needs an owner and consequence`);
  }
  validateDependencyCycles(model.workItems, "work item", errors, model.root);

  const maxInProgress = model.profile.workflow?.maxInProgress;
  const inProgress = model.workItems.filter(item => item.metadata.status === "in_progress");
  if (Number.isInteger(maxInProgress) && maxInProgress > 0 && inProgress.length > maxInProgress) {
    errors.push(`project/profile.json: ${inProgress.length} work items are in_progress; workflow.maxInProgress is ${maxInProgress}`);
  }
}

function validateDependencyCycles(entities, kind, errors, root) {
  const byId = new Map(entities.map(entity => [entity.metadata.id, entity]));
  const indegree = new Map([...byId.keys()].map(id => [id, 0]));
  const dependents = new Map([...byId.keys()].map(id => [id, []]));
  for (const [id, entity] of byId) {
    for (const dependency of Array.isArray(entity.metadata.depends_on) ? entity.metadata.depends_on : []) {
      if (!byId.has(dependency)) continue;
      indegree.set(id, indegree.get(id) + 1);
      dependents.get(dependency).push(id);
    }
  }
  const queue = [...indegree].filter(([, count]) => count === 0).map(([id]) => id);
  let visited = 0;
  while (queue.length) {
    const id = queue.pop();
    visited += 1;
    for (const dependent of dependents.get(id)) {
      const next = indegree.get(dependent) - 1;
      indegree.set(dependent, next);
      if (next === 0) queue.push(dependent);
    }
  }
  if (visited !== byId.size) {
    const cycleMembers = [...indegree].filter(([, count]) => count > 0).map(([id]) => id).slice(0, 8);
    errors.push(`${kind} dependency cycle involving ${cycleMembers.join(", ")}${byId.size - visited > cycleMembers.length ? ", ..." : ""}`);
  }
}

function productRequirements(markdown) {
  const requirements = [];
  for (const line of markdown.replaceAll("\r\n", "\n").split("\n")) {
    if (!/^\|\s*[A-Z]+R-\d+\s*\|/.test(line)) continue;
    const cells = line.split("|").slice(1, -1).map(cell => cell.trim());
    if (cells.length >= 5 && cells[2]) requirements.push({ id: cells[0], text: cells[2], mapping: cells[4] });
  }
  return requirements;
}

function localRequirements(block) {
  const requirements = [];
  for (const line of block.body.replaceAll("\r\n", "\n").split("\n")) {
    if (!/^\|\s*BLK-[a-z0-9-]+-R\d+\s*\|/.test(line)) continue;
    const cells = line.split("|").slice(1, -1).map(cell => cell.trim());
    if (cells.length >= 6 && cells[1]) requirements.push({ id: cells[0], text: cells[1], mapping: cells[4] });
  }
  return requirements;
}

async function validateTraceability(model, errors) {
  const productPath = path.join(model.root, "docs", "product.md");
  if (!(await exists(productPath))) return;
  const markdown = await fs.readFile(productPath, "utf8");
  const requirements = productRequirements(markdown);
  const knownGlobal = new Set(requirements.map(requirement => requirement.id));
  const blockMap = new Map();
  for (const block of model.blocks) {
    for (const requirement of Array.isArray(block.metadata.requirements) ? block.metadata.requirements : []) {
      if (!blockMap.has(requirement)) blockMap.set(requirement, []);
      blockMap.get(requirement).push(block.metadata.id);
    }
  }
  const spikeRequirements = new Set(model.workItems.filter(item => item.metadata.type === "spike").flatMap(item => item.metadata.requirements || []));
  for (const requirement of requirements) {
    const mappedBlocks = blockMap.get(requirement.id) || [];
    const deferred = /\bdefer(?:red|ral)?\b/i.test(requirement.mapping);
    if (!mappedBlocks.length && !spikeRequirements.has(requirement.id) && !deferred) {
      errors.push(`docs/product.md: ${requirement.id} is not mapped to a block, spike, or explicit deferral`);
    }
    const namedBlocks = requirement.mapping.match(/BLK-[a-z0-9-]+/g) || [];
    for (const named of namedBlocks) {
      if (!mappedBlocks.includes(named)) errors.push(`docs/product.md: ${requirement.id} names ${named}, but that block does not list the requirement`);
    }
  }

  const knownLocal = new Set();
  const itemsById = new Map(model.workItems.map(item => [item.metadata.id, item]));
  for (const block of model.blocks) {
    const location = relative(model.root, block.filePath);
    for (const globalId of Array.isArray(block.metadata.requirements) ? block.metadata.requirements : []) {
      if (!knownGlobal.has(globalId)) errors.push(`${location}: unknown global requirement ${globalId}`);
    }
    for (const requirement of localRequirements(block)) {
      if (!requirement.id.startsWith(`${block.metadata.id}-R`)) errors.push(`${location}: local requirement ${requirement.id} must use the block id prefix`);
      if (knownLocal.has(requirement.id)) errors.push(`${location}: duplicate local requirement ${requirement.id}`);
      knownLocal.add(requirement.id);
      const mustMap = ["in_progress", "done"].includes(block.metadata.status) || MATURITY.indexOf(block.metadata.maturity) >= 2;
      if (!mustMap) continue;
      const linkedItems = model.workItems.filter(item => (item.metadata.requirements || []).includes(requirement.id));
      const deferred = /\bdefer(?:red|ral)?\b/i.test(requirement.mapping);
      if (!linkedItems.length && !deferred) errors.push(`${location}: ${requirement.id} must map to a work item, spike, or explicit deferral before L2`);
      const namedItems = requirement.mapping.match(/WI-\d{3,}/g) || [];
      for (const named of namedItems) {
        if (!itemsById.has(named)) errors.push(`${location}: ${requirement.id} names unknown work item ${named}`);
        else if (!(itemsById.get(named).metadata.requirements || []).includes(requirement.id)) errors.push(`${location}: ${requirement.id} names ${named}, but that item does not list the requirement`);
      }
    }
    if (block.metadata.status === "done") {
      const unfinished = model.workItems.filter(item => item.metadata.block === block.metadata.id && !["done", "deferred"].includes(item.metadata.status));
      if (unfinished.length) errors.push(`${location}: done block has unfinished work items: ${unfinished.map(item => item.metadata.id).join(", ")}`);
    }
  }
  const knownRequirements = new Set([...knownGlobal, ...knownLocal]);
  for (const item of model.workItems) {
    const location = relative(model.root, item.filePath);
    for (const requirement of Array.isArray(item.metadata.requirements) ? item.metadata.requirements : []) {
      if (!knownRequirements.has(requirement)) errors.push(`${location}: unknown requirement ${requirement}`);
    }
  }
}

function capabilityValue(profile, pathParts) {
  return pathParts.reduce((value, key) => value?.[key], profile);
}

function validateRelease(model, errors, warnings) {
  const release = model.release;
  if (release.schemaVersion !== 1) errors.push("project/release.json: schemaVersion must be 1");
  if (typeof release.release !== "string" || !release.release.trim()) errors.push("project/release.json: release must be non-empty");
  if (!RELEASE_PHASES.has(release.phase)) errors.push(`project/release.json: invalid phase '${release.phase}'`);
  if (!RELEASE_DECISIONS.has(release.decision)) errors.push(`project/release.json: invalid decision '${release.decision}'`);
  if (!MATURITY.includes(release.requiredMaturity)) errors.push(`project/release.json: invalid requiredMaturity '${release.requiredMaturity}'`);
  if (!Array.isArray(release.requiredBlocks)) errors.push("project/release.json: requiredBlocks must be an array");
  if (!Array.isArray(release.planningApprovals)) errors.push("project/release.json: planningApprovals must be an array");
  if (!Array.isArray(release.gates)) errors.push("project/release.json: gates must be an array");
  if (!release.evidencePolicy || !Number.isInteger(release.evidencePolicy.maxTrackedBytes) || release.evidencePolicy.maxTrackedBytes < 0) {
    errors.push("project/release.json: evidencePolicy.maxTrackedBytes must be a non-negative integer");
  }
  if (!Array.isArray(release.gates)) return;

  const approvalIds = new Set();
  for (const approval of Array.isArray(release.planningApprovals) ? release.planningApprovals : []) {
    if (!approval || typeof approval.id !== "string" || approvalIds.has(approval.id)) errors.push("project/release.json: planning approval ids must be unique strings");
    else approvalIds.add(approval.id);
    if (!["pending", "approved"].includes(approval?.status)) errors.push(`project/release.json: planning approval ${approval?.id || "<unknown>"} has invalid status`);
    if (approval?.status === "approved" && (typeof approval.evidence !== "string" || !approval.evidence.trim())) errors.push(`project/release.json: approved planning approval ${approval.id} needs human evidence`);
  }
  for (const id of ["product-shape", "major-architecture", "first-goal"]) if (!approvalIds.has(id)) errors.push(`project/release.json: missing planning approval ${id}`);

  const gateIds = new Set();
  for (const gate of release.gates) {
    if (!gate || typeof gate !== "object") {
      errors.push("project/release.json: each gate must be an object");
      continue;
    }
    if (typeof gate.id !== "string" || !gate.id.trim()) errors.push("project/release.json: gate id must be non-empty");
    else if (gateIds.has(gate.id)) errors.push(`project/release.json: duplicate gate ${gate.id}`);
    else gateIds.add(gate.id);
    if (typeof gate.required !== "boolean") errors.push(`project/release.json: gate ${gate.id} required must be boolean`);
    if (!GATE_STATUSES.has(gate.status)) errors.push(`project/release.json: gate ${gate.id} has invalid status '${gate.status}'`);
    for (const key of ["evidence", "blockers", "deferrals"]) {
      if (!Array.isArray(gate[key])) errors.push(`project/release.json: gate ${gate.id} ${key} must be an array`);
    }
    if (gate.status === "pass" && (!Array.isArray(gate.evidence) || !gate.evidence.length)) errors.push(`project/release.json: passed gate ${gate.id} needs evidence`);
    if (gate.status === "waived") {
      if (!Array.isArray(gate.deferrals) || !gate.deferrals.length) errors.push(`project/release.json: waived gate ${gate.id} needs an approved deferral`);
      else for (const deferral of gate.deferrals) {
        if (!deferral || typeof deferral !== "object" || !deferral.reason || !deferral.consequence || !deferral.approval) {
          errors.push(`project/release.json: waived gate ${gate.id} deferrals need reason, consequence, and human approval evidence`);
        }
      }
    }
  }

  for (const baseline of ["requirements", "required-blocks", "quality", "clean-setup", "release-artifact", "documentation"]) {
    const gate = release.gates.find(candidate => candidate.id === baseline);
    if (!gate) errors.push(`project/release.json: missing baseline gate ${baseline}`);
    else if (!gate.required) errors.push(`project/release.json: baseline gate ${baseline} must be required`);
  }

  const activePhase = !["intake", "planning"].includes(release.phase);
  if (activePhase) {
    for (const approval of release.planningApprovals || []) {
      if (approval.status !== "approved") errors.push(`project/release.json: approve ${approval.id} with human evidence before leaving planning`);
    }
  }
  for (const [gateId, profilePath] of CONDITIONAL_GATES) {
    const value = capabilityValue(model.profile, profilePath);
    const gate = release.gates.find(candidate => candidate.id === gateId);
    if (!gate) errors.push(`project/release.json: missing conditional gate ${gateId}`);
    else if (value === true && !gate.required) errors.push(`project/release.json: ${gateId} must be required for the active profile`);
    else if (value === false && gate.required) warnings.push(`project/release.json: ${gateId} is required although its profile risk/capability is inactive`);
    if (activePhase && value === "auto") errors.push(`project/profile.json: resolve ${profilePath.join(".")} before leaving planning`);
  }

  const blocksById = new Map(model.blocks.map(block => [block.metadata.id, block]));
  for (const blockId of Array.isArray(release.requiredBlocks) ? release.requiredBlocks : []) {
    if (!blocksById.has(blockId)) errors.push(`project/release.json: unknown required block ${blockId}`);
  }
  if (release.decision === "go") {
    if (!['candidate', 'released'].includes(release.phase)) errors.push("project/release.json: a go decision requires candidate or released phase");
    for (const gate of release.gates.filter(candidate => candidate.required)) {
      if (!['pass', 'waived'].includes(gate.status)) errors.push(`project/release.json: required gate ${gate.id} is not pass or waived`);
    }
    const requiredRank = MATURITY.indexOf(release.requiredMaturity);
    for (const blockId of release.requiredBlocks || []) {
      const block = blocksById.get(blockId);
      if (block && MATURITY.indexOf(block.metadata.maturity) < requiredRank) errors.push(`project/release.json: ${blockId} is ${block.metadata.maturity}, below ${release.requiredMaturity}`);
      if (block && block.metadata.status !== "done") errors.push(`project/release.json: required block ${blockId} must be done for a go decision`);
    }
    const releaseBlockers = model.workItems.filter(item => item.metadata.release === release.release && item.metadata.status === "blocked");
    if (releaseBlockers.length) errors.push(`project/release.json: go decision has blocked items: ${releaseBlockers.map(item => item.metadata.id).join(", ")}`);
  }
}

async function validateUi(model, errors) {
  const enabled = model.profile.capabilities?.ui;
  const manifest = model.uiManifest;
  if (!manifest) {
    errors.push("assets/ui-concepts/ui-manifest.json: missing UI manifest");
    return;
  }
  if (manifest.schemaVersion !== 1) errors.push("assets/ui-concepts/ui-manifest.json: schemaVersion must be 1");
  if (manifest.enabled !== enabled) errors.push("assets/ui-concepts/ui-manifest.json: enabled must match project/profile.json capabilities.ui");
  const states = new Set(["inactive", "unresolved", "options-ready", "selected", "existing"]);
  if (!states.has(manifest.directionState)) errors.push(`assets/ui-concepts/ui-manifest.json: invalid directionState '${manifest.directionState}'`);
  if (enabled === false && manifest.directionState !== "inactive") errors.push("assets/ui-concepts/ui-manifest.json: disabled UI must use inactive directionState");
  if (enabled === true && manifest.directionState === "inactive") errors.push("assets/ui-concepts/ui-manifest.json: enabled UI cannot use inactive directionState");

  const optionsComplete = ["a", "b"].every(key => {
    const option = manifest.options?.[key];
    return option && typeof option.theme === "string" && option.theme && typeof option.designSystem === "string" && option.designSystem && Array.isArray(option.mockups) && option.mockups.length;
  });
  if (["options-ready", "selected"].includes(manifest.directionState) && !optionsComplete) {
    errors.push("assets/ui-concepts/ui-manifest.json: options-ready/selected requires complete theme, design system, and mockups for options a and b");
  }

  const exact = manifest.exactDesignSystem;
  const exactReady = exact && typeof exact.document === "string" && exact.document && typeof exact.tokens === "string" && exact.tokens && typeof exact.componentGallery?.path === "string" && exact.componentGallery.path && typeof exact.componentGallery?.command === "string" && exact.componentGallery.command;
  if (["selected", "existing"].includes(manifest.directionState)) {
    if (!["a", "b", "existing"].includes(manifest.selectedOption)) errors.push("assets/ui-concepts/ui-manifest.json: selected direction needs selectedOption a, b, or existing");
    if (typeof manifest.selectionEvidence !== "string" || !manifest.selectionEvidence.trim()) errors.push("assets/ui-concepts/ui-manifest.json: selected direction needs human selection evidence");
    if (!exactReady) errors.push("assets/ui-concepts/ui-manifest.json: selected direction needs an exact design-system document, token source, and executable component gallery");
    if (!manifest.inventoryComplete) errors.push("assets/ui-concepts/ui-manifest.json: selected direction must confirm the active UI inventory is complete");
  }

  const surfaces = Array.isArray(manifest.surfaces) ? manifest.surfaces : [];
  if (!Array.isArray(manifest.surfaces)) errors.push("assets/ui-concepts/ui-manifest.json: surfaces must be an array");
  const blocksById = new Map(model.blocks.map(block => [block.metadata.id, block]));
  const activeUiItems = model.workItems.filter(item => {
    const block = blocksById.get(item.metadata.block);
    return block?.metadata.ui === true && ["ready", "in_progress", "done"].includes(item.metadata.status) && MATURITY.indexOf(item.metadata.maturity) >= 2;
  });
  if (activeUiItems.length && !["selected", "existing"].includes(manifest.directionState)) {
    errors.push(`assets/ui-concepts/ui-manifest.json: L2+ UI work requires a selected or existing exact direction (${activeUiItems.map(item => item.metadata.id).join(", ")})`);
  }
  for (const item of activeUiItems) {
    const matching = surfaces.filter(surface => surface.block === item.metadata.block);
    if (!matching.length) errors.push(`assets/ui-concepts/ui-manifest.json: ${item.metadata.block} needs surface/state references before L2+ UI work`);
    for (const surface of matching) {
      if (!Array.isArray(surface.states) || !surface.states.length || !Array.isArray(surface.references) || !surface.references.length || !Array.isArray(surface.viewports) || !surface.viewports.length) {
        errors.push(`assets/ui-concepts/ui-manifest.json: surface ${surface.id || "<unknown>"} needs states, references, and viewports`);
      }
    }
  }

  const assets = Array.isArray(manifest.assets) ? manifest.assets : [];
  if (!Array.isArray(manifest.assets)) errors.push("assets/ui-concepts/ui-manifest.json: assets must be an array");
  const assetPaths = new Set();
  for (const asset of assets) {
    if (!asset.id || !asset.path || !asset.purpose || !asset.dimensions) errors.push("assets/ui-concepts/ui-manifest.json: each asset needs id, path, purpose, and dimensions");
    if (assetPaths.has(asset.path)) errors.push(`assets/ui-concepts/ui-manifest.json: duplicate asset path ${asset.path}`);
    assetPaths.add(asset.path);
    if (!new Set(["proposed", "approved", "used", "replaced", "deferred"]).has(asset.status)) errors.push(`assets/ui-concepts/ui-manifest.json: asset ${asset.id} has invalid status '${asset.status}'`);
    if (manifest.directionState === "selected" && asset.status === "approved") errors.push(`assets/ui-concepts/ui-manifest.json: approved asset ${asset.id} must be used, replaced, or deferred before acceptance`);
    if (["replaced", "deferred"].includes(asset.status) && !asset.approval) errors.push(`assets/ui-concepts/ui-manifest.json: ${asset.status} asset ${asset.id} needs human approval evidence`);
    if (asset.status === "used" && asset.path && !(await exists(path.join(model.root, asset.path)))) errors.push(`assets/ui-concepts/ui-manifest.json: used asset path does not exist: ${asset.path}`);
  }
  for (const exception of Array.isArray(manifest.fidelity?.exceptions) ? manifest.fidelity.exceptions : []) {
    if (!exception.approval) errors.push("assets/ui-concepts/ui-manifest.json: every fidelity exception needs human approval evidence");
  }
}

async function validateArtifacts(model, errors) {
  const releasesRoot = path.join(model.root, "artifacts", "releases");
  const files = await listFiles(releasesRoot, filePath => path.basename(filePath) !== "README.md");
  let total = 0;
  for (const filePath of files) total += (await fs.stat(filePath)).size;
  const budget = model.release.evidencePolicy?.maxTrackedBytes;
  if (Number.isInteger(budget) && total > budget) errors.push(`artifacts/releases: ${total} tracked bytes exceeds release evidence budget ${budget}`);
  const entries = await fs.readdir(releasesRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries.filter(candidate => candidate.isDirectory())) {
    const manifestPath = path.join(releasesRoot, entry.name, "manifest.json");
    if (!(await exists(manifestPath))) errors.push(`artifacts/releases/${entry.name}: missing manifest.json`);
    else {
      const manifest = await readJson(manifestPath, `artifacts/releases/${entry.name}/manifest.json`).catch(error => {
        errors.push(error.message);
        return null;
      });
      if (!manifest) continue;
      const location = `artifacts/releases/${entry.name}/manifest.json`;
      if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.artifacts) || manifest.release !== entry.name) {
        errors.push(`${location}: schemaVersion must be 1, release must match the directory, and artifacts must be an array`);
        continue;
      }
      if (!manifest.createdAt || Number.isNaN(Date.parse(manifest.createdAt))) errors.push(`${location}: createdAt must be an ISO date-time`);
      const ids = new Set();
      const gateIds = new Set((model.release.gates || []).map(gate => gate.id));
      for (const artifact of manifest.artifacts) {
        if (!artifact || typeof artifact !== "object" || !artifact.id || ids.has(artifact.id)) {
          errors.push(`${location}: artifact ids must be unique non-empty strings`);
          continue;
        }
        ids.add(artifact.id);
        if (!gateIds.has(artifact.gate)) errors.push(`${location}: artifact ${artifact.id} names unknown release gate ${artifact.gate}`);
        if (!artifact.method || !artifact.environment) errors.push(`${location}: artifact ${artifact.id} needs method and environment`);
        if (!artifact.capturedAt || Number.isNaN(Date.parse(artifact.capturedAt))) errors.push(`${location}: artifact ${artifact.id} needs an ISO capturedAt date-time`);
        const hasPath = typeof artifact.path === "string" && artifact.path.trim();
        const hasExternal = typeof artifact.external === "string" && artifact.external.trim();
        if (Boolean(hasPath) === Boolean(hasExternal)) errors.push(`${location}: artifact ${artifact.id} needs exactly one path or external reference`);
        if (hasPath) {
          const artifactPath = path.resolve(model.root, artifact.path);
          if (!artifactPath.startsWith(`${path.resolve(model.root)}${path.sep}`) || path.basename(artifactPath) === "human.md") {
            errors.push(`${location}: artifact ${artifact.id} has an unsafe path`);
          } else if (!(await exists(artifactPath))) errors.push(`${location}: artifact ${artifact.id} path does not exist: ${artifact.path}`);
          else {
            const hash = createHash("sha256").update(await fs.readFile(artifactPath)).digest("hex");
            if (artifact.sha256 !== hash) errors.push(`${location}: artifact ${artifact.id} sha256 does not match its content`);
          }
        }
      }
    }
  }
}

async function validateSkills(model, errors) {
  const canonical = path.join(model.root, "agent-workflows", "skills");
  const canonicalFiles = await listFiles(canonical);
  if (!canonicalFiles.length) {
    errors.push("agent-workflows/skills: no canonical skills found");
    return;
  }
  for (const destinationRoot of [".agents/skills", ".claude/skills", ".codex/skills"]) {
    const expectedRelativePaths = new Set(canonicalFiles.map(sourcePath => path.relative(canonical, sourcePath)));
    for (const sourcePath of canonicalFiles) {
      const relativePath = path.relative(canonical, sourcePath);
      const destinationPath = path.join(model.root, destinationRoot, relativePath);
      if (!(await exists(destinationPath))) errors.push(`${destinationRoot}/${relativePath.split(path.sep).join("/")}: missing generated skill copy`);
      else if (!Buffer.from(await fs.readFile(sourcePath)).equals(Buffer.from(await fs.readFile(destinationPath)))) errors.push(`${destinationRoot}/${relativePath.split(path.sep).join("/")}: differs from canonical skill`);
    }
    const destinationFiles = await listFiles(path.join(model.root, destinationRoot));
    for (const destinationPath of destinationFiles) {
      const relativePath = path.relative(path.join(model.root, destinationRoot), destinationPath);
      if (!expectedRelativePaths.has(relativePath)) errors.push(`${destinationRoot}/${relativePath.split(path.sep).join("/")}: stale generated skill file; run npm run project:skills`);
    }
  }
}

async function validateLinks(model, errors) {
  const roots = ["README.md", "PROJECT.md", "AGENTS.md", "CLAUDE.md", "MIGRATION.md", "CHANGELOG.md", "docs", "assets/ui-concepts", "agent-workflows/skills"];
  const files = [];
  for (const entry of roots) {
    const fullPath = path.join(model.root, entry);
    if (!(await exists(fullPath))) continue;
    const stat = await fs.stat(fullPath);
    if (stat.isFile() && fullPath.endsWith(".md")) files.push(fullPath);
    else if (stat.isDirectory()) files.push(...(await listFiles(fullPath, candidate => candidate.endsWith(".md"))).filter(candidate => !candidate.startsWith(`${path.join(model.root, "docs", "legacy-v1")}${path.sep}`)));
  }
  for (const filePath of files) {
    const markdown = await fs.readFile(filePath, "utf8");
    for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      let target = match[1].trim().replace(/^<|>$/g, "");
      if (!target || target.startsWith("#") || /^[a-z]+:/i.test(target) || target.includes("{{")) continue;
      target = target.split("#")[0].split("?")[0];
      const resolved = target.startsWith("/") ? path.join(model.root, target.slice(1)) : path.resolve(path.dirname(filePath), target);
      if (!(await exists(resolved))) errors.push(`${relative(model.root, filePath)}: broken local link ${match[1]}`);
    }
  }
}

async function validateCoreFiles(model, errors) {
  const required = [
    "README.md", "PROJECT.md", "AGENTS.md", "CLAUDE.md", "human.md", "docs/README.md", "docs/idea.md", "docs/product.md",
    "docs/architecture.md", "docs/quality.md", "docs/engineering.md", "docs/ui.md", "docs/status.md", "docs/commands.md",
    "docs/blocks/README.md", "docs/blocks/BLOCK-template.md", "docs/work-items/README.md", "docs/work-items/ITEM-template.md",
    "docs/guides/developer.md", "project/profile.json", "project/release.json", "project/template.json", "project/template-contract.json",
    "artifacts/releases/manifest-template.json",
    "assets/ui-concepts/ui-manifest.json", "scripts/project-check.mjs", "scripts/project-status.mjs", "scripts/project-sync-skills.mjs", "scripts/project-migrate.mjs"
  ];
  for (const relativePath of required) if (!(await exists(path.join(model.root, relativePath)))) errors.push(`${relativePath}: missing required template path`);
  for (const ignoreFile of [".gitignore", ".ignore", ".rgignore"]) {
    const filePath = path.join(model.root, ignoreFile);
    if (!(await exists(filePath))) errors.push(`${ignoreFile}: missing`);
    else if (!(await fs.readFile(filePath, "utf8")).split(/\r?\n/).includes("human.md")) errors.push(`${ignoreFile}: must ignore human.md`);
  }
  const agents = await fs.readFile(path.join(model.root, "AGENTS.md"), "utf8").catch(() => "");
  if (agents.split(/\r?\n/).length > 80) errors.push("AGENTS.md: must remain at most 80 lines; move procedures into skills or owned docs");
  const status = await fs.readFile(path.join(model.root, "docs", "status.md"), "utf8").catch(() => "");
  if (status.split(/\r?\n/).filter((line, index, values) => index < values.length - 1 || line !== "").length > 25) errors.push("docs/status.md: generated status exceeds 25 lines");
  if (model.contract.version !== model.provenance.contractVersion) errors.push("project/template.json: contractVersion must match project/template-contract.json version");
  if (model.provenance.templateVersion !== "2.0.0") errors.push(`project/template.json: unsupported templateVersion '${model.provenance.templateVersion}'`);
  const contractIds = new Set();
  for (const rule of Array.isArray(model.contract.rules) ? model.contract.rules : []) {
    if (!rule.id || contractIds.has(rule.id)) errors.push(`project/template-contract.json: missing or duplicate rule id '${rule.id}'`);
    contractIds.add(rule.id);
  }
}

export async function validateProject(model) {
  const errors = [];
  const warnings = [];
  await validateCoreFiles(model, errors);
  validateBlockShape(model, errors, warnings);
  validateWorkShape(model, errors);
  await validateTraceability(model, errors);
  validateRelease(model, errors, warnings);
  await validateUi(model, errors);
  await validateArtifacts(model, errors);
  await validateSkills(model, errors);
  await validateLinks(model, errors);
  return { errors, warnings };
}

function summarize(values, fallback) {
  if (!values.length) return fallback;
  const visible = values.slice(0, 3);
  return `${visible.join(", ")}${values.length > visible.length ? ` (+${values.length - visible.length})` : ""}`;
}

export function renderStatus(model) {
  const activeItems = model.workItems.filter(item => item.metadata.status === "in_progress");
  const activeBlocks = [...new Set(activeItems.map(item => item.metadata.block).filter(id => id !== "none"))];
  const ready = model.workItems.filter(item => item.metadata.status === "ready");
  const proposedReady = model.workItems.filter(item => item.metadata.status === "proposed" && (item.metadata.depends_on || []).every(id => model.workItems.find(candidate => candidate.metadata.id === id)?.metadata.status === "done"));
  const next = ready[0] || proposedReady[0];
  const blocked = model.workItems.filter(item => item.metadata.status === "blocked");
  const requiredBlocks = model.release.requiredBlocks || [];
  const blockMaturity = requiredBlocks.length
    ? requiredBlocks.map(id => `${id}:${model.blocks.find(block => block.metadata.id === id)?.metadata.maturity || "missing"}`)
    : "L0 (no required blocks yet)";
  const failedGates = (model.release.gates || []).filter(gate => gate.required && gate.status === "fail").map(gate => gate.id);
  const pendingApprovals = (model.release.planningApprovals || []).filter(approval => approval.status !== "approved").map(approval => approval.id);
  const blockers = [...blocked.map(item => item.metadata.id), ...failedGates, ...pendingApprovals.map(id => `approval:${id}`)];
  const nextAction = activeItems.length
    ? `complete ${activeItems[0].metadata.id} against its success criteria`
    : next
      ? `start ${next.metadata.id}: ${next.metadata.title}`
      : "run plan mode with `$project-planning`";
  const validation = model.release.lastValidation?.summary || "none recorded";

  return [
    "# Status",
    "",
    "Generated from canonical project state. Do not append history.",
    "",
    `- Profile: ${model.profile.label || model.profile.id}`,
    `- Phase: ${model.release.phase}`,
    `- Active block: ${summarize(activeBlocks, "none")}`,
    `- Active work item: ${summarize(activeItems.map(item => item.metadata.id), "none")}`,
    `- Required-block maturity: ${Array.isArray(blockMaturity) ? blockMaturity.join(", ") : blockMaturity}`,
    `- Release target: ${model.release.release}`,
    `- Release decision: ${model.release.decision}`,
    `- Next action: ${nextAction}`,
    `- Blockers: ${summarize(blockers, "none")}`,
    `- Last release validation: ${validation}`,
    ""
  ].join("\n");
}
