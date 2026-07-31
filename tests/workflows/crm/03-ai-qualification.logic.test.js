#!/usr/bin/env node
// Extracts the ACTUAL jsCode strings from 03-ai-qualification.json and runs
// them in a mocked n8n Code-node context (Node's built-in `vm`, zero
// dependencies — this repo has no test framework, and a plain Node script
// covers everything these two nodes' logic needs). Tests the real workflow
// code, not a re-implementation of it, matching the approach Workflow 1's
// signature algorithm was verified with last sprint. Run: node
// tests/workflows/crm/03-ai-qualification.logic.test.js
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

// ---- Classify Ollama Result ----
function runClassify({ attempt, response }) {
  const code = getCode("Classify Ollama Result");
  const sandbox = {
    $json: response,
    $: (name) => {
      if (name !== "Prepare Attempt") throw new Error("unexpected node ref: " + name);
      return { item: { json: attempt } };
    },
    Buffer,
    Date,
    console,
    result: undefined,
  };
  vm.createContext(sandbox);
  vm.runInContext(`result = (function(){ ${code} })()`, sandbox);
  return sandbox.result[0].json;
}

const baseAttempt = {
  promptText: "p",
  model: "qwen2.5-coder:7b",
  provider: "ollama",
  promptVersion: "v1",
  lead: { id: "lead1", contactName: "Test" },
  workflowExecutionId: "exec1",
  maxRetries: 3,
  confidenceHigh: 0.75,
  confidenceMedium: 0.4,
  ollamaBaseUrl: "http://x",
  ollamaTimeoutMs: 300000,
  retryCount: 0,
  startedAt: Date.now() - 500,
};

const VALID_MODEL_OBJ = {
  leadScore: 70,
  confidence: 0.8,
  priority: "HIGH",
  buyingIntent: "HIGH",
  urgency: "MEDIUM",
  decisionMakerIdentified: true,
  estimatedTimeline: "SHORT_TERM",
  riskLevel: "LOW",
  painPoints: [],
  recommendedAction: "call them",
  summary: "s",
  reasoning: "r",
};

function ollamaContentResponse(content) {
  return { message: { role: "assistant", content } };
}

// 1. Valid response
{
  const r = runClassify({ attempt: baseAttempt, response: ollamaContentResponse(JSON.stringify(VALID_MODEL_OBJ)) });
  check("valid response -> outcome=valid", r.outcome === "valid", r);
  check("valid response -> parsed.leadScore preserved", r.parsed.leadScore === 70, r.parsed);
}

// 2. Valid response wrapped in markdown fences (model disobeying instructions)
{
  const fenced = "```json\n" + JSON.stringify(VALID_MODEL_OBJ) + "\n```";
  const r = runClassify({ attempt: baseAttempt, response: ollamaContentResponse(fenced) });
  check("markdown-fenced JSON still parses -> valid", r.outcome === "valid", r);
}

// 3. Valid JSON embedded in prose (model adding commentary despite instructions)
{
  const prose = `Sure, here is the analysis:\n${JSON.stringify(VALID_MODEL_OBJ)}\nLet me know if you need more.`;
  const r = runClassify({ attempt: baseAttempt, response: ollamaContentResponse(prose) });
  check("JSON embedded in prose -> extracted and valid", r.outcome === "valid", r);
}

// 4. Completely malformed (not JSON at all)
{
  const r = runClassify({ attempt: baseAttempt, response: ollamaContentResponse("I cannot help with that.") });
  check("non-JSON text -> schema_invalid", r.outcome === "schema_invalid", r);
}

// 5. Truncated/broken JSON
{
  const r = runClassify({ attempt: baseAttempt, response: ollamaContentResponse('{"leadScore": 70, "confidence":') });
  check("truncated JSON -> schema_invalid", r.outcome === "schema_invalid", r);
}

// 6. Valid JSON, invalid enum value (priority)
{
  const bad = { ...VALID_MODEL_OBJ, priority: "SUPER_URGENT" };
  const r = runClassify({ attempt: baseAttempt, response: ollamaContentResponse(JSON.stringify(bad)) });
  check("invalid priority enum -> schema_invalid", r.outcome === "schema_invalid" && /priority/.test(r.reason), r);
}

// 7. Valid JSON, confidence out of range
{
  const bad = { ...VALID_MODEL_OBJ, confidence: 1.5 };
  const r = runClassify({ attempt: baseAttempt, response: ollamaContentResponse(JSON.stringify(bad)) });
  check("confidence > 1.0 -> schema_invalid", r.outcome === "schema_invalid" && /confidence/.test(r.reason), r);
}

// 8. Valid JSON, leadScore out of range
{
  const bad = { ...VALID_MODEL_OBJ, leadScore: 150 };
  const r = runClassify({ attempt: baseAttempt, response: ollamaContentResponse(JSON.stringify(bad)) });
  check("leadScore > 100 -> schema_invalid", r.outcome === "schema_invalid" && /leadScore/.test(r.reason), r);
}

// 9. Missing required field (recommendedAction)
{
  const bad = { ...VALID_MODEL_OBJ };
  delete bad.recommendedAction;
  const r = runClassify({ attempt: baseAttempt, response: ollamaContentResponse(JSON.stringify(bad)) });
  check("missing recommendedAction -> schema_invalid", r.outcome === "schema_invalid" && /recommendedAction/.test(r.reason), r);
}

// 10. Valid budgetEstimate object
{
  const withBudget = { ...VALID_MODEL_OBJ, budgetEstimate: { min: 1000, max: 5000, currency: "USD" } };
  const r = runClassify({ attempt: baseAttempt, response: ollamaContentResponse(JSON.stringify(withBudget)) });
  check("valid budgetEstimate -> valid", r.outcome === "valid", r);
}

// 11. Malformed budgetEstimate (missing currency)
{
  const badBudget = { ...VALID_MODEL_OBJ, budgetEstimate: { min: 1000, max: 5000 } };
  const r = runClassify({ attempt: baseAttempt, response: ollamaContentResponse(JSON.stringify(badBudget)) });
  check("malformed budgetEstimate -> schema_invalid", r.outcome === "schema_invalid" && /budgetEstimate/.test(r.reason), r);
}

// 12. null budgetEstimate is fine (explicitly allowed)
{
  const nullBudget = { ...VALID_MODEL_OBJ, budgetEstimate: null };
  const r = runClassify({ attempt: baseAttempt, response: ollamaContentResponse(JSON.stringify(nullBudget)) });
  check("null budgetEstimate -> valid", r.outcome === "valid", r);
}

// 13. Transient error: connection refused (no http code in message)
{
  const r = runClassify({ attempt: baseAttempt, response: { error: { message: "connect ECONNREFUSED 172.30.0.1:11499" } } });
  check("ECONNREFUSED -> transient", r.outcome === "transient", r);
}

// 14. Transient error: 500
{
  const r = runClassify({ attempt: baseAttempt, response: { error: { message: "500 - Internal Server Error" } } });
  check("500 -> transient (not in definitive set)", r.outcome === "transient", r);
}

// 15. Transient error: timeout
{
  const r = runClassify({ attempt: baseAttempt, response: { error: { message: "timeout of 300000ms exceeded" } } });
  check("timeout -> transient", r.outcome === "transient", r);
}

// 16. Definitive error: 400
{
  const r = runClassify({ attempt: baseAttempt, response: { error: { message: '400 - "model not found"' } } });
  check("400 -> definitive", r.outcome === "definitive", r);
}

// 17. Definitive error: 404
{
  const r = runClassify({ attempt: baseAttempt, response: { error: { message: "404 - Not Found" } } });
  check("404 -> definitive", r.outcome === "definitive", r);
}

// 18. Definitive error via explicit httpCode field
{
  const r = runClassify({ attempt: baseAttempt, response: { error: { message: "Unauthorized", httpCode: "401" } } });
  check("explicit httpCode 401 -> definitive", r.outcome === "definitive", r);
}

// ---- Compute Confidence and Route ----
function runConfidence(item) {
  const code = getCode("Compute Confidence and Route");
  const sandbox = { $json: item, console, result: undefined };
  vm.createContext(sandbox);
  vm.runInContext(`result = (function(){ ${code} })()`, sandbox);
  return sandbox.result[0].json;
}

const confBase = {
  workflowExecutionId: "exec1",
  provider: "ollama",
  model: "m",
  promptVersion: "v1",
  latencyMs: 1200,
  lead: { id: "lead1" },
};

// 19. High confidence boundary (exactly 0.75 -> HIGH, not medium)
{
  const r = runConfidence({ ...confBase, confidenceHigh: 0.75, confidenceMedium: 0.4, parsed: { ...VALID_MODEL_OBJ, confidence: 0.75 } });
  check("confidence == high threshold -> not manual review, no annotation", r.needsManualReview === false && !/AI-assisted/.test(r.recommendedAction), r);
}

// 20. Just below high threshold -> MEDIUM (annotated, still automated)
{
  const r = runConfidence({ ...confBase, confidenceHigh: 0.75, confidenceMedium: 0.4, parsed: { ...VALID_MODEL_OBJ, confidence: 0.7499 } });
  check("confidence just below high -> annotated MEDIUM, not manual review", r.needsManualReview === false && /AI-assisted/.test(r.recommendedAction), r);
}

// 21. Medium threshold boundary (exactly 0.4 -> MEDIUM)
{
  const r = runConfidence({ ...confBase, confidenceHigh: 0.75, confidenceMedium: 0.4, parsed: { ...VALID_MODEL_OBJ, confidence: 0.4 } });
  check("confidence == medium threshold -> MEDIUM tier, automated", r.needsManualReview === false && /AI-assisted/.test(r.recommendedAction), r);
}

// 22. Just below medium threshold -> LOW -> manual review
{
  const r = runConfidence({ ...confBase, confidenceHigh: 0.75, confidenceMedium: 0.4, parsed: { ...VALID_MODEL_OBJ, confidence: 0.3999 } });
  check("confidence just below medium -> needsManualReview true", r.needsManualReview === true, r);
}

// 23. Zero confidence -> LOW -> manual review
{
  const r = runConfidence({ ...confBase, confidenceHigh: 0.75, confidenceMedium: 0.4, parsed: { ...VALID_MODEL_OBJ, confidence: 0 } });
  check("confidence 0 -> needsManualReview true", r.needsManualReview === true, r);
}

// 24. leadScore rounding
{
  const r = runConfidence({ ...confBase, confidenceHigh: 0.75, confidenceMedium: 0.4, parsed: { ...VALID_MODEL_OBJ, confidence: 0.9, leadScore: 70.6 } });
  check("leadScore rounds to nearest int", r.leadScore === 71, r);
}

// 25. budgetEstimate flattened correctly into DTO shape
{
  const r = runConfidence({
    ...confBase,
    confidenceHigh: 0.75,
    confidenceMedium: 0.4,
    parsed: { ...VALID_MODEL_OBJ, confidence: 0.9, budgetEstimate: { min: 100, max: 200, currency: "EUR" } },
  });
  check(
    "budgetEstimate flattened to budgetEstimateMin/Max/Currency",
    r.budgetEstimateMin === 100 && r.budgetEstimateMax === 200 && r.budgetEstimateCurrency === "EUR",
    r
  );
}

// 26. null budgetEstimate -> flattened fields undefined (not sent)
{
  const r = runConfidence({ ...confBase, confidenceHigh: 0.75, confidenceMedium: 0.4, parsed: { ...VALID_MODEL_OBJ, confidence: 0.9, budgetEstimate: null } });
  check(
    "null budgetEstimate -> flattened fields all undefined",
    r.budgetEstimateMin === undefined && r.budgetEstimateMax === undefined && r.budgetEstimateCurrency === undefined,
    r
  );
}

console.log(`\n${pass} passed, ${fail} failed (${pass + fail} total assertions)`);
process.exit(fail > 0 ? 1 : 0);
