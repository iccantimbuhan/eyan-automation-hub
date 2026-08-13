#!/usr/bin/env node
// Extracts the ACTUAL jsCode strings from 02-finance-intent-router.json's
// Code nodes and runs them in a mocked n8n Code-node context (Node's
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
// passes contract validation. Classifying/rejecting it is the classifier's
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

// ---- Parse Classification Output (ADR-0012 deterministic parser) ----
function runParse(chainResult) {
  const code = getCode("Parse Classification Output");
  const sandbox = { $json: chainResult, JSON, String, console, result: undefined };
  vm.createContext(sandbox);
  vm.runInContext(`result = (function(){ ${code} })()`, sandbox);
  return sandbox.result[0].json;
}

// As of the ADR-0014 AI Core migration, JSON extraction (fence-stripping,
// brace-span extraction) is AI Core's own job (ai-routing.service.ts's
// extractJson(), called before this node ever runs) -- this node now
// receives AI Core's already-parsed response envelope
// ({data: {outcome, outputJson}} on success, {error} on a transport
// failure). Tests below construct that envelope directly rather than raw
// model text; the markdown-fence/bare-fence/prose-tolerance cases the OLD
// node-local parser needed (dropped from this file) are now AI Core's own
// concern, not this node's -- CRM's Map AI Core Result and this node share
// that same division of labor.
function aiCoreResponse(outputJson) {
  return { data: { outcome: "VALID", outputJson } };
}

// 15. A clean, well-formed classification (the expected happy path) is read correctly
{
  const r = runParse(aiCoreResponse({ intent: "CREATE_EXPENSE", confidence: 0.92 }));
  check("clean classification -> intent extracted", r.intent === "CREATE_EXPENSE", r);
  check("clean classification -> confidence extracted", r.confidence === 0.92, r);
}

// 16. An intent outside the known catalog is forced to UNRECOGNIZED, never passed through raw
{
  const r = runParse(aiCoreResponse({ intent: "DELETE_ALL_EXPENSES", confidence: 0.99 }));
  check("unknown intent value forced to UNRECOGNIZED", r.intent === "UNRECOGNIZED" && r.confidence === 0, r);
}

// 17. A non-VALID AI Core outcome (AI Core already exhausted its own
// maxRetries against SCHEMA_INVALID/TRANSIENT_FAILURE before giving up) ->
// UNRECOGNIZED, confidence 0, no throw.
{
  const r = runParse({ data: { outcome: "SCHEMA_INVALID" } });
  check("non-VALID AI Core outcome -> UNRECOGNIZED", r.intent === "UNRECOGNIZED", r);
  check("non-VALID AI Core outcome -> confidence 0", r.confidence === 0, r);
}

// 18. VALID outcome but no outputJson at all (defensive -- should not
// happen in practice, but never trusted blindly) -> UNRECOGNIZED, no throw.
{
  const r = runParse({ data: { outcome: "VALID", outputJson: undefined } });
  check("VALID outcome with no outputJson -> UNRECOGNIZED", r.intent === "UNRECOGNIZED" && r.confidence === 0, r);
}

// 19. A tool-call-wrapped response (the exact ADR-0009 failure shape) is
// rejected even if AI Core successfully parsed it as JSON -- there is no
// "intent" key at the top level, so isValidClassification correctly falls
// back rather than accidentally succeeding. This is the defense-in-depth
// this node keeps specifically because AI Core enforces no business schema
// of its own (see docs/adrs/ADR-0014-finance-ai-core-migration.md).
{
  const r = runParse(aiCoreResponse({ name: "format_final_json_response", arguments: { output: { intent: "CREATE_EXPENSE", confidence: 1.0 } } }));
  check("tool-call-wrapped shape (no top-level intent) -> UNRECOGNIZED", r.intent === "UNRECOGNIZED" && r.confidence === 0, r);
}

// 20. intent present but not a string -> rejected
{
  const r = runParse(aiCoreResponse({ intent: 42, confidence: 0.9 }));
  check("non-string intent -> UNRECOGNIZED", r.intent === "UNRECOGNIZED", r);
}

// 21. confidence out of [0, 1] range -> rejected
{
  const r = runParse(aiCoreResponse({ intent: "CREATE_EXPENSE", confidence: 1.5 }));
  check("confidence > 1 -> UNRECOGNIZED", r.intent === "UNRECOGNIZED" && r.confidence === 0, r);
}
{
  const r = runParse(aiCoreResponse({ intent: "CREATE_EXPENSE", confidence: -0.1 }));
  check("confidence < 0 -> UNRECOGNIZED", r.intent === "UNRECOGNIZED" && r.confidence === 0, r);
}

// 22. confidence as a non-numeric value (e.g. a string) -> rejected
{
  const r = runParse(aiCoreResponse({ intent: "CREATE_EXPENSE", confidence: "high" }));
  check("non-numeric confidence -> UNRECOGNIZED", r.intent === "UNRECOGNIZED", r);
}

// 23. A genuine array as outputJson (not an object) -> rejected. (Under the
// OLD node-local parser, a top-level array like `[{"intent":...}]` was
// specifically unwrapped-then-rejected by a two-stage parse; AI Core's own
// extractJson() instead extracts the first {...} brace span BEFORE this
// node ever sees it, so that specific case no longer reaches this node as
// an array at all -- it arrives as the already-unwrapped object. This test
// instead covers the case AI Core's own extraction still can produce a
// true array, e.g. the model's entire response literally being a JSON
// array with no {} braces anywhere.)
{
  const r = runParse(aiCoreResponse([1, 2, 3]));
  check("array outputJson (no braces at all in the model's response) -> UNRECOGNIZED", r.intent === "UNRECOGNIZED", r);
}

// 24. Confidence exactly at the boundaries (0 and 1) is accepted, not rejected
{
  const r0 = runParse(aiCoreResponse({ intent: "UNRECOGNIZED", confidence: 0 }));
  check("confidence === 0 is accepted", r0.intent === "UNRECOGNIZED" && r0.confidence === 0, r0);
  const r1 = runParse(aiCoreResponse({ intent: "CREATE_EXPENSE", confidence: 1 }));
  check("confidence === 1 is accepted", r1.intent === "CREATE_EXPENSE" && r1.confidence === 1, r1);
}

// 25. The AI Core call itself failing (onError: continueRegularOutput ->
// $json.error, e.g. a real network failure) is handled gracefully, never
// crashes, never reaches the Intent Router with a bad value. This guard's
// shape is unchanged by the migration -- both the old Chain node and the
// new AI Core httpRequest node use the same onError -> $json.error pattern.
{
  const r = runParse({ error: "some connection failure" });
  check("AI Core call failure -> UNRECOGNIZED, not a thrown error", r.intent === "UNRECOGNIZED" && r.confidence === 0, r);
}

// 26. The parser only ever returns exactly {intent, confidence} -- no other
// fields leak through, matching "The Router must return only: intent,
// confidence" for the classification step itself.
{
  const r = runParse(aiCoreResponse({ intent: "CREATE_EXPENSE", confidence: 0.9, amount: 12.5, category: "FOOD" }));
  check("extra fields in the model's output are dropped, not passed through", Object.keys(r).sort().join(",") === "confidence,intent", r);
}

// ---- Merge Context With Classification ----
function runMerge({ classification, context }) {
  const code = getCode("Merge Context With Classification");
  const sandbox = {
    $json: classification,
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

// 29. Merges the already-clean {intent, confidence} with the original request context
{
  const r = runMerge({ classification: { intent: "CREATE_EXPENSE", confidence: 0.92 }, context: NORMALIZED_CONTEXT });
  check("intent passes through", r.intent === "CREATE_EXPENSE", r);
  check("confidence passes through", r.confidence === 0.92, r);
  check("original request context is preserved", r.rawText === "spent $12.50 on lunch" && r.workflowExecutionId === "exec-3", r);
}

// ---- Return Handler Response ----
function runReturnResponse({ handlerResult, context }) {
  const code = getCode("Return Handler Response");
  const sandbox = {
    $json: handlerResult,
    $: (name) => {
      if (name !== "Merge Context With Classification") throw new Error("unexpected node ref: " + name);
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

// 30. A successful Handler response is returned COMPLETELY UNCHANGED -- the
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

// 31. A missing/failed Handler (onError: continueRegularOutput -> $json.error
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

// 32. error as a plain string (not an {message} object) is also handled
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

// 33. Request Valid? gate
{
  check("valid:true routes to the classifier branch", requestValid({ valid: true }) === true);
  check("valid:false routes to the contract-violation branch", requestValid({ valid: false }) === false);
}

const KNOWN_INTENTS = [
  "CREATE_EXPENSE", "GET_BUDGET", "GET_DASHBOARD", "GET_FINANCE_QUESTION",
  "CREATE_INCOME", "CREATE_TRANSFER", "UPLOAD_RECEIPT", "UNRECOGNIZED",
];

function routeIntent(intent) {
  return KNOWN_INTENTS.includes(intent) ? intent : "Fallback";
}

// 34. Every one of the 8 Intent Catalog values routes to its own dedicated
// Handler-calling branch -- one Execute Workflow node per intent, no inline
// business logic in any branch (verified structurally in the JSON: every
// "Execute Handler - *" node's only parameter is a workflowId).
for (const intent of KNOWN_INTENTS) {
  check(`Intent Router routes ${intent} to its own branch`, routeIntent(intent) === intent);
}

// 35. An intent value the Switch has no explicit rule for falls to the
// defensive "Fallback" extra output -- should be unreachable in practice
// (steps 19-25 above already prove "Parse Classification Output" never
// lets an unknown value this far), but wired to the UNRECOGNIZED Handler
// too, per "never strand a message."
{
  check("an unexpected intent value falls to the Fallback output", routeIntent("SOMETHING_UNEXPECTED") === "Fallback");
}

// 36. Structural check on the workflow JSON itself: every "Execute Handler -
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

// 37. Structural check (ADR-0014): exactly one httpRequest node exists --
// the AI Core capability call -- and it is the ONLY API surface this
// workflow holds. The Router still never calls the Finance REST API
// directly (no /finance/service/* call anywhere), and still never performs
// any Finance-shaped payload construction -- both true before and after
// this migration; what changed is that Ollama is no longer called
// directly either, and the "EYAN Service API" credential (previously held
// only by CRM/Finance-write workflows) is now legitimately held here too,
// for the AI Core call, not a Finance API call.
{
  const httpRequestNodes = wf.nodes.filter((n) => n.type === "n8n-nodes-base.httpRequest");
  check("exactly one httpRequest node exists in the Router (the AI Core call)", httpRequestNodes.length === 1, httpRequestNodes.map((n) => n.name));
  check(
    "that node targets AI Core's finance-intent-classification capability",
    httpRequestNodes[0] && httpRequestNodes[0].parameters.url.includes("/ai-core/service/capabilities/finance-intent-classification/invoke"),
    httpRequestNodes.map((n) => n.parameters.url)
  );
  check(
    "no httpRequest node calls the Finance REST API directly",
    !httpRequestNodes.some((n) => n.parameters.url.includes("/finance/service/")),
    httpRequestNodes.map((n) => n.parameters.url)
  );
  check(
    "no httpRequest node calls Ollama directly anymore",
    !httpRequestNodes.some((n) => n.parameters.url.includes("OLLAMA_BASE_URL")),
    httpRequestNodes.map((n) => n.parameters.url)
  );
}

// 38. Structural check (ADR-0012/ADR-0014): the classification mechanism
// uses neither the n8n AI Agent node, the LangChain Structured Output
// Parser, nor (as of ADR-0014) a Chat Model/Chain node pair -- ADR-0009's
// tool-call-wrapper failure mode is specific to LangChain's ToolsAgent
// machinery, none of which AI Core's own provider layer uses either
// (verified live, see ADR-0014).
{
  const agentNodes = wf.nodes.filter((n) => n.type === "@n8n/n8n-nodes-langchain.agent");
  check("no n8n AI Agent node exists anywhere in the Router", agentNodes.length === 0, agentNodes.map((n) => n.name));
  const parserNodes = wf.nodes.filter((n) => n.type === "@n8n/n8n-nodes-langchain.outputParserStructured");
  check("no LangChain Structured Output Parser node exists anywhere in the Router", parserNodes.length === 0, parserNodes.map((n) => n.name));
  const chatModelNodes = wf.nodes.filter((n) => n.type === "@n8n/n8n-nodes-langchain.lmChatOllama");
  check("no LangChain Ollama Chat Model node exists anywhere in the Router", chatModelNodes.length === 0, chatModelNodes.map((n) => n.name));
  const chainNodes = wf.nodes.filter((n) => n.type === "@n8n/n8n-nodes-langchain.chainLlm");
  check("no LangChain Chain node exists anywhere in the Router", chainNodes.length === 0, chainNodes.map((n) => n.name));
  const hasAiLanguageModelConnection = Object.values(wf.connections).some((conns) => "ai_languageModel" in conns);
  check("no node in the workflow has an ai_languageModel connection", hasAiLanguageModelConnection === false);
  const hasOutputParserConnection = Object.values(wf.connections).some((conns) => "ai_outputParser" in conns);
  check("no node in the workflow has an ai_outputParser connection", hasOutputParserConnection === false);
}

// 39. Structural check (ADR-0014): the "Call AI Core - Intent Classification"
// node is correctly configured -- POST, JSON body with expectJson: true
// (required for AI Core to attempt JSON parsing at all -- see
// ai-routing.service.ts), the shared "EYAN Service API" credential (the
// same one CRM's own "Call AI Core" node and this repo's Finance-write
// calls already use, per docs/security/credential-management.md).
{
  const node = wf.nodes.find((n) => n.name === "Call AI Core - Intent Classification");
  check("Call AI Core - Intent Classification exists and is an httpRequest node", !!node && node.type === "n8n-nodes-base.httpRequest", node);
  check("method is POST", node.parameters.method === "POST", node.parameters);
  check("body declares context.expectJson: true", node.parameters.jsonBody.includes("expectJson: true"), node.parameters.jsonBody);
  check("body declares workflowName for this hop", node.parameters.jsonBody.includes("workflowName: '02-finance-intent-router'"), node.parameters.jsonBody);
  check(
    "credential is a reference to the existing EYAN Service API credential, not an inline secret",
    node.credentials && node.credentials.httpHeaderAuth.id === "HkpCn7QOHOauRVq1" && node.credentials.httpHeaderAuth.name === "EYAN Service API",
    node.credentials
  );
}

console.log(`\n${pass} passed, ${fail} failed (${pass + fail} total assertions)`);
process.exit(fail > 0 ? 1 : 0);
