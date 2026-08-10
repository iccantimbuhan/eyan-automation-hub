#!/usr/bin/env node
// Extracts the ACTUAL jsCode strings from 01-finance-inbox-entry.json's
// three Code nodes and runs them in a mocked n8n Code-node context (Node's
// built-in `vm`, zero dependencies), same approach as
// tests/workflows/crm/04-sales-automation.logic.test.js. Run:
// node tests/workflows/finance/01-finance-inbox-entry.logic.test.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const wf = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "../../../workflows/finance/01-finance-inbox-entry.json"),
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

// ---- Normalize Slack Input ----
function runNormalize(slackEvent) {
  const code = getCode("Normalize Slack Input");
  const sandbox = {
    $json: slackEvent,
    Array,
    Date,
    console,
    result: undefined,
  };
  vm.createContext(sandbox);
  vm.runInContext(`result = (function(){ ${code} })()`, sandbox);
  return sandbox.result[0].json;
}

const SAMPLE_DM_EVENT = {
  type: "message",
  channel: "D0123456789",
  user: "U012ABC3DEF",
  text: "spent $12.50 on lunch",
  ts: "1691250000.000100",
  event_ts: "1691250000.000100",
  channel_type: "im",
};

// 1. A plain DM message -> normalized into the channel-agnostic envelope
{
  const r = runNormalize(SAMPLE_DM_EVENT);
  check("channel is always 'slack'", r.channel === "slack", r);
  check("externalUserId maps from event.user", r.externalUserId === "U012ABC3DEF", r);
  check("externalMessageId maps from event.event_ts", r.externalMessageId === "1691250000.000100", r);
  check("rawText maps from event.text", r.rawText === "spent $12.50 on lunch", r);
  check("attachments defaults to an empty array when no files", Array.isArray(r.attachments) && r.attachments.length === 0, r);
  check("slackChannelId captured for later reply routing", r.slackChannelId === "D0123456789", r);
  check("slackThreadTs falls back to ts when thread_ts is absent", r.slackThreadTs === "1691250000.000100", r);
  check("receivedAt is a real ISO timestamp", !Number.isNaN(Date.parse(r.receivedAt)), r);
}

// 2. event_ts missing -> externalMessageId falls back to ts
{
  const r = runNormalize({ ...SAMPLE_DM_EVENT, event_ts: undefined });
  check("externalMessageId falls back to ts when event_ts is absent", r.externalMessageId === "1691250000.000100", r);
}

// 3. A threaded channel reply -> slackThreadTs uses the real thread_ts, not ts
{
  const r = runNormalize({ ...SAMPLE_DM_EVENT, channel: "C0999999999", thread_ts: "1691240000.000000" });
  check("slackThreadTs prefers thread_ts over ts when present", r.slackThreadTs === "1691240000.000000", r);
}

// 4. A file-share event -> attachments mapped, never downloaded/inspected
{
  const r = runNormalize({
    ...SAMPLE_DM_EVENT,
    subtype: "file_share",
    files: [{ url_private: "https://files.slack.com/f1", mimetype: "image/png", name: "receipt.png" }],
  });
  check("attachments maps url/mimeType/name from files", r.attachments.length === 1 && r.attachments[0].mimeType === "image/png", r);
}

// 5. Missing text (e.g. a file-only message) -> rawText defaults to '', never undefined
{
  const r = runNormalize({ ...SAMPLE_DM_EVENT, text: undefined });
  check("rawText defaults to empty string, not undefined", r.rawText === "", r);
}

// ---- Build Router Input ----
function runBuildRouterInput({ normalized, executionId }) {
  const code = getCode("Build Router Input");
  const sandbox = {
    $: (name) => {
      if (name !== "Normalize Slack Input") throw new Error("unexpected node ref: " + name);
      return { item: { json: normalized } };
    },
    $execution: { id: executionId },
    console,
    result: undefined,
  };
  vm.createContext(sandbox);
  vm.runInContext(`result = (function(){ ${code} })()`, sandbox);
  return sandbox.result[0].json;
}

const NORMALIZED_SAMPLE = {
  channel: "slack",
  externalUserId: "U012ABC3DEF",
  externalMessageId: "1691250000.000100",
  rawText: "spent $12.50 on lunch",
  attachments: [],
  receivedAt: "2026-08-05T00:00:00.000Z",
  slackChannelId: "D0123456789",
  slackThreadTs: "1691250000.000100",
};

// 6. workflowExecutionId is n8n's own $execution.id, generated exactly once here
{
  const r = runBuildRouterInput({ normalized: NORMALIZED_SAMPLE, executionId: "12345" });
  check("workflowExecutionId === $execution.id (generated exactly once, per this workflow's scope)", r.workflowExecutionId === "12345", r);
  check("workflowName is this workflow's own slug", r.workflowName === "01-finance-inbox-entry", r);
  check("contractVersion is '1' (ADR-0019/ADR-0024 contract)", r.contractVersion === "1", r);
}

// 7. Channel-agnostic fields are forwarded unchanged
{
  const r = runBuildRouterInput({ normalized: NORMALIZED_SAMPLE, executionId: "12345" });
  check("channel forwarded", r.channel === "slack", r);
  check("externalUserId forwarded", r.externalUserId === "U012ABC3DEF", r);
  check("externalMessageId forwarded", r.externalMessageId === "1691250000.000100", r);
  check("rawText forwarded", r.rawText === "spent $12.50 on lunch", r);
  check("attachments forwarded", Array.isArray(r.attachments), r);
}

// 8. Slack-specific reply-routing fields are NEVER forwarded to the Router --
// this is the architectural boundary this workflow exists to enforce
// ("channel-agnostic request", no Slack-specific fields leaking downstream).
{
  const r = runBuildRouterInput({ normalized: NORMALIZED_SAMPLE, executionId: "12345" });
  check("slackChannelId is not part of the Router payload", !("slackChannelId" in r), r);
  check("slackThreadTs is not part of the Router payload", !("slackThreadTs" in r), r);
  check("receivedAt is not part of the Router payload", !("receivedAt" in r), r);
}

// ---- Format Slack Reply ----
function runFormatReply(routerResult) {
  const code = getCode("Format Slack Reply");
  const sandbox = { $json: routerResult, console, result: undefined };
  vm.createContext(sandbox);
  vm.runInContext(`result = (function(){ ${code} })()`, sandbox);
  return sandbox.result[0].json;
}

// 9. A well-formed Router response -> its message is relayed verbatim
{
  const r = runFormatReply({ status: "success", message: "Logged $12.50 to FOOD." });
  check("relays the Router's message verbatim", r.replyText === "Logged $12.50 to FOOD.", r);
}

// 10. The Router call itself failed (onError: continueRegularOutput -> $json.error) -> generic fallback, no crash
{
  const r = runFormatReply({ error: { message: "Workflow FinanceIntentRouterWf01 not found" } });
  check("falls back to a generic reply when the Router call errored", /couldn't process/i.test(r.replyText), r);
}

// 11. error as a plain string (not an {message} object) is also handled
{
  const r = runFormatReply({ error: "some string error" });
  check("handles a plain-string error without throwing", /couldn't process/i.test(r.replyText), r);
}

// 12. Router reachable but returned no usable message -> generic fallback, never undefined/blank
{
  const r = runFormatReply({ status: "unsupported" });
  check("falls back when the Router response has no message field", /couldn't process/i.test(r.replyText), r);
}
{
  const r = runFormatReply({ message: "   " });
  check("falls back when message is present but blank", /couldn't process/i.test(r.replyText), r);
}

// 13. This node ignores whatever Finance-specific fields the Router response
// carries -- it must never branch on them (no business logic / no intent
// classification in this workflow, per its stated scope).
{
  const withExtras = runFormatReply({
    status: "success",
    message: "Logged $12.50 to FOOD.",
    intent: "CREATE_EXPENSE",
    data: { id: "expense-1", category: "FOOD", amount: "12.50" },
  });
  const withoutExtras = runFormatReply({ status: "success", message: "Logged $12.50 to FOOD." });
  check(
    "reply text is identical whether or not Finance-specific fields are present",
    withExtras.replyText === withoutExtras.replyText,
    { withExtras, withoutExtras }
  );
}

// ---- Structural sanity check on the "Ignore Bot / System Message?" IF-node
// gating condition (a declarative n8n expression, not extractable jsCode --
// re-implemented here to prove the intended skip-bot/system-message
// semantics against representative event payloads) ----
function shouldProcessMessage(event) {
  return !event.bot_id && event.subtype !== "bot_message" && event.subtype !== "message_changed" && event.subtype !== "message_deleted";
}

// 14. A normal user message (no bot_id, no subtype) is processed
{
  check("plain user message is processed", shouldProcessMessage(SAMPLE_DM_EVENT) === true);
}

// 15. The bot's own messages, and edit/delete echoes, are ignored
{
  check("a message carrying bot_id is ignored", shouldProcessMessage({ ...SAMPLE_DM_EVENT, bot_id: "B0123" }) === false);
  check("subtype bot_message is ignored", shouldProcessMessage({ ...SAMPLE_DM_EVENT, subtype: "bot_message" }) === false);
  check("subtype message_changed is ignored", shouldProcessMessage({ ...SAMPLE_DM_EVENT, subtype: "message_changed" }) === false);
  check("subtype message_deleted is ignored", shouldProcessMessage({ ...SAMPLE_DM_EVENT, subtype: "message_deleted" }) === false);
}

// 16. A file_share subtype (a real user action, not a system echo) is processed
{
  check("subtype file_share is processed (not a bot/system echo)", shouldProcessMessage({ ...SAMPLE_DM_EVENT, subtype: "file_share" }) === true);
}

console.log(`\n${pass} passed, ${fail} failed (${pass + fail} total assertions)`);
process.exit(fail > 0 ? 1 : 0);
