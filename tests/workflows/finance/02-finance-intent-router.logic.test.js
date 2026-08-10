#!/usr/bin/env node
// Extracts the ACTUAL jsCode strings from 02-finance-intent-router.json's
// four Code nodes and runs them in a mocked n8n Code-node context (Node's
// built-in `vm`, zero dependencies), same approach as
// tests/workflows/finance/01-finance-inbox-entry.logic.test.js. Run:
// node tests/workflows/finance/02-finance-intent-router.logic.test.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const wf = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "../../../workflows/finance/02-finance-intent-router.json"),
    "utf8"
  )
);

function getCode(nodeName) {
  const node = wf.nodes.find((n) => n.name === nodeName);
  if (!node) throw new Error(`Node not found: ${nodeName}`);
  return node.parameters.jsCode;
}

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.log(`FAIL: ${label}${detail ? " -- " + JSON.stringify(detail) : ""}`);
  }
}

// ---- Validate Request Contract ----
function runValidate(request) {
  const code = getCode("Validate Request Contract");
  const sandbox = { $json: request, Array, console, result: undefined };
  vm.createContext(sandbox);
  vm.runInContext(`result = (function(){ ${code} })()`, sandbox);
  return sandbox.result[0].json;
}

const VALID_REQUEST = {
  contractVersion: "1",
  workflowExecutionId: "exec-1",
  workflowName: "01-finance-inbox-entry",
  channel: "slack",
  externalUserId: "U012ABC",
  externalMessageId: "1691250000.000100",
  rawText: "spent $12.50 on lunch",
  attachments: [],
};

// 1. A well-formed request matching the Finance Inbox Request Contract -> valid
{
  const r = runValidate(VALID_REQUEST);
  check("well-formed request is valid", r.valid === true, r);
  check("reason is empty on success", r.reason === "", r);
}

// 2-5. Each required field's absence is individually detected -- this is the
// Router's one allowed kind of validation (contract-shape, ADR-0008
// Decision 1), never Finance-specific.
for (const field of ["contractVersion", "workflowExecutionId", "workflowName", "channel"]) {
  const { [field]: _omit, ...rest } = VALID_REQUEST;
  const r = runValidate(rest);
  check(`missing ${field} -> invalid`, r.valid === false && r.reason.includes(field), r);
}

// 6. An unrecognized channel is rejected
{
  const r = runValidate({ ...VALID_REQUEST, channel: "carrier-pigeon" });
  check("unknown channel -> invalid", r.valid === false && /Unknown channel/.test(r.reason), r);
}

// 7. rawText === '' is legitimate (e.g. an image-only OCR submission) -- never rejected
{
  const r = runValidate({ ...VALID_REQUEST, rawText: "" });
  check("empty rawText is still valid (not missing)", r.valid === true, r);
}

// 8. rawText entirely absent (not even an empty string) -> invalid
{
  const { rawText: _omit, ...rest } = VALID_REQUEST;
  const r = runValidate(rest);
  check("missing rawText -> invalid", r.valid === false && /rawText/.test(r.reason), r);
}

// 9-10. externalUserId/externalMessageId are nullable but the KEY must be present
{
  const r = runValidate({ ...VALID_REQUEST, externalUserId: null, externalMessageId: null });
  check("null externalUserId/externalMessageId is valid (nullable, not absent)", r.valid === true, r);
}
{
  const { externalUserId: _omit, ...rest } = VALID_REQUEST;
  const r = runValidate(rest);
  check("missing externalUserId KEY -> invalid", r.valid === false && /externalUserId/.test(r.reason), r);
}

// 11. attachments must be an array
{
  const r = runValidate({ ...VALID_REQUEST, attachments: "not-an-array" });
  check("non-array attachments -> invalid", r.valid === false && /attachments/.test(r.reason), r);
}

// 12. This node never applies a Finance-specific rule -- proven by showing
// an obviously Finance-invalid rawText (no amount, no anything) still
// passes contract validation. Classifying/rejecting it is the AI Agent's
// and downstream Handler's job, never this node's.
{
  const r = runValidate({ ...VALID_REQUEST, rawText: "hello, how are you?" });
  check("Finance-irrelevant but contract-valid text still passes -- no Finance-specific rule here", r.valid === true, r);
}

// ---- Build Contract Violation Response ----
function runViolation(validationResult) {
  const code = getCode("Build Contract Violation Response");
  const sandbox = { $json: validationResult, console, result: undefined };
  vm.createContext(sandbox);
  vm.runInContext(`result = (function(){ ${code} })()`, sandbox);
  return sandbox.result[0].json;
}

// 13. Produces a fully Response-contract-shaped object (ADR-0008 Decision 2)
{
  const r = runViolation({ valid: false, reason: "Missing channel.", workflowExecutionId: "exec-2" });
  check("status is error", r.status === "error", r);
  check("intent is UNRECOGNIZED", r.intent === "UNRECOGNIZED", r);
  check("workflowExecutionId echoed", r.workflowExecutionId === "exec-2", r);
  check("message is a non-empty string", typeof r.message === "string" && r.message.length > 0, r);
  check("clarifyingQuestion is null", r.clarifyingQuestion === null, r);
}

// 14. Falls back to 'unknown' when even workflowExecutionId is missing
{
  const r = runViolation({ valid: false, reason: "Missing everything." });
  check("workflowExecutionId falls back to 'unknown'", r.workflowExecutionId === "unknown", r);
}

// ---- Validate Agent Output ----
function runValidateAgentOutput({ agentResult, context }) {
  const code = getCode("Validate Agent Output");
  const sandbox = {
    $json: agentResult,
    $: (name) => {
      if (name !== "Validate Request Contract") throw new Error("unexpected node ref: " + name);
      return { item: { json: context } };
    },
    console,
    result: undefined,
  };
  vm.createContext(sandbox);
  vm.runInContext(`result = (function(){ ${code} })()`, sandbox);
  return sandbox.result[0].json;
}

const NORMALIZED_CONTEXT = {
  contractVersion: "1",
  workflowExecutionId: "exec-3",
  workflowName: "01-finance-inbox-entry",
  channel: "slack",
  externalUserId: "U012ABC",
  externalMessageId: "1691250000.000100",
  rawText: "spent $12.50 on lunch",
  attachments: [],
};

// 15. A well-formed structured-output object -> intent/confidence extracted correctly
{
  const r = runValidateAgentOutput({
    agentResult: { output: { intent: "CREATE_EXPENSE", confidence: 0.92 } },
    context: NORMALIZED_CONTEXT,
  });
  check("known intent passes through", r.intent === "CREATE_EXPENSE", r);
  check("confidence passes through", r.confidence === 0.92, r);
  check("original request context is preserved (not the Agent's own shape)", r.rawText === "spent $12.50 on lunch" && r.workflowExecutionId === "exec-3", r);
}

// 16. Structured output arriving as a JSON string is parsed, not rejected
{
  const r = runValidateAgentOutput({
    agentResult: { output: '{"intent":"GET_DASHBOARD","confidence":0.8}' },
    context: NORMALIZED_CONTEXT,
  });
  check("string-encoded output is parsed", r.intent === "GET_DASHBOARD" && r.confidence === 0.8, r);
}

// 17. An intent outside the known catalog is forced to UNRECOGNIZED, never passed through raw
{
  const r = runValidateAgentOutput({
    agentResult: { output: { intent: "DELETE_ALL_EXPENSES", confidence: 0.99 } },
    context: NORMALIZED_CONTEXT,
  });
  check("unknown intent value forced to UNRECOGNIZED", r.intent === "UNRECOGNIZED", r);
}

// 18. Malformed/unparseable output -> UNRECOGNIZED, confidence 0, no throw
{
  const r = runValidateAgentOutput({
    agentResult: { output: "{not valid json" },
    context: NORMALIZED_CONTEXT,
  });
  check("malformed output -> UNRECOGNIZED", r.intent === "UNRECOGNIZED", r);
  check("malformed output -> confidence 0", r.confidence === 0, r);
}

// 19. The Agent node itself failing (onError: continueRegularOutput -> $json.error,
// e.g. a real, observed local-model schema mismatch) is handled gracefully,
// never crashes, never reaches the Intent Router with a bad value.
{
  const r = runValidateAgentOutput({
    agentResult: { error: "Model output doesn't fit required format" },
    context: NORMALIZED_CONTEXT,
  });
  check("Agent call failure -> UNRECOGNIZED, not a thrown error", r.intent === "UNRECOGNIZED" && r.confidence === 0, r);
}

// 20. A missing/non-numeric confidence defaults to 0 rather than undefined/NaN
{
  const r = runValidateAgentOutput({
    agentResult: { output: { intent: "CREATE_EXPENSE" } },
    context: NORMALIZED_CONTEXT,
  });
  check("missing confidence defaults to 0", r.confidence === 0, r);
}

// ---- Return Handler Response ----
function runReturnResponse({ handlerResult, context }) {
  const code = getCode("Return Handler Response");
  const sandbox = {
    $json: handlerResult,
    $: (name) => {
      if (name !== "Validate Agent Output") throw new Error("unexpected node ref: " + name);
      return { item: { json: context } };
    },
    console,
    result: undefined,
  };
  vm.createContext(sandbox);
  vm.runInContext(`result = (function(){ ${code} })()`, sandbox);
  return sandbox.result[0].json;
}

const CLASSIFIED_CONTEXT = { ...NORMALIZED_CONTEXT, intent: "CREATE_EXPENSE", confidence: 0.92 };

// 21. A successful Handler response is returned COMPLETELY UNCHANGED -- the
// one requirement this node exists to satisfy (per this workflow's stated
// scope: "Return the downstream Handler response unchanged").
{
  const handlerResponse = {
    contractVersion: "1",
    workflowExecutionId: "exec-3",
    status: "success",
    intent: "CREATE_EXPENSE",
    message: "Logged $12.50 to FOOD.",
    data: { id: "expense-1", amount: "12.50", category: "FOOD" },
    clarifyingQuestion: null,
    // A hypothetical extra field a future Handler might add -- proving this
    // node truly passes the object through rather than re-serializing a
    // known subset of fields.
    debugTrace: ["step1", "step2"],
  };
  const r = runReturnResponse({ handlerResult: handlerResponse, context: CLASSIFIED_CONTEXT });
  check("Handler response returned byte-identical (deep equal)", JSON.stringify(r) === JSON.stringify(handlerResponse), r);
}

// 22. A missing/failed Handler (onError: continueRegularOutput -> $json.error
// -- true for every intent this phase, since no Handler workflow exists
// yet) synthesizes a Response-contract-shaped fallback -- orchestration
// resilience, not a Finance business decision.
{
  const r = runReturnResponse({
    handlerResult: { error: { message: "Workflow FinanceHandlerCreateExpenseWf01 not found" } },
    context: CLASSIFIED_CONTEXT,
  });
  check("missing Handler -> status error", r.status === "error", r);
  check("missing Handler -> intent preserved from context, not lost", r.intent === "CREATE_EXPENSE", r);
  check("missing Handler -> workflowExecutionId preserved from context", r.workflowExecutionId === "exec-3", r);
  check("missing Handler -> friendly message, not a raw error string", /couldn't process/i.test(r.message), r);
}

// 23. error as a plain string (not an {message} object) is also handled
{
  const r = runReturnResponse({ handlerResult: { error: "some string error" }, context: CLASSIFIED_CONTEXT });
  check("plain-string error handled without throwing", r.status === "error", r);
}

// ---- Structural sanity check on the "Request Valid?" IF-node condition and
// the "Intent Router" Switch-node rules (declarative n8n expressions, not
// extractable jsCode -- re-implemented here to verify their intended
// semantics, same technique 04-sales-automation.logic.test.js already
// established for this repo's IF-gate conditions) ----
function requestValid(validationResult) {
  return validationResult.valid === true;
}

// 24. Request Valid? gate
{
  check("valid:true routes to the AI Agent branch", requestValid({ valid: true }) === true);
  check("valid:false routes to the contract-violation branch", requestValid({ valid: false }) === false);
}

const KNOWN_INTENTS = [
  "CREATE_EXPENSE", "GET_BUDGET", "GET_DASHBOARD", "GET_FINANCE_QUESTION",
  "CREATE_INCOME", "CREATE_TRANSFER", "UPLOAD_RECEIPT", "UNRECOGNIZED",
];

function routeIntent(intent) {
  return KNOWN_INTENTS.includes(intent) ? intent : "Fallback";
}

// 25. Every one of the 8 Intent Catalog values routes to its own dedicated
// Handler-calling branch -- one Execute Workflow node per intent, no inline
// business logic in any branch (verified structurally in the JSON: every
// "Execute Handler - *" node's only parameter is a workflowId).
for (const intent of KNOWN_INTENTS) {
  check(`Intent Router routes ${intent} to its own branch`, routeIntent(intent) === intent);
}

// 26. An intent value the Switch has no explicit rule for falls to the
// defensive "Fallback" extra output -- should be unreachable in practice
// (step 17-19 above already prove "Validate Agent Output" never lets an
// unknown value this far), but wired to the UNRECOGNIZED Handler too, per
// "never strand a message."
{
  check("an unexpected intent value falls to the Fallback output", routeIntent("SOMETHING_UNEXPECTED") === "Fallback");
}

// 27. Structural check on the workflow JSON itself: every "Execute Handler -
// *" node's parameters contain ONLY a workflowId -- proving by inspection
// that the Router truly never knows how any Handler works (no jsonBody, no
// URL, no Finance-shaped payload construction anywhere in this workflow).
{
  const handlerNodes = wf.nodes.filter((n) => n.name.startsWith("Execute Handler - "));
  check("exactly 8 Handler-calling nodes exist (one per Intent Catalog entry)", handlerNodes.length === 8, handlerNodes.map((n) => n.name));
  for (const node of handlerNodes) {
    const keys = Object.keys(node.parameters);
    check(`${node.name} has only a workflowId parameter (no inline logic)`, keys.length === 1 && keys[0] === "workflowId", node.parameters);
    check(`${node.name} has onError: continueRegularOutput`, node.onError === "continueRegularOutput", node.onError);
  }
}

// 28. Structural check: no node in this workflow calls the Finance REST API
// directly -- the Router must never hold the "EYAN Service API" credential
// or make an httpRequest call to /finance/service/*.
{
  const httpRequestNodes = wf.nodes.filter((n) => n.type === "n8n-nodes-base.httpRequest");
  check("no httpRequest node exists anywhere in the Router", httpRequestNodes.length === 0, httpRequestNodes.map((n) => n.name));
}

console.log(`\n${pass} passed, ${fail} failed (${pass + fail} total assertions)`);
process.exit(fail > 0 ? 1 : 0);
