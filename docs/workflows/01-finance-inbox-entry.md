# Finance - 01 - Inbox Entry

Status: Active (imported, inactive by default — see Testing)

Category: Finance

Owner: Automation Hub

Version: 1.0

---

# Purpose

The first workflow of the AI Finance Inbox (see the approved implementation plan) and the first workflow in the Finance domain. Receives inbound Slack messages, normalizes them into a channel-agnostic request, generates the idempotency key for the whole downstream chain exactly once, and hands off to the Finance Intent Router — the entry point for AI Finance Inbox automation, and the only Slack-specific workflow in the chain. Slack is the first of several planned front doors (Retell, Telegram, WhatsApp, OCR, Web Chat); every future channel gets its own thin intake workflow following this same shape, calling the same Finance Intent Router unchanged.

This workflow deliberately does **not**: classify intent, call the Finance API, contain business logic, or contain Finance-specific validation. Those responsibilities belong entirely to the Finance Intent Router (not yet built — see Related Documentation) and the intent handler workflows it will dispatch to.

---

# Trigger

- Slack Trigger (`n8n-nodes-base.slackTrigger`) — Slack Events API, `message` and `app_mention` events, whole-workspace (not scoped to one channel), so a user can DM the bot from anywhere it's installed.

---

# Inputs

| Name | Type | Required | Description |
|------|------|----------|-------------|
| Slack event | JSON | Yes | The raw Slack Events API `event` object (`req.body.event`, delivered as `$json` directly by n8n's `SlackTrigger` node — confirmed by reading `SlackTrigger.node.js` in this exact n8n version). Relevant fields: `type`, `user`, `channel`, `text`, `ts`, `event_ts`, `thread_ts`, `subtype`, `bot_id`, `files`. |

---

# Workflow Steps

1. **Slack Trigger - Inbox Message** — receives the Slack event. n8n's `SlackTrigger` node handles Slack's `url_verification` handshake and the request-signature check internally (via the "Slack API" credential's Signature Secret field); this workflow never sees or verifies that handshake itself. The webhook acks Slack immediately (`responseMode: onReceived`, fixed by the node type) — there is no `respondToWebhook` node here, unlike the raw-webhook CRM workflows, because n8n's Slack Trigger doesn't expose a `responseNode` mode.
2. **Ignore Bot / System Message?** (IF) — skips the bot's own messages and edit/delete echoes (`bot_id` present, or `subtype` in `bot_message`/`message_changed`/`message_deleted`). False branch is a silent no-op (matches `04-sales-automation.json`'s `Email Configured?` empty-array pattern) — there is nothing to reply to for a system echo.
3. **Normalize Slack Input** (Code) — maps the raw Slack event onto the channel-agnostic envelope (`channel: "slack"`, `externalUserId`, `externalMessageId`, `rawText`, `attachments`, `receivedAt`) that any future front door could produce identically. Also captures `slackChannelId`/`slackThreadTs` for later use by this workflow's own reply step — these two fields are Slack-specific and are never forwarded past the next node.
4. **Build Router Input** (Code) — generates `workflowExecutionId` **exactly once**, as `$execution.id` (this workflow's own n8n execution ID, the same reuse-not-mint pattern `01-lead-intake.json`'s `Build Sub-Workflow Input` already established for CRM), and assembles the request the Finance Intent Router will receive: `{contractVersion, workflowExecutionId, workflowName, channel, externalUserId, externalMessageId, rawText, attachments}`. Slack-specific fields (`slackChannelId`, `slackThreadTs`, `receivedAt`) are deliberately excluded — this is the channel-agnostic boundary the whole AI Finance Inbox design depends on.
5. **Call Finance Intent Router** (Execute Workflow, `onError: continueRegularOutput`) — passes the built request to `FinanceIntentRouterWf01` by ID. **That workflow does not exist yet** (a later phase) — `onError: continueRegularOutput` means a missing/failing Router surfaces as `$json.error` on the next node rather than crashing this execution, so this workflow is safe to import and even trigger today, before the Router exists.
6. **Format Slack Reply** (Code) — builds `{replyText}` from whatever the Router returned. This node never inspects intent, category, amount, or any other Finance-specific field — it only reads a pre-built `message` string (the Router's responsibility to produce) and falls back to a generic "couldn't process that" message if the call errored or returned nothing usable.
7. **Slack - Post Reply** (`n8n-nodes-base.slack`, resource `message`, operation `post`, `onError: continueRegularOutput`) — replies in the same channel/DM the message came from, using `slackChannelId` captured back in step 3 (referenced by node name, `$('Normalize Slack Input')`), not anything the Router returned.

---

# Integrations

- Slack (Events API inbound, `chat.postMessage` outbound) — via the "Slack API" n8n credential (see Security).
- `FinanceIntentRouterWf01` (Execute Workflow) — **not yet built**. This workflow is deliberately structured to call it by its planned, hand-assigned ID now, so no change is needed here once the Router ships (matches the same forward-reference posture `04-sales-automation.json` already uses for its not-yet-created "SMTP Account" credential — see `docs/security/credential-management.md`).

---

# Outputs

- A Slack reply (success or a generic fallback message) posted to the same channel/DM the inbound message came from.
- An `Execute Workflow` call to `FinanceIntentRouterWf01`, carrying `{contractVersion: "1", workflowExecutionId, workflowName: "01-finance-inbox-entry", channel: "slack", externalUserId, externalMessageId, rawText, attachments}`.

---

# Error Handling

- **Router missing or erroring**: `Call Finance Intent Router` has `onError: continueRegularOutput` — the failure surfaces as `$json.error`, and `Format Slack Reply` produces a generic, friendly fallback message rather than crashing or stranding the user without any reply.
- **Slack post itself failing**: `Slack - Post Reply` also has `onError: continueRegularOutput` — a failed reply (e.g. credential not yet configured) doesn't fail the execution; the attempt is visible in n8n's own execution log.
- **Bot/system messages**: silently ignored (see Workflow Steps step 2) — not an error, a deliberate no-op.
- No retry logic exists in this workflow. Retrying a failed `Call Finance Intent Router` call is deferred to whichever phase defines the Router's own retry policy (see the AI Finance Inbox plan's retry-strategy section) — this entry workflow's job is to degrade gracefully on a single attempt, not to retry.

---

# Security

Authentication: Slack's own Events API request-signature verification, handled internally by n8n's `SlackTrigger` node against the "Slack API" credential's Signature Secret field — this workflow does not implement its own HMAC verification (unlike the EYAN→n8n webhooks in `workflows/crm/`, which use a *different* signing mechanism entirely; the two must never be conflated).

Authorization: n/a — Slack Events API delivery to a registered app is the only gate.

Secrets Used: one n8n-native credential, **"Slack API"** (type `slackApi`, id `SlackApiCred01`), shared by both `Slack Trigger - Inbox Message` and `Slack - Post Reply` — one credential, reused, matching this repo's existing "EYAN Service API" reuse philosophy (ADR-0006). **Not yet created** in this instance (no real Slack App/workspace exists yet) — referenced by id/name now so the workflow is ready the moment it is, the same forward-reference posture `04-sales-automation.json` already uses for its "SMTP Account" credential. See `docs/security/credential-management.md`.

Sensitive Data: the raw Slack message text (`rawText`) and the sender's Slack user ID pass through this workflow and are forwarded to the Finance Intent Router — no Finance-specific data (amounts, categories) is parsed or inspected here, since this workflow never does classification or validation.

---

# Monitoring

Success Metrics: n8n's built-in execution list, same as every other workflow in this repo — no separate telemetry exists for this workflow specifically.

Failure Alerts: not configured — same standing gap as the rest of this repo's workflows (see `01-lead-intake.md`).

Logging: n8n's own execution log only. `Format Slack Reply` additionally `console.log`s the specific error message when the Router call fails, visible in n8n's execution detail view, so a missing/broken Router is diagnosable without guessing from the generic Slack-facing reply text alone.

---

# Testing

Test Cases (`tests/workflows/finance/01-finance-inbox-entry.logic.test.js`, 35 assertions, all passing — `node tests/workflows/finance/01-finance-inbox-entry.logic.test.js`):

- **Normalize Slack Input**: a plain DM message maps correctly to the channel-agnostic envelope; `externalMessageId` falls back from `event_ts` to `ts`; a threaded channel reply's `slackThreadTs` prefers `thread_ts` over `ts`; a `file_share` event's `files` array maps to `attachments`; a missing `text` field defaults `rawText` to `''`, never `undefined`.
- **Build Router Input**: `workflowExecutionId` is exactly `$execution.id` (generated once, here); `workflowName`/`contractVersion` are correct; every channel-agnostic field is forwarded — and, critically, `slackChannelId`/`slackThreadTs`/`receivedAt` are **not** present in the Router payload, proving the channel-agnostic boundary this workflow exists to enforce.
- **Format Slack Reply**: relays a well-formed Router `message` verbatim; falls back to a generic reply on `$json.error` (both `{message}` object and plain-string error shapes); falls back when the Router response has no usable `message`; and — proving "no business logic" structurally, not just by convention — produces the identical reply text whether or not the (hypothetical, future) Router response carries Finance-specific fields like `intent`/`data`.
- **"Ignore Bot / System Message?" gating** (a declarative n8n `IF` expression, not extractable `jsCode` — re-implemented in the test file to verify its intended semantics, same technique `04-sales-automation.logic.test.js` uses for its own IF-gate conditions): a plain user message is processed; the bot's own messages and edit/delete echoes are ignored; a `file_share` subtype (a real user action) is still processed.

`n8n execute --id=` cannot simulate a Slack Trigger event (same CLI limitation ADR-0005's Notes documents for the raw-Webhook CRM workflows) — full inbound-Slack-to-reply behavior has not been exercised against a live Slack workspace this phase (none exists yet; see Security). Structural validity was instead verified directly against the real, running n8n 2.33.3 instance: `n8n import:workflow --input=workflows/finance/01-finance-inbox-entry.json` succeeds, is idempotent on re-import, and — checked explicitly, not just assumed — round-trips byte-for-byte through `n8n export:workflow --id=FinanceInboxEntryWf01` with every node's `parameters`/`credentials`/`connections` intact, including the `slackTrigger` and `slack` (v2.5) node types that had no prior precedent anywhere in this repo. This confirms the workflow is schema-valid for this exact n8n version, not merely schema-plausible.

Expected Results: see Test Cases above; all passed. Full production activation (editor UI toggle) and a live Slack event were not exercised this phase, same posture `01-lead-intake.md` documents for its own not-yet-activated state.

---

# Related Documentation

Architecture: the AI Finance Inbox implementation plan (`.claude/plans/the-required-repository-context-generic-mochi.md`) — this workflow implements that plan's "Phase 1: Finance Inbox Entry" front-door design.

ADR: `docs/adrs/ADR-0005-workflow-organization.md`, `docs/adrs/ADR-0006-crm-workflow-authentication.md`, `eyan-ai-platform` `docs/architecture/decisions/ADR-0024-finance-automation-service-contract.md` (the backend contract this chain will ultimately call into, once the Finance Intent Router and its handlers exist)

Issue: n/a — the Finance Intent Router (`FinanceIntentRouterWf01`) referenced by this workflow's `Call Finance Intent Router` node is a follow-up phase, not yet built.
