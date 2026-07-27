// @ts-check

import assert from "node:assert/strict";
import test from "node:test";
import {
  assertAllowedItem,
  assertOutboundMethod,
  classifyNotification,
  ProtocolPolicyError,
  rejectServerRequest,
} from "../../src/codex/protocol-policy.mjs";

test("automation methods are an exact allowlist", () => {
  assert.doesNotThrow(() => assertOutboundMethod("model/list"));
  assert.throws(() => assertOutboundMethod("config/write"), ProtocolPolicyError);
  assert.throws(() => assertOutboundMethod("account/login/start"), ProtocolPolicyError);
  assert.doesNotThrow(() => assertOutboundMethod("account/login/start", { operatorInitiated: true }));
  assert.throws(
    () => assertOutboundMethod("account/login/start", { operatorInitiated: false }),
    ProtocolPolicyError,
  );
});

test("notifications and item types fail closed when unknown or dangerous", () => {
  assert.equal(classifyNotification("turn/completed"), "allow");
  assert.equal(classifyNotification("model/rerouted"), "fail-closed");
  assert.throws(() => classifyNotification("fs/changed"), ProtocolPolicyError);
  assert.doesNotThrow(() => assertAllowedItem({ type: "agentMessage" }));
  assert.throws(() => assertAllowedItem({ type: "commandExecution" }), ProtocolPolicyError);
  assert.throws(() => assertAllowedItem({ type: "fileChange" }), ProtocolPolicyError);
});

test("every server-initiated request is forbidden", () => {
  assert.throws(() => rejectServerRequest("item/commandExecution/requestApproval"), ProtocolPolicyError);
});
