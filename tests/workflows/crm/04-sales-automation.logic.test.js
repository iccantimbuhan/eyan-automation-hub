#!/usr/bin/env node
// Extracts the ACTUAL jsCode strings from 04-sales-automation.json's two
// Code nodes and runs them in a mocked n8n Code-node context (Node's
// built-in `vm`, zero dependencies), same approach as
// 03-ai-qualification.logic.test.js. Run:
// node tests/workflows/crm/04-sales-automation.logic.test.js
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const wf = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "../../../workflows/crm/04-sales-automation.json"),
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

// ---- Prepare Verification Input ----
function runPrepare({ headers, rawBody }) {
  const code = getCode("Prepare Verification Input");
  const sandbox = {
    $input: { item: { json: { headers }, binary: { data: { data: Buffer.from(rawBody, "utf8").toString("base64") } } } },
    Buffer,
    Date,
    console,
    result: undefined,
  };
  vm.createContext(sandbox);
  vm.runInContext(`result = (function(){ ${code} })()`, sandbox);
  return sandbox.result[0].json;
}

const SECRET = "test-signing-secret";

function sign(timestampMs, rawBody) {
  return crypto.createHmac("sha256", SECRET).update(`${timestampMs}.${rawBody}`).digest("hex");
}

const SAMPLE_PAYLOAD = {
  contractVersion: "1",
  event: "lead.qualified",
  lead: { id: "lead1", contactName: "Test Lead", email: "test@example.com", company: "Acme", assignedToId: null },
  qualification: {
    score: 88,
    confidenceTier: "HIGH",
    confidenceScore: 0.9,
    priority: "HIGH",
    recommendedAction: "Schedule a demo",
    summary: "Strong fit.",
    painPoints: [],
    estimatedTimeline: "SHORT_TERM",
    needsManualReview: false,
  },
  pipelineStage: "QUALIFIED",
};

// 1. Well-formed headers + body -> extracted correctly, fresh
{
  const rawBody = JSON.stringify(SAMPLE_PAYLOAD);
  const now = Date.now();
  const sig = sign(now, rawBody);
  const r = runPrepare({
    headers: { "x-eyan-signature": `sha256=${sig}`, "x-eyan-timestamp": String(now) },
    rawBody,
  });
  check("hasSignature true when header present", r.hasSignature === true, r);
  check("receivedSignature strips the sha256= prefix", r.receivedSignature === sig, r);
  check("isFresh true for a just-signed timestamp", r.isFresh === true, r);
  check("rawBody round-trips through base64", r.rawBody === rawBody, { got: r.rawBody, want: rawBody });
}

// 2. Missing signature header -> hasSignature false
{
  const r = runPrepare({ headers: {}, rawBody: "{}" });
  check("missing signature header -> hasSignature false", r.hasSignature === false, r);
}

// 3. Stale timestamp (6 minutes old) -> not fresh
{
  const rawBody = "{}";
  const stale = Date.now() - 6 * 60 * 1000;
  const r = runPrepare({
    headers: { "x-eyan-signature": `sha256=${sign(stale, rawBody)}`, "x-eyan-timestamp": String(stale) },
    rawBody,
  });
  check("6-minute-old timestamp -> isFresh false", r.isFresh === false, r);
}

// ---- Verify & Parse ----
function runVerify({ prep, computedSignature }) {
  const code = getCode("Verify & Parse");
  const sandbox = {
    $json: { computedSignature },
    $: (name) => {
      if (name !== "Prepare Verification Input") throw new Error("unexpected node ref: " + name);
      return { item: { json: prep } };
    },
    console,
    result: undefined,
  };
  vm.createContext(sandbox);
  vm.runInContext(`result = (function(){ ${code} })()`, sandbox);
  return sandbox.result[0].json;
}

function preppedFor(payload) {
  const rawBody = JSON.stringify(payload);
  const now = Date.now();
  const signedString = `${now}.${rawBody}`;
  const signature = crypto.createHmac("sha256", SECRET).update(signedString).digest("hex");
  return {
    prep: { hasSignature: true, receivedSignature: signature, isFresh: true, rawBody, signedString },
    matchingComputed: signature,
  };
}

// 4. Valid signature + fresh + well-formed payload -> valid, fields extracted
{
  const { prep, matchingComputed } = preppedFor(SAMPLE_PAYLOAD);
  const r = runVerify({ prep, computedSignature: matchingComputed });
  check("valid request -> valid: true", r.valid === true, r);
  check("lead extracted", r.lead && r.lead.id === "lead1", r);
  check("qualification extracted", r.qualification && r.qualification.confidenceTier === "HIGH", r);
  check("pipelineStage extracted", r.pipelineStage === "QUALIFIED", r);
}

// 5. Signature mismatch -> invalid
{
  const { prep } = preppedFor(SAMPLE_PAYLOAD);
  const r = runVerify({ prep, computedSignature: "0".repeat(64) });
  check("signature mismatch -> valid: false", r.valid === false && /signature/i.test(r.reason), r);
}

// 6. No signature header at all -> invalid
{
  const { prep, matchingComputed } = preppedFor(SAMPLE_PAYLOAD);
  const r = runVerify({ prep: { ...prep, hasSignature: false }, computedSignature: matchingComputed });
  check("no signature header -> valid: false", r.valid === false, r);
}

// 7. Stale timestamp -> invalid, even with a matching signature
{
  const { prep, matchingComputed } = preppedFor(SAMPLE_PAYLOAD);
  const r = runVerify({ prep: { ...prep, isFresh: false }, computedSignature: matchingComputed });
  check("stale timestamp -> valid: false", r.valid === false && /freshness/i.test(r.reason), r);
}

// 8. Malformed JSON body -> invalid
{
  const rawBody = "{not json";
  const signedString = `123.${rawBody}`;
  const signature = crypto.createHmac("sha256", SECRET).update(signedString).digest("hex");
  const r = runVerify({
    prep: { hasSignature: true, receivedSignature: signature, isFresh: true, rawBody, signedString },
    computedSignature: signature,
  });
  check("malformed JSON body -> valid: false", r.valid === false && /json/i.test(r.reason), r);
}

// 9. Missing qualification field -> invalid (this workflow requires it, unlike Workflow 1)
{
  const { lead } = SAMPLE_PAYLOAD;
  const { prep, matchingComputed } = preppedFor({ contractVersion: "1", lead });
  const r = runVerify({ prep, computedSignature: matchingComputed });
  check("missing qualification -> valid: false", r.valid === false, r);
}

// 10. Missing lead.id -> invalid
{
  const { prep, matchingComputed } = preppedFor({ ...SAMPLE_PAYLOAD, lead: { contactName: "No ID" } });
  const r = runVerify({ prep, computedSignature: matchingComputed });
  check("missing lead.id -> valid: false", r.valid === false, r);
}

// ---- Structural sanity check on the IF-node gating conditions (declarative
// n8n expressions, not extractable jsCode -- re-implemented here to prove
// the intended skip-if-unconfigured semantics against representative envs) ----
function assignmentNeeded(lead, env) {
  return !lead.assignedToId && !!env.DEFAULT_SALES_OWNER_ID;
}

// 11. Assignment needed when unassigned and a default owner is configured
{
  check(
    "assignment needed: unassigned lead + configured owner",
    assignmentNeeded({ assignedToId: null }, { DEFAULT_SALES_OWNER_ID: "user-1" }) === true
  );
  check(
    "assignment skipped: already-assigned lead",
    assignmentNeeded({ assignedToId: "user-2" }, { DEFAULT_SALES_OWNER_ID: "user-1" }) === false
  );
  check(
    "assignment skipped: no default owner configured",
    assignmentNeeded({ assignedToId: null }, {}) === false
  );
}

console.log(`\n${pass} passed, ${fail} failed (${pass + fail} total assertions)`);
process.exit(fail > 0 ? 1 : 0);
