# Finance - 13 - Handle Get Finance Question

Status: Active (imported; live-validated end-to-end via real WhatsApp against the real Finance Service API and the real AI Core `finance-question` capability)

Category: Finance

Owner: Automation Hub

Version: 1.0

---

# Purpose

The fourth Finance Intent Handler, and the target of `02-finance-intent-router.json`'s forward-referenced `Execute Handler - GET_FINANCE_QUESTION` node (`workflowId: "FinanceHandlerGetFinanceQuestionWf01"`). Receives a channel-agnostic Finance Inbox Request already classified as `GET_FINANCE_QUESTION`, fetches the current period's real dashboard data, and delegates answering the user's open-ended natural-language question to AI Core's new `finance-question` capability -- grounded strictly in that fetched data. Unlike `10-handle-create-expense.json`, this Handler never asks AI Core to extract or parse structured fields (no `expectJson: true`, no JSON schema) -- the model's plain-text answer *is* the Response Contract's `message`, verbatim.

---

# Trigger

- Execute Workflow Trigger (`inputSource: passthrough`) -- called by `02-finance-intent-router.json`'s `Execute Handler - GET_FINANCE_QUESTION` node today; any future caller invokes it identically.

---

# Inputs

The Finance Inbox Request Contract (`docs/adrs/ADR-0008-finance-inbox-workflow-contract.md` Decision 1, `docs/workflows/finance-inbox-contract.md`) -- unchanged from what the Router receives and forwards. Same posture as `11-handle-get-budget.md`/`12-handle-get-dashboard.md`'s Inputs section (`externalUserId` not required -- no per-user scoping on dashboard data), with one addition: `rawText` must be a real, non-empty string -- this Handler's entire job is interpreting it, so an empty question is rejected before any downstream call is made.

---

# Workflow Steps

1. **When Called by Another Workflow** (Execute Workflow Trigger, `inputSource: passthrough`) -- receives the Request contract unchanged.
2. **Validate Handler Input** (Code) -- re-validates the contract shape defensively, plus the one Handler-specific rule: `rawText` must be non-empty.
3. **Handler Input Valid?** (IF) -- `false` -> **Build Invalid Input Response** (terminal, `status: "error"`, `intent: "GET_FINANCE_QUESTION"`); `true` -> continue.
4. **Call Finance Service - Get Dashboard** (`httpRequest`, `onError: continueRegularOutput`) -- `GET {{ $env.EYAN_API_BASE_URL }}/finance/service/dashboard`, no query parameters (always the current period, same reasoning as `11-handle-get-budget.json`/`12-handle-get-dashboard.json`). The same endpoint both sibling Handlers already call -- this is a third, independent caller.
5. **Validate Dashboard Response** (Code) -- gates on whether the fetch succeeded, producing `dashboardOutcome: 'valid' | 'failed'`. The two-call shape (Finance Service, then AI Core) needed an explicit gate here that GET_BUDGET/GET_DASHBOARD's single-call Handlers didn't need -- the AI Core call must never run without real dashboard data to ground it.
6. **Dashboard Fetched?** (IF) -- `false` -> **Build Dashboard Failure Response** (terminal, `status: "error"`); `true` -> continue.
7. **Prepare Finance Question Input** (Code) -- builds the AI Core `finance-question` capability's invoke() request body: `input.question` is `rawText` forwarded **verbatim** (no category/comparison/spending-intent pre-parsing in n8n -- that interpretation is entirely AI Core's job); `input.dashboard` is the exact, unmodified dashboard payload from step 5; `context.expectJson: false` (the plain-text response path, not structured JSON).
8. **Call AI Core - Answer Finance Question** (`httpRequest`, `onError: continueRegularOutput`) -- `POST {{ $env.EYAN_API_BASE_URL }}/ai-core/service/capabilities/finance-question/invoke`, reusing the existing **"EYAN Service API"** credential (`HkpCn7QOHOauRVq1`) -- no new secret. 300s timeout, matching every other AI Core call in this domain.
9. **Validate Finance Question Answer** (Code, terminal) -- reads `result.data.output` (plain text, since `expectJson` was `false` -- never `result.data.outputJson`), trims it, and uses it as `message` verbatim. Any AI Core failure, non-`VALID` outcome, or blank answer -> `status: "error"` with a safe generic message.

---

# Integrations

- **Eyan Finance Service API** (`GET {{ $env.EYAN_API_BASE_URL }}/finance/service/dashboard`) -- the same endpoint `11-handle-get-budget.json`/`12-handle-get-dashboard.json` call. A third, independent caller of this one endpoint.
- **AI Core `finance-question` capability** (`eyan-ai-platform`) -- new for this phase. `finance-question-brain`, prompt `v1`, routing policy pointing at the existing `ollama` provider / `mistral:7b` model (the same model `finance-intent-brain` already uses -- tagged `['chat', 'reasoning']`, the better fit for judgment-over-data than `expense-extraction-brain`'s `gemma3:4b`, tagged only `['chat']`). No new provider, model, schema, migration, route, validator, or credential -- see the seed diff in `backend/prisma/seed-ai-core.ts`'s `seedFinanceQuestionBrain()`.

---

# Outputs

The Finance Inbox Response Contract (`docs/adrs/ADR-0008-finance-inbox-workflow-contract.md` Decision 2):

```json
{
  "contractVersion": "1",
  "workflowExecutionId": "exec-1",
  "status": "success",
  "intent": "GET_FINANCE_QUESTION",
  "message": "Your spending on food this month is $76.72, which is well behind your Housing spend of $650.00. You still have $773.28 left in your $1500.00 budget for August.",
  "data": { "period": "2026-08", "question": "Am I overspending on food?" },
  "clarifyingQuestion": null
}
```

Returned to whichever caller invoked this workflow -- today, the Router's `Execute Handler - GET_FINANCE_QUESTION` node, which relays it unchanged (`Return Handler Response`) back to the original front door.

---

# Idempotency

Not applicable -- this Handler performs no writes. `workflowExecutionId` is forwarded unchanged through both downstream calls and echoed in the Response Contract, same posture as `11-handle-get-budget.json`/`12-handle-get-dashboard.json`.

---

# Error Handling

- **Invalid/missing input** (malformed contract, or empty `rawText`) -> `status: "error"`, before any downstream call is made.
- **Finance Service call failure** (network, timeout, unexpected response shape) -> `status: "error"`, generic safe message -- never reaches the AI Core call, which would have nothing real to reason over.
- **AI Core call failure** (network, timeout, non-`VALID` outcome, or a blank answer) -> `status: "error"`, generic safe message -- never raw HTTP/AI Core internals.
- **A real, answerable "I don't have that information" case** -- when the model itself determines the dashboard doesn't cover the question (e.g. a category with no expenses) -- is **not** an error from this Handler's perspective; it is `status: "success"` with the model's own honest "I don't see that in your data" answer as `message`, per the prompt's explicit instruction to say so rather than fabricate. This Handler cannot and does not distinguish that case from any other successful answer -- it is inherent in what `status: "success"` with a grounded `output.trim()` means for this Handler.
- No retry logic exists in this workflow, matching every other workflow in this repo's stated posture.

---

# Constraints

- **No n8n-side natural-language parsing.** `Prepare Finance Question Input` forwards `rawText` to AI Core verbatim as `question` -- no regex/keyword matching against category names, no comparison-operator detection, no period parsing. All interpretation happens inside the `finance-question` capability's prompt, grounded in the supplied `dashboard` JSON. Verified structurally (test: "does not reference category/comparison keyword lists").
- **No direct Ollama call.** Both `httpRequest` nodes target `$env.EYAN_API_BASE_URL` (the Eyan AI Platform / Finance Service and AI Core surfaces) -- never Ollama's own `/api/chat` endpoint. Verified structurally (test: "no Ollama URL anywhere in its parameters").
- **`expectJson: false` on the AI Core call, deliberately.** Unlike the Router's intent classification or CREATE_EXPENSE's field extraction, this task's answer is free-form natural language for a WhatsApp reply, not structured data -- forcing JSON here would risk exactly the JSON-wrapper failure modes ADR-0009/ADR-0011/ADR-0012 fought through, for no benefit (there is no schema to validate a prose answer against).
- **Grounding is a prompt-level guarantee, not a code-level one.** `Validate Finance Question Answer` cannot verify the model didn't invent a number -- it only checks the AI Core call succeeded and returned non-blank text. The `finance-question-brain` prompt (`eyan-ai-platform`) is the actual safety net: it explicitly instructs the model to answer only from the supplied `dashboard` JSON, never invent/estimate/assume a financial number, and say so plainly when the data doesn't cover the question. This is the same trust boundary every other Finance AI call in this repo already accepts for its own prompt's instructions (e.g. CREATE_EXPENSE trusts `expense-extraction-brain`'s prompt not to invent a category outside the real enum, backed by real enum validation as defense-in-depth -- this Handler has no equivalent enum to validate a prose answer against, so the prompt is the only safety net here, not defense-in-depth over a code check).
- **Read-only, no mutation.** Two `httpRequest` calls: one `GET` (Finance Service), one `POST` to AI Core's `invoke()` endpoint -- an AI reasoning call, not a Finance-domain write. Zero calls to any Finance mutation endpoint (`/expenses`, `/budget` PUT, etc.). Verified structurally (test: "no httpRequest node uses a mutation method against the Finance Service").
- **No new backend infrastructure beyond one Capability/Brain/Prompt/RoutingPolicy row set**, all created via the existing seeding pattern `seedFinanceBrains()` already established -- no schema change, no migration, no new validator, no new route, no new credential, no new provider/model (reuses the existing `ollama` provider and `mistral:7b` model rows).

---

# Security

Authentication: none inbound (Execute Workflow Trigger, called only by another workflow in the same n8n instance).

Secrets Used: the existing **"EYAN Service API"** credential (`HkpCn7QOHOauRVq1`), reused unchanged for both the Finance Service and AI Core calls -- no new secret.

Sensitive Data: the user's raw question (`rawText`) and the real dashboard data (spending amounts, categories, recent expense descriptions) are sent to AI Core's `finance-question` capability, which routes to the local `ollama`/`mistral:7b` model -- stays on the host, never leaves the Docker/local network, same posture as every other Finance AI call in this domain.

---

# Testing

**Logic tests** (`tests/workflows/finance/13-handle-get-finance-question.logic.test.js`, 65 assertions, all passing -- `node tests/workflows/finance/13-handle-get-finance-question.logic.test.js`), covering: syntax validity of every Code node; structural checks (workflow id/name, exactly two `httpRequest` nodes, the Finance Service call is a `GET` never targeting a mutation endpoint, the AI Core call targets `finance-question/invoke` with `expectJson: false`, both calls reuse the existing credential and degrade gracefully on failure, no Ollama URL anywhere, no `$execution` usage, no n8n-side category/comparison keyword parsing); input validation (empty `rawText` rejected, `externalUserId` not required); Response Contract shape on Handler-level and dashboard-fetch-failure rejection; `rawText`-forwarded-verbatim and dashboard-payload-forwarded-unmodified checks on the AI Core request body; and answer-mapping for a real grounded AI Core response (matching the live smoke-test result captured during this phase), an AI Core network failure, a non-`VALID` outcome, and a blank answer -- always a safe generic message on failure, never raw internals.

**Live verification against the real, running `eyan-ai-platform` backend** (before this workflow was ever imported into n8n): a direct `POST /ai-core/service/capabilities/finance-question/invoke` call with the question `"Am I overspending on food?"` and a real dashboard payload (period `2026-08`, `totalExpenses: "726.72"`, `remainingBudget: "773.28"`, `categoryBreakdown` including `FOOD: "76.72"`) returned `outcome: "VALID"`, `brain: "finance-question-brain"`, `model: "mistral:7b"`, `promptVersion: "v1"`, and a correctly-grounded plain-text answer citing the real `$76.72`/`$773.28`/`$1500.00` figures verbatim -- no invented numbers. Latency: 177.2s (within the 300s policy timeout). One quality note, not a grounding violation: the model's own derived percentage ("4.9%") was arithmetically imprecise -- every raw figure it cited was correct and real, but computed derivatives (percentages, comparisons) are not independently verified by this Handler; a known limitation, not a blocker.

**Live n8n validation against the real, running n8n 2.33.3 instance:**

1. `n8n import:workflow` -- succeeds.
2. Real WhatsApp test: `"Am I overspending on food?"` sent through the live WhatsApp Gateway -> Finance WhatsApp Entry -> Finance Intent Router -> this Handler -> real `GET /finance/service/dashboard` call -> real AI Core `finance-question` call -> WhatsApp reply. See the sprint verification report for the exact request/response captured.

---

# Related Documentation

Architecture: the AI Finance Inbox implementation plan -- this workflow implements the fourth Finance intent Handler, and the first to use AI Core's plain-text (`expectJson: false`) response path.

ADR: `docs/adrs/ADR-0008-finance-inbox-workflow-contract.md` (the contract this Handler implements), `docs/adrs/ADR-0014-finance-ai-core-migration.md` (the AI Core calling pattern this Handler follows), `docs/adrs/ADR-0011-finance-handler-ai-extraction-approach.md` (the prior rejection of deterministic keyword extraction for free-form Finance NL tasks, the same reasoning that ruled out n8n-side question parsing here).

Workflows: `docs/workflows/02-finance-intent-router.md` (this workflow's only caller today), `docs/workflows/finance-inbox-contract.md` (the contract this workflow both consumes and produces), `docs/workflows/11-handle-get-budget.md` / `docs/workflows/12-handle-get-dashboard.md` (the sibling Handlers this workflow's dashboard-fetch step is structurally identical to).

Issue: n/a -- the remaining four Finance intent Handlers (`CREATE_INCOME`, `CREATE_TRANSFER`, `UPLOAD_RECEIPT`, `UNRECOGNIZED`) are explicitly out of scope for this phase.
