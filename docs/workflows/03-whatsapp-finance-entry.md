# Finance - 03 - WhatsApp Entry

Status: Active (imported, inactive by default — see Testing; import/export round-trip and logic tests verified against the real n8n instance; no live WhatsApp/Finance-API end-to-end run performed this phase — see Testing for why and the exact manual procedure)

Category: Finance

Owner: Automation Hub

Version: 1.0

---

# Purpose

The WhatsApp channel adapter for the AI Finance Inbox — makes the existing Slack-only pipeline (`02-finance-intent-router.json` → `10-handle-create-expense.json`) reachable through WhatsApp, without changing either of those workflows. Receives an already-normalized WhatsApp message event from `workflows/integrations/01-whatsapp-gateway-webhook.json`, translates it into the Finance Inbox Request Contract, dispatches it to the Finance Intent Router via `Execute Workflow`, and relays the Router's response back to the customer via `workflows/integrations/02-whatsapp-outbound-send.json`. This workflow is a **channel adapter**: it owns translation only — no intent classification, no Finance-specific validation, no direct Finance API calls, and no Finance business logic of any kind. See `docs/adrs/ADR-0013-whatsapp-finance-entry-adapter.md` for the full architectural reasoning, including why this workflow is `Execute Workflow`-triggered rather than webhook-triggered.

---

# Trigger

- Execute Workflow Trigger (`inputSource: passthrough`) — called by `workflows/integrations/01-whatsapp-gateway-webhook.json`'s `Call WhatsApp Finance Entry` node, from the Gateway's `Ready For AI / CRM Processing` extension point (every non-`"eyan-test"` inbound WhatsApp message). Any future caller (e.g. a scripted `n8n execute` test, or conceivably another future WhatsApp-based front door) invokes it identically — this workflow defensively re-validates its own input rather than trusting the Gateway blindly (see Workflow Steps).

---

# Inputs

The Gateway's own normalized WhatsApp event shape (`workflows/integrations/01-whatsapp-gateway-webhook.json`'s `Normalize WhatsApp Messages` node output) — **not** the Finance Inbox Request Contract; this workflow's own first job is converting one into the other.

| Name | Type | Required by this adapter | Description |
|------|------|----------|-------------|
| `workflowExecutionId` | string | Yes | The Gateway's own `$execution.id`, generated once at the true channel-entry boundary. This adapter forwards it unchanged — see Idempotency. |
| `customerWhatsappId` | string | Yes | The sender's WhatsApp ID (`wa_id`) — becomes `externalUserId` in the Finance request, and the reply recipient. |
| `messageId` | string \| null | No | Meta's `wamid` — becomes `externalMessageId` in the Finance request. |
| `messageType` | string \| null | No | `"text"`, `"image"`, etc. — read only for logging; does not affect control flow. |
| `messageText` | string \| null | No | The message body (`null` for non-`text` types) — becomes `rawText`, defaulting to `""`. |
| `contractVersion`, `workflowName`, `channel`, `whatsappBusinessAccountId`, `phoneNumberId`, `customerDisplayName`, `messageTimestamp`, `receivedAt`, `rawMessage` | — | No | Present in the Gateway's output; read by neither this workflow's validation nor its Finance-request construction. `workflowName`/`channel` are rebuilt by this workflow itself rather than trusted from the caller (see Workflow Steps step 3). |

---

# Workflow Steps

1. **When Called by Another Workflow** (Execute Workflow Trigger, `inputSource: passthrough`) — receives the Gateway's normalized event unchanged.
2. **Validate WhatsApp Event Input** (Code) — defensive structural check, independent of the Finance Inbox Contract: requires `workflowExecutionId` (the one hard idempotency requirement) and `customerWhatsappId` (this adapter's own reply-routing requirement, mirroring `10-handle-create-expense.json`'s Handler-specific `externalUserId` rule) as real, non-empty strings.
3. **WhatsApp Event Valid?** (IF) — `false` → **Build Invalid Event Response** (terminal, logs and stops — no Finance request is built, no reply is attempted, since a safe recipient could not even be confirmed); `true` → continue.
4. **Build Finance Inbox Request** (Code) — the core translation step. Maps the WhatsApp-native fields onto the Finance Inbox Request Contract's 8 fields exactly (`contractVersion: "1"`, `workflowExecutionId` forwarded unchanged, `workflowName: "03-whatsapp-finance-entry"` — this adapter's own slug, not the Gateway's — `channel: "whatsapp"`, `externalUserId` ← `customerWhatsappId`, `externalMessageId` ← `messageId`, `rawText` ← `messageText`, `attachments: []` always — see Constraints). No WhatsApp-specific field (`customerWhatsappId`, `messageId`, `messageType`, `whatsappBusinessAccountId`, `phoneNumberId`) is forwarded into this object.
5. **Call Finance Intent Router** (`Execute Workflow`, `workflowId: "FinanceIntentRouterWf01"`, `onError: continueRegularOutput`) — identical node shape to `01-finance-inbox-entry.json`'s own call into the same Router.
6. **Build WhatsApp Reply Input** (Code) — translates the Router's Response Contract into `02-whatsapp-outbound-send.json`'s own input contract (`{to, messageType, text, contextTag}`). Reads `message` only — never `status`, `intent`, or `data` — so a `success`, `clarify`, `unsupported`, or `error` response are all relayed identically via their `message` text, with no adapter-invented business logic. A failed `Execute Workflow` call (`$json.error`) degrades to the same safe generic fallback text `01-finance-inbox-entry.json`'s `Format Slack Reply` uses, never leaking raw error internals.
7. **Call WhatsApp Outbound Send** (`Execute Workflow`, `workflowId: "WhatsappOutboundSendWf01"`, `onError: continueRegularOutput`) — reuses the existing reusable outbound-send workflow, identical to the Gateway's own `"eyan-test"` reply path; no WhatsApp-sending logic is duplicated here.
8. **Finance Reply Sent** (NoOp, terminal) — mirrors the Gateway's own `Test Reply Sent` marker node.

---

# Integrations

- **`workflows/finance/02-finance-intent-router.json`** (`Execute Workflow`) — the Finance Intent Router; this workflow calls it exactly as `01-finance-inbox-entry.json` does, with the same Request Contract shape.
- **`workflows/integrations/02-whatsapp-outbound-send.json`** (`Execute Workflow`) — the existing, reusable WhatsApp send capability; not duplicated.
- No direct HTTP Request node exists in this workflow. No Finance API endpoint (`/finance/service/expenses`, `/categories`, `/dashboard`, etc.) is ever called from here — see Architectural Constraints.

---

# Outputs

Not consumed by any caller today (`workflows/integrations/01-whatsapp-gateway-webhook.json`'s `Call WhatsApp Finance Entry` node does not inspect this workflow's return value — same posture as its own `Call Outbound Send - Test Reply` node). The final node's output is simply `Call WhatsApp Outbound Send`'s own result (`{success, messageId, to}` or `{success:false, error}`), useful for n8n's execution log / manual debugging.

---

# Idempotency

`workflowExecutionId` is **received** from the Gateway (which generated it once, as its own `$execution.id`, in `Normalize WhatsApp Messages`) and **forwarded unchanged** into the Finance Inbox Request — this workflow never reads its own `$execution.id` (structurally verified: no Code node in this workflow references `$execution` outside of comments explaining why not — see the logic test suite). This is the exact discipline `docs/workflows/finance-inbox-contract.md`'s "Generating `workflowExecutionId`" section requires, applied across a two-workflow front-door split (Gateway + Adapter) rather than the single-workflow shape Slack uses — see `docs/adrs/ADR-0013-whatsapp-finance-entry-adapter.md` for why this split exists and why it still preserves the contract's idempotency guarantee. `workflowName` is this adapter's **own** slug (`"03-whatsapp-finance-entry"`), not the Gateway's — matching the same per-hop-self-identifies convention `10-handle-create-expense.json` and `workflows/crm/03-ai-qualification.json` already established.

The actual deduplication mechanism (keyed on `workflowExecutionId`) lives entirely in `eyan-ai-platform`'s `WorkflowExecutionLogRepository`, reached via the Router → `10-handle-create-expense.json` → Finance Service API chain — this adapter introduces no idempotency mechanism of its own, and cannot: it never touches the Finance API directly.

---

# Error Handling

- **Malformed/incomplete input from the caller** (missing `workflowExecutionId` or `customerWhatsappId`) → logged, the request stops before the Router is ever called, no reply is attempted (no confirmed safe recipient).
- **Finance Intent Router call failure** (`Execute Workflow` `onError: continueRegularOutput` surfaces `$json.error`) → a safe, generic WhatsApp reply, never raw error internals — identical posture to `01-finance-inbox-entry.json`'s `Format Slack Reply`.
- **Any Router/Handler response status** (`success`, `clarify`, `unsupported`, `error`) → relayed via `message` uniformly; this adapter never branches on `status` or `intent`.
- **WhatsApp Outbound Send failure** — not specially handled by this workflow (`onError: continueRegularOutput` prevents a crash, but no retry or alternate delivery is attempted); the same posture as the Gateway's own test-reply path.
- No retry logic exists anywhere in this workflow, matching every other workflow in this repository's stated posture.

---

# Architectural Constraints

Enforced structurally (verified by the logic test suite against the committed workflow JSON, not just by convention):

- **Zero `httpRequest` nodes** — this adapter never calls the Finance API (or any HTTP API) directly.
- **Zero LangChain/Agent nodes, and no jsCode references any Intent Catalog value** (`CREATE_EXPENSE`, `GET_BUDGET`, etc.) — this adapter never classifies intent.
- **No jsCode references any Finance-domain field** (`amount`, `category`, `paymentMethod`, `isRecurring`, `ExpenseCategory`) — this adapter never performs Finance-specific validation.
- **Exactly 2 `Execute Workflow` nodes**, targeting `FinanceIntentRouterWf01` and `WhatsappOutboundSendWf01` only — never `FinanceHandlerCreateExpenseWf01` or any other Handler directly.
- **No node reads `$execution`** — `workflowExecutionId` is always the value received from the caller, never regenerated.
- **WhatsApp-specific fields never appear in the Finance Inbox Request** — the object built in `Build Finance Inbox Request` carries exactly the 8 contract keys and nothing else (test-enforced key-set equality, not just a spot check).

---

# Security

Authentication: none inbound (Execute Workflow Trigger, called only by another workflow in the same n8n instance).

Secrets used: **none directly.** This workflow holds no credential of its own — both downstream calls (`FinanceIntentRouterWf01`, `WhatsappOutboundSendWf01`) are `Execute Workflow` calls, which run as their own workflows with their own credentials (the Router's Ollama connection, the Outbound Send workflow's Meta WhatsApp Cloud API credential) rather than anything this adapter needs to hold.

Sensitive data: `rawText` (the customer's WhatsApp message) and `externalUserId` (their WhatsApp ID) flow through this adapter into the Router/Handler chain exactly as Slack's do — no additional exposure introduced by this workflow.

---

# Known Limitations

- **WhatsApp media messages are not extracted as attachments.** `attachments` is always `[]` — `workflows/integrations/01-whatsapp-gateway-webhook.json`'s `Parse WhatsApp Payload` does not resolve WhatsApp media IDs to downloadable URLs (a separate, authenticated Graph API call it does not currently make). A message of type `image`/`document`/etc. reaches this adapter with `messageText: null` → `rawText: ""`, and degrades safely through the Router (routes toward `UNRECOGNIZED`/`clarify`, never a crash) rather than being usefully processed. Extending the Gateway to resolve media URLs, and this adapter (or a future `UPLOAD_RECEIPT` Handler) to consume them, is explicitly out of scope for this phase.
- **No live WhatsApp-to-Finance-database end-to-end test was performed this phase** — see Testing for the exact reason and the manual procedure to run one.

---

# Testing

**Logic tests** (`tests/workflows/finance/03-whatsapp-finance-entry.logic.test.js`, `node tests/workflows/finance/03-whatsapp-finance-entry.logic.test.js`), covering: syntax validity of every Code node (via `vm.Script`, the same regression class discovered in `10-handle-create-expense.json` during Phase 3A); valid-event normalization (channel, externalUserId, externalMessageId, rawText, contractVersion, workflowName, attachments); malformed/incomplete-event handling (missing/empty `workflowExecutionId`, `null` `customerWhatsappId`, a completely empty event, a non-text message type) — all rejected safely, none crash; WhatsApp-specific-field-leak prevention (the Finance Inbox Request object's key set is asserted exactly equal to the 8 contract keys); `workflowExecutionId` preservation, including a same-input-called-twice replay check proving deterministic, non-regenerated output; WhatsApp reply construction on success, on a Router-call failure (safe fallback text, no raw error leaked), on a missing/empty Router response, and on a non-`success`-status Router response (proving no status-based special-casing); and structural checks (workflow id, Router/Outbound-Send target ids, zero `httpRequest` nodes, zero LangChain/Agent nodes, no Finance-domain-field references, no `$execution` reads, exactly 2 `Execute Workflow` nodes, never targeting the Handler directly) — 51 assertions, 51 passing.

**Gateway wiring tests** (`tests/workflows/integrations/01-whatsapp-gateway-webhook.logic.test.js`) — 4 new structural assertions added this phase, confirming the new `Call WhatsApp Finance Entry` node exists, targets `FinanceWhatsAppEntryWf01`, is reached from `Ready For AI / CRM Processing`, and that the pre-existing `"eyan-test"` keyword-reply branch is byte-for-byte unchanged — 21 assertions, 21 passing (17 pre-existing + 4 new).

**Content-snapshot guard**: this workflow's own logic test suite hashes `01-finance-inbox-entry.json`, `02-finance-intent-router.json`, and `10-handle-create-expense.json` (sha256) and asserts they match this phase's starting snapshot — confirming none of the three explicitly-protected files were altered by this phase's work, without relying on `git diff --stat` against `HEAD` (which this repository's actual development flow — multiple phases landing as uncommitted working-tree changes before anything is committed — makes an unreliable signal; see `tests/workflows/finance/10-handle-create-expense.logic.test.js`'s own comment on this exact issue from the prior phase's cleanup pass).

**Live n8n validation against the real, running n8n 2.33.3 instance:**

1. `n8n import:workflow` — both `03-whatsapp-finance-entry.json` (new) and `01-whatsapp-gateway-webhook.json` (modified) import successfully.
2. `n8n export:workflow` — both round-trip **byte-for-byte** (`id`/`name`/`nodes`/`connections`/`settings`) against the committed files.
3. Full repository test suite (all `*.logic.test.js` files) re-run and green — see this phase's validation report for the exact counts.

**Not exercised this phase**: a real, live WhatsApp message was **not** sent through the deployed Gateway into a real Finance database write. This requires a real Meta WhatsApp test-number message delivery (an external, human-initiated action from a real WhatsApp client — nothing in this repository can simulate an inbound Meta webhook call the way `n8n execute` can simulate an `Execute Workflow Trigger`), which was not available to perform in this environment this phase. Manufacturing a "successful" result without one would violate this phase's own instruction not to claim WhatsApp end-to-end success without a real event and a verified downstream write. What *was* validated live: import/export correctness for both files, and every logic/structural test above, executed against the real workflow JSON.

**Manual end-to-end test procedure** (to run once a real WhatsApp test-number send is available):

1. From a phone with access to Meta's test WhatsApp number, send: `I spent €25 on lunch today`.
2. Confirm in n8n's execution list: one execution of `01-whatsapp-gateway-webhook.json` (message received, 200 ack), followed by a child execution of `03-whatsapp-finance-entry.json`, a further child execution of `02-finance-intent-router.json`, and (assuming correct `CREATE_EXPENSE` classification) `10-handle-create-expense.json`.
3. Confirm the WhatsApp reply received on the test device reads a real, non-templated message derived from the Handler's actual result — e.g. `"Logged €25.00 to FOOD."` (exact wording depends on Ollama's extraction; the point is that it is NOT hardcoded anywhere in this adapter).
4. Confirm in the Finance database (or via a safe `GET /finance/service/dashboard` call) that a real expense row was created, attributable to this test.
5. Re-send the identical message with WhatsApp's own retry/dedup semantics in mind, or manually re-trigger `01-whatsapp-gateway-webhook.json` with the same normalized event, to confirm the replay case (`data.replayed === true`, no duplicate row) — mirroring the replay proof already performed live for `10-handle-create-expense.json` in Phase 3A.
6. Send a non-text message (e.g. an image) and confirm it degrades safely (a clarify/unrecognized reply, no crash) — proving the Known Limitations section's claim in practice, not just in unit tests.

---

# Related Documentation

Architecture: the AI Finance Inbox implementation plan — this workflow implements Phase 3B, the WhatsApp channel adapter.

ADR: `docs/adrs/ADR-0013-whatsapp-finance-entry-adapter.md` (this workflow's own architectural decisions), `docs/adrs/ADR-0008-finance-inbox-workflow-contract.md` (the contract this workflow implements), `docs/adrs/ADR-0010-whatsapp-outbound-messaging.md` (the outbound-send capability reused here).

Workflows: `docs/workflows/finance-inbox-contract.md` (the contract this workflow both consumes and produces), `docs/workflows/01-whatsapp-gateway-webhook.md` (this workflow's only caller today), `docs/workflows/02-whatsapp-outbound-send.md` (this workflow's outbound dependency), `docs/workflows/whatsapp-gateway-architecture.md`, `docs/workflows/02-finance-intent-router.md`, `docs/workflows/10-handle-create-expense.md`.

Issue: n/a — GET_BUDGET, GET_DASHBOARD, GET_FINANCE_QUESTION, CREATE_INCOME, CREATE_TRANSFER, and UPLOAD_RECEIPT remain unbuilt Handlers regardless of channel; this adapter reaches all of them identically once built, since it is intent-blind by design.
