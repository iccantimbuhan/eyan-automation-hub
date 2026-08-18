#!/usr/bin/env node
// Extracts the ACTUAL jsCode strings from 13-handle-get-finance-question.json's
// Code nodes and runs them in a mocked n8n Code-node context (Node's
// built-in `vm`, zero dependencies), same approach as every other
// *.logic.test.js file in this repo. Run:
// node tests/workflows/finance/13-handle-get-finance-question.logic.test.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { Script } = require("vm");

const wf = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "../../../workflows/finance/13-handle-get-finance-question.json"),
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
  check("workflow id is FinanceHandlerGetFinanceQuestionWf01 (matches Router's forward reference)", wf.id === "FinanceHandlerGetFinanceQuestionWf01", wf.id);
  check("workflow name follows convention", wf.name === "Finance - 13 - Handle Get Finance Question", wf.name);

  const httpNodes = wf.nodes.filter((n) => n.type === "n8n-nodes-base.httpRequest");
  check("exactly two httpRequest nodes (dashboard read + AI Core call -- no more, no fewer)", httpNodes.length === 2, httpNodes.map((n) => n.name));

  const mutationMethods = ["POST", "PUT", "PATCH", "DELETE"];
  const financeServiceCall = httpNodes.find((n) => n.name === "Call Finance Service - Get Dashboard");
  check("Finance Service call is a GET (read-only)", financeServiceCall.parameters.method === "GET", financeServiceCall.parameters);
  check("Finance Service call targets the dashboard endpoint, not a mutation endpoint", financeServiceCall.parameters.url.includes("/finance/service/dashboard"), financeServiceCall.parameters.url);
  check("Finance Service call does not target any known Finance mutation endpoint", !/\/expenses\b/.test(financeServiceCall.parameters.url), financeServiceCall.parameters.url);

  const aiCoreCall = httpNodes.find((n) => n.name === "Call AI Core - Answer Finance Question");
  check("AI Core call exists", !!aiCoreCall);
  check("AI Core call is a POST to the finance-question capability's invoke endpoint (the only expected POST in this workflow)", aiCoreCall.parameters.url.includes("/ai-core/service/capabilities/finance-question/invoke"), aiCoreCall.parameters.url);
  check("no httpRequest node uses a mutation method against the Finance Service (only the AI Core invoke() POST exists)", httpNodes.filter((n) => mutationMethods.includes(n.parameters.method) && n.parameters.url.includes("/finance/service/")).length === 0, httpNodes.map((n) => ({ name: n.name, method: n.parameters.method, url: n.parameters.url })));

  for (const n of httpNodes) {
    check(`${n.name}: reuses the existing EYAN Service API credential (no new secret)`, n.credentials && n.credentials.httpHeaderAuth && n.credentials.httpHeaderAuth.id === "HkpCn7QOHOauRVq1", n.credentials);
    check(`${n.name}: degrades gracefully on failure (onError continueRegularOutput)`, n.onError === "continueRegularOutput", n.onError);
    check(`${n.name}: no Ollama URL anywhere in its parameters (no direct Ollama call)`, !JSON.stringify(n.parameters).toLowerCase().includes("ollama"), n.parameters);
  }

  check("AI Core call uses expectJson:false (the plain-text response path, not structured JSON)", getCode("Prepare Finance Question Input").includes("expectJson: false"), "");

  const codeNodes = wf.nodes.filter((n) => n.type === "n8n-nodes-base.code");
  const executionIdOffenders = codeNodes.filter((n) => n.parameters.jsCode.includes("$execution"));
  check("no Code node reads $execution (workflowExecutionId is always forwarded, never regenerated)", executionIdOffenders.length === 0, executionIdOffenders.map((n) => n.name));

  const ollamaOffenders = codeNodes.filter((n) => /https?:\/\/[^\s"'`]*ollama/i.test(n.parameters.jsCode) || n.parameters.jsCode.toLowerCase().includes("host.docker.internal"));
  check("no Code node references an Ollama URL directly", ollamaOffenders.length === 0, ollamaOffenders.map((n) => n.name));

  // The design's core constraint: no category/comparison/spending-intent
  // pre-parsing happens in n8n -- rawText is forwarded to AI Core verbatim
  // as `question`, never regex/keyword-matched against category names.
  const prepCode = getCode("Prepare Finance Question Input");
  check("Prepare Finance Question Input forwards rawText verbatim as `question` (no n8n-side NL parsing)", prepCode.includes("question: input.rawText"), prepCode);
  check("Prepare Finance Question Input does not reference category/comparison keyword lists", !/HOUSING|FOOD|UTILITIES|TRANSPORTATION|SHOPPING|MEDICAL/i.test(prepCode), prepCode);
}

// ---- Validate Handler Input ----
const VALID_REQUEST = {
  contractVersion: "1",
  workflowExecutionId: "exec-1",
  workflowName: "03-whatsapp-finance-entry",
  channel: "whatsapp",
  externalUserId: "34612345678",
  externalMessageId: "wamid.abc123",
  rawText: "Am I overspending on food?",
  attachments: [],
};

{
  const r = runCode("Validate Handler Input", { $json: VALID_REQUEST });
  check("well-formed request is valid", r.valid === true, r);
  check("workflowExecutionId forwarded unchanged", r.workflowExecutionId === "exec-1", r);
  check("rawText forwarded unchanged", r.rawText === VALID_REQUEST.rawText, r);
}

{
  const r = runCode("Validate Handler Input", { $json: { ...VALID_REQUEST, externalUserId: null } });
  check("null externalUserId is still accepted (no per-user scoping on dashboard data)", r.valid === true, r);
}

{
  const r = runCode("Validate Handler Input", { $json: { ...VALID_REQUEST, rawText: "" } });
  check("empty rawText is rejected (nothing for AI Core to reason about)", r.valid === false && r.reason.includes("rawText"), r);
}

for (const field of ["contractVersion", "workflowExecutionId", "workflowName", "channel"]) {
  const { [field]: _omit, ...rest } = VALID_REQUEST;
  const r = runCode("Validate Handler Input", { $json: rest });
  check(`missing ${field} -> invalid`, r.valid === false && r.reason.includes(field), r);
}

// ---- Build Invalid Input Response ----
{
  const r = runCode("Build Invalid Input Response", { $json: { workflowExecutionId: "exec-2", reason: "Missing/empty required field: rawText." } });
  check("status is error", r.status === "error", r);
  check("intent stays GET_FINANCE_QUESTION (Router already classified this correctly)", r.intent === "GET_FINANCE_QUESTION", r);
  check("clarifyingQuestion is null (not an ambiguity case)", r.clarifyingQuestion === null, r);
}

// ---- Validate Dashboard Response ----
function runValidateDashboard(apiResult, handlerInput) {
  return runCode("Validate Dashboard Response", {
    $json: apiResult,
    $: (name) => {
      if (name !== "Validate Handler Input") throw new Error("unexpected node ref: " + name);
      return { item: { json: handlerInput ?? { ...VALID_REQUEST, valid: true } } };
    },
  });
}

const HANDLER_CONTEXT = { ...VALID_REQUEST, valid: true };
const REAL_DASHBOARD_DATA = {
  period: "2026-08",
  budget: { id: "b1", period: "2026-08", monthlyLimit: "1500.00" },
  totalExpenses: "726.72",
  remainingBudget: "773.28",
  categoryBreakdown: [
    { category: "HOUSING", total: "650.00" },
    { category: "FOOD", total: "76.72" },
  ],
  spendingTrend: [],
  recentExpenses: [{ id: "e1", amount: "8.00", category: "FOOD", description: "cafe" }],
  // Deterministic facts Finance Service computes server-side (see
  // eyan-ai-platform backend/src/utils/finance-facts.ts) -- this Handler
  // splits it out of `dashboard` into its own `facts` key, never leaves it
  // in `dashboard` for AI Core.
  financeFacts: {
    hasBudget: true,
    categoryRanking: [
      { category: "HOUSING", total: "650.00", rank: 1 },
      { category: "FOOD", total: "76.72", rank: 2 },
    ],
    categoryPercentages: [
      { category: "HOUSING", total: "650.00", percentageOfTotalSpending: "89.4", percentageOfBudget: "43.3" },
      { category: "FOOD", total: "76.72", percentageOfTotalSpending: "10.6", percentageOfBudget: "5.1" },
    ],
    hasCategorySpecificThresholds: false,
  },
};

{
  const r = runValidateDashboard({ success: true, data: REAL_DASHBOARD_DATA }, HANDLER_CONTEXT);
  check("dashboardOutcome is valid on a real successful fetch", r.dashboardOutcome === "valid", r);
  check("dashboard data is carried through unmodified", JSON.stringify(r.dashboard) === JSON.stringify(REAL_DASHBOARD_DATA), r);
  check("workflowExecutionId preserved from context", r.workflowExecutionId === "exec-1", r);
}

{
  const r = runValidateDashboard({ error: { message: "timeout of 10000ms exceeded" } }, HANDLER_CONTEXT);
  check("dashboardOutcome is failed on a network/timeout error", r.dashboardOutcome === "failed", r);
}

{
  const r = runValidateDashboard({ success: false }, HANDLER_CONTEXT);
  check("dashboardOutcome is failed on success:false", r.dashboardOutcome === "failed", r);
}

// ---- Build Dashboard Failure Response ----
{
  const r = runCode("Build Dashboard Failure Response", { $json: { workflowExecutionId: "exec-3" } });
  check("status is error", r.status === "error", r);
  check("intent stays GET_FINANCE_QUESTION", r.intent === "GET_FINANCE_QUESTION", r);
  check("message does not leak raw internals", !/timeout|ECONNREFUSED|success:false/i.test(r.message), r);
}

// ---- Prepare Finance Question Input ----
{
  const dashboardContext = { ...HANDLER_CONTEXT, dashboardOutcome: "valid", dashboard: REAL_DASHBOARD_DATA };
  const r = runCode("Prepare Finance Question Input", { $json: dashboardContext });
  const { financeFacts: expectedFacts, ...expectedDashboard } = REAL_DASHBOARD_DATA;
  check("input.question is rawText, forwarded verbatim", r.aiCoreRequestBody.input.question === "Am I overspending on food?", r);
  check("input.dashboard is the real fetched dashboard data minus financeFacts", JSON.stringify(r.aiCoreRequestBody.input.dashboard) === JSON.stringify(expectedDashboard), r);
  check("input.dashboard no longer embeds financeFacts (split into its own top-level key)", r.aiCoreRequestBody.input.dashboard.financeFacts === undefined, r);
  check("input.facts is the precomputed financeFacts, forwarded unmodified", JSON.stringify(r.aiCoreRequestBody.input.facts) === JSON.stringify(expectedFacts), r);
  check("context.expectJson is false (plain-text answer, not structured JSON)", r.aiCoreRequestBody.context.expectJson === false, r);
  check("context.workflowName identifies this Handler", r.aiCoreRequestBody.context.workflowName === "13-handle-get-finance-question", r);
  check("context.workflowExecutionId is forwarded from the Handler input", r.aiCoreRequestBody.context.workflowExecutionId === "exec-1", r);
}

// ---- Validate Finance Question Answer ----
function runValidateAnswer(apiResult, dashboardContext) {
  return runCode("Validate Finance Question Answer", {
    $json: apiResult,
    $: (name) => {
      if (name !== "Validate Dashboard Response") throw new Error("unexpected node ref: " + name);
      return { item: { json: dashboardContext ?? { ...HANDLER_CONTEXT, dashboardOutcome: "valid", dashboard: REAL_DASHBOARD_DATA } } };
    },
  });
}

const DASHBOARD_CONTEXT = { ...HANDLER_CONTEXT, dashboardOutcome: "valid", dashboard: REAL_DASHBOARD_DATA };

// A real AI Core finance-question response shape (expectJson:false -- plain
// text in data.output, no outputJson), matching the live smoke-test result
// captured during this phase's implementation.
{
  const apiResult = {
    success: true,
    data: {
      output: " Your spending on food this month is $76.72, which is well behind your Housing spend of $650.00. You still have $773.28 left in your $1500.00 budget for August.",
      brain: "finance-question-brain",
      provider: "ollama",
      model: "mistral:7b",
      promptVersion: "v1",
      confidence: null,
      needsManualReview: false,
      outcome: "VALID",
      retryCount: 0,
      latencyMs: 177181,
    },
  };
  const r = runValidateAnswer(apiResult, DASHBOARD_CONTEXT);
  check("status success on a valid AI Core answer", r.status === "success", r);
  check("intent is GET_FINANCE_QUESTION", r.intent === "GET_FINANCE_QUESTION", r);
  check("message is the AI Core output, trimmed", r.message === apiResult.data.output.trim(), r);
  check("message contains the real grounded figures the model was given", r.message.includes("76.72") && r.message.includes("773.28"), r);
  check("data.period reflects the real dashboard period", r.data.period === "2026-08", r);
  check("data.question echoes the original question", r.data.question === "Am I overspending on food?", r);
  check("workflowExecutionId forwarded from context, not the AI Core response", r.workflowExecutionId === "exec-1", r);
  check("clarifyingQuestion is null", r.clarifyingQuestion === null, r);
}

// AI Core call itself failed (network/timeout).
{
  const r = runValidateAnswer({ error: { message: "timeout of 300000ms exceeded" } }, DASHBOARD_CONTEXT);
  check("status is error on AI Core call failure", r.status === "error", r);
  check("intent stays GET_FINANCE_QUESTION", r.intent === "GET_FINANCE_QUESTION", r);
  check("message does not leak the raw error internals", !r.message.includes("300000ms"), r);
  check("data is null", r.data === null, r);
}

// AI Core responded but outcome was not VALID (e.g. model call exhausted retries).
{
  const r = runValidateAnswer({ success: true, data: { outcome: "DEFINITIVE_FAILURE", output: "" } }, DASHBOARD_CONTEXT);
  check("status is error when AI Core outcome is not VALID", r.status === "error", r);
}

// AI Core responded VALID but with an empty/whitespace-only answer -- never
// silently fabricate or forward a blank message.
{
  const r = runValidateAnswer({ success: true, data: { outcome: "VALID", output: "   " } }, DASHBOARD_CONTEXT);
  check("status is error when the AI Core answer is blank", r.status === "error", r);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
