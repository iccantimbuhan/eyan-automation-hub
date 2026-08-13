# WhatsApp Gateway Architecture

Status: Active (test-number phase — see Production-Number Migration Plan below). Since Phase 3B (ADR-0013), non-test messages are dispatched to `workflows/finance/03-whatsapp-finance-entry.json` rather than dead-ending — see the diagram below.

---

# Purpose

Cross-cutting reference for the WhatsApp integration as a whole — how the two workflows fit together, what's configured where, and what changes when moving from Meta's test number to a real production number. Per-workflow detail lives in `docs/workflows/01-whatsapp-gateway-webhook.md` and `docs/workflows/02-whatsapp-outbound-send.md`; the *why* behind each decision lives in `docs/adrs/ADR-0010-whatsapp-outbound-messaging.md` (outbound) and the earlier inbound-gateway implementation.

---

# Architecture

```
WhatsApp customer
      |
      v
Meta WhatsApp Cloud API
      |
      v  (HTTPS, nginx -> 127.0.0.1:5678)
n8n: 01-whatsapp-gateway-webhook.json
      |  GET  -> verify webhook subscription (hub.verify_token)
      |  POST -> parse, validate, fast-ack, normalize
      v
Normalized internal event (whatsappBusinessAccountId, phoneNumberId,
customerWhatsappId, messageId, messageText, ...)
      |
      +-- non-test message --> Ready For AI / CRM Processing (NoOp, kept as
      |                         a named marker) --> Call WhatsApp Finance
      |                         Entry (Execute Workflow)
      |                                 |
      |                                 v
      |                   n8n: workflows/finance/03-whatsapp-finance-entry.json
      |                   (Finance Inbox Request --> Finance Intent Router
      |                    --> ... --> Response --> WhatsApp reply, via
      |                    02-whatsapp-outbound-send.json -- see ADR-0013)
      |
      +-- exact text "eyan-test" --> Build Test Reply Input
                                            |
                                            v
                              n8n: 02-whatsapp-outbound-send.json
                              (Execute Workflow call)
                                            |
                                            v
                              Meta WhatsApp Cloud API
                                            |
                                            v
                                    WhatsApp customer
```

`01-whatsapp-gateway-webhook.json` and `02-whatsapp-outbound-send.json` live under `workflows/integrations/` (not `workflows/crm/` or `workflows/finance/`) — this is a channel gateway, not a business-domain workflow; CRM/Finance/future domains are expected to call `02-whatsapp-outbound-send.json` themselves once they need to send WhatsApp messages, the same way they'd call any other integrations-domain capability. `workflows/finance/03-whatsapp-finance-entry.json` is the first such domain-owned consumer (Phase 3B, ADR-0013) — it lives in `workflows/finance/`, not here, since it is Finance-domain logic (contract mapping, Router dispatch), not channel-gateway logic.

---

# Inbound Webhook

`https://automation.eyan.fyi/webhook/whatsapp/webhook` (GET + POST, single n8n Webhook node). See `docs/workflows/01-whatsapp-gateway-webhook.md`.

# Outbound Messaging

Reusable sub-workflow, `Execute Workflow`-callable, not bound to any one caller. See `docs/workflows/02-whatsapp-outbound-send.md`.

---

# Credential Requirements

| Concept | Where it lives | Secret? |
|---|---|---|
| `WHATSAPP_VERIFY_TOKEN` | `.env`, `$env`-read | Yes (shared secret, no dedicated credential type fits) |
| Meta access token | n8n credential store only (`whatsAppApi` type, "Meta WhatsApp Cloud API") | Yes — **no `.env` mirror**, by design (ADR-0010) |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | n8n credential store (same credential) + `.env` (disaster-recovery reference only, not `$env`-read) | No |
| `WHATSAPP_PHONE_NUMBER_ID` | `.env`, `$env`-read | No |
| `WHATSAPP_GRAPH_API_VERSION` | `.env`, `$env`-read | No |

Full reasoning: `docs/security/credential-management.md`, `docs/adrs/ADR-0010-whatsapp-outbound-messaging.md`.

---

# Test-Number Setup (current state)

- Meta test WhatsApp number: `+1 (555) 195-7017` (Meta-provided, not a real EYAN number).
- `WHATSAPP_PHONE_NUMBER_ID` / `WHATSAPP_BUSINESS_ACCOUNT_ID` in `.env` point at this test number's IDs.
- The Meta access token currently in n8n's credential store is Meta's **temporary development token** for this test number — expected to expire/rotate, treated as disposable.
- Outbound sending is proven end-to-end only through the `"eyan-test"` keyword-gated reply path — there is no automatic/AI-driven reply yet.

---

# Security Rules (summary — see ADR-0010 and credential-management.md for full reasoning)

- Meta access token: never in workflow JSON, `.env`, `.env.example`, git, markdown docs, test fixtures, or logs. Lives only in n8n's encrypted credential store.
- `WHATSAPP_VERIFY_TOKEN`: `.env` only, `$env`-read, never logged or echoed in any response.
- Non-secret config (`WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_GRAPH_API_VERSION`, `WHATSAPP_BUSINESS_ACCOUNT_ID`): fine in `.env` / `.env.example` (as placeholders) since they carry no authority on their own.
- No auto-reply to arbitrary inbound messages — outbound sending only happens via an explicit call (today: the `"eyan-test"` keyword gate; later: an explicit AI/CRM decision, not a blanket "reply to everything").

---

# Production-Number Migration Plan

Not started — this integration currently only targets Meta's test number. When a real EYAN WhatsApp Business number is ready:

1. Complete Meta's WhatsApp Business Account verification for the real number (business verification, display name approval — a Meta-side process, not an n8n change).
2. Obtain a **permanent** (System User) access token for the production WABA — the current token is a temporary per-session development token and is not suitable for production use regardless of number.
3. Update `.env`: `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_BUSINESS_ACCOUNT_ID` to the production number's real values.
4. Re-run `import-whatsapp-credential.sh` (or re-enter via the n8n editor UI) to replace the "Meta WhatsApp Cloud API" credential's `accessToken`/`businessAccountId` with the production values — same credential ID, no workflow JSON change needed.
5. Update the Meta App Dashboard webhook subscription to point at the production number (verify token stays the same unless rotated separately).
6. Remove or further restrict the `"eyan-test"` keyword-reply path before any real customer traffic flows through the production number — it was scaffolding for validating the outbound capability, not intended to reach production as-is (see ADR-0010, Consequences).
7. Re-run the full live test sequence (`docs/workflows/01-whatsapp-gateway-webhook.md` / `02-whatsapp-outbound-send.md` Testing sections) against the production number before considering it live.

---

# Related Documentation

- `docs/adrs/ADR-0010-whatsapp-outbound-messaging.md`
- `docs/adrs/ADR-0013-whatsapp-finance-entry-adapter.md` (the Finance-domain plug-in described above)
- `docs/workflows/01-whatsapp-gateway-webhook.md`
- `docs/workflows/02-whatsapp-outbound-send.md`
- `docs/workflows/03-whatsapp-finance-entry.md`
- `docs/security/credential-management.md`
