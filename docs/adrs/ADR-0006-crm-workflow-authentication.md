# ADR-0006: CRM Workflow Authentication & Credentials

- Status: Accepted
- Date: 2026-07-31
- Authors: Claude Code

---

# Context

`eyan-ai-platform`'s `.claude/decisions/ADR-0019-automation-integration-contract.md` fixes the cross-system *protocol*: EYAN signs outbound webhook calls with HMAC-SHA256 (`AUTOMATION_WEBHOOK_SIGNING_SECRET`), and n8n authenticates its own outbound calls to EYAN with a static bearer token (`AUTOMATION_SERVICE_API_KEY`). That ADR deliberately doesn't prescribe *how n8n itself* should hold and use those two secrets — this ADR fixes that, for Workflow 1 (Lead Intake) and Workflow 2 (Validation), and for every future workflow domain that reuses the same shared secrets (ADR-0018 Decision 6, `eyan-ai-platform`).

# Decision

**`AUTOMATION_SERVICE_API_KEY` → n8n-native HTTP Header Auth credential** ("EYAN Service API"). Every HTTP Request node calling `/api/v1/crm/service/*` sets `authentication: genericCredentialType`, `genericAuthType: httpHeaderAuth`, and references this credential — never a raw header parameter, never `$env`. n8n encrypts credential data at rest using `N8N_ENCRYPTION_KEY` (already configured for this instance); this is a stronger storage posture than an env var read directly by workflow code, and it's the mechanism the TDD's own §6 anticipated ("n8n-native credentials ... for the EYAN service API key").

**`AUTOMATION_WEBHOOK_SIGNING_SECRET` → n8n-native Crypto credential** ("EYAN Webhook Signing Secret", `hmacSecret` field). Workflow 1's signature verification uses the native Crypto node's `Hmac` action against this credential — not a Code node computing `require('crypto')` HMAC by hand. Two reasons: first, it's the same encrypted-storage benefit as the header-auth credential above; second, and just as important, it means Workflow 1 never needs to `require()` a Node built-in inside a Code node at all — n8n's Code node sandbox is explicitly documented (via its own builder guidance surfaced in the node's property schema) to block network-capable modules, and while `crypto` specifically may or may not be restricted in this instance, there was no reason to find out empirically when a native, purpose-built node already does the job correctly.

**`EYAN_API_BASE_URL` → `$env`, the one exception.** This is a plain URL, not a secret, so every HTTP Request node's URL expression reads `{{ $env.EYAN_API_BASE_URL }}` directly. This n8n version blocks `$env` access from node expressions by default (discovered this sprint — an `ExpressionError: access to env vars denied` when the flag is unset, which is the opposite of what older n8n defaults led us to expect going in). `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` is now set in `.env`, documented there as narrowly scoped: the only `$env` reference anywhere in `workflows/crm/` is this one non-sensitive base URL. No node in either workflow reads a secret via `$env`.

**Signature comparison is a plain string `===`, not `crypto.timingSafeEqual`.** Deliberate, not an oversight: the comparison already avoids `require('crypto')` (decision above), and the threat model differs from EYAN's own `authenticateService` comparison (`eyan-ai-platform` `middleware/service-auth.middleware.ts`, which does use `timingSafeEqual`) — that middleware gates a request an external caller can direct at will and repeatedly time; this comparison runs inside n8n's own internal workflow engine, reachable only after a request has already passed nginx/n8n's webhook routing, not something an external caller can isolate and time independently of full HTTP round-trip noise. If this assumption changes (e.g. this exact comparison becomes reachable in a lower-latency, more isolated context), revisit.

# Alternatives Considered and Rejected

- **Both secrets via `$env` in Code nodes** — the original plan going into this sprint, before the native Crypto credential type was discovered mid-implementation. Rejected once found: encrypted-at-rest credential storage is strictly better than an env var every workflow process can read, for no added complexity (n8n already ships the exact node needed).
- **`require('crypto')` in a Code node** for HMAC computation and/or comparison — rejected in favor of the native Crypto node, sidestepping the Code node's module-access sandbox entirely rather than relying on it permitting `crypto` specifically.
- **`crypto.timingSafeEqual` for the signature comparison** — would require `require('crypto')` again (see above) for a threat this comparison's actual position in the request path doesn't clearly justify; noted as revisitable, not dismissed outright.

# Consequences

- No workflow node in `workflows/crm/` ever holds a secret value in its own `parameters` — always via a `credentials` reference. Reviewing a workflow JSON for "does this leak a secret" is a one-line grep for `credentials` vs. `parameters`.
- Rotating either secret means updating the two n8n credential records (and the matching `eyan-ai-platform/backend/.env` values) — never editing workflow JSON.
- A future workflow domain (support, finance, marketing) reusing `AUTOMATION_SERVICE_API_KEY` (ADR-0018 Decision 6) reuses the same "EYAN Service API" credential unchanged — no new credential to create.
- The one `$env` exception (`EYAN_API_BASE_URL`) is auditable as non-sensitive by construction — if a future workflow ever needs a second `$env` value, that addition should be reviewed against this same "is it actually a secret" test before being added.

# Related Documents

- `eyan-ai-platform` `.claude/decisions/ADR-0019-automation-integration-contract.md` (the protocol this ADR implements)
- `eyan-ai-platform` `.claude/decisions/ADR-0018-crm-foundation.md` Decision 6 (platform-level secret naming, for future domain reuse)
- `ADR-0005-workflow-organization.md` (file/naming/ID conventions this ADR's workflows follow)
- `docs/security/credential-management.md`
- `docs/workflows/01-lead-intake.md`

# Notes

Both n8n credentials were created via `n8n import:credentials --input=<file>` (a plaintext JSON with `data` fields, encrypted by n8n at import time using `N8N_ENCRYPTION_KEY` — confirmed by reading `ImportCredentialsCommand`'s actual source in this n8n version) rather than through the editor UI, matching this sprint's CLI-driven deployment approach. The plaintext credential JSON files were written to a location outside version control, imported, and deleted immediately after — never committed.
