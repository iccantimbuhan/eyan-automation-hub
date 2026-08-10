# Credential Management

Status: Active (first real credentials — CRM domain, 2026-07-31; Sprint 5 adds a third credential reference, not yet created — see Notes; AI Finance Inbox Phase 1 adds a fourth, also not yet created — see Notes; Phase 2 adds a fifth, real and created this time — Ollama; WhatsApp Gateway inbound, 2026-08-10, adds a second `$env` exception — no new credential type; WhatsApp outbound, 2026-08-10, adds a sixth credential — the first native, non-generic-auth credential type in this repo, and the first credential deliberately given NO `.env` disaster-recovery mirror, see below)

---

# Purpose

This document describes how EYAN Automation Hub actually stores and uses credentials, now that a first real integration (CRM, `eyan-ai-platform`) exists. It replaces the "future implementation should support..." placeholder this file previously held with the concrete pattern every future domain should follow.

---

# Where Credentials Live

Every credential a workflow needs to call an external system is stored as an **n8n-native credential**, encrypted at rest by n8n's own credential store (`N8N_ENCRYPTION_KEY`, `.env`) — never as a plain value inside a workflow's `parameters`, and never (with one narrow, documented exception below) read via `$env` inside a Code node.

Credentials created via `n8n import:credentials` (see Notes):

| Credential Name | Type | Used By | Purpose |
|---|---|---|---|
| EYAN Service API | HTTP Header Auth | Every `/crm/service/*` **and** (Sprint 5) `/ai-core/service/*` HTTP Request node in `workflows/crm/` | Authenticates n8n's outbound calls to EYAN as `Authorization: Bearer <AUTOMATION_SERVICE_API_KEY>` |
| EYAN Webhook Signing Secret | Crypto | Workflows 1 and (Sprint 5) 4's `Compute Expected Signature` node (Hmac action) | Verifies EYAN's inbound webhook signatures (`AUTOMATION_WEBHOOK_SIGNING_SECRET`) |
| SMTP Account | SMTP | Workflow 4's `Send Email Notification` node | Sends the sales-automation email notification — **referenced by name/id (`SmtpAccountCred01`) in `04-sales-automation.json` but not yet created**; no real SMTP server/credentials were available this session (see Notes). The Email step is gated behind `SALES_NOTIFICATION_EMAIL_TO` being set, so it fails closed (skipped, not a broken node) until this credential exists. |
| Slack API | Slack API (`slackApi`) | `workflows/finance/01-finance-inbox-entry.json`'s `Slack Trigger - Inbox Message` and `Slack - Post Reply` nodes | Authenticates both the inbound Slack Events API signature check and outbound `chat.postMessage` calls — **referenced by name/id (`SlackApiCred01`) but not yet created**; no real Slack App/workspace exists yet (AI Finance Inbox Phase 1). Both nodes have `onError: continueRegularOutput`, so this workflow imports and is safe to leave inactive until the credential exists — same forward-reference posture as SMTP Account above. Note this is a genuine n8n credential (Access Token + Signature Secret fields), not the `$env`-based `SLACK_WEBHOOK_URL` CRM's Workflow 4 uses — that was a one-way incoming-webhook URL with no signature verification; this integration needs to *receive* verified events and reply in a specific channel/DM, which only a real Slack API credential (not a webhook URL) can do. |
| Ollama (Local) | Ollama (`ollamaApi`) | `workflows/finance/02-finance-intent-router.json`'s `Ollama Chat Model` node | Backs the Finance Intent Router's AI Agent (`baseUrl: http://host.docker.internal:11434`, no API key — Ollama has no auth in this local setup). **Real and created** — Ollama connectivity was independently re-verified live this phase (`wget` from inside `eyan-n8n` to `/api/tags`), reusing the exact `host.docker.internal` reachability path ADR-0007 already established for CRM's Workflow 3, so there was a genuine, testable target to create a credential against. This is the first n8n credential in this repo backing a LangChain node rather than an `httpRequest`/`slack`/`crypto` node. |
| Meta WhatsApp Cloud API | WhatsApp API (`whatsAppApi`) | `workflows/integrations/02-whatsapp-outbound-send.json`'s `Send WhatsApp Message` node (`authentication: predefinedCredentialType`, `nodeCredentialType: whatsAppApi`) | Authenticates outbound Meta Graph API calls as `Authorization: Bearer <access token>`. **Real and created** — the first *native, service-specific* credential type in this repo (every prior credential above used a generic type: HTTP Header Auth, Crypto, SMTP, or a service-specific type that still needed manual header wiring). n8n ships this type pre-built for WhatsApp specifically (`accessToken` + `businessAccountId` fields), so no header-wiring decision was needed at all — see `docs/adrs/ADR-0010-whatsapp-outbound-messaging.md`. **Deliberately has NO `.env` disaster-recovery mirror** (see "The One `$env` Exception" below and ADR-0010) — the access token was entered directly into n8n via a self-run terminal script (`import-whatsapp-credential.sh`, silent prompt, immediate shred of the plaintext import file), specifically so it would never pass through the agent session. If the credential store is ever rebuilt, this one credential must be re-entered manually; every other credential in this table can be reconstructed from its `.env` copy. |

See `docs/adrs/ADR-0006-crm-workflow-authentication.md` for the full reasoning — including why these are two different n8n credential *types* (an outbound auth header vs. HMAC secret material are different technical needs, and n8n ships a purpose-built native type for each).

---

# The One `$env` Exception

`EYAN_API_BASE_URL` (a plain URL, e.g. `https://eyan.fyi/api/v1`) is read via `$env` in HTTP Request node URL expressions — it is not a secret, and there is no credential type for "which host to call." This required setting `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` (`.env`), since this n8n version blocks `$env` access by default. No secret is ever read via `$env` anywhere in `workflows/crm/` — a future PR adding a second `$env` reference should be checked against this same rule before being merged.

`WHATSAPP_GRAPH_API_VERSION` and `WHATSAPP_PHONE_NUMBER_ID` (`workflows/integrations/02-whatsapp-outbound-send.json`) are the same kind of exception, for the same reason — a Graph API version pin and a phone number ID are plain config, not secrets, and there's no credential type for either. `WHATSAPP_VERIFY_TOKEN` (`workflows/integrations/01-whatsapp-gateway-webhook.json`) is a *secret* read via `$env`, documented separately above under "no dedicated n8n credential type fits."

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

`WHATSAPP_VERIFY_TOKEN` (WhatsApp Gateway, `workflows/integrations/01-whatsapp-gateway-webhook.json`) is the same kind of exception, for the same reason: it's a static shared secret Meta echoes back on the GET webhook-verification handshake (`hub.verify_token`), compared with a plain `===` in a Code node (`Verify Meta Webhook Challenge`). It isn't an outbound auth header (HTTP Header/Bearer Auth) or HMAC key material (Crypto credential) — no native n8n credential type fits "compare this string," and unlike the CRM signature check (ADR-0006), there's no HMAC computation step a Crypto-node-plus-credential could front for. Never logged, and never included in either webhook response body (403 on mismatch returns a generic error, no echoed token).

---

# Related Documents

- `docs/adrs/ADR-0006-crm-workflow-authentication.md`
- `docs/adrs/ADR-0005-workflow-organization.md`
- `docs/architecture/security-architecture.md`
- `eyan-ai-platform` `.claude/decisions/ADR-0019-automation-integration-contract.md`

# Notes

Credentials were created this sprint via `n8n import:credentials --input=<file>` rather than the editor UI — the only way to seed them without interactive n8n login/API-key access. This requires an explicit `"id"` field in the JSON (a not-null database constraint, not documented in `n8n import:credentials --help`) and encrypts the plaintext `data` field automatically at import time. Confirmed by reading `ImportCredentialsCommand`'s actual source (`/usr/local/lib/node_modules/n8n/dist/commands/import/credentials.js` inside the running container) — n8n's own docs don't spell out the encryption-on-import behavior.
