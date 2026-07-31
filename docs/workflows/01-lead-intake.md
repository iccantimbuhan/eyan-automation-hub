# CRM - 01 - Lead Intake

Status: Active (imported, inactive by default — see Testing)

Category: CRM

Owner: Automation Hub

Version: 1.0

---

# Purpose

Receives the signed webhook EYAN fires when a new Lead is created (`eyan-ai-platform`, `CrmLeadService.create()` → `AutomationWebhookService`), verifies it really came from EYAN, and hands the lead off to Workflow 2 (Validation) — the entry point for the whole CRM automation chain.

---

# Trigger

- Webhook — `POST /webhook/crm/lead-intake`

---

# Inputs

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `X-Eyan-Signature` header | string | Yes | `sha256=<hex hmac>` — see Security |
| `X-Eyan-Timestamp` header | string | Yes | Unix ms, must be within 5 minutes of receipt |
| Body | JSON | Yes | `{ contractVersion, event: "lead.created", lead: { id, contactName, email, phone, company, industry, companySize, source, createdAt } }` |

---

# Workflow Steps

1. **Webhook - Lead Intake** — receives the request; "Raw Body" is enabled so the exact bytes EYAN signed are captured (not a re-serialization of the parsed JSON).
2. **Prepare Verification Input** (Code) — decodes the raw body, extracts/strips the signature header, checks the timestamp is within the 5-minute freshness window.
3. **Compute Expected Signature** (Crypto, Hmac action, "EYAN Webhook Signing Secret" credential) — computes the expected HMAC over `${timestamp}.${rawBody}`.
4. **Verify & Parse** (Code) — compares the computed and received signatures, checks freshness, parses the raw body into a `lead` object. Never trusts the body until the signature has already passed.
5. **Signature Valid?** (IF) — branches on the result of step 4.
   - **True**: responds `202 Accepted` immediately (`Respond 202 Accepted`), then builds the sub-workflow input (`Build Sub-Workflow Input` — attaches `$execution.id` as the `workflowExecutionId`) and calls Workflow 2 (`Call Workflow 2 - Validation`). The response has already been sent by this point — EYAN's dispatch never waits on Workflow 2.
   - **False**: responds `401` with the specific rejection reason (`Respond 401 Invalid Signature`).

---

# Integrations

- EYAN AI Platform (`eyan-ai-platform`) — inbound webhook source; this workflow makes no outbound calls to EYAN itself (Workflow 2 does).

---

# Outputs

- `202` response to EYAN (signature valid) or `401` (signature invalid/stale/malformed) — EYAN's dispatch is fire-and-forget and doesn't read this response body (see `eyan-ai-platform` ADR-0019 Decision 1), so this is for direct/manual testing and n8n's own execution log, not a contract EYAN depends on.
- A Workflow 2 execution, passed `{ lead, workflowExecutionId }`.

---

# Error Handling

Every rejection reason (invalid signature, stale timestamp, malformed JSON, missing lead payload) is a distinct, explicit branch outcome, not a generic failure — visible in n8n's execution log and in the `401` response body. No retry logic exists on this side (verification is a synchronous check with a deterministic outcome, not a transient-failure-prone external call). This workflow does not call `/crm/service/*` — no `WorkflowExecutionLog` row is written for a rejected or accepted intake; the first execution-log row appears once Workflow 2 begins.

---

# Security

Authentication: HMAC-SHA256 signature verification (no other auth — this is an inbound webhook, matching the design in `eyan-ai-platform` ADR-0019 Decision 1).

Authorization: n/a — the signature check is both authentication and the only authorization this endpoint needs.

Secrets Used: `AUTOMATION_WEBHOOK_SIGNING_SECRET`, via the "EYAN Webhook Signing Secret" n8n credential (never `$env`, never a Code node's `require('crypto')`) — see ADR-0006.

Sensitive Data: the lead's contact fields (name, email, phone) pass through this workflow — logged only in n8n's own execution history, not forwarded anywhere beyond Workflow 2.

---

# Monitoring

Success Metrics: n8n's built-in execution list (filterable by workflow) is the source of truth for this workflow's run history — no separate EYAN-side telemetry exists for Workflow 1 itself (see Error Handling).

Failure Alerts: not configured this sprint — a named follow-up once notification workflows exist (Sprint 5 per the TDD).

Logging: n8n's own execution log only.

---

# Testing

Test Cases (verified this sprint against a real, temporary EYAN instance and real HMAC signatures — see `tasks/completed/`):

- Valid signature, fresh timestamp → accepted, Workflow 2 invoked.
- Tampered body → rejected (signature mismatch).
- Wrong secret → rejected (signature mismatch).
- Stale timestamp (>5 min) → rejected.
- Malformed JSON body → rejected.

`n8n execute --id=<id>` cannot simulate a Webhook trigger (n8n CLI limitation — see ADR-0005 Notes), so this workflow's downstream logic was verified two ways: (1) the exact verification algorithm run standalone in plain Node against real valid/invalid signatures (all five cases above passed), and (2) the full Workflow 1 → Workflow 2 chain executed live via a temporarily-injected trigger payload matching n8n's actual documented Webhook-with-raw-body output shape (confirmed by reading `Webhook.node.js` source directly), which also completed successfully end-to-end. Full production webhook activation (via the n8n editor's Active toggle) was not exercised this sprint — activation requires interactive UI access not available to this session; the workflow imports correctly and is ready to activate.

Expected Results: see Test Cases above; all passed.

---

# Related Documentation

Architecture: `eyan-ai-platform` `docs/ARCHITECTURE.md` ("Sprint 2 — Automation Integration Contract")

ADR: `eyan-ai-platform` `.claude/decisions/ADR-0019-automation-integration-contract.md`, `docs/adrs/ADR-0005-workflow-organization.md`, `docs/adrs/ADR-0006-crm-workflow-authentication.md`

Issue: n/a
