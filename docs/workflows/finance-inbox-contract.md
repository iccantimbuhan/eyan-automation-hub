# Finance Inbox — Workflow Communication Contract

Status: Active (Phase 1.5 — contract fixed; Phase 2 — Router built; handlers not yet built)

Category: Finance

Owner: Automation Hub

Version: 1.0

---

# Purpose

Describes how every workflow in the Finance Inbox talks to every other workflow — the shared envelope every front door, the Finance Intent Router, and every intent handler must speak, regardless of channel or intent. This is the living, lookup-friendly companion to `docs/adrs/ADR-0008-finance-inbox-workflow-contract.md`, which records *why* this shape was chosen. If the two ever disagree, the ADR is authoritative and this doc is stale — update this doc, not the other way around.

Nothing in this document changes any existing workflow. `workflows/finance/01-finance-inbox-entry.json` (Phase 1) already implements the producer side of the Request contract and the consumer side of the Response contract exactly as described here.

---

# The Three Tiers

```
Front Door                    Intent Router                  Handler
(channel-specific)            (classification + routing      (one Finance capability
                                only, no business logic)       each, all business logic)

  Slack   ─┐
  Telegram ─┤                                                  ┌─ CREATE_EXPENSE handler (built)
  WhatsApp ─┼──[Request]──▶  Finance Intent Router  ──[Request]─┼─ GET_BUDGET handler (built)
  Retell   ─┤   (§ Request      (built, Phase 2 --               ├─ GET_DASHBOARD handler (built)
  Web Chat ─┤    Contract)       02-finance-intent-router.json)   ├─ GET_FINANCE_QUESTION handler (built)
  OCR      ─┘                                                    ├─ CREATE_INCOME handler (not built, stub)
                                                                  ├─ CREATE_TRANSFER handler (not built, stub)
                                                                  └─ UPLOAD_RECEIPT handler (not built)
  ◀──────────────────────[Response]──────────────────────────────────┘
       (§ Response Contract, produced by the Router directly for
        UNRECOGNIZED, or relayed from whichever handler ran)
```

Only the front-door tier knows which channel it is. Only the handler tier knows how to call the Finance API. The Router tier knows neither — it only classifies and dispatches. This is the architectural promise `docs/adrs/ADR-0008-finance-inbox-workflow-contract.md` Decision 4 exists to keep enforceable as the system grows.

---

# The Request Contract (front door → Intent Router)

Every call into the Finance Intent Router, via `Execute Workflow`, carries exactly this shape:

```json
{
  "contractVersion": "1",
  "workflowExecutionId": "n8n-execution-98421",
  "workflowName": "01-finance-inbox-entry",
  "channel": "slack",
  "externalUserId": "U012ABC3DEF",
  "externalMessageId": "1691250000.000100",
  "rawText": "spent $12.50 on lunch",
  "attachments": []
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `contractVersion` | string | Yes | `"1"` today. |
| `workflowExecutionId` | string | Yes | The calling front door's own `$execution.id` — the idempotency key for the whole chain. Generated once, forwarded unchanged at every hop. See "Generating `workflowExecutionId`" below. |
| `workflowName` | string | Yes | The calling front-door workflow's file slug. |
| `channel` | string | Yes | `"slack"` \| `"telegram"` \| `"whatsapp"` \| `"retell"` \| `"web-chat"` \| `"ocr"` |
| `externalUserId` | string \| null | Yes | Sender identity within that channel. |
| `externalMessageId` | string \| null | Yes | Per-message identifier from that channel. |
| `rawText` | string | Yes | Raw text content; `""` if none. |
| `attachments` | array | Yes | `{url, mimeType, name}[]`; `[]` if none. |

**Full field reference and rationale:** `docs/adrs/ADR-0008-finance-inbox-workflow-contract.md` Decision 1.

---

# The Response Contract (Intent Router / handler → front door)

Every response a front door receives back has exactly this shape:

```json
{
  "contractVersion": "1",
  "workflowExecutionId": "n8n-execution-98421",
  "status": "success",
  "intent": "CREATE_EXPENSE",
  "message": "Logged $12.50 to FOOD.",
  "data": { "id": "expense-1", "amount": "12.50", "category": "FOOD" },
  "clarifyingQuestion": null
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `contractVersion` | string | Yes | `"1"` today. |
| `workflowExecutionId` | string | Yes | Echoed back from the Request unchanged. |
| `status` | string | Yes | `"success"` \| `"clarify"` \| `"unsupported"` \| `"error"` |
| `intent` | string | Yes | One of the Intent Catalog values below, or `"UNRECOGNIZED"`. |
| `message` | string | Yes | Human-readable plain text. **The only field a front door is required to use.** |
| `data` | object \| null | No | Optional structured detail for a front door that wants richer rendering later. |
| `clarifyingQuestion` | string \| null | No | Set only when `status === "clarify"`. |

A front door that does nothing but `postReply(response.message)` is always a correct, complete implementation of this contract — exactly what `01-finance-inbox-entry.json`'s `Format Slack Reply` node already does.

**Full field reference and rationale:** `docs/adrs/ADR-0008-finance-inbox-workflow-contract.md` Decision 2.

---

# The Finance Intent Catalog

| Intent | Purpose | Example message | Fields the Handler extracts from `rawText`/`attachments` (Phase 2 amendment — the Router itself extracts nothing beyond `{intent, confidence}`; see ADR-0008 Notes) | Handler writes to | Backend readiness |
|---|---|---|---|---|---|
| `CREATE_EXPENSE` | Log an expense | "spent $12.50 on lunch" | `date, amount, category, paymentMethod?, description?, isRecurring?` | `POST /finance/service/expenses` | **Full** |
| `GET_BUDGET` | Ask the monthly budget | "what's my budget this month?" | none — always the current period | `GET /finance/service/dashboard` (reads `budget`/`remainingBudget` only; same endpoint `GET_DASHBOARD` uses) | **Full** — `FinanceHandlerGetBudgetWf01` (`workflows/finance/11-handle-get-budget.json`) |
| `GET_DASHBOARD` | Ask for a spending summary | "how am I doing this month?" | none — always the current period | `GET /finance/service/dashboard` | **Full** — `FinanceHandlerGetDashboardWf01` (`workflows/finance/12-handle-get-dashboard.json`) |
| `GET_FINANCE_QUESTION` | Open-ended finance question | "am I overspending on food?" | none extracted in n8n -- `rawText` forwarded verbatim as `question` to AI Core, which interprets it grounded in the fetched dashboard data | `GET /finance/service/dashboard` (no `/categories` call needed -- the dashboard response's `categoryBreakdown` already covers it) | **Full** — `FinanceHandlerGetFinanceQuestionWf01` (`workflows/finance/13-handle-get-finance-question.json`), answered by AI Core's `finance-question` capability |
| `CREATE_INCOME` | Log income | "got paid $2000" | `date, amount, source?, description?` | *(none — no data model)* | **Stub only** |
| `CREATE_TRANSFER` | Log a transfer | "sent $50 to Alex" | `date, amount, counterparty?, description?` | *(none — no data model)* | **Stub only** |
| `UPLOAD_RECEIPT` | Log an expense from a receipt | *(a shared image + caption)* | Same as `CREATE_EXPENSE` | `POST /finance/service/expenses` (via the `CREATE_EXPENSE` handler) | **Partial** — only when extraction succeeds |
| `UNRECOGNIZED` | Doesn't fit any of the above | *(ambiguous / off-topic)* | none | *(none)* | Always resolves to `status: "clarify"` |

**Full rationale and the backend cross-reference this table is derived from:** `docs/adrs/ADR-0008-finance-inbox-workflow-contract.md` Decision 3, `eyan-ai-platform` ADR-0024.

---

# Generating `workflowExecutionId`

This is the one detail worth over-explaining, because it fails silently if missed:

1. The **front door** generates it, once, as its own `$execution.id` — never minted separately, matching `01-lead-intake.json`'s identical CRM-domain precedent.
2. Every subsequent `Execute Workflow` hop (front door → Router, Router → handler, handler → handler, e.g. `UPLOAD_RECEIPT`'s handler calling `CREATE_EXPENSE`'s) **forwards the value it received** as a plain payload field — it never reads its own `$execution.id`, which would be a different value belonging to that hop's own child execution.
3. Every Finance write endpoint's idempotency check (`eyan-ai-platform` ADR-0024 Decision 5) is keyed on this value. Regenerate it at any hop, and a retried/redelivered message silently stops being deduplicated — the failure mode only shows up under retry, not in a first-pass test.

`01-finance-inbox-entry.json`'s `Build Router Input` node is the reference implementation of step 1 — see its own code comment for the same warning.

---

# Adding a New Channel

A new front door (e.g. Telegram) needs to:

1. Receive that channel's native event (its own trigger node).
2. Normalize it into the Request contract above — `channel: "telegram"`, mapping that channel's own user/message identifiers into `externalUserId`/`externalMessageId`.
3. Generate `workflowExecutionId` exactly once, as its own `$execution.id`.
4. Call the Finance Intent Router via `Execute Workflow`.
5. Relay `response.message` back through that channel's own reply mechanism.

No change to the Router, any handler, or either contract. If step 2 or step 5 needs a field neither contract offers, that's a signal to open a new ADR proposing a contract change — not to add a channel-specific bag field (see ADR-0008 Decision 4).

---

# Adding a New Intent

1. Add one row to the Intent Catalog above (and to ADR-0008 Decision 3).
2. Build one new handler workflow that accepts the Request contract, does its own field-completeness/business-rule validation, calls whatever Finance API endpoint it owns, and returns the Response contract.
3. Add one new branch to the Finance Intent Router's Intent Router node, dispatching to the new handler by ID.

No change to Decision 1 or Decision 2's envelope shape — the whole point of a fixed, intent-agnostic contract is that this is the only kind of change adding an intent should ever require.

---

# Related Documentation

Architecture: `docs/architecture/workflow-architecture.md`

ADR: `docs/adrs/ADR-0008-finance-inbox-workflow-contract.md` (this contract's decision record), `docs/adrs/ADR-0005-workflow-organization.md`, `docs/adrs/ADR-0006-crm-workflow-authentication.md`, `eyan-ai-platform` `docs/architecture/decisions/ADR-0019-automation-integration-contract.md` and `ADR-0024-finance-automation-service-contract.md`

Workflows: `docs/workflows/01-finance-inbox-entry.md` (the only workflow currently implementing this contract)

Issue: n/a — the 8 Handler workflows this contract specifies are future phases, not yet built. The Finance Intent Router itself was built in Phase 2 (`workflows/finance/02-finance-intent-router.json`, `docs/workflows/02-finance-intent-router.md`).
