#!/usr/bin/env node
// Extracts the ACTUAL jsCode strings from 12-handle-get-dashboard.json's
// Code nodes and runs them in a mocked n8n Code-node context (Node's
// built-in `vm`, zero dependencies), same approach as
// tests/workflows/finance/11-handle-get-budget.logic.test.js. Run:
// node tests/workflows/finance/12-handle-get-dashboard.logic.test.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { Script } = require("vm");

const wf = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "../../../workflows/finance/12-handle-get-dashboard.json"),
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

// ---- Syntax regression check on every Code node ----
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
  check("workflow id is FinanceHandlerGetDashboardWf01 (matches Router's forward reference)", wf.id === "FinanceHandlerGetDashboardWf01", wf.id);
  const httpNodes = wf.nodes.filter((n) => n.type === "n8n-nodes-base.httpRequest");
  check("exactly one httpRequest node (read-only -- no AI Core call, no write call)", httpNodes.length === 1, httpNodes.map((n) => n.name));
  check("the one httpRequest node is a GET (read-only, never mutates)", httpNodes[0].parameters.method === "GET", httpNodes[0].parameters);
  check("httpRequest targets the dashboard endpoint (same endpoint GET_BUDGET uses)", httpNodes[0].parameters.url.includes("/finance/service/dashboard"), httpNodes[0].parameters.url);
  check("reuses the existing EYAN Service API credential (no new secret)", httpNodes[0].credentials.httpHeaderAuth.id === "HkpCn7QOHOauRVq1", httpNodes[0].credentials);
  check("httpRequest node degrades gracefully on failure (onError continueRegularOutput)", httpNodes[0].onError === "continueRegularOutput", httpNodes[0].onError);
  const codeNodes = wf.nodes.filter((n) => n.type === "n8n-nodes-base.code");
  const offenders = codeNodes.filter((n) => n.parameters.jsCode.includes("$execution"));
  check("no Code node reads $execution (workflowExecutionId is always forwarded, never regenerated)", offenders.length === 0, offenders.map((n) => n.name));
}

// ---- Validate Handler Input ----
const VALID_REQUEST = {
  contractVersion: "1",
  workflowExecutionId: "exec-1",
  workflowName: "03-whatsapp-finance-entry",
  channel: "whatsapp",
  externalUserId: "34612345678",
  externalMessageId: "wamid.abc123",
  rawText: "Show me my spending dashboard for this month.",
  attachments: [],
};

{
  const r = runCode("Validate Handler Input", { $json: VALID_REQUEST });
  check("well-formed request is valid", r.valid === true, r);
  check("workflowExecutionId forwarded unchanged", r.workflowExecutionId === "exec-1", r);
}

{
  const r = runCode("Validate Handler Input", { $json: { ...VALID_REQUEST, externalUserId: null } });
  check("null externalUserId is still accepted (no per-user scoping on dashboard data)", r.valid === true, r);
}

for (const field of ["contractVersion", "workflowExecutionId", "workflowName", "channel"]) {
  const { [field]: _omit, ...rest } = VALID_REQUEST;
  const r = runCode("Validate Handler Input", { $json: rest });
  check(`missing ${field} -> invalid`, r.valid === false && r.reason.includes(field), r);
}

// ---- Build Invalid Input Response ----
{
  const r = runCode("Build Invalid Input Response", { $json: { workflowExecutionId: "exec-2", reason: "Missing channel." } });
  check("status is error", r.status === "error", r);
  check("intent stays GET_DASHBOARD (Router already classified this correctly)", r.intent === "GET_DASHBOARD", r);
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

// A real FinanceDashboardResponseDto shape -- budget configured, under
// budget, two categories, five recent expenses (the live shape observed
// during GET_BUDGET's real WhatsApp test).
{
  const apiResult = {
    success: true,
    data: {
      period: "2026-08",
      budget: { id: "b1", period: "2026-08", monthlyLimit: "1500.00", createdBy: null, updatedBy: null },
      totalExpenses: "726.72",
      remainingBudget: "773.28",
      categoryBreakdown: [
        { category: "HOUSING", total: "650.00" },
        { category: "FOOD", total: "76.72" },
      ],
      spendingTrend: [
        { period: "2026-03", total: "0.00" },
        { period: "2026-08", total: "726.72" },
      ],
      recentExpenses: [
        { id: "e1", amount: "8.00", category: "FOOD", description: "cafe" },
        { id: "e2", amount: "68.70", category: "FOOD", description: "Mercadona for groceries" },
      ],
    },
  };
  const r = runValidateResponse(apiResult, HANDLER_CONTEXT);
  check("status success", r.status === "success", r);
  check("intent is GET_DASHBOARD", r.intent === "GET_DASHBOARD", r);
  check("message includes a human month name", r.message.includes("August 2026"), r);
  check("message includes total spent", r.message.includes("726.72"), r);
  check("message includes budget limit", r.message.includes("1500.00"), r);
  check("message includes remaining budget", r.message.includes("773.28"), r);
  check("message includes category breakdown line for HOUSING", r.message.includes("HOUSING: $650.00"), r);
  check("message includes category breakdown line for FOOD", r.message.includes("FOOD: $76.72"), r);
  check("message includes a recent expense with its description", r.message.includes("Mercadona for groceries"), r);
  check("message does NOT include the raw spendingTrend history (kept out of message, present in data)", !r.message.includes("2026-03"), r);
  check("data.categoryBreakdown carries the real rows through", r.data.categoryBreakdown.length === 2, r);
  check("data.spendingTrend carries the real rows through (available for a richer future front door)", r.data.spendingTrend.length === 2, r);
  check("data.recentExpenses carries the real rows through", r.data.recentExpenses.length === 2, r);
  check("workflowExecutionId forwarded from context, not the API response", r.workflowExecutionId === "exec-1", r);
  check("clarifyingQuestion is null", r.clarifyingQuestion === null, r);
}

// Overspent case.
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
  check("message reports being over budget", r.message.includes("over budget"), r);
  check("message shows the absolute overage amount, not a negative number", r.message.includes("100.00") && !r.message.includes("-100.00"), r);
}

// No budget configured.
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
  check("message states no budget is set", r.message.includes("no budget set"), r);
  check("data.budget is null", r.data.budget === null, r);
}

// Empty category breakdown / no recent expenses -- no dangling empty
// "By category:" / "Recent expenses:" headers with nothing under them.
{
  const apiResult = {
    success: true,
    data: {
      period: "2026-08",
      budget: null,
      totalExpenses: "0.00",
      remainingBudget: null,
      categoryBreakdown: [],
      spendingTrend: [],
      recentExpenses: [],
    },
  };
  const r = runValidateResponse(apiResult, HANDLER_CONTEXT);
  check("no 'By category:' header when categoryBreakdown is empty", !r.message.includes("By category:"), r);
  check("no 'Recent expenses:' header when recentExpenses is empty", !r.message.includes("Recent expenses:"), r);
}

// Finance API call itself failed.
{
  const r = runValidateResponse({ error: { message: "timeout of 10000ms exceeded" } }, HANDLER_CONTEXT);
  check("status is error on network/timeout failure", r.status === "error", r);
  check("intent stays GET_DASHBOARD", r.intent === "GET_DASHBOARD", r);
  check("message does not leak the raw error internals", !r.message.includes("timeout of 10000ms"), r);
  check("data is null", r.data === null, r);
}

{
  const r = runValidateResponse({ success: false, errors: [{ msg: "internal error" }] }, HANDLER_CONTEXT);
  check("status is error on success:false", r.status === "error", r);
  check("message does not leak the raw errors array", !r.message.includes("internal error"), r);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
