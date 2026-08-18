# ADR-0008: Finance Inbox Workflow Contract

- Status: Accepted
- Date: 2026-08-05
- Authors: Claude Code

---

# Context

Phase 1 (`workflows/finance/01-finance-inbox-entry.json`, `docs/workflows/01-finance-inbox-entry.md`) shipped the first, and so far only, Finance Inbox workflow: a Slack-specific front door that normalizes an inbound message and calls a not-yet-built `FinanceIntentRouterWf01` by ID. That workflow already invented a concrete request shape (`contractVersion`, `workflowExecutionId`, `workflowName`, `channel`, `externalUserId`, `externalMessageId`, `rawText`, `attachments`) and a minimal response expectation (a `message` string) — but neither was ever written down as a contract, and no Intent Catalog exists anywhere. Building the Finance Intent Router (Phase 2) or any intent handler workflow (Phase 3+) without first fixing this contract risks the same problem ADR-0005/ADR-0006 already exist to prevent for workflow organization and credentials: undocumented conventions that the next phase has to reverse-engineer from source instead of read.

This ADR does for the Finance Inbox's internal (workflow-to-workflow) contract what `eyan-ai-platform`'s ADR-0019/ADR-0024 already did for the external (n8n-to-backend) contract — fixes it into concrete, implementable decisions before the Router or any handler is built, per `docs/standards/documentation-standards.md`'s documentation-first discipline this repo has followed since ADR-0002.

**Scope note**: this ADR fixes the contract only. It does not implement the Finance Intent Router, any handler workflow, or modify `01-finance-inbox-entry.json` — that workflow already satisfies this contract as shipped (see Consequences).

---

# Decision

## Decision 1: Finance Inbox Request Contract (front door → Intent Router)

Every Finance Inbox front-door workflow (Slack today; Telegram, WhatsApp, Retell, Web Chat, OCR planned) calls the Finance Intent Router via `Execute Workflow` with exactly this shape — the same shape `01-finance-inbox-entry.json`'s `Build Router Input` node already produces:

```json
{
  "contractVersion": "1",
  "workflowExecutionId": "<n8n execution id of the CALLING front-door workflow>",
  "workflowName": "01-finance-inbox-entry",
  "channel": "slack",
  "externalUserId": "U012ABC3DEF",
  "externalMessageId": "1691250000.000100",
  "rawText": "spent $12.50 on lunch",
  "attachments": [
    { "url": "https://files.slack.com/f1", "mimeType": "image/png", "name": "receipt.png" }
  ]
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `contractVersion` | string | Yes | This contract's own version, independent of any URL version — mirrors `eyan-ai-platform` ADR-0019 Decision 6 / ADR-0024 Decision 6's identical field on the Finance service API. |
| `workflowExecutionId` | string | Yes | The **calling front-door workflow's own** `$execution.id`, generated **exactly once**, at the front door, and threaded unchanged through every subsequent hop (Router → handler → any handler-to-handler call). Never regenerated at a later hop — see Decision 4. |
| `workflowName` | string | Yes | The literal slug of the calling front-door workflow file (e.g. `01-finance-inbox-entry`, or a future channel's own front-door slug). |
| `channel` | string enum | Yes | One of `"slack"`, `"telegram"`, `"whatsapp"`, `"retell"`, `"web-chat"`, `"ocr"` — see Decision 3's channel-extensibility note. |
| `externalUserId` | string \| null | Yes (nullable) | The sender's identity within that channel — Slack user ID, Telegram user/chat ID, WhatsApp phone number, Retell caller ID, Web Chat session ID, OCR submitter ID. |
| `externalMessageId` | string \| null | Yes (nullable) | A per-message identifier from the channel, for traceability and future dedup — Slack `event_ts`/`ts` today. |
| `rawText` | string | Yes | The raw natural-language text content. `""` (never `null`/absent) when there is none — e.g. an image-only OCR submission. |
| `attachments` | array | Yes (may be empty) | Generic file references: `{url, mimeType, name}` only. No channel-specific metadata field — see Decision 4's "no channel-metadata bag" rule. |

**No Finance-specific field appears in this contract** — no `intent`, `category`, `amount`. Classifying those is the Router's job, not the front door's, per the front door's own documented scope (`docs/workflows/01-finance-inbox-entry.md`: "Do not classify intents... Do not contain business logic").

## Decision 2: Finance Inbox Response Contract (Intent Router / handler → front door)

Every response a front door receives back from `Execute Workflow: Finance Intent Router` — whether directly from the Router (e.g. an `UNRECOGNIZED` intent) or from whichever handler the Router dispatched to — has exactly this shape:

```json
{
  "contractVersion": "1",
  "workflowExecutionId": "<echoed back unchanged>",
  "status": "success",
  "intent": "CREATE_EXPENSE",
  "message": "Logged $12.50 to FOOD.",
  "data": { "id": "expense-1", "amount": "12.50", "category": "FOOD" },
  "clarifyingQuestion": null
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `contractVersion` | string | Yes | Same versioning posture as Decision 1. |
| `workflowExecutionId` | string | Yes | Echoed back unchanged, so a front door can correlate/log against the request it sent. |
| `status` | string enum | Yes | `"success"` \| `"clarify"` \| `"unsupported"` \| `"error"` — the vocabulary the approved AI Finance Inbox implementation plan already establishes for this exact purpose. |
| `intent` | string enum | Yes | One of the Finance Intent Catalog values (Decision 3), or `"UNRECOGNIZED"`. Present even on `error`/`unsupported`, for audit/logging — a front door may ignore it, but must never be required to branch on it (see Decision 4). |
| `message` | string | Yes | Human-readable, plain text (no channel-specific markup — no Slack `mrkdwn`, no Block Kit JSON). **This is the only field a front door is ever required to use** to build its reply — confirmed by inspection: `01-finance-inbox-entry.json`'s `Format Slack Reply` node reads only `.message` today. |
| `data` | object \| null | No | Optional structured payload (e.g. the created expense's id/amount/category) for a front door that wants to do richer rendering later. Never required; a front door that only reads `message` is always correct. |
| `clarifyingQuestion` | string \| null | No | Present only when `status === "clarify"`; also already folded into `message` for a front door that ignores this field. |

## Decision 3: Finance Intent Catalog

The Router classifies every request into exactly one of these seven real intents, or the internal fallback `UNRECOGNIZED`:

| Intent | Purpose | Fields the owning Handler extracts from `rawText`/`attachments` (Phase 2 amendment — see Notes) | Backend readiness today (`eyan-ai-platform` ADR-0024) |
|---|---|---|---|
| `CREATE_EXPENSE` | Log a household expense | `date, amount, category, paymentMethod?, description?, isRecurring?` | **Full** — `POST /finance/service/expenses` |
| `GET_BUDGET` | Answer "what's my budget" | none — always the current period (see `11-handle-get-budget.md` Constraints) | **Full** (Handler built) — `GET /finance/service/dashboard`, no dedicated endpoint; satisfies `GET_BUDGET` via that response's `budget`/`remainingBudget` fields, per ADR-0024 Decision 2/Alternatives |
| `GET_DASHBOARD` | Answer "show me my spending" | none — always the current period (see `12-handle-get-dashboard.md` Constraints) | **Full** (Handler built) — `GET /finance/service/dashboard` |
| `GET_FINANCE_QUESTION` | Open-ended NL finance question not covered by the two structured reads above | none extracted in n8n — `rawText` forwarded verbatim to AI Core as `question`, interpreted there grounded in fetched dashboard data (see `13-handle-get-finance-question.md` Constraints) | **Full** (Handler built) — `GET /finance/service/dashboard` (no dedicated endpoint of its own), answered by AI Core's `finance-question` capability |
| `CREATE_INCOME` | Log income | `date, amount, source?, description?` | **Stub only** — no `Income` Prisma model exists; must resolve to `status: "unsupported"`, never a write |
| `CREATE_TRANSFER` | Log a transfer between accounts/people | `date, amount, counterparty?, description?` | **Stub only** — no `Transfer` Prisma model exists; same as above |
| `UPLOAD_RECEIPT` | Log an expense from a shared receipt/image | Same shape as `CREATE_EXPENSE`, extracted from `rawText`/`attachments` | **Partial** — once fields are extracted, writes via the same `POST /finance/service/expenses` endpoint as `CREATE_EXPENSE` (a handler-to-handler call, not a separate endpoint) |
| `UNRECOGNIZED` | The message doesn't clearly fit any of the above | none | N/A — always resolves to `status: "clarify"` |

Backend readiness is tracked here as a convenience cross-reference to `eyan-ai-platform` ADR-0024, not as its source of truth — that ADR is authoritative for what the Finance API actually exposes; this table must be kept in sync by hand when it changes (a known process risk, see Consequences).

## Decision 4: Extension and Versioning Rules

- **Adding a channel** means writing a new front-door workflow that produces Decision 1's Request contract correctly. It requires no change to the Router, any handler, or this ADR.
- **Adding an intent** means adding one row to Decision 3's catalog, one new handler workflow, and one new branch on the Router's Intent Router node. It requires no change to Decision 1 or Decision 2 — the envelope shape is intent-agnostic by design.
- **No channel-specific "metadata bag" field is ever added to either contract.** A front door needing to remember something channel-specific for its own reply step (e.g. Slack's `slackChannelId`/`slackThreadTs`) keeps it locally, referenced by node name, exactly as `01-finance-inbox-entry.json`'s `Normalize Slack Input` → `Slack - Post Reply` already does — never threaded through the Router. This is the same boundary the approved AI Finance Inbox implementation plan calls the central reusability mechanism; a generic bag field would quietly reopen it.
- **`workflowExecutionId` is generated exactly once**, at the original front door, and threaded unchanged through every hop (front door → Router → handler → any handler-to-handler call, e.g. `UPLOAD_RECEIPT` → `CREATE_EXPENSE`'s handler). Regenerating it at any hop (e.g. reading `$execution.id` inside the Router instead of forwarding the value it received) breaks the idempotency check every Finance write endpoint relies on (`eyan-ai-platform` ADR-0024 Decision 5) — flagged here because it's exactly the kind of detail that works in a single-hop test and only breaks under a retried/redelivered message.
- **Unrecognized `contractVersion`**: processed best-effort with a logged warning, never hard-rejected — matches the "never strand a message" principle `01-lead-intake.md`/ADR-0019 already establish for the equivalent EYAN↔n8n contract.
- A breaking change to either contract (removing/renaming a required field, changing `status`'s vocabulary) requires a `contractVersion` bump and a new ADR, not a silent edit to this one.

---

# Alternatives Considered and Rejected

- **Channel-specific request shapes per front door** — rejected: defeats the entire reusability goal the two-workflow (front door / core) split exists to serve; every future channel would need its own Router-side parsing branch.
- **A generic `channelMetadata` bag field on either contract** — rejected: becomes an escape hatch for channel-specific concerns to leak into the shared Router/handlers, the exact risk the approved implementation plan flags explicitly. Slack-specific fields belong in the Slack front door only, referenced locally, never forwarded.
- **Opaque/numeric intent codes** instead of descriptive `UPPER_SNAKE_CASE` strings — rejected: this repo already favors readable string enums everywhere they appear (n8n Switch node branches, execution logs, `ExpenseCategory`/`LeadStatus` on the backend side) — an opaque code would need a lookup table to read at a glance, with no offsetting benefit.
- **Strictly typing `data` per intent right now** — rejected as premature: no handler exists yet to validate against. `data` stays a loosely-typed optional object until each handler ships and a real shape is proven, avoiding a near-certain breaking `contractVersion` bump the moment the first handler is actually built.
- **One combined bidirectional contract document** instead of two directionally-named contracts (Request vs. Response) — rejected: the two flow through different tiers with different producers and consumers (front doors only ever produce Request/consume Response; the Router and handlers only ever consume Request/produce Response), so naming and documenting them separately — the same choice `eyan-ai-platform` ADR-0019 makes with its own per-direction Decisions — is clearer to reference independently later.

---

# Consequences

- **No workflow changes.** `01-finance-inbox-entry.json` already satisfies Decision 1 exactly as shipped (verified by inspection against `Build Router Input`'s actual output) and already satisfies being a valid Decision-2 consumer — `Format Slack Reply` reads only `.message`, which this contract defines as the one field every producer must set, and ignores every other field by design (proven in `tests/workflows/finance/01-finance-inbox-entry.logic.test.js`'s "reply text is identical whether or not Finance-specific fields are present" case). This ADR formalizes what Phase 1 already built rather than changing it.
- The not-yet-built Finance Intent Router and every intent handler workflow are now built against a fixed, written spec rather than whatever shape their author would otherwise have improvised.
- A future channel's front door (Telegram, WhatsApp, Retell, Web Chat, OCR) needs only Decision 1 to integrate — zero Router/handler-side knowledge required, confirmed structurally by Decision 4's extension rule.
- The Intent Catalog's backend-readiness column duplicates information that lives authoritatively in `eyan-ai-platform` ADR-0024 — a real, accepted process risk (two repos, no shared schema registry) rather than an oversight; flagged for manual upkeep whenever ADR-0024 (or its successor) changes the Finance service API surface.

---

# Related Documents

- `docs/adrs/ADR-0005-workflow-organization.md` (file/naming/ID conventions this contract's future Router/handler workflows will follow)
- `docs/adrs/ADR-0006-crm-workflow-authentication.md` (the credential-reuse precedent this domain's future Finance API calls will follow)
- `docs/workflows/01-finance-inbox-entry.md` (the only workflow that currently implements this contract)
- `docs/workflows/finance-inbox-contract.md` (the living reference doc for this contract — full examples, walkthrough, extension guide)
- `eyan-ai-platform` `docs/architecture/decisions/ADR-0019-automation-integration-contract.md` and `ADR-0024-finance-automation-service-contract.md` (the external n8n↔backend contract this internal workflow-to-workflow contract sits in front of)
- The approved AI Finance Inbox implementation plan (intent-routed revision) — the source of the `status`/intent-routing vocabulary this ADR fixes into a written contract

---

# Notes

This ADR intentionally does not assign hand-picked workflow IDs for the Router or any handler (e.g. `FinanceIntentRouterWf01`, already forward-referenced by `01-finance-inbox-entry.json`) beyond what Phase 1 already committed to — assigning the full ID scheme for workflows that don't exist yet is Phase 2/3's job, per ADR-0005's per-domain, as-built ID convention, not something to speculate on here.

**Amendment (Phase 2, `02-finance-intent-router.json`)**: Decision 3's `data` column originally read "Router's extraction, not yet validated," implying the Router itself extracts intent-specific fields (amount, category, etc.) from `rawText`. Phase 2's actual implementation is stricter: the Router's AI Agent output is `{intent, confidence}` only — no other field. Extracting `date`/`amount`/`category`/etc. from `rawText` is entirely the owning Handler's responsibility, once that Handler exists. This keeps the Router honestly "orchestration only" (it never even attempts field extraction, not just "extracts but doesn't validate") and was chosen over amending the Request/Response contract shapes themselves, which are unaffected — see `02-finance-intent-router.md`'s Constraints Verified section for how this is checked structurally, not just declared. Decision 3's table header above is corrected accordingly; the rest of Decision 3 (the eight intents, their purpose, and backend readiness) is unchanged. Phase 2 also assigned the eight Handler workflow IDs this Notes section deferred — see `docs/workflows/02-finance-intent-router.md`'s "Handler ID Assignments" table, not restated here to avoid two sources of truth drifting apart.

**Amendment (`11-handle-get-budget.json`, second Finance Handler built)**: Decision 3's `GET_BUDGET` row originally read "Not built." This phase built `FinanceHandlerGetBudgetWf01`, per the row's own already-stated plan: no dedicated `/finance/service/budget` endpoint was added (none was needed — `eyan-ai-platform` ADR-0024's Alternatives section explicitly rejected building one prematurely), and the Handler instead calls the existing `GET /finance/service/dashboard` and reads only its `budget`/`totalExpenses`/`remainingBudget`/`period` fields. The row's `data` column is also corrected: the Phase 2 amendment above already established the Router extracts nothing, but this row still listed `period?` as a field the Handler would extract from `rawText` — this phase's Handler does not implement period parsing at all (every query is always the current period; see `docs/workflows/11-handle-get-budget.md` Constraints for why extending this to arbitrary periods was deferred as speculative, no real caller needing it yet). Decision 3's table is corrected accordingly; no other row changed.

**Amendment (`12-handle-get-dashboard.json`, third Finance Handler built)**: Decision 3's `GET_DASHBOARD` row is corrected the same way the `GET_BUDGET` row was above — it listed `period?` as a Handler-extracted field, but this phase's Handler does not implement period parsing (always the current period, same reasoning as `GET_BUDGET`; see `docs/workflows/12-handle-get-dashboard.md` Constraints). No endpoint change was needed: this Handler is a second, independent caller of the exact same `GET /finance/service/dashboard` `GET_BUDGET` already calls, reading the full response instead of only `budget`/`remainingBudget` — the one dashboard endpoint ADR-0024 built was already sufficient for both intents, confirming that Alternatives-section decision in practice, not just on paper.

**Amendment (`13-handle-get-finance-question.json`, fourth Finance Handler built)**: Decision 3's `GET_FINANCE_QUESTION` row originally listed `question, impliedPeriod?, impliedCategory?` as fields the Handler would extract from `rawText`, and `GET /finance/service/dashboard` + `GET /finance/service/categories` as the composed read surface. Both are corrected: this Handler extracts nothing in n8n at all — `rawText` is forwarded verbatim to a new AI Core capability (`finance-question`, `finance-question-brain`, `eyan-ai-platform` `backend/prisma/seed-ai-core.ts`'s `seedFinanceQuestionBrain()`) as the `question` field, and the model interprets it entirely grounded in the real `dashboard` JSON also supplied in that same call — no separate `impliedPeriod`/`impliedCategory` slot-extraction step, no second AI round-trip. The `/finance/service/categories` call was found unnecessary once implemented: `GET /finance/service/dashboard`'s own `categoryBreakdown` field already carries every category with real spending in the current period, which is what a category-shaped question actually needs. This is the first Finance AI Core call to use `expectJson: false` (a plain-text answer, not structured JSON) — deliberately, since a free-form WhatsApp-bound answer has no schema to force, and forcing one would risk the same JSON-wrapper failure modes ADR-0009/ADR-0011/ADR-0012 already fought through for structured-output tasks, for no benefit here. No existing Finance capability/brain/prompt/policy was modified — `finance-question` is new, additive infrastructure only.
