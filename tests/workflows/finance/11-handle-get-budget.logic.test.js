#!/usr/bin/env node
// Extracts the ACTUAL jsCode strings from 11-handle-get-budget.json's Code
// nodes and runs them in a mocked n8n Code-node context (Node's built-in
// `vm`, zero dependencies), same approach as every other *.logic.test.js
// file in this repo. Run:
// node tests/workflows/finance/11-handle-get-budget.logic.test.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { Script } = require("vm");

const wf = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "../../../workflows/finance/11-handle-get-budget.json"),
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

function runCode(nodeName, sandboxExtra) {
  const code = getCode(nodeName);
  const sandbox = { Array, Date, Number, Math, JSON, String, console, result: undefined, ...sandboxExtra };
  vm.createContext(sandbox);
  vm.runInContext(`result = (function(){ ${code} })()`, sandbox);
  return sandbox.result[0].json;
}

// ---- Syntax regression check on every Code node (same class of bug found
// in 10-handle-create-expense.json during Phase 3A) ----
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

// ---- Structural checks ----
{
  check("workflow id is FinanceHandlerGetBudgetWf01 (matches Router's forward reference)", wf.id === "FinanceHandlerGetBudgetWf01", wf.id);
  const httpNodes = wf.nodes.filter((n) => n.type === "n8n-nodes-base.httpRequest");
  check("exactly one httpRequest node (read-only -- no AI Core call, no write call)", httpNodes.length === 1, httpNodes.map((n) => n.name));
  check("the one httpRequest node is a GET (read-only, never mutates)", httpNodes[0].parameters.method === "GET", httpNodes[0].parameters);
  check("httpRequest targets the dashboard endpoint (no dedicated /budget route -- ADR-0024/ADR-0008)", httpNodes[0].parameters.url.includes("/finance/service/dashboard"), httpNodes[0].parameters.url);
  check("reuses the existing EYAN Service API credential (no new secret)", httpNodes[0].credentials.httpHeaderAuth.id === "HkpCn7QOHOauRVq1", httpNodes[0].credentials);
  check("httpRequest node degrades gracefully on failure (onError continueRegularOutput)", httpNodes[0].onError === "continueRegularOutput", httpNodes[0].onError);
  const codeNodes = wf.nodes.filter((n) => n.type === "n8n-nodes-base.code");
  const offenders = codeNodes.filter((n) => n.parameters.jsCode.includes("$execution"));
  check("no Code node reads $execution (workflowExecutionId is always forwarded, never regenerated)", offenders.length === 0, offenders.map((n) => n.name));
  const hardcodedSecret = codeNodes.some((n) => /https?:\/\/(?!\{\{)/.test(n.parameters.jsCode));
  check("no Code node hardcodes a URL (base URL always comes from $env.EYAN_API_BASE_URL)", !hardcodedSecret, "");
}

// ---- Validate Handler Input ----
const VALID_REQUEST = {
  contractVersion: "1",
  workflowExecutionId: "exec-1",
  workflowName: "03-whatsapp-finance-entry",
  channel: "whatsapp",
  externalUserId: "34612345678",
  externalMessageId: "wamid.abc123",
  rawText: "How much is left in my budget this month?",
  attachments: [],
};

{
  const r = runCode("Validate Handler Input", { $json: VALID_REQUEST });
  check("well-formed request is valid", r.valid === true, r);
  check("workflowExecutionId forwarded unchanged", r.workflowExecutionId === "exec-1", r);
  check("rawText forwarded unchanged", r.rawText === VALID_REQUEST.rawText, r);
}

// GET_BUDGET, unlike CREATE_EXPENSE, imposes NO extra requirement on
// externalUserId -- this is a read-only, org-wide query, not attributed to
// a sender.
{
  const r = runCode("Validate Handler Input", { $json: { ...VALID_REQUEST, externalUserId: null } });
  check("null externalUserId is still accepted (no per-user scoping on budget data)", r.valid === true, r);
}

for (const field of ["contractVersion", "workflowExecutionId", "workflowName", "channel"]) {
  const { [field]: _omit, ...rest } = VALID_REQUEST;
  const r = runCode("Validate Handler Input", { $json: rest });
  check(`missing ${field} -> invalid`, r.valid === false && r.reason.includes(field), r);
}

{
  const r = runCode("Validate Handler Input", { $json: { ...VALID_REQUEST, attachments: "not-an-array" } });
  check("non-array attachments -> invalid", r.valid === false, r);
}

// ---- Build Invalid Input Response ----
{
  const r = runCode("Build Invalid Input Response", { $json: { workflowExecutionId: "exec-2", reason: "Missing channel." } });
  check("status is error", r.status === "error", r);
  check("intent stays GET_BUDGET (Router already classified this correctly)", r.intent === "GET_BUDGET", r);
  check("workflowExecutionId echoed", r.workflowExecutionId === "exec-2", r);
  check("clarifyingQuestion is null (not an ambiguity case)", r.clarifyingQuestion === null, r);
}

// ---- Validate Finance API Response ----
function runValidateResponse(apiResult, handlerInput) {
  return runCode("Validate Finance API Response", {
    $json: apiResult,
    $: (name) => {
      if (name !== "Validate Handler Input") throw new Error("unexpected node ref: " + name);
      return { item: { json: handlerInput ?? { ...VALID_REQUEST, valid: true } } };
    },
  });
}

const HANDLER_CONTEXT = { ...VALID_REQUEST, valid: true };

// A real FinanceDashboardResponseDto shape, budget configured, under budget.
{
  const apiResult = {
    success: true,
    data: {
      period: "2026-08",
      budget: { id: "b1", period: "2026-08", monthlyLimit: "500.00", createdBy: null, updatedBy: null },
      totalExpenses: "142.30",
      remainingBudget: "357.70",
      categoryBreakdown: [],
      spendingTrend: [],
      recentExpenses: [],
    },
  };
  const r = runValidateResponse(apiResult, HANDLER_CONTEXT);
  check("status success when budget configured and under limit", r.status === "success", r);
  check("intent is GET_BUDGET", r.intent === "GET_BUDGET", r);
  check("message includes the real spent amount", r.message.includes("142.30"), r);
  check("message includes the real budget limit", r.message.includes("500.00"), r);
  check("message includes the real remaining amount", r.message.includes("357.70"), r);
  check("message is phrased as money left, not over budget", r.message.includes("left") && !r.message.includes("over budget"), r);
  check("message includes a human month name (not raw YYYY-MM)", r.message.includes("August 2026"), r);
  check("data.remainingBudget carries the real value through", r.data.remainingBudget === "357.70", r);
  check("workflowExecutionId forwarded from context, not the API response", r.workflowExecutionId === "exec-1", r);
  check("clarifyingQuestion is null", r.clarifyingQuestion === null, r);
}

// Overspent case -- remainingBudget is negative.
{
  const apiResult = {
    success: true,
    data: {
      period: "2026-08",
      budget: { id: "b1", period: "2026-08", monthlyLimit: "500.00", createdBy: null, updatedBy: null },
      totalExpenses: "600.00",
      remainingBudget: "-100.00",
      categoryBreakdown: [],
      spendingTrend: [],
      recentExpenses: [],
    },
  };
  const r = runValidateResponse(apiResult, HANDLER_CONTEXT);
  check("status is still success (a fact about spending, not an error)", r.status === "success", r);
  check("message reports being over budget", r.message.includes("over budget"), r);
  check("message shows the absolute overage amount, not a negative number", r.message.includes("100.00") && !r.message.includes("-100.00"), r);
}

// No budget configured for this period -- data.budget is null.
{
  const apiResult = {
    success: true,
    data: {
      period: "2026-08",
      budget: null,
      totalExpenses: "42.00",
      remainingBudget: null,
      categoryBreakdown: [],
      spendingTrend: [],
      recentExpenses: [],
    },
  };
  const r = runValidateResponse(apiResult, HANDLER_CONTEXT);
  check("status is success even with no budget configured", r.status === "success", r);
  check("message explains no budget is set", r.message.includes("haven't set a budget"), r);
  check("message still reports real spending so far", r.message.includes("42.00"), r);
  check("data.budget is null", r.data.budget === null, r);
  check("data.remainingBudget is null", r.data.remainingBudget === null, r);
}

// Finance API call itself failed (network/timeout) -- $json.error, same
// pattern as 10-handle-create-expense.json's onError handling.
{
  const r = runValidateResponse({ error: { message: "timeout of 10000ms exceeded" } }, HANDLER_CONTEXT);
  check("status is error on network/timeout failure", r.status === "error", r);
  check("intent stays GET_BUDGET", r.intent === "GET_BUDGET", r);
  check("message does not leak the raw error internals", !r.message.includes("timeout of 10000ms"), r);
  check("data is null", r.data === null, r);
}

// Finance API responded but with an unexpected/failure shape.
{
  const r = runValidateResponse({ success: false, errors: [{ msg: "internal error" }] }, HANDLER_CONTEXT);
  check("status is error on success:false", r.status === "error", r);
  check("message does not leak the raw errors array", !r.message.includes("internal error"), r);
}

{
  const r = runValidateResponse(null, HANDLER_CONTEXT);
  check("status is error on a completely empty response", r.status === "error", r);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
