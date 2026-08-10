# ADR-0010: WhatsApp Outbound Messaging

- Status: Accepted
- Date: 2026-08-10
- Authors: Claude Code

---

# Context

`ADR-000?`-equivalent groundwork for this domain didn't exist yet — `workflows/integrations/01-whatsapp-gateway-webhook.json` (built in an earlier session) only covers the inbound half: Meta webhook verification, safe payload parsing, and normalization into an internal event. It deliberately stopped there — no AI, no CRM, no outbound reply capability. This ADR covers the first outbound capability: a reusable "send a WhatsApp message" operation, plus a **controlled, explicitly-gated** test path that proves the full inbound → outbound loop works against Meta's test number without risking an uncontrolled auto-reply loop.

# Decision

**Credential: native n8n `whatsAppApi` credential type**, not a generic HTTP Header Auth credential (which is what `workflows/crm/` uses for the EYAN Service API, per ADR-0006). n8n ships a purpose-built credential type for this (`accessToken` + `businessAccountId` fields, auto-injects `Authorization: Bearer <token>`) — using it is both less setup and, per this n8n version's own HTTP Request node property hints, the officially preferred choice ("Prefer predefinedCredentialType whenever n8n already ships a credential for the target service"). The credential is named "Meta WhatsApp Cloud API", ID `MetaWhatsAppCloudApiCred01`.

**Sending goes through a plain `httpRequest` node with `authentication: predefinedCredentialType` / `nodeCredentialType: whatsAppApi`, not n8n's native WhatsApp Business Cloud node.** The native node (`n8n-nodes-base.whatsApp`) hard-codes its Graph API base URL to `v13.0` internally (confirmed by reading `GenericFunctions.js` in this n8n build) — a version old enough that Meta may have already sunset it (Meta's 2026 docs point to v21.0+, and versions are typically supported ~2 years). Using the native node would silently pin this integration to a version with no override mechanism. The `httpRequest` node gets the same credential-based auth without that lock-in, and matches the exact pattern already established in `workflows/crm/` (`Call AI Core`, `Submit Qualification` — HTTP Request + credential, never a raw header).

**Graph API version is `$env`-configurable (`WHATSAPP_GRAPH_API_VERSION`, currently `v21.0`), not hard-coded in the workflow.** Same posture as `EYAN_API_BASE_URL` (ADR-0006): a plain, non-secret config value, not something that belongs in a credential. `WHATSAPP_PHONE_NUMBER_ID` is `$env`-configurable for the same reason — the phone number to send *from* is deployment config, not something to bake into a workflow node (a WABA can have multiple numbers; hard-coding one here would foreclose the multi-tenant direction ADR-0005/the original WhatsApp Gateway design already commits to).

**`WHATSAPP_ACCESS_TOKEN` is NOT mirrored in `.env`, unlike every other secret in this repo.** Every existing credential (`AUTOMATION_SERVICE_API_KEY`, `AUTOMATION_WEBHOOK_SIGNING_SECRET`, `WHATSAPP_VERIFY_TOKEN`) keeps a plaintext copy in `.env` purely as a disaster-recovery re-import reference (`docs/security/credential-management.md`). This one deliberately breaks that pattern: the operator required the token never pass through the agent session or chat transcript at all, so it was entered directly into n8n's encrypted credential store via a **self-run terminal script** (`import-whatsapp-credential.sh` — silent `read -s` prompt, writes a plaintext import file, runs `n8n import:credentials`, shreds the file, all executed by the operator in their own terminal, never by the agent). The agent never saw the value. Consequence: if the n8n credential store is ever rebuilt from scratch, this one credential has no re-import copy and must be re-entered manually — an accepted, explicit tradeoff for this specific secret, not an oversight.

**Outbound sending is a separate, reusable sub-workflow** (`workflows/integrations/02-whatsapp-outbound-send.json`), called via `Execute Workflow` — same cross-workflow pattern as ADR-0005 (CRM Workflow 1 → 2 → 3 → 4). It accepts `{ to, messageType, text, contextTag }` and returns `{ success, messageId, to }` or `{ success: false, error }`. `contextTag` is a free-text audit label only (e.g. `"gateway-test-reply"`) — never used for control flow. Only `messageType: "text"` is implemented this phase; template messages are a documented future extension, not built speculatively now.

**The inbound gateway's only new behavior is a keyword-gated test-reply branch**, not a general auto-responder. `01-whatsapp-gateway-webhook.json`'s `Normalize WhatsApp Messages` now feeds into `Is Test Keyword Message?` — an exact, case-insensitive match on the *entire* inbound message text against the literal string `"eyan-test"`. Only a match calls the outbound sub-workflow; everything else (including every real customer message) still just normalizes and stops at the pre-existing `Ready For AI / CRM Processing` NoOp, completely unchanged from before this ADR. This is deliberately conservative — Phase 4 explicitly asked for a controlled test path, not an automatic response to every inbound message, and a later milestone (AI/CRM-driven replies) is expected to replace this gate entirely rather than build on top of it.

**No persistence layer added for loop-safety, and no persistence layer needed.** Three things independently make an inbound→outbound→inbound loop structurally impossible here, none of which require a database:
1. Meta's webhook payload already separates customer messages (`value.messages`) from delivery/read status callbacks for messages *we* sent (`value.statuses`) — `Parse WhatsApp Payload` (pre-existing) only ever extracts `messages`. A status callback for our own test reply can never become a normalized message, so it can never reach the keyword gate at all.
2. Meta's Cloud API does not echo an app's own outbound sends back through that same app's inbound webhook as a new customer message — there is no delivery path by which our reply could ever appear as inbound traffic in the first place.
3. Even hypothetically, the test reply's own text (`"[EYAN TEST REPLY] Received your test message..."`) is not the literal string `"eyan-test"`, so it would fail the exact-match gate anyway — a second, independent safeguard.

If a future milestone needs to distinguish inbound/outbound/status events by message ID for some other reason (e.g. deduplicating retried Meta deliveries — already flagged as deferred in `01-whatsapp-gateway-webhook.json`), that's a separate, narrower persistence decision to make explicitly at that time, not a blanket database added speculatively now.

# Alternatives Considered and Rejected

- **n8n's native WhatsApp Business Cloud node** — rejected due to the hard-coded `v13.0` Graph API version with no override.
- **Auto-reply to every inbound message** — explicitly out of scope per the task; rejected in favor of the keyword gate.
- **A message-log table (Postgres) to track inbound vs. outbound** — rejected as unjustified for this phase; see loop-safety reasoning above. Revisit only if a concrete future need (e.g. true retry deduplication) requires it.
- **Mirroring `WHATSAPP_ACCESS_TOKEN` in `.env` like every other secret** — rejected per explicit operator instruction for this one credential; documented as a conscious exception, not silent drift from the established pattern.

# Consequences

- Rotating the Meta access token means re-entering it directly in n8n (editor UI or the same self-run CLI-import script) — there is no `.env` copy to fall back on for this one credential.
- `WHATSAPP_GRAPH_API_VERSION` needs periodic manual review against Meta's changelog; nothing in this repo currently automates that check.
- The keyword-gated test path is intentionally throwaway scaffolding for validating the outbound capability end-to-end — a future AI/CRM-driven reply workflow should replace, not extend, `Is Test Keyword Message?`.
- `WhatsappOutboundSendWf01` is reusable by any future caller (AI/CRM workflows, other channels' outbound needs), not just the test path.

# Related Documents

- `docs/adrs/ADR-0005-workflow-organization.md` (cross-workflow call convention)
- `docs/adrs/ADR-0006-crm-workflow-authentication.md` (credential pattern this ADR extends)
- `docs/security/credential-management.md`
- `docs/workflows/01-whatsapp-gateway-webhook.md`
- `docs/workflows/02-whatsapp-outbound-send.md`
- `docs/workflows/whatsapp-gateway-architecture.md`

# Notes

The `whatsAppApi` credential was imported via `n8n import:credentials` (matching ADR-0006's CLI-driven precedent), but via a script the *operator* ran themselves in their own terminal session (silent prompt, immediate shred of the plaintext file) rather than the agent performing the import directly — the only way to seed this specific credential without the token ever appearing in the agent's tool calls or this repository's session history.
