// @ts-check

import { acceptedFixtureRequest, fixtureRequestBytes, rejectedFixtureRequest } from "./fixtures.mjs";
import { AuthorityAdapterError, invokePaperAuthority } from "./authority-client.mjs";

export async function runFixtureCli(argv = process.argv.slice(2), out = process.stdout, err = process.stderr) {
  const caseIndex = argv.indexOf("--case");
  const name = caseIndex >= 0 ? argv[caseIndex + 1] : null;
  if (name !== "accepted" && name !== "rejected") {
    err.write("usage: npm run paper:fixture -- --case accepted|rejected\n");
    return 2;
  }
  const request = name === "accepted" ? acceptedFixtureRequest() : rejectedFixtureRequest();
  try {
    const response = await invokePaperAuthority({ requestBytes: fixtureRequestBytes(request) });
    const refs = response.gateDecision.inputRefs;
    out.write(`${JSON.stringify({
      schemaVersion: 1,
      case: name,
      profile: response.profile,
      requestId: response.requestId,
      operationId: response.operationId,
      status: response.status,
      primaryReasonCode: response.primaryReasonCode,
      reasonCodes: response.reasonCodes,
      evidence: { eventId: refs.eventId, candidateId: refs.candidateId, intentId: refs.intentId, verdictId: refs.verdictId },
      gate: { decisionId: response.gateDecision.decisionId, decision: response.gateDecision.decision },
      planId: response.orderPlan?.planId ?? null,
      executionId: response.executionEvent?.executionId ?? null,
      audit: { eventCount: response.auditEvents.length, headHash: response.headHash },
    })}\n`);
    return 0;
  } catch (error) {
    const code = error instanceof AuthorityAdapterError ? error.code : "AUTHORITY_PROCESS_FAILED";
    out.write(`${JSON.stringify({ schemaVersion: 1, case: name, status: "ERROR", errorCode: code })}\n`);
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = await runFixtureCli();
