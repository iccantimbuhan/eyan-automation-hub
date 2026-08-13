# Finance - 02 - Intent Router

Status: Active (imported, inactive by default — see Testing; Phase 2.5 formally evaluated local model choice, `mistral:7b` remains the configured default — see ADR-0009; Phase 2.6 replaced the classification mechanism itself — no more AI Agent node or Structured Output Parser, see ADR-0012)

Category: Finance

Owner: Automation Hub

Version: 1.0

---

# Purpose

The second workflow of the AI Finance Inbox and the target of `01-finance-inbox-entry.json`'s forward-referenced `FinanceIntentRouterWf01` call. Receives a channel-agnostic Finance Inbox Request, validates it against the Finance Inbox Workflow Contract, classifies it into one of the eight Finance Intents using a deterministic Chat Model + Code-node classification pipeline (ADR-0012 — no n8n AI Agent node, no LangChain Structured Output Parser), and dispatches to the matching (not-yet-built) Handler workflow via `Execute Workflow`. This is a pure orchestrator: it contains no Finance business logic, no Finance-specific validation, no field extraction, and no channel-specific logic of any kind — see Constraints below, each one verified structurally, not just by convention.

---

# Trigger

- Execute Workflow Trigger (`inputSource: passthrough`) — called by `01-finance-inbox-entry.json` today; any future channel's own front-door workflow calls it identically.

---

# Inputs

The Finance Inbox Request Contract (`docs/adrs/ADR-0008-finance-inbox-workflow-contract.md` Decision 1, `docs/workflows/finance-inbox-contract.md`):

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `contractVersion` | string | Yes | `"1"` today. |
| `workflowExecutionId` | string | Yes | Generated once by the calling front door; forwarded unchanged to whichever Handler this workflow dispatches to. |
| `workflowName` | string | Yes | The calling front door's slug. |
| `channel` | string | Yes | `slack` \| `telegram` \| `whatsapp` \| `retell` \| `web-chat` \| `ocr`. |
| `externalUserId` | string \| null | Yes (nullable) | |
| `externalMessageId` | string \| null | Yes (nullable) | |
| `rawText` | string | Yes | May be `""`. |
| `attachments` | array | Yes (may be empty) | `{url, mimeType, name}[]`. |

---

# Workflow Steps

1. **When Called by Another Workflow** (Execute Workflow Trigger, `inputSource: passthrough`) — receives the Request contract unchanged.
2. **Validate Request Contract** (Code) — checks the request matches the contract shape: required fields present and non-empty, `channel` is a known value, `attachments` is an array, `externalUserId`/`externalMessageId` keys exist (values may be `null`). **This is structural validation only** — it never inspects `rawText` for Finance meaning, never checks for an amount or category, and would pass an obviously Finance-irrelevant message ("hello, how are you?") just as readily as a real expense description, because deciding what the message *means* is not this node's job.
3. **Request Valid?** (IF) — branches on step 2's result.
   - **False**: → **Build Contract Violation Response** (Code) — returns a fully Response-contract-shaped `status: "error"` object without ever reaching the classifier. Terminal leaf.
   - **True**: → the classification pipeline.
4. **Classification pipeline (ADR-0012)** — a deterministic Chat Model → Code-node pipeline, **not** an n8n AI Agent node and **not** a LangChain Structured Output Parser. This replaced the original Phase 2 Agent-based design after ADR-0009 proved it fails 0/22 times across two Ollama models (both wrap their answer in a `format_final_json_response` tool-call envelope the parser can't unwrap):
   - **Ollama Chat Model** (`lmChatOllama`, model `mistral:7b`, "Ollama (Local)" credential — **no `options.format: "json"`**, deliberately: keeping it would make n8n's Basic LLM Chain silently auto-parse JSON internally, an implicit, format-dependent response shape this design specifically avoids, see ADR-0012) — connected via the `ai_languageModel` connection type.
   - **Classify Intent (Chain)** (`@n8n/n8n-nodes-langchain.chainLlm`, "Basic LLM Chain", `hasOutputParser: false`, `onError: continueRegularOutput`) — sends the system prompt plus the request's `rawText` (with a note when `attachments` is non-empty) to the Chat Model and returns its **raw text completion** unmodified as `$json.text`. No output parser is attached, so no tool-calling or schema-forcing mechanism is ever invoked — this is a plain chat completion call.
     - System prompt: `workflows/finance/prompts/intent-classification.v2.md` (embedded verbatim in `parameters.messages.messageValues[0].message` — see that file's own note on why this isn't loaded from disk at runtime). v2 explicitly instructs: JSON only, no Markdown fences, no explanations, no tool calls, no invented fields, exactly one of the eight intents, confidence in `[0, 1]`, and prefer `UNRECOGNIZED` on any of several named ambiguous cases (expense-vs-transfer, income-vs-expense, uncertain-receipt-attachment).
   - **Parse Classification Output** (Code) — the entire classification-output contract enforcement lives here, not in any LangChain node. Reads `$json.text`, tolerates a ```` ```json ... ``` ```` fence or surrounding prose, parses it, and validates that the result is an object with `intent` in the eight-value catalog and `confidence` a number in `[0, 1]`. Any failure at any step — unparseable text, wrong shape, out-of-catalog intent, out-of-range confidence, or the Chat Model call itself failing (`$json.error`, caught by the Chain node's `onError`) — falls back to `{intent: "UNRECOGNIZED", confidence: 0}`. Never throws. Returns **only** `intent` and `confidence`, nothing else, even if the model's raw text contained extra fields.
5. **Merge Context With Classification** (Code) — merges the parser's already-validated `{intent, confidence}` with the original request context, read back from **Validate Request Contract** by node name (never trusted to have survived the classification pipeline unchanged). Does no re-validation of its own — that already happened in step 4.
6. **Intent Router** (`n8n-nodes-base.switch`, mode `rules`, 8 rule outputs + 1 defensive `Fallback` output) — routes purely on `$json.intent === "<value>"`. No branch contains any logic beyond the routing rule itself.
7. **Execute Handler - `<INTENT>`** (8 `Execute Workflow` nodes, one per Intent Catalog entry, each `onError: continueRegularOutput`) — each node's **only** parameter is a hand-assigned `workflowId` (see Handler ID Assignments below). The `Fallback` output also connects to `Execute Handler - UNRECOGNIZED`, so no classification outcome is ever a dead end.
8. **Return Handler Response** (Code) — the single convergence point all 8 branches feed into.
   - **Handler responded successfully**: returns that response **completely unchanged** — verified by a byte-identical deep-equality test, not just "looks right" (see Testing).
   - **Handler call failed** (`$json.error` — true for every intent this phase, since no Handler workflow exists yet): synthesizes a Response-contract-shaped `status: "error"` fallback, using `intent`/`workflowExecutionId` preserved from **Merge Context With Classification**. This is orchestration-layer resilience (“the Handler is unreachable”), never a Finance business decision.

---

# Handler ID Assignments (this phase's contribution to ADR-0008)

ADR-0008's Notes explicitly deferred assigning Handler workflow IDs to "Phase 2/3." This phase assigns them, following ADR-0005's `<Domain><Purpose>Wf<NN>` convention and the `09`/`10`–`16` numbering block already anticipated:

| Intent | Handler ID (forward reference — not yet built) | Planned file |
|---|---|---|
| `CREATE_EXPENSE` | `FinanceHandlerCreateExpenseWf01` | `workflows/finance/10-handle-create-expense.json` |
| `GET_BUDGET` | `FinanceHandlerGetBudgetWf01` | `workflows/finance/11-handle-get-budget.json` |
| `GET_DASHBOARD` | `FinanceHandlerGetDashboardWf01` | `workflows/finance/12-handle-get-dashboard.json` |
| `GET_FINANCE_QUESTION` | `FinanceHandlerGetFinanceQuestionWf01` | `workflows/finance/13-handle-get-finance-question.json` |
| `CREATE_INCOME` | `FinanceHandlerCreateIncomeWf01` | `workflows/finance/14-handle-create-income.json` |
| `CREATE_TRANSFER` | `FinanceHandlerCreateTransferWf01` | `workflows/finance/15-handle-create-transfer.json` |
| `UPLOAD_RECEIPT` | `FinanceHandlerUploadReceiptWf01` | `workflows/finance/16-handle-upload-receipt.json` |
| `UNRECOGNIZED` | `FinanceHandlerUnrecognizedIntentWf01` | `workflows/finance/09-handle-unrecognized-intent.json` |

None of these files exist. This workflow imports and runs correctly without them, by design (see Error Handling) — the same forward-reference posture `01-finance-inbox-entry.json` already established for this very workflow's own ID.

---

# Integrations

- **Ollama** (local, `http://host.docker.internal:11434`, "Ollama (Local)" credential) — backs the classification pipeline's Chat Model. Real connectivity confirmed live in Phase 2 (`wget` from inside `eyan-n8n` to `/api/tags` returned the real model list) — the same host-reachability path ADR-0007 already established and resolved for CRM's Workflow 3.
- 8 forward-referenced Handler workflows (`Execute Workflow`) — none exist yet; see Handler ID Assignments.

---

# Outputs

The Finance Inbox Response Contract (`docs/adrs/ADR-0008-finance-inbox-workflow-contract.md` Decision 2):

```json
{
  "contractVersion": "1",
  "workflowExecutionId": "exec-1",
  "status": "success",
  "intent": "CREATE_EXPENSE",
  "message": "Logged $12.50 to FOOD.",
  "data": { "id": "expense-1", "amount": "12.50", "category": "FOOD" },
  "clarifyingQuestion": null
}
```

Returned to whichever front door called this workflow — today, `01-finance-inbox-entry.json`'s `Call Finance Intent Router` node.

---

# Error Handling

- **Contract violation** (malformed Request): rejected before the classification pipeline is ever reached; `status: "error"`, `intent: "UNRECOGNIZED"`.
- **Chat Model call failure**: `onError: continueRegularOutput` on the Chain node catches it; `Parse Classification Output` defaults to `UNRECOGNIZED` rather than crashing.
- **Malformed, out-of-catalog, or out-of-range classification output**: never reaches the Intent Router — `Parse Classification Output` forces `{intent: "UNRECOGNIZED", confidence: 0}` for any shape it can't validate, including the exact `format_final_json_response` tool-call-wrapped shape that broke the original Agent-based design (this is now structurally impossible to reach the Switch node with, not just discouraged — see Testing).
- **Handler missing or failing**: `onError: continueRegularOutput` on every `Execute Handler - *` node; `Return Handler Response` synthesizes a fallback `status: "error"` response rather than stranding the caller.
- **No retry logic** exists in this workflow — a single attempt at each step, degrading gracefully on failure. Retry policy (if any) for a real Handler's own Finance API call is that Handler's responsibility, not the Router's.

---

# Constraints Verified (not just declared)

Every constraint below was checked structurally against the actual committed JSON, not just written down:

| Constraint | How it's verified |
|---|---|
| Never calls the Finance REST API | Zero `n8n-nodes-base.httpRequest` nodes exist anywhere in this workflow (test #28) |
| Never implements Finance business logic | No node references budgets, categories, or spending calculations |
| Never extracts expense fields | The classifier's output schema is `{intent, confidence}` only — no `amount`/`category`/`date` field anywhere in this workflow; `Parse Classification Output` structurally drops any extra field the model's raw text might contain (test #28) |
| Never relies on LangChain tool-calling or a Structured Output Parser (ADR-0012) | Zero `@n8n/n8n-nodes-langchain.agent` and zero `@n8n/n8n-nodes-langchain.outputParserStructured` nodes exist anywhere in this workflow; the Chain node declares `hasOutputParser: false` and has no `ai_outputParser` connection (tests #38–39) |
| Never validates Finance-specific data | `Validate Request Contract` checks contract shape only (test #12: an obviously Finance-irrelevant message still passes) |
| Never parses receipts | `attachments` is passed through as opaque `{url, mimeType, name}` objects, never opened/interpreted |
| Never calculates budgets | No arithmetic on `amount`/`data` appears anywhere |
| Never contains Slack-specific or channel-specific logic | `channel` is read only to validate it's a known enum value; no branch behaves differently per channel |
| Never knows how a Handler works | Every `Execute Handler - *` node's parameters contain **only** `workflowId` — no jsonBody, no field mapping, no Handler-specific shape (test #27) |

---

# Security

Authentication: none inbound (Execute Workflow Trigger, called only by another workflow in the same n8n instance — no public webhook surface).

Secrets Used: one new n8n-native credential, **"Ollama (Local)"** (type `ollamaApi`, id `OllamaLocalCred01`) — `baseUrl: http://host.docker.internal:11434`, no API key (Ollama has no auth in this local setup). Created via `n8n import:credentials` (same procedure `docs/security/credential-management.md` documents for the two CRM credentials), **not** referenced-but-uncreated like the Slack/SMTP credentials — this one is real, because Ollama connectivity is real and testable in this environment (unlike Slack, for which no workspace exists yet).

Sensitive Data: `rawText` (the user's raw message) is sent to a local Ollama instance for classification — stays on the host, never leaves the Docker network.

---

# Monitoring

Success Metrics: n8n's built-in execution list.

Failure Alerts: not configured — same standing gap as every other workflow in this repo.

Logging: n8n's own execution log. `Parse Classification Output` and `Return Handler Response` additionally `console.log` the specific failure reason when the Chat Model call fails, the classification output is malformed, or a Handler call fails, so a real failure is diagnosable from n8n's execution detail view without guessing from the generic caller-facing message alone.

---

# Testing

**Logic tests** (`tests/workflows/finance/02-finance-intent-router.logic.test.js`, 39 test blocks / 80 assertions, all passing — `node tests/workflows/finance/02-finance-intent-router.logic.test.js`):

- `Validate Request Contract`: accepts a well-formed request; rejects each missing required field individually; rejects an unknown `channel`; accepts `rawText: ""` but rejects `rawText` entirely absent; accepts `null` `externalUserId`/`externalMessageId` but rejects the *key* being absent; rejects non-array `attachments`; and — proving "no Finance-specific validation" structurally — accepts an obviously Finance-irrelevant message.
- `Build Contract Violation Response`: produces a fully contract-shaped `status: "error"` object; falls back to `workflowExecutionId: "unknown"` when even that is missing.
- `Parse Classification Output` (ADR-0012's deterministic parser — the bulk of this phase's new coverage): accepts clean JSON; tolerates a ```` ```json ... ``` ```` fence, a bare ``` ``` ``` fence, and surrounding prose; forces an out-of-catalog intent, a completely unparseable response, a non-string `intent`, an out-of-range `confidence` (both `>1` and `<0`), a non-numeric `confidence`, and a top-level array (as opposed to an object) all to `UNRECOGNIZED`/`0`; accepts `confidence` exactly at the `0` and `1` boundaries; handles a Chat Model call failure (`$json.error`) gracefully; drops any extra field the model's text might contain, returning **only** `intent`/`confidence`; and — the specific regression test for the bug this phase exists to fix — correctly rejects the exact `format_final_json_response` tool-call-wrapped shape that broke the original Agent-based design, since that shape has no top-level `intent` key.
- `Merge Context With Classification`: merges the parser's clean `{intent, confidence}` with the original request context.
- `Return Handler Response`: returns a successful Handler response **byte-identical** (deep-equality-checked, including a hypothetical field a future Handler might add, proving true pass-through rather than field-by-field reconstruction); synthesizes a correct fallback on Handler failure, preserving `intent`/`workflowExecutionId` from context.
- Structural sanity checks (declarative `IF`/`Switch` expressions, not extractable `jsCode`, re-implemented and tested the same way `04-sales-automation.logic.test.js` already does for its own `IF` gates): the `Request Valid?` gate; all 8 Intent Catalog values routing to their own branch; an unexpected value falling to the defensive `Fallback` output; every `Execute Handler - *` node structurally verified to carry only a `workflowId`; zero `httpRequest` nodes anywhere in the workflow; zero AI Agent nodes and zero Structured Output Parser nodes anywhere in the workflow (ADR-0012); the Chain node's `hasOutputParser: false` and the absence of any `ai_outputParser` connection.

**Live end-to-end validation against the real, running n8n 2.33.3 instance** (not just structural — this phase went further than Phase 1's validation bar):

1. `n8n import:workflow` — succeeds, idempotent on re-import.
2. `n8n export:workflow` — round-trips **byte-for-byte** through every node's `parameters`/`credentials`/`connections`/`onError`, including the `ai_languageModel` sub-node wiring and the 9-output `Switch` node — neither had any prior precedent in this repo. (Phase 2 originally also had an `ai_outputParser` connection here; Phase 2.6/ADR-0012 removed it along with the Structured Output Parser node itself — re-verified round-tripping after that change too, see item 7.)
3. **`n8n execute --id=FinanceIntentRouterWf01` against real Ollama** (`N8N_RUNNERS_BROKER_PORT` overridden to avoid a port conflict with the already-running instance's own task broker — undocumented elsewhere, noted here for the next person). A representative `CREATE_EXPENSE`-shaped request (`"spent $12.50 on lunch"`) was temporarily hardcoded into a throwaway copy of `Validate Request Contract`'s `jsCode` for this run only — `pinData` on the Execute Workflow Trigger was tried first and found **not** to be honored by `n8n execute` for this trigger type (a new finding, worth recording alongside ADR-0005's existing CLI-quirk Notes); the temporary-injected-Code-node technique ADR-0005 already documents for Webhook triggers works here too and is what was actually used. Nothing about this technique was committed.
4. **A real finding, caught by this live run and fixed before commit**: the AI Agent node had no `onError` set. The real `mistral:7b` model produced tool-call-wrapped output (`{"name":"format_final_json_response","arguments":{"output":{...}}}`) that `N8nStructuredOutputParser` rejected ("Model output doesn't fit required format"), which — without `onError` — crashed the entire execution rather than degrading to `UNRECOGNIZED`. Fixed by adding `onError: continueRegularOutput` to the Agent node and extending `Validate Agent Output` to treat `$json.error` the same as malformed output. Re-run confirmed: the workflow now completes successfully end-to-end even when the model fails, producing a correct `status: "error"`, `intent: "UNRECOGNIZED"` response — proven twice, on two separate real failures.
5. **A real, diagnosed (not resolved) model-reliability limitation**, in the same spirit as ADR-0007's honest accounting of `qwen2.5-coder:7b`'s schema unreliability: `mistral:7b`'s raw completion, both with and without Ollama's native `format: "json"` mode, correctly computed `{"intent":"CREATE_EXPENSE","confidence":1.0}` — **the model understood the task correctly, twice** — but wrapped it in a `format_final_json_response` tool-call envelope that this exact n8n/LangChain version's `N8nStructuredOutputParser` does not unwrap. `gemma3:4b` was tried as an alternative and failed harder: it lacks Ollama "tools" capability at all, and n8n's Agent v3 (`ToolsAgent`-based) hard-errors (`"...does not support tools"`) rather than falling back to a non-tool-calling mode.
6. **Phase 2.5 — formal model evaluation, exhaustively confirming and extending finding 5.** All three locally available models were run against a fixed 11-case test set (one message per intent, plus repeats and a deliberately ambiguous case) rather than the single ad hoc example above. Result: **both `mistral:7b` and `qwen2.5-coder:7b` fail the structured-output parser on 0/11 and 0/11 attempts respectively** — the wrapper-mismatch bug is not model-specific; every Ollama "tools"-capable model tried produces the same tool-call envelope shape. Decoded manually, the *underlying* classification was correct in 10/11 (`mistral:7b`) and 11/11 (`qwen2.5-coder:7b`) cases — the models understand the task; the Agent-node/parser combination is what's blocking it. Full methodology, per-case data, and the comparison matrix: `docs/adrs/ADR-0009-finance-intent-router-model-selection.md`.
7. **Phase 2.6 — the architectural fix (ADR-0012), re-validated against the same 11-case test set.** The AI Agent node and Structured Output Parser were replaced with a deterministic Chat Model (Basic LLM Chain, no output parser) → Code-node parser pipeline (see Workflow Steps above). Re-running the identical test set live against `mistral:7b`: **11/11 (100%) clean structured-output success and 11/11 (100%) correct classification** — a complete reversal of items 5–6's 0/11. Mean latency also dropped from 34.5s to **13.9s** (no tool-calling round trip). One case's response was wrapped in single backticks (an unanticipated format neither test-authored beforehand) and was correctly recovered by the parser's fallback extraction — a real, not hand-picked, robustness proof. The one thing this phase did **not** fix: the deliberately ambiguous test case ("sent $50 to Alex for dinner") still resolved to `CREATE_TRANSFER` rather than the prompt-preferred `UNRECOGNIZED` — a model prompt-following limitation, unrelated to the mechanism replaced here. Full methodology and the complete results table: `docs/adrs/ADR-0012-finance-intent-router-deterministic-classification.md`.

Full production activation (editor UI toggle) was not exercised, same posture as every other workflow in this repo.

Expected Results: see Test Cases above; all logic-test assertions passed, and — as of Phase 2.6 — real Slack-shaped messages now classify correctly end-to-end against the live local model, not just degrade safely to `UNRECOGNIZED`.

---

# Related Documentation

Architecture: the AI Finance Inbox implementation plan (intent-routed revision) — this workflow implements that plan's "Finance Intent Router" design.

ADR: `docs/adrs/ADR-0008-finance-inbox-workflow-contract.md` (the contract this workflow implements — its Decision 3 wording is corrected by an amendment this phase added, see that ADR's Notes), `docs/adrs/ADR-0005-workflow-organization.md`, `docs/adrs/ADR-0006-crm-workflow-authentication.md`, `docs/adrs/ADR-0007-n8n-ollama-connectivity-gap.md` (the connectivity precedent this workflow's Ollama integration relies on), `docs/adrs/ADR-0009-finance-intent-router-model-selection.md` (Phase 2.5 — the formal local-model evaluation that ruled out "try another model" as the fix), `docs/adrs/ADR-0012-finance-intent-router-deterministic-classification.md` (Phase 2.6 — replaced the AI Agent + Structured Output Parser with the deterministic Chain + Code-node pipeline currently in this workflow).

Workflows: `docs/workflows/01-finance-inbox-entry.md` (this workflow's only caller today), `docs/workflows/finance-inbox-contract.md` (the living reference for the contract this workflow implements).

Issue: n/a — the 8 Handler workflows this workflow forward-references are future phases, not yet built.
