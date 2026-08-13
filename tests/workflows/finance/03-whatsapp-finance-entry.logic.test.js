#!/usr/bin/env node
// Extracts the ACTUAL jsCode strings from 03-whatsapp-finance-entry.json's
// Code nodes and runs them in a mocked n8n Code-node context (Node's
// built-in `vm`, zero dependencies), same approach as every other
// *.logic.test.js file in this repo. Run:
// node tests/workflows/finance/03-whatsapp-finance-entry.logic.test.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { Script } = require("vm");

const wf = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "../../../workflows/finance/03-whatsapp-finance-entry.json"),
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

// Strips `//` line comments before a structural regex scan -- several nodes'
// jsCode deliberately DISCUSSES $execution/Finance-domain fields in comments
// (explaining why they are NOT used here), which would otherwise false-positive
// a naive substring/regex search against the raw source.
function stripLineComments(code) {
  return code
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

// ---- Syntax regression check on every Code node (same class of bug found
// and fixed in 10-handle-create-expense.json during Phase 3A -- a bare
// `new Function(jsCode)` per exercised node never catches an unexercised
// node's syntax error, so every node is compiled here regardless of
// whether a test below happens to exercise it). ----
{
  for (const node of wf.nodes) {
    if (node.parameters && typeof node.parameters.jsCode === "string") {
      let ok = true;
      let message = "";
      try {
        new Script(`(function(){\n${node.parameters.jsCode}\n})`);
      } catch (error) {
        ok = false;
        message = error.message;
      }
      check(`jsCode is syntactically valid JavaScript: ${node.name}`, ok, message);
    }
  }
}

// ---- No node ever reads $execution.id -- this adapter is not the true
// channel-entry boundary (the Gateway is) and must forward
// workflowExecutionId unchanged, never regenerate it. See ADR-0013. None of
// the sandboxes below provide a $execution global, so any accidental read
// would surface as a ReferenceError in the tests below too -- this is the
// explicit, always-on version of that same guarantee. ----
{
  const offenders = wf.nodes.filter(
    (n) => n.parameters && typeof n.parameters.jsCode === "string" && stripLineComments(n.parameters.jsCode).includes("$execution")
  );
  check("no Code node reads $execution anywhere (outside of explanatory comments)", offenders.length === 0, offenders.map((n) => n.name));
}

// ---- Validate WhatsApp Event Input ----
function runValidate(json) {
  const code = getCode("Validate WhatsApp Event Input");
  const sandbox = { $json: json, console, result: undefined };
  vm.createContext(sandbox);
  vm.runInContext(`result = (function(){ ${code} })()`, sandbox);
  return sandbox.result[0].json;
}

const VALID_EVENT = {
  contractVersion: "1",
  workflowExecutionId: "exec-wa-001",
  workflowName: "whatsapp-gateway-webhook",
  channel: "whatsapp",
  whatsappBusinessAccountId: "WABA1",
  phoneNumberId: "PHONE1",
  customerWhatsappId: "15551234567",
  customerDisplayName: "Jane",
  messageId: "wamid.XYZ",
  messageType: "text",
  messageText: "I spent €25 on lunch today",
  messageTimestamp: "1700000000",
  receivedAt: "2026-08-10T00:00:00.000Z",
  rawMessage: { id: "wamid.XYZ" },
};

{
  const r = runValidate(VALID_EVENT);
  check("valid WhatsApp event -> valid: true", r.valid === true, r);
  check("workflowExecutionId preserved unchanged", r.workflowExecutionId === "exec-wa-001", r);
  check("customerWhatsappId preserved unchanged", r.customerWhatsappId === "15551234567", r);
  check("messageId preserved unchanged", r.messageId === "wamid.XYZ", r);
  check("messageText preserved unchanged", r.messageText === "I spent €25 on lunch today", r);
}

// 16 (malformed/unsupported events, per the existing gateway's own
// convention of never crashing on missing/empty fields).
{
  const r = runValidate({ ...VALID_EVENT, workflowExecutionId: "" });
  check("empty workflowExecutionId -> invalid, reason names it", r.valid === false && /workflowExecutionId/.test(r.reason), r);
}
{
  const r = runValidate({ ...VALID_EVENT, workflowExecutionId: undefined });
  check("missing workflowExecutionId -> invalid, no crash", r.valid === false, r);
}
{
  const r = runValidate({ ...VALID_EVENT, customerWhatsappId: null });
  check("null customerWhatsappId -> invalid, reason names it", r.valid === false && /customerWhatsappId/.test(r.reason), r);
}
{
  const r = runValidate({});
  check("completely empty event -> invalid, no crash", r.valid === false, r);
}
{
  const r = runValidate({ ...VALID_EVENT, messageType: "image", messageText: null });
  check("non-text message (e.g. image) -> still valid, messageText defaults to ''", r.valid === true && r.messageText === "", r);
}

// ---- Build Invalid Event Response ----
function runInvalidResponse(validateResult) {
  const code = getCode("Build Invalid Event Response");
  const sandbox = { $json: validateResult, console, result: undefined };
  vm.createContext(sandbox);
  vm.runInContext(`result = (function(){ ${code} })()`, sandbox);
  return sandbox.result[0].json;
}

{
  const invalid = runValidate({ ...VALID_EVENT, workflowExecutionId: "" });
  const r = runInvalidResponse(invalid);
  check("invalid event -> dispatched: false, never reaches the Router", r.dispatched === false, r);
  check("invalid event response carries the rejection reason", typeof r.reason === "string" && r.reason.length > 0, r);
}

// ---- Build Finance Inbox Request (the core contract-mapping node) ----
function runBuildFinanceRequest(validated) {
  const code = getCode("Build Finance Inbox Request");
  const sandbox = {
    $: (name) => {
      if (name !== "Validate WhatsApp Event Input") throw new Error("unexpected node ref: " + name);
      return { item: { json: validated } };
    },
    console,
    result: undefined,
  };
  vm.createContext(sandbox);
  vm.runInContext(`result = (function(){ ${code} })()`, sandbox);
  return sandbox.result[0].json;
}

const REQUEST_CONTRACT_KEYS = [
  "contractVersion",
  "workflowExecutionId",
  "workflowName",
  "channel",
  "externalUserId",
  "externalMessageId",
  "rawText",
  "attachments",
].sort();

// 1, 2, 3, 4, 5: normalization correctness
{
  const validated = runValidate(VALID_EVENT);
  const r = runBuildFinanceRequest(validated);
  check("channel is exactly 'whatsapp'", r.channel === "whatsapp", r);
  check("externalUserId === WhatsApp customerWhatsappId", r.externalUserId === "15551234567", r);
  check("externalMessageId === WhatsApp messageId", r.externalMessageId === "wamid.XYZ", r);
  check("rawText === WhatsApp messageText", r.rawText === "I spent €25 on lunch today", r);
  check("contractVersion is '1'", r.contractVersion === "1", r);
  check("workflowName is this adapter's own slug, not the Gateway's", r.workflowName === "03-whatsapp-finance-entry", r);
  check("attachments is an array (empty -- WhatsApp media not yet resolved)", Array.isArray(r.attachments) && r.attachments.length === 0, r);
}

// 6: WhatsApp-specific fields never leak into the Finance Inbox Request
{
  const validated = runValidate(VALID_EVENT);
  const r = runBuildFinanceRequest(validated);
  const keys = Object.keys(r).sort();
  check("Finance Inbox Request carries EXACTLY the 8 contract keys, nothing WhatsApp-specific", JSON.stringify(keys) === JSON.stringify(REQUEST_CONTRACT_KEYS), keys);
  check("customerWhatsappId does not leak into the Finance request", !("customerWhatsappId" in r), r);
  check("messageId does not leak into the Finance request", !("messageId" in r), r);
  check("messageType does not leak into the Finance request", !("messageType" in r), r);
  check("whatsappBusinessAccountId/phoneNumberId never even reach this node's input, let alone leak", !("whatsappBusinessAccountId" in r) && !("phoneNumberId" in r), r);
}

// 7, 16: workflowExecutionId preserved exactly once, deterministically, never regenerated on repeat/replay
{
  const validated = runValidate(VALID_EVENT);
  const r1 = runBuildFinanceRequest(validated);
  const r2 = runBuildFinanceRequest(validated);
  check("workflowExecutionId equals the Gateway-supplied value, not a freshly generated one", r1.workflowExecutionId === "exec-wa-001", r1);
  check("replaying the same validated event twice yields the identical workflowExecutionId both times (no regeneration)", r1.workflowExecutionId === r2.workflowExecutionId, { r1, r2 });
}

// ---- Build WhatsApp Reply Input ----
function runBuildReply({ validated, routerResult }) {
  const code = getCode("Build WhatsApp Reply Input");
  const sandbox = {
    $: (name) => {
      if (name !== "Validate WhatsApp Event Input") throw new Error("unexpected node ref: " + name);
      return { item: { json: validated } };
    },
    $json: routerResult,
    console,
    result: undefined,
  };
  vm.createContext(sandbox);
  vm.runInContext(`result = (function(){ ${code} })()`, sandbox);
  return sandbox.result[0].json;
}

// 14: downstream (Router/Handler) response forwarded verbatim, no invented Finance business logic
{
  const validated = runValidate(VALID_EVENT);
  const r = runBuildReply({
    validated,
    routerResult: { contractVersion: "1", workflowExecutionId: "exec-wa-001", status: "success", intent: "CREATE_EXPENSE", message: "Logged €25.00 to FOOD.", data: { id: "e1" }, clarifyingQuestion: null },
  });
  check("success message is forwarded verbatim, not reworded", r.text === "Logged €25.00 to FOOD.", r);
  check("reply targets the original WhatsApp sender", r.to === "15551234567", r);
  check("messageType is 'text' (the only type 02-whatsapp-outbound-send.json supports)", r.messageType === "text", r);
  check("contextTag marks this as a Finance Inbox response", r.contextTag === "finance-inbox-response", r);
}

// 15: Router/Execute Workflow call failure -> safe WhatsApp response, never raw error internals
{
  const validated = runValidate(VALID_EVENT);
  const r = runBuildReply({ validated, routerResult: { error: { message: "connect ECONNREFUSED" } } });
  check("Router call failure -> safe generic text, not the raw error", r.text === "Sorry, I couldn't process that just now. Please try again in a moment." && !/ECONNREFUSED/.test(r.text), r);
  check("still targets the original sender even on failure", r.to === "15551234567", r);
}

// Missing/empty message from a malformed Router response -> same safe fallback
{
  const validated = runValidate(VALID_EVENT);
  const r = runBuildReply({ validated, routerResult: {} });
  check("empty Router result -> safe fallback text, no crash", r.text === "Sorry, I couldn't process that just now. Please try again in a moment.", r);
}

// A clarify/error-status response from the Router is still just relayed via `message` -- this
// node never branches on `status`/`intent`, proving it invents no Finance business logic.
{
  const validated = runValidate(VALID_EVENT);
  const r = runBuildReply({
    validated,
    routerResult: { status: "clarify", intent: "CREATE_EXPENSE", message: "What category was this expense?", data: null, clarifyingQuestion: "What category was this expense?" },
  });
  check("a clarify-status response is relayed via `message` exactly like success -- no special-casing", r.text === "What category was this expense?", r);
}

// ---- STRUCTURAL TESTS (against the committed workflow JSON itself) ----

// 9, 13: Router/Handler call targets
{
  const routerNode = wf.nodes.find((n) => n.name === "Call Finance Intent Router");
  check("Router call targets FinanceIntentRouterWf01", routerNode && routerNode.parameters.workflowId === "FinanceIntentRouterWf01", routerNode);
  const outboundNode = wf.nodes.find((n) => n.name === "Call WhatsApp Outbound Send");
  check("Outbound send call targets WhatsappOutboundSendWf01", outboundNode && outboundNode.parameters.workflowId === "WhatsappOutboundSendWf01", outboundNode);

  const executeWorkflowNodes = wf.nodes.filter((n) => n.type === "n8n-nodes-base.executeWorkflow");
  check("exactly 2 executeWorkflow nodes exist (Router, Outbound Send) -- no other workflow is called", executeWorkflowNodes.length === 2, executeWorkflowNodes.map((n) => n.name));
  check(
    "this adapter never calls the CREATE_EXPENSE Handler directly (only via the Router)",
    executeWorkflowNodes.every((n) => n.parameters.workflowId !== "FinanceHandlerCreateExpenseWf01"),
    executeWorkflowNodes.map((n) => n.parameters.workflowId)
  );
}

// 10: no Finance HTTP Request node exists in this adapter
{
  const httpRequestNodes = wf.nodes.filter((n) => n.type === "n8n-nodes-base.httpRequest");
  check("zero httpRequest nodes exist in this adapter -- it never calls the Finance API directly", httpRequestNodes.length === 0, httpRequestNodes.map((n) => n.name));
}

// 11: no intent classification exists in this adapter
{
  const aiNodes = wf.nodes.filter((n) => n.type.includes("langchain") || n.type === "n8n-nodes-base.agent");
  check("zero LangChain/Agent nodes exist in this adapter -- it never classifies intent", aiNodes.length === 0, aiNodes.map((n) => n.name));
  const classifyingCode = wf.nodes.filter(
    (n) => n.parameters && typeof n.parameters.jsCode === "string" && /\bCREATE_EXPENSE\b|\bGET_BUDGET\b|\bUNRECOGNIZED\b/.test(stripLineComments(n.parameters.jsCode))
  );
  check("no Code node's jsCode references any Intent Catalog value -- this adapter is intent-blind", classifyingCode.length === 0, classifyingCode.map((n) => n.name));
}

// 12: no Finance-specific validation exists in this adapter
{
  const financeValidationCode = wf.nodes.filter(
    (n) =>
      n.parameters &&
      typeof n.parameters.jsCode === "string" &&
      /\bamount\b|\bcategory\b|\bpaymentMethod\b|\bExpenseCategory\b|\bisRecurring\b/i.test(stripLineComments(n.parameters.jsCode))
  );
  check(
    "no Code node's jsCode references any Finance-domain field outside of explanatory comments -- this adapter does no Finance validation",
    financeValidationCode.length === 0,
    financeValidationCode.map((n) => n.name)
  );
}

// Workflow identity, matching the Gateway's forward-reference (see the Gateway's own structural test)
{
  check("workflow id is exactly FinanceWhatsAppEntryWf01", wf.id === "FinanceWhatsAppEntryWf01", wf.id);
}

// Content-snapshot guard on the three files this phase must not modify, following the same
// pattern established in 10-handle-create-expense.logic.test.js's cleanup pass -- NOT a
// `git diff --stat` vs HEAD check (this repository legitimately carries multiple prior phases'
// uncommitted work at any given time; see that file's own comment for the full reasoning).
{
  const crypto = require("crypto");
  const EXPECTED_HASHES = {
    "workflows/finance/01-finance-inbox-entry.json": "cb9ec9e53b3fbcd1d2b5fa76e74d6f0d1b539f686789229f5b3bdde5f7a73564",
    // Updated for the ADR-0014 AI Core migration (deliberate, reviewed
    // change to this file -- see docs/adrs/ADR-0014-finance-ai-core-migration.md).
    "workflows/finance/02-finance-intent-router.json": "0986cecd1c77c4c76be7cf496ac3a9f2bb6a44ef9a71009103926939e7c7a99c",
    // Updated for the ADR-0014 AI Core migration (deliberate, reviewed
    // change to this file -- see docs/adrs/ADR-0014-finance-ai-core-migration.md
    // and 10-handle-create-expense.logic.test.js's own snapshot comment).
    "workflows/finance/10-handle-create-expense.json": "adee10326b63bf253d1ef14d41ce4ca40beac645b647630ff430625ef08b8e6c",
  };
  for (const [rel, expected] of Object.entries(EXPECTED_HASHES)) {
    const full = path.join(__dirname, "../../..", rel);
    const actual = crypto.createHash("sha256").update(fs.readFileSync(full, "utf8")).digest("hex");
    check(`${rel} content matches this phase's snapshot (untouched)`, actual === expected, actual);
  }
}

console.log(`\n${pass} passed, ${fail} failed (${pass + fail} total assertions)`);
process.exit(fail > 0 ? 1 : 0);
