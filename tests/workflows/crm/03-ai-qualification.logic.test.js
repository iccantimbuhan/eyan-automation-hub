#!/usr/bin/env node
// Extracts the ACTUAL jsCode string from 03-ai-qualification.json's "Map AI
// Core Result" node and runs it in a mocked n8n Code-node context (Node's
// built-in `vm`, zero dependencies — this repo has no test framework).
// Sprint 5 replaced the direct-Ollama chain (Select Provider / Load Prompt
// Template / Call Ollama / Classify Ollama Result / retry loop) with a
// single HTTP call to AI Core plus this one mapping node, since AI Core now
// owns provider selection, prompt versioning, retries, and confidence-tier
// computation. Run: node tests/workflows/crm/03-ai-qualification.logic.test.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const wf = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "../../../workflows/crm/03-ai-qualification.json"),
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

// ---- Map AI Core Result ----
function runMap({ config, response }) {
  const code = getCode("Map AI Core Result");
  const sandbox = {
    $json: response,
    $: (name) => {
      if (name !== "Load Config") throw new Error("unexpected node ref: " + name);
      return { item: { json: config } };
    },
    Date,
    console,
    result: undefined,
  };
  vm.createContext(sandbox);
  vm.runInContext(`result = (function(){ ${code} })()`, sandbox);
  return sandbox.result[0].json;
}

const baseConfig = {
  lead: { id: "lead1", contactName: "Test Lead" },
  workflowExecutionId: "exec1",
  startedAt: Date.now() - 500,
};

const VALID_OUTPUT_JSON = {
  leadScore: 70.6,
  confidence: 0.8,
  priority: "HIGH",
  industry: "SaaS",
  companySizeEstimate: "50-200",
  budgetEstimate: { min: 1000, max: 5000, currency: "USD" },
  buyingIntent: "HIGH",
  urgency: "MEDIUM",
  decisionMakerIdentified: true,
  estimatedTimeline: "SHORT_TERM",
  riskLevel: "LOW",
  painPoints: ["slow onboarding"],
  recommendedAction: "call them",
  summary: "s",
  reasoning: "r",
};

function aiCoreSuccess(overrides = {}) {
  return {
    success: true,
    message: "AI Capability invoked successfully.",
    data: {
      output: JSON.stringify(VALID_OUTPUT_JSON),
      outputJson: VALID_OUTPUT_JSON,
      brain: "sales-brain",
      provider: "ollama",
      model: "qwen2.5-coder:7b",
      promptVersion: "v1",
      confidence: "HIGH",
      needsManualReview: false,
      outcome: "VALID",
      retryCount: 0,
      latencyMs: 1200,
      ...overrides,
    },
  };
}

// 1. Valid AI Core result -> full qualification payload, no annotation for HIGH
{
  const r = runMap({ config: baseConfig, response: aiCoreSuccess() });
  check("valid VALID outcome -> leadId/workflowExecutionId carried through", r.leadId === "lead1" && r.workflowExecutionId === "exec1", r);
  check("leadScore rounds to nearest int", r.leadScore === 71, r);
  check("confidence is the model's own numeric value, not the tier", r.confidence === 0.8, r);
  check("confidenceTier is AI Core's HIGH/MEDIUM/LOW tier", r.confidenceTier === "HIGH", r);
  check("HIGH tier -> no [AI-assisted] annotation", r.recommendedAction === "call them", r);
  check("needsManualReview passed through from AI Core, not recomputed", r.needsManualReview === false, r);
  check("provider/model/promptVersion come from AI Core's response", r.provider === "ollama" && r.model === "qwen2.5-coder:7b" && r.promptVersion === "v1", r);
}

// 2. MEDIUM tier -> annotated recommendedAction, still not manual review
{
  const r = runMap({ config: baseConfig, response: aiCoreSuccess({ confidence: "MEDIUM" }) });
  check("MEDIUM tier -> [AI-assisted] annotation added", /AI-assisted/.test(r.recommendedAction), r);
}

// 3. LOW tier -> no annotation (needsManualReview carries the signal instead)
{
  const r = runMap({ config: baseConfig, response: aiCoreSuccess({ confidence: "LOW", needsManualReview: true }) });
  check("LOW tier -> no [AI-assisted] annotation", !/AI-assisted/.test(r.recommendedAction), r);
  check("LOW tier -> needsManualReview true", r.needsManualReview === true, r);
}

// 4. budgetEstimate flattened correctly into DTO shape
{
  const r = runMap({ config: baseConfig, response: aiCoreSuccess() });
  check(
    "budgetEstimate flattened to budgetEstimateMin/Max/Currency",
    r.budgetEstimateMin === 1000 && r.budgetEstimateMax === 5000 && r.budgetEstimateCurrency === "USD",
    r
  );
}

// 5. null budgetEstimate -> flattened fields undefined (not sent)
{
  const outputWithNullBudget = { ...VALID_OUTPUT_JSON, budgetEstimate: null };
  const r = runMap({
    config: baseConfig,
    response: aiCoreSuccess({ output: JSON.stringify(outputWithNullBudget), outputJson: outputWithNullBudget }),
  });
  check(
    "null budgetEstimate -> flattened fields all undefined",
    r.budgetEstimateMin === undefined && r.budgetEstimateMax === undefined && r.budgetEstimateCurrency === undefined,
    r
  );
}

// 6. AI Core outcome=SCHEMA_INVALID (retries exhausted on AI Core's side) -> manual review payload
{
  const r = runMap({
    config: baseConfig,
    response: aiCoreSuccess({ outcome: "SCHEMA_INVALID", outputJson: undefined, output: "not json" }),
  });
  check("SCHEMA_INVALID outcome -> needsManualReview true", r.needsManualReview === true, r);
  check("SCHEMA_INVALID outcome -> leadScore 0, confidence 0", r.leadScore === 0 && r.confidence === 0, r);
  check("SCHEMA_INVALID outcome -> no confidenceTier (stays AI_ANALYZED backend-side)", r.confidenceTier === undefined, r);
  check("SCHEMA_INVALID outcome -> errorMessage mentions the outcome", /SCHEMA_INVALID/.test(r.errorMessage), r);
}

// 7. AI Core outcome=DEFINITIVE_FAILURE -> manual review payload, provider/model still carried
{
  const r = runMap({
    config: baseConfig,
    response: aiCoreSuccess({ outcome: "DEFINITIVE_FAILURE", outputJson: undefined, provider: "ollama", model: "qwen2.5-coder:7b" }),
  });
  check("DEFINITIVE_FAILURE -> needsManualReview true", r.needsManualReview === true, r);
  check("DEFINITIVE_FAILURE -> provider/model still carried for the audit trail", r.provider === "ollama" && r.model === "qwen2.5-coder:7b", r);
}

// 8. HTTP request itself failed (network error, AI Core unreachable) -> manual review payload
{
  const r = runMap({ config: baseConfig, response: { error: { message: "connect ECONNREFUSED 127.0.0.1:3001" } } });
  check("network failure -> needsManualReview true", r.needsManualReview === true, r);
  check("network failure -> provider/model default to 'unknown', never crash", r.provider === "unknown" && r.model === "unknown", r);
  check("network failure -> errorMessage captures the request failure", /request_failed/.test(r.errorMessage), r);
}

// 9. leadId/workflowExecutionId always present even on every failure path (never strand a lead)
{
  const failureCases = [
    aiCoreSuccess({ outcome: "TRANSIENT_FAILURE", outputJson: undefined }),
    { error: { message: "timeout" } },
  ];
  for (const response of failureCases) {
    const r = runMap({ config: baseConfig, response });
    check("failure path still carries leadId/workflowExecutionId", r.leadId === "lead1" && r.workflowExecutionId === "exec1", r);
    check("failure path still sets workflowName/contractVersion for Submit Qualification", r.workflowName === "03-ai-qualification" && r.contractVersion === "1", r);
  }
}

console.log(`\n${pass} passed, ${fail} failed (${pass + fail} total assertions)`);
process.exit(fail > 0 ? 1 : 0);
