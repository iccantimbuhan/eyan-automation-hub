# WhatsApp - 02 - Outbound Send

Status: Active

Category: Integrations

Owner: EYAN Automation Hub

Version: 1.0

---

# Purpose

Reusable, callable capability for sending a WhatsApp message through Meta's Cloud API. Not bound to any one caller — the keyword-gated test-reply branch in `01-whatsapp-gateway-webhook.json` calls it today; a future AI/CRM-driven reply workflow is expected to call it too, unchanged.

---

# Trigger

`n8n-nodes-base.executeWorkflowTrigger` (`inputSource: passthrough`) — called via `Execute Workflow`, never invoked directly by an external request.

---

# Inputs

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `to` | string | Yes | Recipient WhatsApp ID / E.164 phone number |
| `messageType` | string | Yes | Only `"text"` is implemented; anything else is rejected with a clear reason |
| `text` | string | Yes (for `messageType: "text"`) | Message body |
| `contextTag` | string | No | Free-text audit label (e.g. `"gateway-test-reply"`) — never affects control flow |

---

# Workflow Steps

1. `Validate Send Input` — required-field/type checks, never throws.
2. `Send Input Valid?` → `Result - Invalid Input` (`{success:false, error:{type:'invalid_input', ...}}`) if not.
3. `Build Graph API Request` — builds Meta's `messages` request body (`messaging_product`, `to`, `type`, `text.body`, `preview_url: false`).
4. `Send WhatsApp Message` — `POST https://graph.facebook.com/{WHATSAPP_GRAPH_API_VERSION}/{WHATSAPP_PHONE_NUMBER_ID}/messages`, authenticated via the native `whatsAppApi` credential ("Meta WhatsApp Cloud API"). `onError: continueRegularOutput` — a failed call surfaces as `$json.error`, never crashes the caller.
5. `Map Send Result` — normalizes both the success shape (`messages[0].id`, `contacts[0].wa_id`) and the error shape into `{success, messageId, to}` or `{success:false, error}`.

---

# Integrations

- Meta WhatsApp Cloud API (`POST /{version}/{phone_number_id}/messages`)

---

# Outputs

`{success: true, messageId, to}` on success; `{success: false, error: {type, message}}` on either invalid input (`type: 'invalid_input'`) or a Meta API failure (`type: 'meta_api_error'`).

---

# Error Handling

Both invalid input and Meta API failures return a structured result to the caller rather than throwing — the caller (e.g. the inbound gateway's test-reply branch) decides what to do with a failed send.

---

# Security

**Authentication**: native n8n `whatsAppApi` credential ("Meta WhatsApp Cloud API", ID `MetaWhatsAppCloudApiCred01`) — `accessToken` + `businessAccountId`, encrypted at rest, auto-injected as `Authorization: Bearer <token>`. Never referenced by value anywhere in this workflow's `parameters` — only by credential ID/name, same rule as `docs/security/credential-management.md` established for CRM.

**Secrets used**: the Meta access token, held only in the credential store — see ADR-0010 for why it has no `.env` disaster-recovery mirror (deliberate exception to this repo's usual convention).

**Non-secret config**: `WHATSAPP_GRAPH_API_VERSION`, `WHATSAPP_PHONE_NUMBER_ID` — `$env`-read, same posture as `EYAN_API_BASE_URL`.

---

# Monitoring

Visible via n8n's execution list (as a sub-workflow execution under whatever caller invoked it).

---

# Testing

`tests/workflows/integrations/02-whatsapp-outbound-send.logic.test.js`. Live test: one real send to the Meta test number, confirmed delivered, documented in the implementation report.

---

# Related Documentation

- `docs/adrs/ADR-0010-whatsapp-outbound-messaging.md`
- `docs/workflows/01-whatsapp-gateway-webhook.md`
- `docs/workflows/whatsapp-gateway-architecture.md`
- `docs/security/credential-management.md`
