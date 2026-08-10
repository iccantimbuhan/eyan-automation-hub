# WhatsApp Gateway — Webhook

Status: Active

Category: Integrations

Owner: EYAN Automation Hub

Version: 1.1 (adds the keyword-gated test-reply branch — see ADR-0010)

---

# Purpose

Receive inbound WhatsApp traffic from Meta's Cloud API (webhook verification + incoming messages), normalize it into a channel-agnostic internal event, and hand off to whatever processes it next — currently the keyword-gated test-reply path (ADR-0010); a future AI/CRM workflow is expected to replace that.

---

# Trigger

Single `n8n-nodes-base.webhook` node, `multipleMethods: true`, listening on both `GET` and `POST` at `whatsapp/webhook` (production URL: `https://automation.eyan.fyi/webhook/whatsapp/webhook`).

---

# Inputs

**GET** (Meta's webhook verification handshake):

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `hub.mode` | query string | Yes | Must equal `subscribe` |
| `hub.verify_token` | query string | Yes | Compared against `WHATSAPP_VERIFY_TOKEN` |
| `hub.challenge` | query string | Yes | Echoed back verbatim on success |

**POST** (Meta WhatsApp Business Account webhook event — see [Meta's webhooks reference](https://developers.facebook.com/docs/graph-api/webhooks/getting-started)): a `whatsapp_business_account` envelope, batched (`entry[].changes[].value`), containing either `messages` (inbound customer messages) or `statuses` (delivery/read receipts for our own outbound sends).

---

# Workflow Steps

1. **GET branch**: `Verify Meta Webhook Challenge` compares `hub.verify_token` against `$env.WHATSAPP_VERIFY_TOKEN` → `Respond - Challenge OK` (200, raw challenge text) or `Respond - Verification Failed` (403, generic body — token never echoed either way).
2. **POST branch**: `Parse WhatsApp Payload` safely parses the envelope, extracts every `messages[]` entry across all batched `entry`/`changes`, ignores `statuses`-only payloads.
3. `Is WhatsApp Business Event?` → 400 if the payload isn't a `whatsapp_business_account` envelope at all.
4. `Has Messages?` → 200 `{received:true,ignored:true}` if it's a valid envelope with no messages (e.g. a status callback) — **this is the mechanism that makes status callbacks for our own outbound sends structurally unable to trigger a reply, see ADR-0010**.
5. If there are messages: **fast 200 ack first** (`Respond - Message Received`), then `Normalize WhatsApp Messages` runs in the background, producing one internal event per message.
6. `Is Test Keyword Message?` (added in ADR-0010): if the message text is *exactly* `"eyan-test"` (case-insensitive), build a reply and call `WhatsappOutboundSendWf01`. Otherwise, unchanged from before ADR-0010 — stop at `Ready For AI / CRM Processing` (a NoOp placeholder for the next milestone).

---

# Integrations

- Meta WhatsApp Cloud API (inbound only — no outbound calls happen in this workflow directly; the test-reply branch delegates to `WhatsappOutboundSendWf01`)

---

# Outputs

Normalized event (see `workflows/integrations/01-whatsapp-gateway-webhook.json`'s `Normalize WhatsApp Messages` node): `whatsappBusinessAccountId`, `phoneNumberId`, `customerWhatsappId`, `customerDisplayName`, `messageId`, `messageType`, `messageText`, `messageTimestamp`, `rawMessage` (original Meta payload, preserved for audit).

---

# Error Handling

Malformed JSON, non-WhatsApp payloads, and status-only callbacks are all handled explicitly (400 / 200-ignored) rather than throwing. Meta's own body parser rejects genuinely malformed JSON before the workflow even runs (422, observed in testing).

---

# Security

**Authentication**: `WHATSAPP_VERIFY_TOKEN` — plain shared secret, `$env`-read (documented exception, no dedicated n8n credential type fits a GET query-param comparison — see `docs/security/credential-management.md`). Never logged, never echoed on failure.

**Secrets used**: `WHATSAPP_VERIFY_TOKEN` only. No Meta access token is used or needed by this workflow (that's `02-whatsapp-outbound-send.json`'s concern).

**Sensitive data**: inbound message text/sender IDs are customer data — currently only held in n8n execution history (no external persistence).

---

# Monitoring

Success/failure visible via n8n's execution list. No external logging/alerting configured yet.

---

# Testing

`tests/workflows/integrations/01-whatsapp-gateway-webhook.logic.test.js` (Code node logic, zero dependencies, `node tests/workflows/integrations/01-whatsapp-gateway-webhook.logic.test.js`). Live GET/POST tests documented in the implementation reports for this workflow (verification handshake, real/status/malformed payloads, keyword-gated reply, loop-safety).

---

# Related Documentation

- `docs/adrs/ADR-0010-whatsapp-outbound-messaging.md`
- `docs/workflows/02-whatsapp-outbound-send.md`
- `docs/workflows/whatsapp-gateway-architecture.md`
- `docs/security/credential-management.md`
