#!/usr/bin/env node
// Extracts the ACTUAL jsCode strings from 01-whatsapp-gateway-webhook.json's
// Code nodes and runs them in a mocked n8n Code-node context (Node's
// built-in `vm`, zero dependencies — same approach as the CRM/Finance logic
// tests). Run: node tests/workflows/integrations/01-whatsapp-gateway-webhook.logic.test.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const wf = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "../../../workflows/integrations/01-whatsapp-gateway-webhook.json"),
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

// ---- Verify Meta Webhook Challenge ----
function runVerify(json, envToken) {
  const code = getCode("Verify Meta Webhook Challenge");
  const sandbox = { $json: json, $env: { WHATSAPP_VERIFY_TOKEN: envToken }, console, result: undefined };
  vm.createContext(sandbox);
  vm.runInContext(`result = (function(){ ${code} })()`, sandbox);
  return sandbox.result[0].json;
}

{
  const r = runVerify({ query: { "hub.mode": "subscribe", "hub.verify_token": "secret1", "hub.challenge": "999" } }, "secret1");
  check("matching token + subscribe -> verified true, challenge echoed", r.verified === true && r.challenge === "999", r);
}
{
  const r = runVerify({ query: { "hub.mode": "subscribe", "hub.verify_token": "wrong", "hub.challenge": "999" } }, "secret1");
  check("wrong token -> verified false, challenge null (never leaked)", r.verified === false && r.challenge === null, r);
}
{
  const r = runVerify({ query: { "hub.mode": "unsubscribe", "hub.verify_token": "secret1", "hub.challenge": "999" } }, "secret1");
  check("mode != subscribe -> verified false", r.verified === false, r);
}
{
  const r = runVerify({ query: { "hub.mode": "subscribe", "hub.verify_token": "secret1", "hub.challenge": "999" } }, "");
  check("no server-side token configured -> fails closed, not open", r.verified === false, r);
}

// ---- Parse WhatsApp Payload ----
function runParse(body) {
  const code = getCode("Parse WhatsApp Payload");
  const sandbox = { $json: { body }, console, result: undefined };
  vm.createContext(sandbox);
  vm.runInContext(`result = (function(){ ${code} })()`, sandbox);
  return sandbox.result[0].json;
}

const REAL_MESSAGE_PAYLOAD = {
  object: "whatsapp_business_account",
  entry: [{
    id: "WABA1",
    changes: [{
      value: {
        metadata: { phone_number_id: "PHONE1" },
        contacts: [{ profile: { name: "Jane" }, wa_id: "1555" }],
        messages: [{ from: "1555", id: "wamid.ABC", timestamp: "111", type: "text", text: { body: "eyan-test" } }],
      },
    }],
  }],
};
{
  const r = runParse(REAL_MESSAGE_PAYLOAD);
  check("real message payload -> valid, one message extracted", r.valid === true && r.messages.length === 1, r);
  check("extracted message carries all required identifiers", r.messages[0].whatsappBusinessAccountId === "WABA1" && r.messages[0].phoneNumberId === "PHONE1" && r.messages[0].customerWhatsappId === "1555" && r.messages[0].messageId === "wamid.ABC" && r.messages[0].messageText === "eyan-test", r);
}
{
  const r = runParse({ object: "whatsapp_business_account", entry: [{ id: "WABA1", changes: [{ value: { metadata: { phone_number_id: "PHONE1" }, statuses: [{ id: "wamid.ABC", status: "delivered" }] } }] }] });
  check("status-only callback -> valid envelope but zero messages", r.valid === true && r.messages.length === 0, r);
}
{
  const r = runParse({ object: "page", entry: [] });
  check("wrong object type -> invalid, reason names it", r.valid === false && /object: page/.test(r.reason), r);
}
{
  const r = runParse("not json");
  check("malformed string body -> invalid, no crash", r.valid === false && /Malformed JSON/.test(r.reason), r);
}

// ---- Normalize WhatsApp Messages ----
function runNormalize(parsedJson, executionId) {
  const code = getCode("Normalize WhatsApp Messages");
  const sandbox = {
    $: (name) => {
      if (name !== "Parse WhatsApp Payload") throw new Error("unexpected node ref: " + name);
      return { item: { json: parsedJson } };
    },
    $execution: { id: executionId },
    console,
    result: undefined,
  };
  vm.createContext(sandbox);
  vm.runInContext(`result = (function(){ ${code} })()`, sandbox);
  return sandbox.result.map((item) => item.json);
}

{
  const parsed = runParse(REAL_MESSAGE_PAYLOAD);
  const normalized = runNormalize(parsed, "exec-123");
  check("normalize produces one event per message", normalized.length === 1, normalized);
  const evt = normalized[0];
  check("normalized event carries every required lookup key", evt.whatsappBusinessAccountId === "WABA1" && evt.phoneNumberId === "PHONE1" && evt.customerWhatsappId === "1555" && evt.messageId === "wamid.ABC", evt);
  check("normalized event carries the raw Meta message for audit", evt.rawMessage && evt.rawMessage.id === "wamid.ABC", evt);
  check("workflowExecutionId threaded through unchanged", evt.workflowExecutionId === "exec-123", evt);
}

// ---- Build Test Reply Input (loop-safety: gated behind an exact keyword, reply text is never the keyword itself) ----
{
  const code = getCode("Build Test Reply Input");
  const sandbox = { $json: { customerWhatsappId: "1555", messageId: "wamid.ABC" }, console, result: undefined };
  vm.createContext(sandbox);
  vm.runInContext(`result = (function(){ ${code} })()`, sandbox);
  const r = sandbox.result[0].json;
  check("test reply targets the actual sender", r.to === "1555", r);
  check("test reply is clearly labeled as a test", /EYAN TEST REPLY/.test(r.text), r);
  check("test reply text is NOT the trigger keyword itself (no loop even if ever re-ingested)", r.text.trim().toLowerCase() !== "eyan-test", r);
  check("contextTag marks this as the gateway test-reply path", r.contextTag === "gateway-test-reply", r);
}

// ---- STRUCTURAL: "Ready For AI / CRM Processing" now plugs into the
// WhatsApp Finance Entry adapter (Phase 3B). This was previously a
// dead-end NoOp ("future milestone plugs in here", per
// docs/workflows/whatsapp-gateway-architecture.md) -- this test locks in
// that wiring without touching any pre-existing node's behavior. ----
{
  const financeEntryNode = wf.nodes.find((n) => n.name === "Call WhatsApp Finance Entry");
  check("a Call WhatsApp Finance Entry node exists", !!financeEntryNode, financeEntryNode);
  check(
    "it is an executeWorkflow node targeting FinanceWhatsAppEntryWf01",
    financeEntryNode && financeEntryNode.type === "n8n-nodes-base.executeWorkflow" && financeEntryNode.parameters.workflowId === "FinanceWhatsAppEntryWf01",
    financeEntryNode
  );
  check(
    "'Ready For AI / CRM Processing' now connects to it (the documented extension point)",
    JSON.stringify(wf.connections["Ready For AI / CRM Processing"]) === JSON.stringify({ main: [[{ node: "Call WhatsApp Finance Entry", type: "main", index: 0 }]] }),
    wf.connections["Ready For AI / CRM Processing"]
  );
  check(
    "the pre-existing 'eyan-test' keyword-reply branch is untouched",
    JSON.stringify(wf.connections["Is Test Keyword Message?"]) ===
      JSON.stringify({
        main: [
          [{ node: "Build Test Reply Input", type: "main", index: 0 }],
          [{ node: "Ready For AI / CRM Processing", type: "main", index: 0 }],
        ],
      }),
    wf.connections["Is Test Keyword Message?"]
  );
}

console.log(`\n${pass} passed, ${fail} failed (${pass + fail} total assertions)`);
process.exit(fail > 0 ? 1 : 0);
