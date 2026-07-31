# CRM - 02 - Validation

Status: Active (imported, inactive by default — see Testing)

Category: CRM

Owner: Automation Hub

Version: 1.0

---

# Purpose

Validates a lead's required fields, checks for a duplicate lead by email, and writes the result back to EYAN — marking the lead `VALIDATED` or `DISQUALIFIED`. On success, hands off to Workflow 3 (real AI qualification, Sprint 3 — see `eyan-ai-platform` ADR-0020 and `03-ai-qualification.md`), which replaced Sprint 2's dummy/stub qualification payload.

---

# Trigger

- Execute Workflow Trigger (called by Workflow 1 — see `01-lead-intake.md`). `inputSource: passthrough`, so it also runs standalone with manually-provided test data (e.g. via the n8n editor's "Test workflow" or a temporarily pinned/injected input) without any code change.

---

# Inputs

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `lead` | object | Yes | `{ id, contactName, email, phone, company, industry, companySize, source, createdAt }` — forwarded from Workflow 1 |
| `workflowExecutionId` | string | Yes | n8n's own execution ID (`$execution.id` from Workflow 1) — the ADR-0019 idempotency key |

---

# Workflow Steps

1. **When Called by Another Workflow** (Execute Workflow Trigger) — receives `{ lead, workflowExecutionId }`.
2. **Validate Payload** (Code) — checks `contactName` is present and `email` is a plausible address.
3. **Payload Valid?** (IF)
   - **False** → **Mark Disqualified - Invalid Payload** (`PATCH /crm/service/leads/:id/validation`, `status: DISQUALIFIED`, `errorMessage` set to the specific validation failure) → end.
   - **True** → continue.
4. **Dedupe Check** (`GET /crm/service/leads?email=`) — looks up any existing lead for this email. This *always* finds the current lead itself (EYAN already persisted it before the webhook fired), so a self-match is not a duplicate.
5. **Check Duplicate** (Code) — compares the found lead's `id` against the current lead's own `id`; only a *different* `id` counts as a genuine duplicate.
6. **Is Duplicate?** (IF)
   - **True** → **Mark Disqualified - Duplicate** (same PATCH shape, `errorMessage: "Duplicate lead..."`) → end.
   - **False** → continue.
7. **Mark Validated** (`PATCH .../validation`, `status: VALIDATED`).
8. **Build Workflow 3 Input** (Code) — reconstructs `{ lead, workflowExecutionId }` (the HTTP response from "Mark Validated" replaced `$json`, so this pulls from `Check Duplicate`'s own output, same pattern Workflow 1 uses before calling this workflow).
9. **Call Workflow 3 - AI Qualification** (Execute Workflow) — real AI qualification (Sprint 3, see `03-ai-qualification.md`); moves the lead to `AI_ANALYZED` with a real (or, on failure, manual-review-flagged) score/priority.

---

# Integrations

- EYAN AI Platform (`eyan-ai-platform`) — every HTTP Request node in this workflow calls `/api/v1/crm/service/*`, authenticated via the "EYAN Service API" credential (ADR-0006).

---

# Outputs

- The lead's EYAN-side status moves to `VALIDATED`/`DISQUALIFIED`, and (on the happy path) further to `AI_ANALYZED` via Workflow 3's real AI qualification.
- Two `WorkflowExecutionLog` rows are written on EYAN's side per successful run (one per `PATCH` call that succeeds) — `02-validation` and, on the happy path, `03-ai-qualification`.
- A `LeadActivity` row per status/analysis change, visible on the Lead Detail Timeline in EYAN's CRM UI, attributed to no user (`actorId: null` — system-originated).

---

# Error Handling

Every branch (invalid payload, duplicate, validated+qualified) writes a real, distinguishable outcome back to EYAN — no branch is a silent no-op. Idempotency: every `PATCH` call carries `workflowExecutionId` + `workflowName`; EYAN checks its own `WorkflowExecutionLog` for a prior `SUCCESS` before applying the mutation, so a replayed execution (e.g. a retried Workflow 1 call) is a safe no-op rather than a duplicate write — verified this sprint by re-submitting an already-succeeded execution with deliberately different (wrong) values and confirming the original result was preserved, not overwritten.

If EYAN rejects a `PATCH` (e.g. an illegal lifecycle transition, a validation error) the HTTP Request node surfaces it as a node execution error — this sprint did not add explicit n8n-level error-branch handling (e.g. an "On Error" continue path) for that case; a lead stuck mid-chain due to an EYAN-side rejection is visible in n8n's execution log as a failed run, not silently dropped, but isn't yet automatically routed anywhere. Named follow-up, not a silent gap.

---

# Security

Authentication: outbound calls to EYAN use the "EYAN Service API" HTTP Header Auth credential (ADR-0006) — never a value in node `parameters`.

Authorization: EYAN's `authenticateService` middleware is the actual authority; this workflow has no authorization logic of its own.

Secrets Used: `AUTOMATION_SERVICE_API_KEY`, via credential (see above). `EYAN_API_BASE_URL` (not a secret) via `$env`.

Sensitive Data: lead contact fields pass through every node in this workflow; no external system beyond EYAN itself sees them.

---

# Monitoring

Success Metrics: n8n's execution list; EYAN's `WorkflowExecutionLog` table (queryable once EYAN builds a UI for it — not yet, per that repo's own roadmap).

Failure Alerts: not configured this sprint.

Logging: n8n's own execution log; EYAN's `LeadActivity`/`WorkflowExecutionLog` rows.

---

# Testing

Test Cases (all verified live this sprint against a real, temporary EYAN instance — see `tasks/completed/`):

- Valid lead, no existing duplicate → `VALIDATED` → Workflow 3 called → `AI_ANALYZED`, score/priority set correctly (Sprint 2 exercised this with a dummy payload built inline; Sprint 3 replaced that with a real call to Workflow 3 — see `03-ai-qualification.md` for that workflow's own test coverage). Confirmed independently via `GET /crm/service/leads?email=`.
- A second lead sharing the first lead's email → correctly identified as a genuine duplicate (not a self-match) → `DISQUALIFIED` with the duplicate reason.
- Replayed execution (same `workflowExecutionId`, deliberately different/wrong values) → original result preserved, not overwritten — idempotency confirmed.
- Invalid payload (missing `contactName`) → `DISQUALIFIED` with the specific validation reason (exercised incidentally during debugging this sprint; branch logic confirmed correct).

Run via `n8n execute --id=CrmValidationWf01` (this trigger type is CLI-executable, unlike Workflow 1's Webhook trigger — see ADR-0005 Notes), with a temporarily-injected test input node standing in for real caller data (discarded after testing, never committed).

Expected Results: see Test Cases above; all passed.

---

# Related Documentation

Architecture: `eyan-ai-platform` `docs/ARCHITECTURE.md` ("Sprint 2 — Automation Integration Contract")

ADR: `eyan-ai-platform` `.claude/decisions/ADR-0019-automation-integration-contract.md`, `.claude/decisions/ADR-0020-ai-provider-contract.md` (the contract Workflow 3 implements), `docs/adrs/ADR-0005-workflow-organization.md`, `docs/adrs/ADR-0006-crm-workflow-authentication.md`

Issue: n/a
