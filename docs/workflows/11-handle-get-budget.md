# Finance - 11 - Handle Get Budget

Status: Active (imported; live-validated end-to-end via real WhatsApp against the real Finance Service API)

Category: Finance

Owner: Automation Hub

Version: 1.0

---

# Purpose

The second Finance Intent Handler, and the target of `02-finance-intent-router.json`'s forward-referenced `Execute Handler - GET_BUDGET` node (`workflowId: "FinanceHandlerGetBudgetWf01"`). Receives a channel-agnostic Finance Inbox Request already classified as `GET_BUDGET`, retrieves the current period's budget and spending data from the Eyan Finance Service API, formats it into a human-readable message, and returns the Finance Inbox Response Contract. Unlike `10-handle-create-expense.json`, this Handler does **no AI extraction and no field-completeness ambiguity handling** — it is a pure read, not a write, and needs nothing from `rawText` beyond having been classified `GET_BUDGET` in the first place.

---

# Trigger

- Execute Workflow Trigger (`inputSource: passthrough`) — called by `02-finance-intent-router.json`'s `Execute Handler - GET_BUDGET` node today; any future caller invokes it identically.

---

# Inputs

The Finance Inbox Request Contract (`docs/adrs/ADR-0008-finance-inbox-workflow-contract.md` Decision 1, `docs/workflows/finance-inbox-contract.md`) — unchanged from what the Router receives and forwards:

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `contractVersion` | string | Yes | `"1"` today. |
| `workflowExecutionId` | string | Yes | Forwarded unchanged through the Router to this Handler. Not used for idempotency here (this Handler never writes), but preserved and echoed back per the Response Contract regardless. |
| `workflowName` | string | Yes | The original front door's slug. |
| `channel` | string | Yes | `slack` \| `telegram` \| `whatsapp` \| `retell` \| `web-chat` \| `ocr`. |
| `externalUserId` | string \| null | Yes (nullable) | **Not required by this Handler** (unlike `10-handle-create-expense.json`) — budget/spending data is org-wide, not per-user (`FinanceDashboardService` has no per-user scoping), so there is nothing to attribute a read to. |
| `externalMessageId` | string \| null | Yes (nullable) | Unused by this Handler. |
| `rawText` | string | Yes | Unused beyond contract validation — no field extraction happens here (see Constraints). |
| `attachments` | array | Yes (may be empty) | Unused. |

---

# Workflow Steps

1. **When Called by Another Workflow** (Execute Workflow Trigger, `inputSource: passthrough`) — receives the Request contract unchanged.
2. **Validate Handler Input** (Code) — re-validates the contract shape defensively (this workflow could be called directly by a future caller). Adds no Handler-specific requirement — `externalUserId` may be `null`, unlike `10-handle-create-expense.json`.
3. **Handler Input Valid?** (IF) — `false` → **Build Invalid Input Response** (terminal, `status: "error"`, `intent: "GET_BUDGET"`); `true` → continue.
4. **Call Finance Service - Get Dashboard** (`httpRequest`, `onError: continueRegularOutput`) — `GET {{ $env.EYAN_API_BASE_URL }}/finance/service/dashboard`, no query parameters (see Constraints: no `period` extraction). `authentication: genericCredentialType` / `httpHeaderAuth`, reusing the existing **"EYAN Service API"** credential (`HkpCn7QOHOauRVq1`) unchanged — no new secret.
5. **Validate Finance API Response** (Code, terminal) — maps the dashboard response's `data.budget`/`data.totalExpenses`/`data.remainingBudget`/`data.period` fields onto the Response Contract: a real configured budget → `status: "success"` with a message stating amount spent, budget limit, and amount left (or amount over budget, if `remainingBudget` is negative); no budget configured for the period → still `status: "success"`, stating that fact plus spending so far (not an error — this is a real, knowable state, not ambiguity); any API/network failure → `status: "error"` with a safe, generic message.

---

# Integrations

- **Eyan Finance Service API** (`GET {{ $env.EYAN_API_BASE_URL }}/finance/service/dashboard`) — the same endpoint `docs/adrs/ADR-0008-finance-inbox-workflow-contract.md`'s `GET_DASHBOARD` intent forward-references (`FinanceHandlerGetDashboardWf01`, not yet built). This Handler is a **second caller** of that one endpoint, reading a strict subset of its response (`budget`, `totalExpenses`, `remainingBudget`, `period`) and ignoring the rest (`categoryBreakdown`, `spendingTrend`, `recentExpenses`) — those belong to `GET_DASHBOARD`, not `GET_BUDGET`. No new backend endpoint was built for this Handler; see Constraints for why.

---

# Outputs

The Finance Inbox Response Contract (`docs/adrs/ADR-0008-finance-inbox-workflow-contract.md` Decision 2):

```json
{
  "contractVersion": "1",
  "workflowExecutionId": "exec-1",
  "status": "success",
  "intent": "GET_BUDGET",
  "message": "You've spent $142.30 of your $500.00 budget for August 2026 -- $357.70 left.",
  "data": { "period": "2026-08", "monthlyLimit": "500.00", "totalExpenses": "142.30", "remainingBudget": "357.70" },
  "clarifyingQuestion": null
}
```

Returned to whichever caller invoked this workflow — today, the Router's `Execute Handler - GET_BUDGET` node, which relays it unchanged (`Return Handler Response`) back to the original front door.

---

# Idempotency

Not applicable — this Handler performs no writes. `workflowExecutionId` is still forwarded unchanged and echoed in the Response Contract (per contract, every response carries it), but no idempotency mechanism is needed or invoked, unlike `10-handle-create-expense.json`.

---

# Error Handling

- **Invalid/missing input** (malformed contract) → `status: "error"`, before any Finance API call is made.
- **Finance API call failure** (network, timeout, 401/500) → `status: "error"`, generic safe message — never raw HTTP internals.
- **Finance API responded with an unexpected/failure shape** (`success: false`, missing `data`) → `status: "error"`, generic safe message — never the raw response body.
- **No budget configured for the current period** → **not an error** — `status: "success"` with a message stating that fact and current spending. This is a real, answerable state, not a system failure or user ambiguity.
- **Overspent** (`remainingBudget` negative) → **not an error** — `status: "success"` with a message stating the overage.
- No retry logic exists in this workflow, matching every other workflow in this repo's stated posture.

---

# Constraints

- **No AI extraction of any kind.** This Handler makes zero calls to AI Core or Ollama — it is a pure data-retrieval operation, per this phase's explicit scope. `rawText` is validated for contract shape only, never parsed for a `period` or anything else.
- **No `period` extraction from `rawText`.** Every call always asks for the *current* period — `GET /finance/service/dashboard` with no `period` query parameter, which the backend defaults to `currentPeriod()` (`eyan-ai-platform` `finance-dashboard.service.ts`). The Intent Catalog's `period?` field (`docs/workflows/finance-inbox-contract.md`) is deliberately not implemented in this phase — the target WhatsApp message ("How much is left in my budget this month?") always means the current month, and adding period parsing without a real caller asking for a past/future period would be exactly the kind of speculative surface this platform's standards warn against.
- **No dedicated `/finance/service/budget` endpoint exists, by design.** `eyan-ai-platform`'s `docs/architecture/decisions/ADR-0024-finance-automation-service-contract.md` (Decision 2 / Alternatives) and this repo's `docs/adrs/ADR-0008-finance-inbox-workflow-contract.md` (Decision 3) both explicitly decided `GET_DASHBOARD`'s existing `budget`/`remainingBudget` fields are sufficient for `GET_BUDGET`, and rejected building a budget-only route as premature. This Handler follows that decision exactly rather than inventing a new contract.
- **Never computes budget arithmetic itself.** `remainingBudget` is a Decimal-safe server-side calculation (`FinanceDashboardService.getDashboard()`, `budgetRaw.monthlyLimit.minus(totalExpenses)`); this Handler only formats the string the API already returns, never re-derives it in JavaScript float arithmetic.
- **Read-only, no mutation.** Contains zero `POST`/`PUT`/`DELETE` calls — a single `GET` request, verified structurally (see Testing).

---

# Security

Authentication: none inbound (Execute Workflow Trigger, called only by another workflow in the same n8n instance).

Secrets Used: the existing **"EYAN Service API"** credential (`HkpCn7QOHOauRVq1`), reused unchanged — no new secret.

Sensitive Data: none beyond what the Finance API call itself carries (an authenticated service-to-service request); no user message content is sent anywhere.

---

# Testing

**Logic tests** (`tests/workflows/finance/11-handle-get-budget.logic.test.js`, 49 assertions, all passing — `node tests/workflows/finance/11-handle-get-budget.logic.test.js`), covering: syntax validity of every Code node; structural checks (workflow id matches the Router's forward reference, exactly one `httpRequest` node and it is a `GET` against `/finance/service/dashboard`, reuses the existing credential, degrades gracefully on failure, no `$execution` usage, no hardcoded URL); input validation (including that `externalUserId` is *not* required, unlike `10-handle-create-expense.json`); Response Contract shape on Handler-level rejection; dashboard-response mapping for under-budget, over-budget, and no-budget-configured cases (message wording, real amounts threaded through, human month name); and Finance API failure handling (network error, `success: false`, empty response) — always a safe generic message, never raw internals.

**Live n8n validation against the real, running n8n 2.33.3 instance:**

1. `n8n import:workflow` — succeeds.
2. Real WhatsApp test: `"How much is left in my budget this month?"` sent through the live WhatsApp Gateway → Finance WhatsApp Entry → Finance Intent Router → this Handler → real `GET /finance/service/dashboard` call → WhatsApp reply. See the sprint verification report for the exact request/response captured.

---

# Related Documentation

Architecture: the AI Finance Inbox implementation plan — this workflow implements the second Finance intent Handler.

ADR: `docs/adrs/ADR-0008-finance-inbox-workflow-contract.md` (the contract this Handler implements, and Decision 3's explicit "satisfy `GET_BUDGET` via `GET_DASHBOARD`" ruling), `eyan-ai-platform` `docs/architecture/decisions/ADR-0024-finance-automation-service-contract.md` (the backend contract this Handler's Finance API call implements, and the Alternatives section rejecting a dedicated `/budget` automation route).

Workflows: `docs/workflows/02-finance-intent-router.md` (this workflow's only caller today), `docs/workflows/finance-inbox-contract.md` (the contract this workflow both consumes and produces), `docs/workflows/10-handle-create-expense.md` (the sibling Handler this workflow's structure follows, minus AI extraction).

Issue: n/a — the remaining six Finance intent Handlers (`GET_DASHBOARD`, `GET_FINANCE_QUESTION`, `CREATE_INCOME`, `CREATE_TRANSFER`, `UPLOAD_RECEIPT`, `UNRECOGNIZED`) are explicitly out of scope for this phase.
