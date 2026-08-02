# CRM - 04 - Sales Automation

Status: Active (imported, inactive by default — see Testing)

Category: CRM

Owner: Automation Hub

Version: 1.0

---

# Purpose

Sprint 5's downstream consumer of Workflow 3's qualification result — the automation this repo's own roadmap had reserved as a never-built "Workflow 5" (notifications). EYAN (`eyan-ai-platform`) triggers this workflow once a lead has already been fully qualified and pipeline-routed on its own side (`CrmAutomationIngestService.applyQualificationResult`) — this workflow only orchestrates the sales-facing side effects (assign a salesperson, notify Slack, notify email); it never re-derives pipeline stage or re-runs AI logic itself, per the sprint's "n8n orchestrates, AI logic stays in AI Core, business logic stays in CRM" rule.

---

# Trigger

- Webhook (`POST /webhook/crm/lead-qualified`) — EYAN's `AutomationWebhookService.dispatchLeadQualified()` fires this after a qualification result is fully applied (new `LeadAiAnalysis` row, pipeline transition, Activities all written). Same HMAC-signed pattern as Workflow 1's trigger (ADR-0019/ADR-0006), reusing the same "EYAN Webhook Signing Secret" credential.

---

# Inputs

Signed JSON body (`X-Eyan-Signature: sha256=...`, `X-Eyan-Timestamp`):

| Field | Type | Description |
|---|---|---|
| `contractVersion` | string | `"1"` |
| `event` | string | `"lead.qualified"` |
| `lead` | object | `{ id, contactName, email, company, assignedToId }` |
| `qualification` | object | `{ score, confidenceTier, confidenceScore, priority, buyingIntent, urgency, recommendedAction, summary, painPoints, estimatedTimeline, needsManualReview }` |
| `pipelineStage` | string | The `LeadStatus` EYAN already routed the lead to (e.g. `QUALIFIED`, `AI_ANALYZED`, `DISQUALIFIED`) |

---

# Workflow Steps

1. **Webhook - Lead Qualified** (Webhook) — `POST /webhook/crm/lead-qualified`, raw body captured for signature verification.
2. **Prepare Verification Input** / **Compute Expected Signature** / **Verify & Parse** — identical HMAC verification shape to Workflow 1, extended to also require `payload.qualification` (not just `payload.lead.id`).
3. **Signature Valid?** (IF) → **Respond 202 Accepted** (valid) or **Respond 401 Invalid Signature** (invalid).
4. **Assignment Needed?** (IF: lead not already assigned **and** `DEFAULT_SALES_OWNER_ID` is configured) → **Assign Salesperson** (`PATCH /crm/service/leads/:id/assign`, same "EYAN Service API" credential and idempotency contract as Workflows 1-3's write-backs). Both branches converge on the next step — assignment is optional, never blocks notifications.
5. **Slack Configured?** (IF: `SLACK_WEBHOOK_URL` set) → **Send Slack Notification** (HTTP POST, plain incoming-webhook message summarizing lead/score/confidence/stage/recommended action). Skipped, not errored, if unset.
6. **Email Configured?** (IF: `SALES_NOTIFICATION_EMAIL_TO` set) → **Send Email Notification** (n8n native Send Email node, "SMTP Account" credential — not yet created, see `docs/security/credential-management.md`). Skipped, not errored, if unset.

---

# Integrations

- **EYAN AI Platform** (`eyan-ai-platform`) — `Assign Salesperson` calls `/api/v1/crm/service/leads/:id/assign` (new Sprint 5 route, mirrors the existing validation/qualification write-back routes), same "EYAN Service API" credential.
- **Slack** — plain incoming-webhook URL (`SLACK_WEBHOOK_URL`), no n8n credential (see Security below for why).
- **SMTP** — via n8n's native Send Email node and an "SMTP Account" credential (not yet created this session).

---

# Outputs

- A lead may get `assignedToId` set (an `ASSIGNMENT` `LeadActivity` is written EYAN-side by the new `/crm/service/leads/:id/assign` route, same pattern as the existing human-triggered assign flow).
- A Slack message and/or email may be sent. Neither writes anything back to EYAN — this workflow is a one-way notifier once assignment (the only step with a side effect EYAN needs to know about) is done.

---

# Error Handling

Every side-effect step is independently optional and gated behind its own "is this configured" check — an unconfigured step is a normal skip, not a failure. `Send Slack Notification` and `Send Email Notification` both use `onError: continueRegularOutput` so a transient Slack/SMTP outage never fails the whole execution or blocks the other notification channel. There is no retry on these two (unlike the CRM write-back calls) — a missed one-off notification is an acceptable failure mode for a sprint that explicitly scoped out a full notification/reliability system (Workflow 5/6 in the original roadmap language).

---

# Security

Authentication: `Assign Salesperson` uses the "EYAN Service API" credential (ADR-0006), reused rather than duplicated, per that ADR's own guidance for future domains. The inbound webhook uses the same "EYAN Webhook Signing Secret" credential Workflow 1 uses.

Authorization: EYAN's `authenticateService` middleware is the actual authority for the assignment write-back; this workflow has no authorization logic of its own for that call. The webhook's own authorization is the HMAC signature check.

Secrets Used: `AUTOMATION_SERVICE_API_KEY` / `AUTOMATION_WEBHOOK_SIGNING_SECRET` via credential (same as Workflows 1-3). `SLACK_WEBHOOK_URL` is read via `$env` — a deliberate, documented exception (it IS a bearer secret in URL form, unlike `EYAN_API_BASE_URL`; see `docs/security/credential-management.md`'s Notes for the reasoning). SMTP credentials are never in `$env` — n8n's native SMTP credential type.

Sensitive Data: lead contact fields and the qualification summary/reasoning-adjacent fields pass through this workflow into the Slack message and email body — visible in n8n's execution history and, for Slack, in the destination channel's history. No new PII beyond what Workflows 1-3 already handle.

---

# Monitoring

Success Metrics: n8n's execution list; the `ASSIGNMENT` `LeadActivity` row EYAN writes when assignment happens.

Failure Alerts: not configured — this workflow *is* the notification layer; there is no meta-notification for its own failures this sprint.

Logging: n8n's own execution log is the only record of whether a Slack message or email was actually sent (EYAN has no visibility into that half — only into the assignment write-back).

---

# Testing

**Live, end-to-end, the assignment write-back only** (this session): `PATCH /crm/service/leads/:id/assign` was exercised directly against a running `eyan-ai-platform` instance with the exact payload shape `Assign Salesperson` sends — confirmed `assignedToId` set on the lead and an `ASSIGNMENT` `LeadActivity` row written. Slack/email were **not** live-tested — no real Slack workspace or SMTP credentials were available this session (see `docs/security/credential-management.md`); both steps fail closed (skipped) with their env vars unset, which is the state this workflow ships in.

**Algorithm-level, against the actual committed code**: `tests/workflows/crm/04-sales-automation.logic.test.js` extracts the real `jsCode` from `Prepare Verification Input` and `Verify & Parse` (signature computed with Node's own `crypto.createHmac`, not a re-implementation) — 19 assertions covering valid/invalid/stale/malformed/missing-field cases, plus a re-implementation check of the two IF-gate conditions (declarative n8n expressions, not extractable as `jsCode` the way Code nodes are) against representative env states. Run: `node tests/workflows/crm/04-sales-automation.logic.test.js`. All 19 pass.

**Not verified this session**: a live execution through the actual n8n engine (no interactive n8n UI/API-key access, same limitation noted on Workflows 1-3); the Slack and email notification steps end-to-end (no real credentials available); production webhook activation.

---

# Related Documentation

Architecture: `eyan-ai-platform` `docs/ARCHITECTURE.md`

ADR: `docs/adrs/ADR-0005-workflow-organization.md`, `docs/adrs/ADR-0006-crm-workflow-authentication.md`, `eyan-ai-platform` `.claude/decisions/ADR-0018-crm-foundation.md`, `.claude/decisions/ADR-0019-automation-integration-contract.md`

Issue: n/a
