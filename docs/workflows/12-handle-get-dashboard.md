# Finance - 12 - Handle Get Dashboard

Status: Active (imported; live-validated end-to-end via real WhatsApp against the real Finance Service API)

Category: Finance

Owner: Automation Hub

Version: 1.0

---

# Purpose

The third Finance Intent Handler, and the target of `02-finance-intent-router.json`'s forward-referenced `Execute Handler - GET_DASHBOARD` node (`workflowId: "FinanceHandlerGetDashboardWf01"`). Receives a channel-agnostic Finance Inbox Request already classified as `GET_DASHBOARD`, retrieves the current period's full spending summary from the Eyan Finance Service API, formats it into a human-readable message, and returns the Finance Inbox Response Contract. Structurally identical to `11-handle-get-budget.json` through `Validate Handler Input`/`Handler Input Valid?`/the HTTP call — the only difference is `Validate Finance API Response` surfaces the **full** dashboard payload (category breakdown, recent expenses, spending trend) rather than only `budget`/`remainingBudget`. Like `11-handle-get-budget.json`, this Handler does no AI extraction and no field-completeness ambiguity handling — it is a pure read.

---

# Trigger

- Execute Workflow Trigger (`inputSource: passthrough`) — called by `02-finance-intent-router.json`'s `Execute Handler - GET_DASHBOARD` node today; any future caller invokes it identically.

---

# Inputs

The Finance Inbox Request Contract (`docs/adrs/ADR-0008-finance-inbox-workflow-contract.md` Decision 1, `docs/workflows/finance-inbox-contract.md`) — unchanged from what the Router receives and forwards. Same field table as `docs/workflows/11-handle-get-budget.md`'s Inputs section — `externalUserId` is not required by this Handler either, for the same reason (no per-user scoping on dashboard data).

---

# Workflow Steps

1. **When Called by Another Workflow** (Execute Workflow Trigger, `inputSource: passthrough`) — receives the Request contract unchanged.
2. **Validate Handler Input** (Code) — re-validates the contract shape defensively; identical to `11-handle-get-budget.json`'s own node of the same name.
3. **Handler Input Valid?** (IF) — `false` → **Build Invalid Input Response** (terminal, `status: "error"`, `intent: "GET_DASHBOARD"`); `true` → continue.
4. **Call Finance Service - Get Dashboard** (`httpRequest`, `onError: continueRegularOutput`) — `GET {{ $env.EYAN_API_BASE_URL }}/finance/service/dashboard`, no query parameters (always the current period, same reasoning as `11-handle-get-budget.json`). Reuses the existing **"EYAN Service API"** credential (`HkpCn7QOHOauRVq1`) — the exact same HTTP call `11-handle-get-budget.json` makes; this Handler is a second, independent caller of the same endpoint.
5. **Validate Finance API Response** (Code, terminal) — maps the full dashboard response onto the Response Contract: `message` is a multi-line human summary (period, budget/spent/remaining line, a `By category:` section when non-empty, a `Recent expenses:` section when non-empty); `data` carries the full payload (`period`, `budget`, `totalExpenses`, `remainingBudget`, `categoryBreakdown`, `spendingTrend`, `recentExpenses`) for a future front door that wants richer rendering. Any API/network failure → `status: "error"` with a safe, generic message.

---

# Integrations

- **Eyan Finance Service API** (`GET {{ $env.EYAN_API_BASE_URL }}/finance/service/dashboard`) — the same endpoint `11-handle-get-budget.json` calls. `eyan-ai-platform`'s `docs/architecture/decisions/ADR-0024-finance-automation-service-contract.md` built this one endpoint sufficient for both intents rather than two separate routes (Decision 2 / Alternatives).

---

# Outputs

The Finance Inbox Response Contract (`docs/adrs/ADR-0008-finance-inbox-workflow-contract.md` Decision 2):

```json
{
  "contractVersion": "1",
  "workflowExecutionId": "exec-1",
  "status": "success",
  "intent": "GET_DASHBOARD",
  "message": "Dashboard for August 2026:\nSpent $726.72 of your $1500.00 budget -- $773.28 left.\nBy category:\n- HOUSING: $650.00\n- FOOD: $76.72\nRecent expenses:\n- $8.00 FOOD -- cafe\n- $68.70 FOOD -- Mercadona for groceries",
  "data": {
    "period": "2026-08",
    "budget": { "id": "...", "period": "2026-08", "monthlyLimit": "1500.00" },
    "totalExpenses": "726.72",
    "remainingBudget": "773.28",
    "categoryBreakdown": [{ "category": "HOUSING", "total": "650.00" }, { "category": "FOOD", "total": "76.72" }],
    "spendingTrend": [{ "period": "2026-03", "total": "0.00" }, "..."],
    "recentExpenses": ["..."]
  },
  "clarifyingQuestion": null
}
```

Returned to whichever caller invoked this workflow — today, the Router's `Execute Handler - GET_DASHBOARD` node, which relays it unchanged (`Return Handler Response`) back to the original front door.

---

# Idempotency

Not applicable — this Handler performs no writes, same posture as `11-handle-get-budget.json`.

---

# Error Handling

Same posture as `11-handle-get-budget.json`: invalid input and Finance API failures both map to `status: "error"` with a safe generic message; no budget configured and being overspent are both real, answerable states (`status: "success"`), not errors.

---

# Constraints

- **No AI extraction of any kind** — zero calls to AI Core or Ollama, same as `11-handle-get-budget.json`.
- **No `period` extraction from `rawText`** — always the current period, for the same reason `11-handle-get-budget.json` documents.
- **`message` deliberately omits `spendingTrend`.** The full 6-month trend array is still returned in `data` (for a future richer front door), but a text list of mostly-zero historical months does not answer "show me my spending dashboard for this month" as directly as the current period's own numbers, and rendering a trend judgment ("spending is up/down") would be a business decision this node does not make. Category breakdown and recent expenses ARE included in `message` since they directly answer the dashboard question.
- **Never re-derives any number.** `totalExpenses`, `remainingBudget`, and every `categoryBreakdown`/`spendingTrend` total are Decimal-safe server-side calculations (`FinanceDashboardService`); this Handler only formats the strings already returned, never re-computes in JavaScript float arithmetic.
- **Read-only, no mutation.** A single `GET` request — verified structurally (see Testing), same as `11-handle-get-budget.json`.
- **No new backend endpoint.** Reuses `GET /finance/service/dashboard` exactly as `11-handle-get-budget.json` does — no schema or API change was needed, since ADR-0024 already built this endpoint's response shape to cover both intents.

---

# Security

Authentication: none inbound (Execute Workflow Trigger, called only by another workflow in the same n8n instance).

Secrets Used: the existing **"EYAN Service API"** credential (`HkpCn7QOHOauRVq1`), reused unchanged — no new secret.

Sensitive Data: none beyond the Finance API call itself; no user message content is sent anywhere.

---

# Testing

**Logic tests** (`tests/workflows/finance/12-handle-get-dashboard.logic.test.js`, 48 assertions, all passing — `node tests/workflows/finance/12-handle-get-dashboard.logic.test.js`), covering: syntax validity of every Code node; structural checks (workflow id matches the Router's forward reference, exactly one `httpRequest` node and it is a `GET` against `/finance/service/dashboard`, reuses the existing credential, degrades gracefully on failure, no `$execution` usage); input validation (`externalUserId` not required); Response Contract shape on Handler-level rejection; dashboard-response mapping for under-budget, over-budget, no-budget-configured, and empty-breakdown/empty-recent-expenses cases (correct message wording, `spendingTrend` deliberately excluded from `message` but present in `data`, no dangling section headers when a section is empty); and Finance API failure handling (network error, `success: false`) — always a safe generic message, never raw internals.

**Live n8n validation against the real, running n8n 2.33.3 instance:**

1. `n8n import:workflow` — succeeds.
2. Real WhatsApp test: `"Show me my spending dashboard for this month."` sent through the live WhatsApp Gateway → Finance WhatsApp Entry → Finance Intent Router → this Handler → real `GET /finance/service/dashboard` call → WhatsApp reply. See the sprint verification report for the exact request/response captured.

---

# Related Documentation

Architecture: the AI Finance Inbox implementation plan — this workflow implements the third Finance intent Handler.

ADR: `docs/adrs/ADR-0008-finance-inbox-workflow-contract.md` (the contract this Handler implements), `eyan-ai-platform` `docs/architecture/decisions/ADR-0024-finance-automation-service-contract.md` (the backend contract this Handler's Finance API call implements).

Workflows: `docs/workflows/02-finance-intent-router.md` (this workflow's only caller today), `docs/workflows/finance-inbox-contract.md` (the contract this workflow both consumes and produces), `docs/workflows/11-handle-get-budget.md` (the sibling Handler this workflow's structure is identical to, minus the response-formatting node).

Issue: n/a — the remaining five Finance intent Handlers (`GET_FINANCE_QUESTION`, `CREATE_INCOME`, `CREATE_TRANSFER`, `UPLOAD_RECEIPT`, `UNRECOGNIZED`) are explicitly out of scope for this phase.
