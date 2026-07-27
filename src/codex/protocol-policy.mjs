// @ts-check

export const AUTOMATION_METHODS = new Set([
  "initialize",
  "initialized",
  "config/read",
  "account/read",
  "model/list",
  "skills/list",
  "mcpServerStatus/list",
  "thread/start",
  "thread/resume",
  "turn/start",
  "turn/interrupt",
]);

export const OPERATOR_ONLY_METHODS = new Set([
  "account/login/start",
  "account/login/cancel",
]);

export const ALLOWED_NOTIFICATIONS = new Set([
  "account/login/completed",
  "account/rateLimits/updated",
  "account/updated",
  "configWarning",
  "deprecationNotice",
  "guardianWarning",
  "item/agentMessage/delta",
  "item/completed",
  "item/mcpToolCall/progress",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
  "item/started",
  "mcpServer/startupStatus/updated",
  "model/rerouted",
  "model/safetyBuffering/updated",
  "model/verification",
  "remoteControl/status/changed",
  "skills/changed",
  "thread/compacted",
  "thread/name/updated",
  "thread/settings/updated",
  "thread/started",
  "thread/status/changed",
  "thread/tokenUsage/updated",
  "turn/completed",
  "turn/moderationMetadata",
  "turn/started",
  "warning",
]);

export const FAIL_CLOSED_NOTIFICATIONS = new Set([
  "model/rerouted",
  "skills/changed",
]);

export const ALLOWED_ITEM_TYPES = new Set([
  "agentMessage",
  "collabAgentToolCall",
  "contextCompaction",
  "mcpToolCall",
  "reasoning",
  "subAgentActivity",
  "userMessage",
]);

export class ProtocolPolicyError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "ProtocolPolicyError";
  }
}

/** @param {string} method @param {{operatorInitiated?: boolean}} [options] */
export function assertOutboundMethod(method, options = {}) {
  if (AUTOMATION_METHODS.has(method)) return;
  if (options.operatorInitiated === true && OPERATOR_ONLY_METHODS.has(method)) return;
  throw new ProtocolPolicyError(`outbound app-server method is not allowed: ${method}`);
}

/**
 * @param {string} method
 * @returns {"allow" | "fail-closed"}
 */
export function classifyNotification(method) {
  if (!ALLOWED_NOTIFICATIONS.has(method)) {
    throw new ProtocolPolicyError(`app-server notification is not allowed: ${method}`);
  }
  return FAIL_CLOSED_NOTIFICATIONS.has(method) ? "fail-closed" : "allow";
}

/** @param {unknown} item */
export function assertAllowedItem(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw new ProtocolPolicyError("app-server item must be an object");
  }
  const type = Reflect.get(item, "type");
  if (typeof type !== "string" || !ALLOWED_ITEM_TYPES.has(type)) {
    throw new ProtocolPolicyError(`app-server item type is not allowed: ${String(type)}`);
  }
}

/**
 * The V1 app-server transport is not allowed to ask the desktop host to run
 * commands, write files, approve actions, provide auth tokens, or collect
 * user input. Required MCP executes out-of-process and does not use this path.
 * @param {string} method
 */
export function rejectServerRequest(method) {
  throw new ProtocolPolicyError(`server-initiated request is forbidden: ${method}`);
}
