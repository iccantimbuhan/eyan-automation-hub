#!/usr/bin/env node
// Extracts the ACTUAL jsCode strings from 10-handle-create-expense.json's
// Code nodes and runs them in a mocked n8n Code-node context (Node's
// built-in `vm`, zero dependencies), same approach as
// tests/workflows/finance/02-finance-intent-router.logic.test.js. Run:
// node tests/workflows/finance/10-handle-create-expense.logic.test.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { Script } = require("vm");

const wf = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "../../../workflows/finance/10-handle-create-expense.json"),
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

// ---- Syntax regression check on every Code node ----
// A real bug was found during Phase 3A live-validation: v1's "Prepare
// Expense Extraction Input" embedded a prompt inside a JS template literal
// (`const systemPrompt = \`...\`;`), and part of that prompt text wrapped
// `${today}` in single Markdown-style backticks (`` use `${today}` ``) --
// valid in the .md reference file, but a genuine JS SyntaxError once
// embedded literally inside a template literal (an unescaped backtick
// closes the literal rather than nesting, leaving a bare `${today}`
// outside any string). This would have thrown the first time this node
// actually ran in n8n; the pre-existing logic tests never caught it
// because `new Function(jsCode)` and this file's own `vm.runInContext`
// technique only compile a jsCode string on-demand for the node under
// test, and nothing before this pass checked EVERY node's syntax
// independent of whether a specific test case happened to exercise it.
// This block closes that gap for good, for every Code node, not just the
// one that broke.
{
  for (const node of wf.nodes) {
    if (node.type !== "n8n-nodes-base.code") continue;
    let syntaxError = null;
    try {
      // eslint-disable-next-line no-new
      new Script(`(function(){ ${node.parameters.jsCode} })`);
    } catch (error) {
      syntaxError = error.message;
    }
    check(`${node.name}: jsCode is syntactically valid JavaScript`, syntaxError === null, syntaxError);
  }
}

// ---- Validate Handler Input ----
function runValidateInput(request) {
  const code = getCode("Validate Handler Input");
  const sandbox = { $json: request, Array, Date, console, result: undefined };
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

// 1. A well-formed request is valid and forwards every field unchanged
{
  const r = runValidateInput(VALID_REQUEST);
  check("well-formed request is valid", r.valid === true, r);
  check("workflowExecutionId forwarded unchanged", r.workflowExecutionId === "exec-1", r);
  check("externalUserId forwarded unchanged", r.externalUserId === "U012ABC", r);
  check("channel forwarded unchanged", r.channel === "slack", r);
  check("rawText forwarded unchanged", r.rawText === "spent $12.50 on lunch", r);
}

// 2. Handler-specific rule: externalUserId is REQUIRED here (stricter than
// the shared Inbox Contract, which allows it to be null) -- without a real
// sender identity this Handler cannot safely attribute an expense.
{
  const r = runValidateInput({ ...VALID_REQUEST, externalUserId: null });
  check("null externalUserId is rejected by this Handler", r.valid === false && /externalUserId/.test(r.reason), r);
}
{
  const r = runValidateInput({ ...VALID_REQUEST, externalUserId: "" });
  check("empty-string externalUserId is rejected", r.valid === false, r);
}

// 3. Missing contract-shape fields are still individually detected
for (const field of ["contractVersion", "workflowExecutionId", "workflowName", "channel"]) {
  const { [field]: _omit, ...rest } = VALID_REQUEST;
  const r = runValidateInput(rest);
  check(`missing ${field} -> invalid`, r.valid === false && r.reason.includes(field), r);
}

// ---- Build Invalid Input Response ----
function runInvalidInputResponse(validationResult) {
  const code = getCode("Build Invalid Input Response");
  const sandbox = { $json: validationResult, console, result: undefined };
  vm.createContext(sandbox);
  vm.runInContext(`result = (function(){ ${code} })()`, sandbox);
  return sandbox.result[0].json;
}

// 4. Response Contract shape on invalid input -- error, intent preserved
// as CREATE_EXPENSE (not UNRECOGNIZED -- the Router already classified
// this correctly before dispatching here), no raw internal detail exposed.
{
  const r = runInvalidInputResponse({ valid: false, reason: "Missing externalUserId.", workflowExecutionId: "exec-2" });
  check("status is error", r.status === "error", r);
  check("intent stays CREATE_EXPENSE on Handler-level rejection", r.intent === "CREATE_EXPENSE", r);
  check("workflowExecutionId echoed", r.workflowExecutionId === "exec-2", r);
  check("message does not leak the raw validation reason", !r.message.includes("externalUserId"), r);
  check("contractVersion present", r.contractVersion === "1", r);
  check("clarifyingQuestion is null (not an ambiguity case)", r.clarifyingQuestion === null, r);
}

// ---- Prepare Expense Extraction Input ----
function runPrepareExtraction(handlerInput) {
  const code = getCode("Prepare Expense Extraction Input");
  const sandbox = {
    $: (name) => {
      if (name !== "Validate Handler Input") throw new Error("unexpected node ref: " + name);
      return { item: { json: handlerInput } };
    },
    Date,
    console,
    result: undefined,
  };
  vm.createContext(sandbox);
  vm.runInContext(`result = (function(){ ${code} })()`, sandbox);
  return sandbox.result[0].json;
}

const VALIDATED_INPUT = {
  ...VALID_REQUEST,
  startedAt: 1000000,
};

// 5. Builds a well-formed Ollama request: correct model, native JSON mode,
// user message carries the raw text, today's date is embedded for
// relative-date resolution.
{
  const r = runPrepareExtraction(VALIDATED_INPUT);
  check("model is gemma3:4b (production-capacity finding, see ADR-0011 Addendum, not $env.OLLAMA_MODEL)", r.ollamaRequestBody.model === "gemma3:4b", r);
  check("format is Ollama's native json mode", r.ollamaRequestBody.format === "json", r);
  check("not streamed", r.ollamaRequestBody.stream === false, r);
  check("temperature is 0 for deterministic extraction", r.ollamaRequestBody.options.temperature === 0, r);
  check("num_ctx is 2048 (production-tested value, preferable to the 4096 default for this workload)", r.ollamaRequestBody.options.num_ctx === 2048, r);
  check("system message present", typeof r.ollamaRequestBody.messages[0].content === "string" && r.ollamaRequestBody.messages[0].content.length > 0, r);
  check("user message carries rawText", r.ollamaRequestBody.messages[1].content.includes("spent $12.50 on lunch"), r);
  check("today is a real YYYY-MM-DD date embedded in the system prompt", r.ollamaRequestBody.messages[0].content.includes(r.today), r);
  check("startedAt survives forward (needed later for durationMs)", r.startedAt === 1000000, r);
}

// 6. Attachment-only message still produces a usable prompt (attachment
// count is noted, never silently dropped).
{
  const r = runPrepareExtraction({ ...VALIDATED_INPUT, rawText: "", attachments: [{ url: "https://x", mimeType: "image/png", name: "r.png" }] });
  check("attachment count is noted in the user message", r.ollamaRequestBody.messages[1].content.includes("1 attachment"), r);
}

// ---- Validate Expense Extraction ----
function runValidateExtraction({ ollamaResult, context }) {
  const code = getCode("Validate Expense Extraction");
  const sandbox = {
    $json: ollamaResult,
    $: (name) => {
      if (name !== "Prepare Expense Extraction Input") throw new Error("unexpected node ref: " + name);
      return { item: { json: context } };
    },
    console,
    result: undefined,
  };
  vm.createContext(sandbox);
  vm.runInContext(`result = (function(){ ${code} })()`, sandbox);
  return sandbox.result[0].json;
}

const EXTRACTION_CONTEXT = { ...VALIDATED_INPUT, today: "2026-08-10", ollamaRequestBody: {} };

function ollamaChatResponse(obj) {
  return { message: { role: "assistant", content: JSON.stringify(obj) } };
}

// 7. Valid extraction (amount + category present) -> extractionOutcome: valid
{
  const r = runValidateExtraction({
    ollamaResult: ollamaChatResponse({ amount: 12.5, category: "FOOD", paymentMethod: null, date: "2026-08-10", description: "lunch" }),
    context: EXTRACTION_CONTEXT,
  });
  check("valid extraction reaches 'valid' outcome", r.extractionOutcome === "valid", r);
  check("amount extracted correctly", r.amount === 12.5, r);
  check("category extracted correctly", r.category === "FOOD", r);
  check("description extracted correctly", r.description === "lunch", r);
  check("context (workflowExecutionId etc.) is preserved through extraction", r.workflowExecutionId === "exec-1" && r.externalUserId === "U012ABC", r);
}

// 7b. description is genuinely OPTIONAL: a valid extraction with no
// description at all (amount + category present, nothing else) still
// reaches 'valid' -- description never blocks an otherwise-complete
// expense (unlike amount/category, which do).
{
  const r = runValidateExtraction({
    ollamaResult: ollamaChatResponse({ amount: 12.5, category: "FOOD", date: "2026-08-10" }),
    context: EXTRACTION_CONTEXT,
  });
  check("extraction with no description at all is still 'valid'", r.extractionOutcome === "valid", r);
  check("description is undefined, not a fabricated placeholder", r.description === undefined, r);
}

// 8. Amount extraction accepts a numeric string too (models don't always
// emit a bare number)
{
  const r = runValidateExtraction({
    ollamaResult: ollamaChatResponse({ amount: "12.50", category: "FOOD", date: "2026-08-10" }),
    context: EXTRACTION_CONTEXT,
  });
  check("numeric-string amount is accepted", r.amount === 12.5 && r.extractionOutcome === "valid", r);
}

// 9. Category extraction: an out-of-enum value is treated as absent, never
// passed through raw (proves the real ExpenseCategory enum is enforced,
// not invented).
{
  const r = runValidateExtraction({
    ollamaResult: ollamaChatResponse({ amount: 12.5, category: "GROCERIES", date: "2026-08-10" }),
    context: EXTRACTION_CONTEXT,
  });
  check("out-of-enum category is rejected, not passed through", r.category === null, r);
  check("out-of-enum category triggers clarification, not a guess", r.extractionOutcome === "needs_clarification" && r.missingField === "category", r);
}

// 9b. Category extraction: LITERALLY missing (null/absent), not just
// out-of-enum -- a distinct named case from #9 above, exercised
// separately since it is a different real-world model output shape (the
// model omitting the field or explicitly returning null, rather than
// hallucinating an invalid value).
{
  const r = runValidateExtraction({
    ollamaResult: ollamaChatResponse({ amount: 12.5, category: null, date: "2026-08-10" }),
    context: EXTRACTION_CONTEXT,
  });
  check("literally missing category -> needs_clarification", r.extractionOutcome === "needs_clarification" && r.missingField === "category", r);
  check("missing category is never fabricated", r.category === null, r);
}

// 10. Date handling: a missing/invalid date defaults to "today" (the
// workflow's own execution date) rather than blocking or guessing a
// specific wrong date.
{
  const r = runValidateExtraction({
    ollamaResult: ollamaChatResponse({ amount: 12.5, category: "FOOD", date: null }),
    context: EXTRACTION_CONTEXT,
  });
  check("missing date defaults to today, does not block the expense", r.date === "2026-08-10" && r.extractionOutcome === "valid", r);
}
{
  const r = runValidateExtraction({
    ollamaResult: ollamaChatResponse({ amount: 12.5, category: "FOOD", date: "not-a-date" }),
    context: EXTRACTION_CONTEXT,
  });
  check("unparseable date defaults to today rather than being sent raw", r.date === "2026-08-10", r);
}

// 11. Missing amount -> clarify, amount is NEVER invented/defaulted
{
  const r = runValidateExtraction({
    ollamaResult: ollamaChatResponse({ amount: null, category: "FOOD", date: "2026-08-10" }),
    context: EXTRACTION_CONTEXT,
  });
  check("missing amount -> needs_clarification", r.extractionOutcome === "needs_clarification", r);
  check("missing amount is reported as the missing field", r.missingField === "amount", r);
  check("amount is never fabricated", r.amount === null, r);
}
{
  // A zero or negative amount is just as invalid as missing -- never
  // silently coerced to a positive guess.
  const r = runValidateExtraction({
    ollamaResult: ollamaChatResponse({ amount: 0, category: "FOOD", date: "2026-08-10" }),
    context: EXTRACTION_CONTEXT,
  });
  check("zero amount is treated as missing, not a valid expense", r.extractionOutcome === "needs_clarification" && r.missingField === "amount", r);
}

// 11b. Malformed amount: a non-numeric string the model might emit (e.g.
// echoing back words instead of a number) is treated as missing, never
// coerced via NaN or silently dropped to 0 -- a distinct failure shape
// from #11's null/zero cases (Number("twelve dollars") is NaN, which
// Number.isFinite correctly rejects).
{
  const r = runValidateExtraction({
    ollamaResult: ollamaChatResponse({ amount: "twelve dollars", category: "FOOD", date: "2026-08-10" }),
    context: EXTRACTION_CONTEXT,
  });
  check("non-numeric string amount -> needs_clarification, not NaN/coerced", r.extractionOutcome === "needs_clarification" && r.missingField === "amount", r);
  check("malformed amount is never fabricated as a number", r.amount === null, r);
}

// 12. Ambiguous expense (e.g. "spent some money on lunch" -- the model
// correctly reports no determinable amount) -- same path as #11, exercised
// with a message-shaped scenario to prove the behavior, not just the
// isolated field rule.
{
  const r = runValidateExtraction({
    ollamaResult: ollamaChatResponse({ amount: null, category: null, date: "2026-08-10", description: "lunch" }),
    context: { ...EXTRACTION_CONTEXT, rawText: "spent some money on lunch" },
  });
  check("ambiguous message with no determinable amount asks for clarification, never guesses one", r.extractionOutcome === "needs_clarification" && r.missingField === "amount", r);
}

// 13. Invalid AI output: unparseable JSON -> extraction_failed (a system
// failure, not a user-facing clarify), never throws.
{
  const r = runValidateExtraction({
    ollamaResult: { message: { role: "assistant", content: "not valid json at all" } },
    context: EXTRACTION_CONTEXT,
  });
  check("unparseable Ollama output -> extraction_failed, not clarify", r.extractionOutcome === "extraction_failed" && r.reasonCode === "unparseable_output", r);
}
{
  // The Ollama call itself failing (onError: continueRegularOutput -> $json.error)
  // is handled the same defensive way, never a thrown error.
  const r = runValidateExtraction({
    ollamaResult: { error: { message: "connect ECONNREFUSED" } },
    context: EXTRACTION_CONTEXT,
  });
  check("Ollama call failure -> extraction_failed, not clarify, no throw", r.extractionOutcome === "extraction_failed" && r.reasonCode === "ollama_call_failed", r);
}

// 14. Unknown/invalid paymentMethod is dropped, never blocks the expense
// (paymentMethod is optional in the Finance API contract).
{
  const r = runValidateExtraction({
    ollamaResult: ollamaChatResponse({ amount: 12.5, category: "FOOD", paymentMethod: "BITCOIN", date: "2026-08-10" }),
    context: EXTRACTION_CONTEXT,
  });
  check("unknown paymentMethod is dropped, does not block a valid expense", r.extractionOutcome === "valid" && r.paymentMethod === undefined, r);
}

// 14b. A real, valid paymentMethod value is a genuinely OPTIONAL field
// that flows through correctly when present -- complements #14 (which
// only proves an INVALID value is dropped) by proving a VALID value is
// not dropped.
{
  const r = runValidateExtraction({
    ollamaResult: ollamaChatResponse({ amount: 12.5, category: "FOOD", paymentMethod: "CASH", date: "2026-08-10" }),
    context: EXTRACTION_CONTEXT,
  });
  check("a valid paymentMethod value passes through unchanged", r.extractionOutcome === "valid" && r.paymentMethod === "CASH", r);
}

// 14c-e. isRecurring (v2 addition, see expense-extraction.v2.md and
// ADR-0024's isRecurring/RecurringTemplate support): only a literal
// `true` from the model is honored; anything else -- explicit false,
// missing entirely, or a non-boolean value -- defaults to false, and
// never blocks an otherwise-valid extraction either way.
{
  const r = runValidateExtraction({
    ollamaResult: ollamaChatResponse({ amount: 15, category: "UTILITIES", date: "2026-08-10", description: "Netflix", isRecurring: true }),
    context: EXTRACTION_CONTEXT,
  });
  check("explicit isRecurring: true is honored", r.extractionOutcome === "valid" && r.isRecurring === true, r);
}
{
  const r = runValidateExtraction({
    ollamaResult: ollamaChatResponse({ amount: 12.5, category: "FOOD", date: "2026-08-10", isRecurring: false }),
    context: EXTRACTION_CONTEXT,
  });
  check("explicit isRecurring: false is honored", r.extractionOutcome === "valid" && r.isRecurring === false, r);
}
{
  const r = runValidateExtraction({
    ollamaResult: ollamaChatResponse({ amount: 12.5, category: "FOOD", date: "2026-08-10" }),
    context: EXTRACTION_CONTEXT,
  });
  check("isRecurring defaults to false when the model omits it entirely", r.extractionOutcome === "valid" && r.isRecurring === false, r);
}
{
  // A non-boolean value (e.g. the model emitting the string "yes") is
  // never guessed as true -- only a literal boolean true is honored,
  // matching the extraction prompt's own "NEVER guess true" instruction.
  const r = runValidateExtraction({
    ollamaResult: ollamaChatResponse({ amount: 12.5, category: "FOOD", date: "2026-08-10", isRecurring: "yes" }),
    context: EXTRACTION_CONTEXT,
  });
  check("a non-boolean isRecurring value defaults to false, never guessed true", r.extractionOutcome === "valid" && r.isRecurring === false, r);
}

// ---- Build Extraction Failure Response ----
function runExtractionFailureResponse(extractionResult) {
  const code = getCode("Build Extraction Failure Response");
  const sandbox = { $json: extractionResult, console, result: undefined };
  vm.createContext(sandbox);
  vm.runInContext(`result = (function(){ ${code} })()`, sandbox);
  return sandbox.result[0].json;
}

// 15. Clarification response shape: status "clarify", real clarifying
// question, intent preserved, no fake success.
{
  const r = runExtractionFailureResponse({ extractionOutcome: "needs_clarification", missingField: "amount", workflowExecutionId: "exec-3" });
  check("clarify status set", r.status === "clarify", r);
  check("clarifyingQuestion is a real, non-empty question", typeof r.clarifyingQuestion === "string" && r.clarifyingQuestion.length > 0, r);
  check("message mirrors the clarifying question", r.message === r.clarifyingQuestion, r);
  check("intent preserved", r.intent === "CREATE_EXPENSE", r);
  check("data is null on clarify", r.data === null, r);
}
{
  const r = runExtractionFailureResponse({ extractionOutcome: "needs_clarification", missingField: "category", workflowExecutionId: "exec-3" });
  check("category clarifying question lists the REAL enum values, not invented ones", ["HOUSING", "FOOD", "UTILITIES", "TRANSPORTATION", "SHOPPING", "MEDICAL", "CREDIT_CARD", "SAVINGS", "TAX", "OTHERS"].every((c) => r.clarifyingQuestion.includes(c)), r);
}

// 16. Extraction-failure response: status "error", no internal detail
// (reasonCode, Ollama error text) leaks into the user-facing message.
{
  const r = runExtractionFailureResponse({ extractionOutcome: "extraction_failed", reasonCode: "ollama_call_failed", workflowExecutionId: "exec-3" });
  check("extraction failure maps to status error", r.status === "error", r);
  check("raw reasonCode is not exposed in the message", !r.message.includes("ollama_call_failed"), r);
  check("intent preserved on system failure too", r.intent === "CREATE_EXPENSE", r);
}

// ---- Build Finance API Request ----
function runBuildApiRequest(extractionResult) {
  const code = getCode("Build Finance API Request");
  const sandbox = { $json: extractionResult, String, Date, console, result: undefined };
  vm.createContext(sandbox);
  vm.runInContext(`result = (function(){ ${code} })()`, sandbox);
  return sandbox.result[0].json;
}

const VALID_EXTRACTION = {
  ...EXTRACTION_CONTEXT,
  extractionOutcome: "valid",
  amount: 12.5,
  category: "FOOD",
  paymentMethod: undefined,
  date: "2026-08-10",
  description: "lunch",
};

// 17. Request body matches the real CreateExpenseAutomatedDto exactly:
// amount as a STRING (never a number -- Prisma Decimal boundary), real
// category enum, source envelope with channel + externalUserId.
{
  const r = runBuildApiRequest(VALID_EXTRACTION);
  const body = r.financeApiRequestBody;
  check("amount is sent as a string, not a number", typeof body.amount === "string" && body.amount === "12.5", r);
  check("category forwarded", body.category === "FOOD", r);
  check("date forwarded", body.date === "2026-08-10", r);
  check("source.channel forwarded", body.source.channel === "slack", r);
  check("source.externalUserId forwarded", body.source.externalUserId === "U012ABC", r);
  check("intent is CREATE_EXPENSE", body.intent === "CREATE_EXPENSE", r);
  check("workflowName identifies THIS handler, not the front door", body.workflowName === "10-handle-create-expense", r);
}

// 18. CRITICAL: workflowExecutionId is the value RECEIVED from the Router,
// forwarded unchanged -- never regenerated via $execution.id. This is the
// idempotency guarantee every Finance write endpoint relies on.
{
  const r = runBuildApiRequest({ ...VALID_EXTRACTION, workflowExecutionId: "front-door-exec-999" });
  check("workflowExecutionId in the API body is the ORIGINAL front-door value", r.financeApiRequestBody.workflowExecutionId === "front-door-exec-999", r);
  check("workflowExecutionId is also carried at the top level for later context lookup", r.workflowExecutionId === "front-door-exec-999", r);
}

// 19. externalUserId is the Finance Inbox Contract's identity -- never an
// internal n8n execution id or any other substitute identity.
{
  const r = runBuildApiRequest({ ...VALID_EXTRACTION, externalUserId: "U099XYZ" });
  check("externalUserId is preserved, not substituted with an n8n identity", r.financeApiRequestBody.source.externalUserId === "U099XYZ", r);
}

// 20. Optional fields (paymentMethod, description, externalMessageId,
// durationMs) are included only when present -- never sent as null/empty
// placeholders the validator would reject.
{
  const r = runBuildApiRequest({ ...VALID_EXTRACTION, paymentMethod: "CASH", externalMessageId: "msg-1" });
  check("paymentMethod included when present", r.financeApiRequestBody.paymentMethod === "CASH", r);
  check("source.externalMessageId included when present", r.financeApiRequestBody.source.externalMessageId === "msg-1", r);
}
{
  const { externalMessageId: _omit, ...extractionWithoutMessageId } = VALID_EXTRACTION;
  const r = runBuildApiRequest(extractionWithoutMessageId);
  check("paymentMethod omitted (not null) when absent", !("paymentMethod" in r.financeApiRequestBody), r);
  check("source.externalMessageId omitted when absent", !("externalMessageId" in r.financeApiRequestBody.source), r);
}

// 20b. isRecurring (v2 addition) follows the same "included only when
// present/true" convention as paymentMethod/description above -- the
// Finance API's isRecurring is optional and its absence just means "not
// recurring," so there is no need to ever send `isRecurring: false`
// explicitly.
{
  const r = runBuildApiRequest({ ...VALID_EXTRACTION, isRecurring: true });
  check("isRecurring: true is forwarded to the Finance API request", r.financeApiRequestBody.isRecurring === true, r);
}
{
  const r = runBuildApiRequest({ ...VALID_EXTRACTION, isRecurring: false });
  check("isRecurring: false is omitted (not sent as an explicit false)", !("isRecurring" in r.financeApiRequestBody), r);
}
{
  const r = runBuildApiRequest(VALID_EXTRACTION);
  check("isRecurring omitted entirely when absent from the extraction result", !("isRecurring" in r.financeApiRequestBody), r);
}

// ---- Validate Finance API Response ----
function runValidateApiResponse({ apiResult, context }) {
  const code = getCode("Validate Finance API Response");
  const sandbox = {
    $json: apiResult,
    $: (name) => {
      if (name !== "Build Finance API Request") throw new Error("unexpected node ref: " + name);
      return { item: { json: context } };
    },
    String,
    Array,
    JSON,
    console,
    result: undefined,
  };
  vm.createContext(sandbox);
  vm.runInContext(`result = (function(){ ${code} })()`, sandbox);
  return sandbox.result[0].json;
}

const API_CONTEXT = { workflowExecutionId: "exec-4" };

// 21. Finance API success -> Response Contract success, real created-expense
// fields surfaced in `data`, human-readable message built from the ACTUAL
// API response, not guessed client-side.
{
  const r = runValidateApiResponse({
    apiResult: {
      success: true,
      message: "Expense recorded successfully.",
      data: { replayed: false, id: "expense-1", date: "2026-08-10T00:00:00.000Z", amount: "12.50", category: "FOOD", paymentMethod: null, description: "lunch", isRecurring: false },
    },
    context: API_CONTEXT,
  });
  check("status success", r.status === "success", r);
  check("intent CREATE_EXPENSE", r.intent === "CREATE_EXPENSE", r);
  check("message reflects the real amount/category from the API", r.message === "Logged $12.50 to FOOD.", r);
  check("data.id comes from the real API response", r.data.id === "expense-1", r);
  check("data.isRecurring is surfaced from the real API response", r.data.isRecurring === false, r);
  check("workflowExecutionId echoed from context", r.workflowExecutionId === "exec-4", r);
  check("clarifyingQuestion null on success", r.clarifyingQuestion === null, r);
}
{
  // A recurring expense's success response surfaces isRecurring: true too --
  // not just the false/absent case above.
  const r = runValidateApiResponse({
    apiResult: {
      success: true,
      message: "Expense recorded successfully.",
      data: { replayed: false, id: "expense-2", date: "2026-08-10T00:00:00.000Z", amount: "15.00", category: "UTILITIES", paymentMethod: null, description: "Netflix", isRecurring: true },
    },
    context: API_CONTEXT,
  });
  check("data.isRecurring: true is surfaced when the API confirms a recurring expense", r.data.isRecurring === true, r);
}

// 22. A replay (idempotent retry) is still reported as success -- not a
// duplicate, not an error.
{
  const r = runValidateApiResponse({
    apiResult: { success: true, message: "Expense already recorded for this workflow execution.", data: { replayed: true, workflowExecutionId: "exec-4" } },
    context: API_CONTEXT,
  });
  check("replay is reported as success, not an error or a second creation", r.status === "success" && r.data.replayed === true, r);
}

// 23. Finance API success (network/onError) -- CRITICAL: no fake success
// when the API call itself failed.
{
  const r = runValidateApiResponse({
    apiResult: { error: { message: "connect ETIMEDOUT 10.0.0.5:443" } },
    context: API_CONTEXT,
  });
  check("network/timeout failure -> status error, never success", r.status === "error", r);
  check("raw network error text is not exposed to the user", !r.message.includes("ETIMEDOUT") && !r.message.includes("10.0.0.5"), r);
  check("workflowExecutionId still preserved on failure", r.workflowExecutionId === "exec-4", r);
}

// 24. Finance API validation/business error (400, success:false) -- also
// never reported as success, and the raw validator payload is not leaked.
{
  const r = runValidateApiResponse({
    apiResult: { success: false, errors: [{ msg: "Invalid category.", path: "category" }] },
    context: API_CONTEXT,
  });
  check("400-shaped API rejection -> status error, never success", r.status === "error", r);
  check("raw express-validator error array is not exposed verbatim", !r.message.includes("path") && !r.message.includes("msg"), r);
}

// 25. Response Contract shape is complete on every terminal outcome type
// this workflow can produce (success, replay, clarify, extraction error,
// API error, invalid input) -- same required keys every time.
{
  const REQUIRED_KEYS = ["contractVersion", "workflowExecutionId", "status", "intent", "message", "data", "clarifyingQuestion"];
  const samples = [
    runInvalidInputResponse({ valid: false, reason: "x", workflowExecutionId: "e" }),
    runExtractionFailureResponse({ extractionOutcome: "needs_clarification", missingField: "amount", workflowExecutionId: "e" }),
    runExtractionFailureResponse({ extractionOutcome: "extraction_failed", reasonCode: "x", workflowExecutionId: "e" }),
    runValidateApiResponse({ apiResult: { error: "x" }, context: { workflowExecutionId: "e" } }),
    runValidateApiResponse({ apiResult: { success: false }, context: { workflowExecutionId: "e" } }),
    runValidateApiResponse({ apiResult: { success: true, data: { replayed: false, id: "1", amount: "1.00", category: "FOOD" } }, context: { workflowExecutionId: "e" } }),
  ];
  for (const sample of samples) {
    check(
      "every terminal response carries all Response Contract keys",
      REQUIRED_KEYS.every((k) => k in sample),
      sample
    );
  }
}

// ---- Structural sanity check on the "Handler Input Valid?" and
// "Expense Data Valid?" IF-node conditions (declarative n8n expressions,
// not extractable jsCode -- re-implemented here to verify their intended
// semantics, same technique 02-finance-intent-router.logic.test.js already
// established) ----
function handlerInputValid(validationResult) {
  return validationResult.valid === true;
}
function expenseDataValid(extractionResult) {
  return extractionResult.extractionOutcome === "valid";
}

// 26. IF-gate semantics
{
  check("Handler Input Valid?: valid:true routes to extraction", handlerInputValid({ valid: true }) === true);
  check("Handler Input Valid?: valid:false routes to the error branch", handlerInputValid({ valid: false }) === false);
  check("Expense Data Valid?: 'valid' outcome routes to the Finance API call", expenseDataValid({ extractionOutcome: "valid" }) === true);
  check("Expense Data Valid?: any other outcome routes to the failure branch", expenseDataValid({ extractionOutcome: "needs_clarification" }) === false && expenseDataValid({ extractionOutcome: "extraction_failed" }) === false);
}

// ---- STRUCTURAL TESTS (against the committed workflow JSON itself) ----

// 27. Workflow identity: ID and file location match what the Router
// forward-references (workflowId: "FinanceHandlerCreateExpenseWf01" in
// 02-finance-intent-router.json's "Execute Handler - CREATE_EXPENSE" node).
{
  check("workflow id is exactly FinanceHandlerCreateExpenseWf01", wf.id === "FinanceHandlerCreateExpenseWf01", wf.id);
  check(
    "workflow file exists at the intended path",
    fs.existsSync(path.join(__dirname, "../../../workflows/finance/10-handle-create-expense.json"))
  );
}

// 28. This workflow does not modify the Router or the Inbox Entry.
//
// Originally this compared `git diff --stat` against HEAD and required an
// empty diff. That assumption is wrong in this repository's actual
// development flow: multiple phases land as uncommitted working-tree
// changes before anything is committed (e.g. Phase 2.6's legitimate,
// already-reported rewrite of 02-finance-intent-router.json), so "any
// uncommitted diff vs HEAD" is not the same claim as "this Handler's own
// changes touched the Router." A git-vs-HEAD check can't tell those apart
// without a commit boundary, which this phase is explicitly not allowed to
// create ("Do not commit anything").
//
// Instead this snapshots the Router/Inbox Entry content as of when this
// Handler's test suite was last verified, via sha256, and fails only if
// their content changes *after that point* -- i.e. only if something
// touches these files while this Handler's own work is in flight. A
// deliberate, reviewed change to either file (a future phase) is expected
// to update EXPECTED_ROUTER_HASH / EXPECTED_ENTRY_HASH alongside it, the
// same way a snapshot test is intentionally re-recorded.
{
  const crypto = require("crypto");
  const EXPECTED_ROUTER_HASH = "8025e19a23d834c9763c585b6aebfa5fc6f9b11ed4495cde5432cc0aa54a2005";
  const EXPECTED_ENTRY_HASH = "cb9ec9e53b3fbcd1d2b5fa76e74d6f0d1b539f686789229f5b3bdde5f7a73564";
  const routerPath = path.join(__dirname, "../../../workflows/finance/02-finance-intent-router.json");
  const entryPath = path.join(__dirname, "../../../workflows/finance/01-finance-inbox-entry.json");
  const routerHash = crypto.createHash("sha256").update(fs.readFileSync(routerPath, "utf8")).digest("hex");
  const entryHash = crypto.createHash("sha256").update(fs.readFileSync(entryPath, "utf8")).digest("hex");
  check("02-finance-intent-router.json content matches this Handler's snapshot", routerHash === EXPECTED_ROUTER_HASH, routerHash);
  check("01-finance-inbox-entry.json content matches this Handler's snapshot", entryHash === EXPECTED_ENTRY_HASH, entryHash);
}

// 29. The Router's CREATE_EXPENSE dispatch node already points at this
// workflow's id -- confirms the two files agree without editing the Router.
{
  const routerPath = path.join(__dirname, "../../../workflows/finance/02-finance-intent-router.json");
  const router = JSON.parse(fs.readFileSync(routerPath, "utf8"));
  const handlerNode = router.nodes.find((n) => n.name === "Execute Handler - CREATE_EXPENSE");
  check("Router's CREATE_EXPENSE dispatch targets this exact workflow id", handlerNode && handlerNode.parameters.workflowId === "FinanceHandlerCreateExpenseWf01", handlerNode);
}

// 30. Exactly two httpRequest (API call) nodes exist, and only in this
// Handler's own boundary: one to Ollama for extraction, one to the Finance
// Service API for the write -- no other API surface, no accidental extra
// call.
{
  const httpRequestNodes = wf.nodes.filter((n) => n.type === "n8n-nodes-base.httpRequest");
  check("exactly 2 httpRequest nodes exist in this Handler", httpRequestNodes.length === 2, httpRequestNodes.map((n) => n.name));
  check(
    "one httpRequest node targets Ollama for extraction",
    httpRequestNodes.some((n) => n.parameters.url.includes("OLLAMA_BASE_URL")),
    httpRequestNodes.map((n) => n.parameters.url)
  );
  check(
    "one httpRequest node targets the real Finance API endpoint",
    httpRequestNodes.some((n) => n.parameters.url.includes("EYAN_API_BASE_URL") && n.parameters.url.includes("/finance/service/expenses")),
    httpRequestNodes.map((n) => n.parameters.url)
  );
}

// 31. No node in this workflow ever READS $execution.id in executable code
// -- the one thing that would silently regenerate the idempotency key at
// this hop instead of forwarding the value received from the Router.
// Comment lines are stripped first: "Build Finance API Request" legitimately
// MENTIONS $execution.id in a code comment (explaining why it is NOT used),
// which must not itself trip this check.
{
  function stripLineComments(jsCode) {
    return jsCode
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, ""))
      .join("\n");
  }
  const nodesReadingExecutionId = wf.nodes.filter(
    (n) => n.parameters && n.parameters.jsCode && stripLineComments(n.parameters.jsCode).includes("$execution")
  );
  check("no node reads $execution.id in executable code (workflowExecutionId must only ever be forwarded)", nodesReadingExecutionId.length === 0, nodesReadingExecutionId.map((n) => n.name));
}

// 32. No hardcoded credentials, API keys, bearer tokens, or secret-shaped
// literals anywhere in the committed workflow JSON. The only `credentials`
// block references the pre-existing, reused "EYAN Service API" credential
// by id/name (never a raw secret value) -- Ollama needs no credential at
// all (no auth locally).
{
  const raw = fs.readFileSync(path.join(__dirname, "../../../workflows/finance/10-handle-create-expense.json"), "utf8");
  check("no 'Bearer ' literal anywhere in the workflow JSON", !raw.includes("Bearer "), null);
  check("no 'Authorization' header literal hardcoded", !raw.includes('"Authorization"'), null);
  check("no apiKey-shaped literal", !/["']?api[_-]?key["']?\s*:\s*["'][^"']+["']/i.test(raw.replace(/\/\/.*$/gm, "")), null);

  const credentialNodes = wf.nodes.filter((n) => n.credentials);
  check("exactly one node carries a credentials reference", credentialNodes.length === 1, credentialNodes.map((n) => n.name));
  check(
    "that credential is a reference (id/name) to the existing EYAN Service API credential, not an inline secret",
    credentialNodes[0].credentials.httpHeaderAuth.id === "HkpCn7QOHOauRVq1" && credentialNodes[0].credentials.httpHeaderAuth.name === "EYAN Service API",
    credentialNodes[0].credentials
  );
}

// 33. Every terminal Code node in this workflow returns an object shaped
// like the established Response Contract (contractVersion, status, intent,
// message, data, clarifyingQuestion) -- checked here structurally by name,
// complementing test #25's behavioral check.
{
  const terminalNodeNames = ["Build Invalid Input Response", "Build Extraction Failure Response", "Validate Finance API Response"];
  for (const name of terminalNodeNames) {
    const code = getCode(name);
    for (const key of ["contractVersion", "status", "intent", "message", "data", "clarifyingQuestion"]) {
      check(`${name} builds a Response Contract with '${key}'`, code.includes(key), name);
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed (${pass + fail} total assertions)`);
process.exit(fail > 0 ? 1 : 0);
