# Sprint 2 Development Log — CRM Automation Hub (Workflows 1 & 2)

Sprint: 2

Status: Complete

---

# Objective

Implement the Automation Hub side of the CRM integration contract `eyan-ai-platform` Sprint 2 built (`.claude/decisions/ADR-0019-automation-integration-contract.md`): Workflow 1 (Lead Intake) and Workflow 2 (Validation), signed webhook verification, service authentication, and a dummy qualification payload — proving the cross-system contract end-to-end before real AI qualification (Sprint 3 / `.claude/decisions/ADR-0020-ai-provider-contract.md`, `eyan-ai-platform`) is built.

Per the sprint brief: no Ollama, OpenAI, Gemini, or Claude call; no notifications; no Workflow 3.

---

# Deliverables

Completed:

- `workflows/crm/01-lead-intake.json` — Webhook trigger, HMAC-SHA256 signature verification (raw-body-exact, 5-minute freshness window), calls Workflow 2 on success.
- `workflows/crm/02-validation.json` — required-field validation, dedupe check (self-match-aware), `VALIDATED`/`DISQUALIFIED` write-back, and a dummy/stub qualification write-back completing the `NEW → VALIDATED → AI_ANALYZED` chain.
- Two n8n-native credentials: "EYAN Service API" (HTTP Header Auth) and "EYAN Webhook Signing Secret" (Crypto) — see `docs/adrs/ADR-0006-crm-workflow-authentication.md`.
- Environment: `EYAN_API_BASE_URL`, `AUTOMATION_SERVICE_API_KEY`, `AUTOMATION_WEBHOOK_SIGNING_SECRET`, `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` (`.env`, `.env.example`).
- `docs/adrs/ADR-0005-workflow-organization.md` (finally written — was scaffolded empty since Sprint 0/1) and `docs/adrs/ADR-0006-crm-workflow-authentication.md` (new).
- `docs/security/credential-management.md` (finally written).
- `docs/workflows/01-lead-intake.md`, `docs/workflows/02-validation.md` (per `templates/workflow/workflow-template.md`).
- Live end-to-end verification against a real, temporary `eyan-ai-platform` backend instance (see Validation below).

Not built (explicit sprint exclusions): any real AI provider call, notifications, Workflow 3.

---

# Key Architectural Decisions

See the two new ADRs for full rationale. Summary:

1. **Workflow chaining**: Workflow 1 calls Workflow 2 via n8n's native Execute Workflow / Execute Workflow Trigger pair, not a message bus — each workflow independently re-runnable, per the original TDD design.
2. **Credentials over `$env` for both secrets**: `AUTOMATION_SERVICE_API_KEY` → HTTP Header Auth credential; `AUTOMATION_WEBHOOK_SIGNING_SECRET` → Crypto credential (native Hmac action, not `require('crypto')` in a Code node). The only `$env` reference anywhere in these two workflows is `EYAN_API_BASE_URL`, a plain URL.
3. **Self-match-aware dedupe check**: Workflow 2's dedupe lookup always finds the lead being validated (EYAN persisted it before the webhook fired) — a genuine duplicate is a *different* lead ID for the same email, not any match at all. Caught and fixed during design, before implementation (not a bug found in testing).
4. **Dummy qualification payload lives inside Workflow 2**, not a separate "Workflow 3" file — Workflow 3 (real AI) doesn't exist yet, and building an empty placeholder file for it would be scope creep beyond what this sprint asked for. The dummy payload proves the exact contract Workflow 3 will use.
5. **A repo-boundary conflict was resolved before implementation began**: the parent sprint's brief listed this repo's implementation as in-scope only after `eyan-ai-platform`'s own Sprint 2 explicitly deferred it — confirmed with the user before any code was written here.

---

# Validation

- Both workflow JSON files import cleanly via `n8n import:workflow` against the live, real n8n 2.33.3 instance (`eyan-n8n`) — not just schema-plausible, actually accepted by this exact n8n version.
- **Signature verification logic**: the exact algorithm used by Workflow 1's Code nodes was run standalone in plain Node against a real HMAC signature — valid signature accepted; tampered body, wrong secret, stale timestamp, and malformed JSON all correctly rejected (5/5 cases).
- **Full chain, live**: a temporary `eyan-ai-platform` backend instance was started (spare port, throwaway `AUTOMATION_SERVICE_API_KEY`/`AUTOMATION_WEBHOOK_SIGNING_SECRET` matching this repo's own, production `:3001` untouched), reachable from the n8n container via the Docker bridge gateway. Workflow 1 was executed with a real, correctly-signed webhook payload (via a temporarily-injected trigger output matching n8n's actual documented Webhook-raw-body shape, confirmed by reading `Webhook.node.js` source directly — `n8n execute` cannot simulate a live HTTP call to a Webhook trigger, a real CLI limitation documented in ADR-0005 Notes) → correctly called Workflow 2 → dedupe check → `VALIDATED` write-back → dummy qualification write-back → lead reached `AI_ANALYZED` with the expected score/priority, confirmed independently via `GET /crm/service/leads?email=`.
- **Duplicate detection**: a second lead sharing the first's email was correctly identified as a genuine duplicate (not a self-match) and marked `DISQUALIFIED`.
- **Idempotency**: replaying an already-succeeded execution ID with deliberately different (wrong) values did not overwrite the original result — confirmed against the real `WorkflowExecutionLog`-backed check `eyan-ai-platform` built in its own Sprint 2.
- All test leads, the temporary EYAN backend process, and every test-only workflow modification (pinData, injected test nodes) were removed after verification — only the clean, final workflow JSON is imported into the live instance.
- Production webhook *activation* (the n8n editor's Active toggle) was not exercised — this session has no interactive n8n UI/API-key access, and activation involves an internal versioning mechanism beyond a simple database flag (discovered and documented in ADR-0005 Notes rather than worked around further). The workflow imports correctly and is ready to activate through the editor.

---

# Lessons Learned

- This n8n version blocks `$env` access by default — a change from older n8n defaults this session initially assumed. Discovering it via a real failed execution (rather than assuming success) caught a design gap before it shipped silently broken.
- `n8n import:workflow`/`import:credentials` both require an explicit `id` field — a real, currently-undocumented CLI behavior (a raw Postgres not-null constraint error, not a friendly CLI message) now recorded in ADR-0005 for the next person.
- `n8n execute` cannot simulate a Webhook trigger — verifying Workflow 1's downstream logic required combining a standalone algorithm test with a live chain test triggered from a temporarily-injected node, rather than one clean CLI invocation.
- A stale, unrelated leftover process (from prior `eyan-ai-platform` sessions) intercepted early smoke-test traffic during that repo's own Sprint 2 — this sprint's own verification here was run from a clean process each time and cross-checked directly against the target lead's state via EYAN's own API, not just n8n's execution log, specifically to avoid repeating that class of mistake.

---

# Next Sprint

Two independent follow-ups, neither started or approved:

1. **`eyan-ai-platform` side**: update `backend/.env` with the same `AUTOMATION_SERVICE_API_KEY`/`AUTOMATION_WEBHOOK_SIGNING_SECRET` values now configured here, and activate these two workflows through the n8n editor, before this integration is live end-to-end outside of throwaway test instances.
2. **Sprint 3 (real AI qualification)**, per `eyan-ai-platform` ADR-0020: implement Workflow 3, replacing Workflow 2's dummy qualification payload with a real Ollama call (provider abstraction, prompt versioning, retry/confidence/fallback policy all already specified).
