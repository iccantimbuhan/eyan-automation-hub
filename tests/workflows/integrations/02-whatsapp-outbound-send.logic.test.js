#!/usr/bin/env node
// Extracts the ACTUAL jsCode strings from 02-whatsapp-outbound-send.json's
// three Code nodes and runs them in a mocked n8n Code-node context (Node's
// built-in `vm`, zero dependencies — same approach as the CRM/Finance logic
// tests). Run: node tests/workflows/integrations/02-whatsapp-outbound-send.logic.test.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const wf = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "../../../workflows/integrations/02-whatsapp-outbound-send.json"),
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

function runNode(nodeName, json) {
  const code = getCode(nodeName);
  const sandbox = { $json: json, console, result: undefined };
  vm.createContext(sandbox);
  vm.runInContext(`result = (function(){ ${code} })()`, sandbox);
  return sandbox.result[0].json;
}

// ---- Validate Send Input ----
{
  const r = runNode("Validate Send Input", { to: "15559998888", messageType: "text", text: "hello" });
  check("valid text input -> valid true", r.valid === true, r);
  check("valid text input -> fields passed through", r.to === "15559998888" && r.text === "hello", r);
}
{
  const r = runNode("Validate Send Input", { messageType: "text", text: "hello" });
  check("missing to -> invalid", r.valid === false && /Missing "to"/.test(r.reason), r);
}
{
  const r = runNode("Validate Send Input", { to: "15559998888", messageType: "text", text: "   " });
  check("blank text -> invalid", r.valid === false && /Missing "text"/.test(r.reason), r);
}
{
  const r = runNode("Validate Send Input", { to: "15559998888", messageType: "template", text: "x" });
  check("unsupported messageType -> invalid, names the type", r.valid === false && /Unsupported messageType "template"/.test(r.reason), r);
}
{
  const r = runNode("Validate Send Input", { to: "  15559998888  ", messageType: "text", text: "hi" });
  check("to is trimmed", r.to === "15559998888", r);
}

// ---- Result - Invalid Input ----
{
  const r = runNode("Result - Invalid Input", { reason: 'Missing "to" (recipient WhatsApp ID / phone number).' });
  check("invalid-input result shape", r.success === false && r.error.type === "invalid_input", r);
}

// ---- Build Graph API Request ----
{
  const r = runNode("Build Graph API Request", { to: "15559998888", text: "hi there", contextTag: "gateway-test-reply" });
  check("request body targets Meta's contract", r.requestBody.messaging_product === "whatsapp" && r.requestBody.to === "15559998888", r);
  check("request body is a text message with the given body", r.requestBody.type === "text" && r.requestBody.text.body === "hi there", r);
  check("preview_url explicitly false (no link-preview surprises)", r.requestBody.text.preview_url === false, r);
  check("contextTag passed through for the caller/audit trail", r.contextTag === "gateway-test-reply", r);
}

// ---- Map Send Result ----
{
  const r = runNode("Map Send Result", {
    messaging_product: "whatsapp",
    contacts: [{ input: "15559998888", wa_id: "15559998888" }],
    messages: [{ id: "wamid.OUTBOUND001" }],
  });
  check("success response -> success true + messageId + to extracted", r.success === true && r.messageId === "wamid.OUTBOUND001" && r.to === "15559998888", r);
}
{
  const r = runNode("Map Send Result", { error: { message: "Invalid OAuth access token." } });
  check("error response (onError: continueRegularOutput shape) -> success false, message captured", r.success === false && r.error.type === "meta_api_error" && /Invalid OAuth access token/.test(r.error.message), r);
}
{
  const r = runNode("Map Send Result", { error: "some string error" });
  check("string error shape still handled without crashing", r.success === false && /some string error/.test(r.error.message), r);
}

console.log(`\n${pass} passed, ${fail} failed (${pass + fail} total assertions)`);
process.exit(fail > 0 ? 1 : 0);
