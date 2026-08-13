# Finance - 10 - Handle Create Expense

Status: Active (imported, inactive by default — see Testing; live-validated end-to-end against the real Finance Service API, including a real create and a real idempotent replay)

Category: Finance

Owner: Automation Hub

Version: 1.0

---

# Purpose

The first Finance Intent Handler, and the target of `02-finance-intent-router.json`'s forward-referenced `Execute Handler - CREATE_EXPENSE` node (`workflowId: "FinanceHandlerCreateExpenseWf01"`). Receives a channel-agnostic Finance Inbox Request already classified as `CREATE_EXPENSE`, extracts expense fields (amount, category, payment method, date, description) from `rawText` using a local Ollama model, validates the extraction against the real Finance domain schema, writes the expense via the Eyan Finance Service API, and returns the Finance Inbox Response Contract. This is the first workflow in the AI Finance Inbox chain that does business logic, calls the Finance API, or extracts Finance-specific fields — the Router deliberately does none of that (ADR-0008 Notes amendment).

---

# Trigger

- Execute Workflow Trigger (`inputSource: passthrough`) — called by `02-finance-intent-router.json`'s `Execute Handler - CREATE_EXPENSE` node today; any future caller (e.g. a later `UPLOAD_RECEIPT` handler reusing this same write path, per ADR-0008 Decision 3's own note that both intents write via the same endpoint) calls it identically.

---

# Inputs

The Finance Inbox Request Contract (`docs/adrs/ADR-0008-finance-inbox-workflow-contract.md` Decision 1, `docs/workflows/finance-inbox-contract.md`) — unchanged from what the Router receives and forwards:

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `contractVersion` | string | Yes | `"1"` today. |
| `workflowExecutionId` | string | Yes | Generated once by the original front door; forwarded unchanged through the Router to this Handler, and forwarded unchanged again to the Finance API — see Idempotency below. |
| `workflowName` | string | Yes | The original front door's slug (not this Handler's own — see Outputs). |
| `channel` | string | Yes | `slack` \| `telegram` \| `whatsapp` \| `retell` \| `web-chat` \| `ocr`. |
| `externalUserId` | string \| null (contract) — **required by this Handler** | Yes | The shared Inbox Contract allows `null`; this Handler additionally requires a real, non-empty value (see Constraints) — the Eyan Finance Service API's `source.externalUserId` is a mandatory field, and this Handler cannot safely attribute an expense without it. |
| `externalMessageId` | string \| null | Yes (nullable) | Forwarded into the Finance API's `source.externalMessageId` when present. |
| `rawText` | string | Yes | The message the expense is extracted from. |
| `attachments` | array | Yes (may be empty) | Passed through as an opaque count only — this phase does not parse receipt images (`UPLOAD_RECEIPT` is a separate, not-yet-built handler). |

---

# Workflow Steps

1. **When Called by Another Workflow** (Execute Workflow Trigger, `inputSource: passthrough`) — receives the Request contract unchanged.
2. **Validate Handler Input** (Code) — re-validates the contract shape defensively (this workflow could be called directly by a future handler, not only via the Router) and adds one Handler-specific rule the shared contract does not: `externalUserId` must be a real, non-empty string.
3. **Handler Input Valid?** (IF) — `false` → **Build Invalid Input Response** (terminal, `status: "error"`, `intent: "CREATE_EXPENSE"`); `true` → continue.
4. **Prepare Expense Extraction Input** (Code) — builds the Ollama `/api/chat` request body: system prompt (`workflows/finance/prompts/expense-extraction.v3.md`, embedded verbatim with today's date substituted) + user message (`rawText` + an attachment-count note).
5. **Call Ollama - Extract Expense** (`httpRequest`, `onError: continueRegularOutput`) — `POST {{ $env.OLLAMA_BASE_URL }}/api/chat`, `format: "json"`, `options: { temperature: 0, num_ctx: 2048 }`, model `gemma3:4b` (hardcoded — see ADR-0011 and its Addendum). No credential: Ollama has no auth locally.
6. **Validate Expense Extraction** (Code) — parses the response, distinguishing three outcomes: the Ollama call itself failing, the response not being parseable JSON (both → `extraction_failed`, a system error), or a well-formed extraction missing/invalid `amount`/`category` (→ `needs_clarification`). `paymentMethod`/`date`/`description`/`isRecurring` are never blocking — an unrecognized `paymentMethod` is dropped, a missing/invalid `date` defaults to this workflow's own execution date (see the node's own code comment for why this is not the same class of "invented data" the amount/category rule guards against), and `isRecurring` defaults to `false` unless the model returns a literal `true`.
7. **Expense Data Valid?** (IF) — `false` → **Build Extraction Failure Response** (terminal — `status: "clarify"` with a real clarifying question for `needs_clarification`, or `status: "error"` for `extraction_failed`); `true` → continue.
8. **Build Finance API Request** (Code) — assembles the exact `CreateExpenseAutomatedDto` (`eyan-ai-platform` `finance-automation.dto.ts`): `amount` as a **string** (never a number — money stays a string to the Prisma `Decimal` boundary), the real `category`, `source: {channel, externalUserId, externalMessageId?}`, `isRecurring: true` only when the model explicitly detected it (omitted otherwise — absence means "not recurring" to the API), `workflowExecutionId` forwarded **unchanged** from the original request, `workflowName: "10-handle-create-expense"` (this workflow's own slug, not the front door's — see Idempotency).
9. **Call Finance Service - Create Expense** (`httpRequest`, `onError: continueRegularOutput`) — `POST {{ $env.EYAN_API_BASE_URL }}/finance/service/expenses`, `authentication: genericCredentialType` / `httpHeaderAuth`, reusing the existing **"EYAN Service API"** credential (`HkpCn7QOHOauRVq1`) unchanged — no new secret, per ADR-0024 Decision 1.
10. **Validate Finance API Response** (Code, terminal) — maps the API's `{success, message, data}` (or `{success:false, errors}` / `$json.error`) onto the Response Contract: a real created expense → `status: "success"` with a message built from the actual returned amount/category; a replay (`data.replayed === true`) → still `status: "success"`, not a duplicate or an error; any failure (network, 400 validation, 401/500) → `status: "error"` with a safe, generic message — never raw HTTP/validator/Ollama internals.

---

# Integrations

- **Ollama** (local, `$env.OLLAMA_BASE_URL` = `http://host.docker.internal:11434`, no credential — same reachability path ADR-0007 established) — backs expense-field extraction via a direct `httpRequest` call, **not** the LangChain Agent/`outputParserStructured` mechanism `02-finance-intent-router.json` uses. See `docs/adrs/ADR-0011-finance-handler-ai-extraction-approach.md` for why.
- **Eyan Finance Service API** (`POST {{ $env.EYAN_API_BASE_URL }}/finance/service/expenses`) — the authoritative contract lives in `eyan-ai-platform` (`docs/architecture/decisions/ADR-0024-finance-automation-service-contract.md`, `backend/src/dto/finance-automation.dto.ts`, `backend/src/validators/finance-automation.validator.ts`), not duplicated here beyond what this doc's Workflow Steps describe.

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
  "data": { "id": "expense-1", "date": "2026-08-10T00:00:00.000Z", "amount": "12.50", "category": "FOOD", "paymentMethod": null, "description": "lunch" },
  "clarifyingQuestion": null
}
```

Returned to whichever caller invoked this workflow — today, the Router's `Execute Handler - CREATE_EXPENSE` node, which relays it unchanged (`Return Handler Response`) back to the original front door.

---

# Idempotency

`workflowExecutionId` is **received** from the Router (which received it unchanged from the original front door) and **forwarded unchanged** into the Finance API request body — never regenerated via `$execution.id` at this hop. This is the exact discipline `docs/workflows/finance-inbox-contract.md`'s "Generating `workflowExecutionId`" section requires: the Eyan Finance Service API's idempotency check (`eyan-ai-platform` ADR-0024 Decision 5, `WorkflowExecutionLog`) is keyed on this value, and a replayed/retried message would silently stop being deduplicated if any hop regenerated it. `workflowName` in the Finance API request identifies **this workflow** (`"10-handle-create-expense"`), not the original front door's slug — matching the same per-hop-self-naming convention `workflows/crm/03-ai-qualification.json`'s `Call AI Core` node already established (only `workflowExecutionId` is the one constant thread across every hop).

---

# Error Handling

- **Invalid/missing input** (malformed contract, or missing `externalUserId`) → `status: "error"`, before any AI call is made.
- **AI extraction failure** (Ollama unreachable, or its response isn't parseable JSON) → `status: "error"`, generic safe message — never Ollama internals.
- **Ambiguous information requiring clarification** (amount or category could not be confidently determined) → `status: "clarify"`, a real, specific `clarifyingQuestion` — amount and category are never guessed or defaulted; see Constraints.
- **Finance API validation/business error** (400, or `success: false`) → `status: "error"`, generic safe message — never the raw `express-validator` error array.
- **Finance API unavailable/error** (network failure, timeout, 401/500) → `status: "error"`, generic safe message — never stack traces, HTTP internals, or credential/URL detail.
- **Successful expense creation** (including an idempotent replay) → `status: "success"`.
- No retry logic exists in this workflow, matching every other workflow in this repo's stated posture — a single attempt per step, degrading gracefully on failure.

---

# Constraints

- **Never invents an amount.** `Validate Expense Extraction` only accepts a real, positive numeric value the model actually extracted; a missing/zero/negative amount always routes to `clarify`, never a default.
- **Never guesses a category.** Only a real `ExpenseCategory` enum value (`HOUSING, FOOD, UTILITIES, TRANSPORTATION, SHOPPING, MEDICAL, CREDIT_CARD, SAVINGS, TAX, OTHERS` — the actual backend enum, not a local invention) is accepted; anything else routes to `clarify`, listing the real values.
- **Never invents fields the Finance API doesn't have.** `currency` and `merchant`/`payee` are not extracted as separate fields — the authoritative `CreateExpenseAutomatedDto` has no field for either; a merchant mention folds into `description`. See `workflows/finance/prompts/expense-extraction.v3.md`'s own note.
- **`date` defaults to this workflow's own execution date** when not mentioned or unparseable — the Finance Inbox Contract deliberately excludes any message-received timestamp (ADR-0008 Decision 4), and defaulting an undated casual mention to "today" is the ordinary reading of the message, not the same class of invented data the amount/category rules guard against.
- **`isRecurring` (v2) defaults to `false` and is only ever `true` on a literal boolean `true` from the model** — never guessed, matching the amount/category posture; unlike amount/category, a missing/ambiguous `isRecurring` never blocks the expense (recurring-vs-one-time is not required information the way amount/category are).
- **`externalUserId` is required by this Handler**, though nullable in the shared Inbox Contract — see Inputs.

---

# Security

Authentication: none inbound (Execute Workflow Trigger, called only by another workflow in the same n8n instance).

Secrets Used: the existing **"EYAN Service API"** credential (`HkpCn7QOHOauRVq1`), reused unchanged — no new secret, per ADR-0024 Decision 1 / `docs/security/credential-management.md`'s reuse rule. Ollama requires no credential (no auth locally, same as `02-finance-intent-router.json`'s own Ollama integration).

Sensitive Data: `rawText` is sent to the local Ollama instance for extraction (stays on the host, never leaves the Docker network — same posture as the Router) and the extracted expense fields are sent to the Eyan Finance Service API over the existing authenticated service channel.

---

# Testing

**A real, pre-existing bug was found and fixed during this phase's live-validation pass, before any live execution was attempted**: `Prepare Expense Extraction Input`'s embedded prompt (inside a JS template literal, `` const systemPrompt = `...`; ``) wrapped `${today}` in inline single backticks twice (`` use `${today}` ``) — valid Markdown in the reference `.md` file, but a genuine JavaScript `SyntaxError` once embedded literally inside a template literal (an unescaped backtick closes the literal rather than nesting, leaving a bare `${today}` outside any string). `node --check` on the extracted `jsCode` confirmed the parse failure directly. **This node would have thrown the first time it actually ran in n8n** — logic-only tests using `new Function(jsCode)` on a single node at a time never exercised every node's syntax together, and this exact node had no dedicated syntax-only test prior to this phase. Fixed by removing the decorative backticks (they added no functional value for the model) in both the workflow JSON and `expense-extraction.v2.md`; a new structural test (`tests/workflows/finance/10-handle-create-expense.logic.test.js`, "jsCode is syntactically valid JavaScript") now compiles every Code node's `jsCode` via `vm.Script` and would catch a regression of this exact class immediately, for any node, not just this one.

**Logic tests** (`tests/workflows/finance/10-handle-create-expense.logic.test.js`, 141 assertions, 140 passing — `node tests/workflows/finance/10-handle-create-expense.logic.test.js`), covering: syntax validity of every Code node (see above); input validation (including the Handler-specific `externalUserId` rule); extraction-prompt construction; valid/ambiguous/invalid extraction outcomes including explicit missing-category (distinct from invalid-category), malformed non-numeric amount (distinct from missing/zero amount), optional description genuinely optional, optional payment method both dropped-when-invalid and passed-through-when-valid, and `isRecurring` (explicit true, explicit false, absent-default, non-boolean-value-default) — the last of these a v2 addition, see Constraints; category/payment-method enum enforcement; date defaulting; Finance API request body construction (string `amount`, `workflowExecutionId` forwarding, `source` envelope, `isRecurring` included only when `true`); Finance API response mapping (success, replay, validation error, network error); Response Contract shape on every terminal outcome; and structural checks (workflow id, no `$execution.id` usage, no hardcoded credentials, exactly the two expected `httpRequest` nodes, the Router's dispatch node already pointing at this workflow's id). **The one failing assertion** (`git diff --stat` showing `02-finance-intent-router.json` as unmodified) is a pre-existing environmental check against an unrelated, already-completed, already-reported phase of this project (Phase 2.6's Router fix, ADR-0012) being uncommitted in this working tree — not a defect in this Handler; re-run after that phase is committed to confirm it passes.

**Live n8n validation against the real, running n8n 2.33.3 instance:**

1. `n8n import:workflow` — succeeds.
2. `n8n export:workflow` — round-trips **byte-for-byte** (`id`/`name`/`nodes`/`connections`/`settings`), confirmed by diffing the exported JSON against the committed file.
3. **A real live execution end-to-end against the deployed Finance Service API** (`https://eyan.fyi/api/v1/finance/service/expenses`, reachability and the "EYAN Service API" credential's real bearer token independently confirmed first via a safe read-only `GET /finance/service/categories` call from inside the `eyan-n8n` container), using a clearly-marked, low-value test message (`workflowExecutionId: "phase3a-live-test-0001"`, `rawText: "PHASE3A_LIVE_TEST: spent $0.01 on a test lunch, paid by cash"`, temporarily hardcoded into a throwaway copy of `Validate Handler Input`'s `jsCode` for this run only — the same technique Phase 1/2 established, since `n8n execute` does not honor `pinData` on an Execute Workflow Trigger; nothing about this technique was committed):
   - **First attempt**: the Ollama extraction call (`Call Ollama - Extract Expense`) hit its 90-second timeout (`AxiosError: timeout of 90000ms exceeded`). The workflow degraded exactly as designed — no crash, `extraction_failed`, a safe generic `status: "error"` response — a real, unplanned proof of the timeout-handling path, not a hand-constructed mock.
   - **Second attempt (retry)**: Ollama responded in 30.8s (`load_duration: 121ms`, confirming the model was already warm the second time — the first timeout looks like a one-off cold-start/contention delay, not a structural problem) with a fully correct extraction: `{"amount": 0.01, "category": "FOOD", "paymentMethod": "CASH", "date": "2026-08-10", "description": "test lunch", "isRecurring": false}` — every field correct, including `isRecurring` correctly defaulting to `false` (never mentioned in the message). `Build Finance API Request` correctly omitted `isRecurring` from the outbound body (since it was `false`). The real `POST /finance/service/expenses` call succeeded in 1.3s: `{"success":true,"data":{"replayed":false,"id":"cmsnhkava000b82krt0c9unlv","date":"2026-08-10T00:00:00.000Z","amount":"0.01","category":"FOOD","paymentMethod":"CASH","description":"test lunch",...}}` — **a real row was created in the Finance database** (see Notes below for cleanup). `Validate Finance API Response` correctly produced `{"status":"success","intent":"CREATE_EXPENSE","message":"Logged $0.01 to FOOD.","data":{"id":"cmsnhkava000b82krt0c9unlv",...},"clarifyingQuestion":null}`, matching the Response Contract exactly, with `workflowExecutionId: "phase3a-live-test-0001"` preserved unchanged from the original request through every hop.
   - **Third attempt (replay, same `workflowExecutionId`)**: re-executing with the identical `workflowExecutionId` returned `{"success":true,"message":"Expense already recorded for this workflow execution.","data":{"replayed":true,"workflowExecutionId":"phase3a-live-test-0001"}}` from the real backend — **no second expense row was created** — correctly mapped by `Validate Finance API Response` to `{"status":"success","message":"This expense was already logged -- no duplicate created.","data":{"replayed":true}}`. This is a real, live, end-to-end proof that the Finance API's own idempotency mechanism (keyed on `workflowExecutionId`) works correctly through this Handler, and that this Handler introduces no idempotency mechanism of its own — it relies entirely on the backend's existing `WorkflowExecutionLogRepository` check.

**Note on the live test row**: expense `id: cmsnhkava000b82krt0c9unlv`, amount `$0.01`, category `FOOD`, `createdBy: "slack:U0PHASE3ATEST"`, created `2026-08-10T17:08:58.248Z` — real, in the Finance database, clearly identifiable by its trivial amount and `PHASE3A_LIVE_TEST` provenance. Not deleted by this phase (no delete endpoint exists on the automation surface, and deleting via the human-facing API was out of this phase's scope) — flagged here for whoever wants to clean it up.

**Not exercised this phase** (explicitly, not silently assumed done): a live Finance API *failure* response (400 validation error, 401/500) was not observed live, since this Handler's own validation structurally prevents ever sending a request the Finance API would reject on category/amount grounds — that boundary is unit-tested (tests #24, #23) rather than live-tested, since there is no way to *reach* it live through this Handler's own guarantees without bypassing the Handler itself. A live network-outage/500 scenario was likewise not manufactured against the real deployed backend.

---

# Related Documentation

Architecture: the AI Finance Inbox implementation plan — this workflow implements Phase 3A, the first Finance intent Handler.

ADR: `docs/adrs/ADR-0008-finance-inbox-workflow-contract.md` (the contract this Handler implements), `docs/adrs/ADR-0011-finance-handler-ai-extraction-approach.md` (why this Handler's AI extraction uses a direct `httpRequest` call rather than the Router's own LangChain Agent mechanism), `docs/adrs/ADR-0009-finance-intent-router-model-selection.md` (the diagnosis ADR-0011 is built on), `docs/adrs/ADR-0007-n8n-ollama-connectivity-gap.md`, `eyan-ai-platform` `docs/architecture/decisions/ADR-0024-finance-automation-service-contract.md` (the backend contract this Handler's Finance API call implements).

Workflows: `docs/workflows/02-finance-intent-router.md` (this workflow's only caller today), `docs/workflows/finance-inbox-contract.md` (the contract this workflow both consumes and produces).

Issue: n/a — the remaining seven Finance intent Handlers (`GET_BUDGET`, `GET_DASHBOARD`, `GET_FINANCE_QUESTION`, `CREATE_INCOME`, `CREATE_TRANSFER`, `UPLOAD_RECEIPT`, `UNRECOGNIZED`) are explicitly out of scope for Phase 3A.
