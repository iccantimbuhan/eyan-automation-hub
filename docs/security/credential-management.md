# Credential Management

Status: Active (first real credentials — CRM domain, 2026-07-31; Sprint 5 adds a third credential reference, not yet created — see Notes)

---

# Purpose

This document describes how EYAN Automation Hub actually stores and uses credentials, now that a first real integration (CRM, `eyan-ai-platform`) exists. It replaces the "future implementation should support..." placeholder this file previously held with the concrete pattern every future domain should follow.

---

# Where Credentials Live

Every credential a workflow needs to call an external system is stored as an **n8n-native credential**, encrypted at rest by n8n's own credential store (`N8N_ENCRYPTION_KEY`, `.env`) — never as a plain value inside a workflow's `parameters`, and never (with one narrow, documented exception below) read via `$env` inside a Code node.

Two credentials exist today, both created via `n8n import:credentials` (see Notes):

| Credential Name | Type | Used By | Purpose |
|---|---|---|---|
| EYAN Service API | HTTP Header Auth | Every `/crm/service/*` **and** (Sprint 5) `/ai-core/service/*` HTTP Request node in `workflows/crm/` | Authenticates n8n's outbound calls to EYAN as `Authorization: Bearer <AUTOMATION_SERVICE_API_KEY>` |
| EYAN Webhook Signing Secret | Crypto | Workflows 1 and (Sprint 5) 4's `Compute Expected Signature` node (Hmac action) | Verifies EYAN's inbound webhook signatures (`AUTOMATION_WEBHOOK_SIGNING_SECRET`) |
| SMTP Account | SMTP | Workflow 4's `Send Email Notification` node | Sends the sales-automation email notification — **referenced by name/id (`SmtpAccountCred01`) in `04-sales-automation.json` but not yet created**; no real SMTP server/credentials were available this session (see Notes). The Email step is gated behind `SALES_NOTIFICATION_EMAIL_TO` being set, so it fails closed (skipped, not a broken node) until this credential exists. |

See `docs/adrs/ADR-0006-crm-workflow-authentication.md` for the full reasoning — including why these are two different n8n credential *types* (an outbound auth header vs. HMAC secret material are different technical needs, and n8n ships a purpose-built native type for each).

---

# The One `$env` Exception

`EYAN_API_BASE_URL` (a plain URL, e.g. `https://eyan.fyi/api/v1`) is read via `$env` in HTTP Request node URL expressions — it is not a secret, and there is no credential type for "which host to call." This required setting `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` (`.env`), since this n8n version blocks `$env` access by default. No secret is ever read via `$env` anywhere in `workflows/crm/` — a future PR adding a second `$env` reference should be checked against this same rule before being merged.

---

# How a Future Workflow Domain Adds a Credential

1. Determine what n8n credential *type* actually fits the need — an outbound API key/token is almost always **HTTP Header Auth** or **HTTP Bearer Auth** (predefined credential types n8n already ships); HMAC/signing secrets use the native **Crypto** credential type; a full OAuth flow uses n8n's OAuth2 credential type. Avoid inventing a workaround (e.g. `$env`, or a Set node holding a "secret" field) when a native type already exists.
2. Create the credential through the n8n editor UI (the normal path — this sprint used CLI import instead, see Notes, because it was the only path available without interactive editor access) or via `n8n import:credentials` with a plaintext JSON file that is written outside version control and deleted immediately after import.
3. Reference it from the node's `credentials` object — never copy the secret value into `parameters`.
4. If the credential is a platform-level shared secret reused across domains (per `eyan-ai-platform` ADR-0018 Decision 6 — e.g. `AUTOMATION_SERVICE_API_KEY`), reuse the existing "EYAN Service API" credential rather than creating a duplicate.

---

# Secrets Never Committed

`.env` holds the actual secret values (for re-import if the credential store is ever rebuilt); `.env.example` holds only placeholders. Both `AUTOMATION_SERVICE_API_KEY` and `AUTOMATION_WEBHOOK_SIGNING_SECRET` must match the same values configured in `eyan-ai-platform/backend/.env` — confirmed matching and working end-to-end against a live local `eyan-ai-platform` instance this session (Sprint 5; that repo's own `.env` previously had these two unset entirely). Rotating either secret is a paired procedure across both repos (update both `.env` files, update the two n8n credentials here, restart both services) — not yet scripted, a candidate for a future operations runbook entry.

`SLACK_WEBHOOK_URL` (Sprint 5, Workflow 4) is a deliberate, narrow exception to "no secret via `$env`" above — Slack incoming-webhook URLs are bearer-in-URL secrets, but n8n has no dedicated "webhook URL" credential type and building a generic-credential workaround for a single, disable-by-omission notification step was judged not worth the added indirection this sprint. Documented here as the actual practice, not silently deviating from the stated rule.

---

# Related Documents

- `docs/adrs/ADR-0006-crm-workflow-authentication.md`
- `docs/adrs/ADR-0005-workflow-organization.md`
- `docs/architecture/security-architecture.md`
- `eyan-ai-platform` `.claude/decisions/ADR-0019-automation-integration-contract.md`

# Notes

Credentials were created this sprint via `n8n import:credentials --input=<file>` rather than the editor UI — the only way to seed them without interactive n8n login/API-key access. This requires an explicit `"id"` field in the JSON (a not-null database constraint, not documented in `n8n import:credentials --help`) and encrypts the plaintext `data` field automatically at import time. Confirmed by reading `ImportCredentialsCommand`'s actual source (`/usr/local/lib/node_modules/n8n/dist/commands/import/credentials.js` inside the running container) — n8n's own docs don't spell out the encryption-on-import behavior.
