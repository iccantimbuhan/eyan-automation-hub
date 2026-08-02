# Sprint 4 Development Log — AI Core Re-Point + Sales Automation

Sprint: 4 (this repo's own numbering — "Sprint 5" in the cross-repo brief that drove this work, tracked against `eyan-ai-platform`'s sprint sequence, not this repo's)

Status: Complete

---

# Objective

Two changes, driven by a cross-repo sprint brief ("AI Sales Qualification & CRM Automation") whose non-negotiable rules included "do not bypass AI Core" / "do not call providers directly" / "n8n orchestrates only":

1. **Re-point Workflow 3 at AI Core.** Sprint 3 built a real, working AI qualification step — but it called Ollama directly, which by this sprint's own rules is exactly the thing to stop doing, now that `eyan-ai-platform` has a working `lead-qualification` AI Core Capability (seeded, schema-matched, but never actually called by any code before this sprint).
2. **Build the sales-automation consumer.** The brief describes a workflow that receives a finished qualification result and does sales-facing automation (assign, notify). This repo's own roadmap had reserved this as a never-built "Workflow 5" — it didn't exist in either repo. Built here as Workflow 4.

Per the brief: reuse everything that already exists (the CRM contract, the credential pattern, the HMAC verification shape); only implement what's missing.

---

# Deliverables

Completed:

- `workflows/crm/03-ai-qualification.json` — rewritten: the 11-node direct-Ollama chain (Select Provider / Load Prompt Template / Build Initial Prompt / Prepare Attempt / Call Ollama / Classify Ollama Result / Outcome Router / Check Retry Budget / Prepare Retry / Build Manual Review Payload / Build Unsupported Provider Payload) is replaced by 3 nodes (Load Config / Call AI Core / Map AI Core Result) that call `eyan-ai-platform`'s new `POST /ai-core/service/capabilities/lead-qualification/invoke` route and map its response onto the same `Submit Qualification` contract, unchanged.
- `workflows/crm/04-sales-automation.json` (new) — `CrmSalesAutomationWf01`, 13 nodes: webhook trigger + HMAC verification (same shape as Workflow 1) → conditional salesperson assignment → conditional Slack notification → conditional email notification. Each side-effect step is independently skippable via its own env-var gate.
- `tests/workflows/crm/03-ai-qualification.logic.test.js` — rewritten for the new `Map AI Core Result` node (the old file tested nodes that no longer exist). 25 assertions, all passing.
- `tests/workflows/crm/04-sales-automation.logic.test.js` (new) — 19 assertions covering the webhook signature verification (reusing Workflow 1's HMAC shape) and the assignment-gating logic. All passing.
- `docs/workflows/03-ai-qualification.md` (rewritten) and `docs/workflows/04-sales-automation.md` (new).
- `docs/adrs/ADR-0005-workflow-organization.md`, `docs/security/credential-management.md`, `.env.example`, `ROADMAP.md` — updated for the new route/credential/env-var references.

Not built (explicit scope decisions, not oversights):

- **A real salesperson-routing engine.** `DEFAULT_SALES_OWNER_ID` is a single configurable owner, not round-robin/territory/skill-based routing — no such system exists anywhere in either repo to extend, and building one wasn't asked for. Flagged as technical debt.
- **The "SMTP Account" n8n credential.** Referenced by the workflow (`SmtpAccountCred01`) but not created — no real SMTP server/credentials were available this session. The Email step fails closed (skipped) without it.
- **A scheduled/delayed follow-up sender.** The brief's "follow-up after X days" is satisfied by an `AUTOMATION` `LeadActivity` EYAN already writes with a computed due-date in its metadata (`eyan-ai-platform`, Phase 5) — an actual reminder-sending mechanism (a scheduled digest workflow querying overdue follow-ups) does not exist and wasn't built; this is genuinely new infrastructure, not a repointing.

---

# Key Architectural Decisions

1. **AI Core's retry/classification logic is not duplicated in n8n.** The old Workflow 3 had its own three-class failure taxonomy (schema-invalid/transient/definitive) and its own retry loop. AI Core's `AiRoutingService` already does equivalent work (its own `AiRoutingPolicy.maxRetries`) before ever returning a response to n8n — keeping both would mean two independent retry policies stacked on each other, and "AI logic belongs in AI Core" from the sprint's own non-negotiable rules. `Map AI Core Result` now just distinguishes "AI Core returned a usable result" from "it didn't" (whatever the reason) — a single manual-review fallback branch instead of three classified ones.
2. **The new `/ai-core/service/*` route reuses the existing service-auth credential**, not a new one — `eyan-ai-platform`'s `ai-capability.controller.ts` had an explicit comment anticipating exactly this ("Phase 3 ... mirroring how CRM's own /crm/service/* routes were added"), confirming this was the intended extension point, not a new pattern invented for this sprint.
3. **Workflow 4 does not re-derive pipeline stage.** The brief's flow diagram shows `CRM Lead Updated → n8n Workflow → Sales Automation` — by the time Workflow 4's webhook fires, EYAN has already fully applied the qualification result (pipeline transition, Activities). Workflow 4 only reads `pipelineStage` from the payload for its Slack/email message text; it never calls any status-changing endpoint. Re-deriving it would duplicate business logic the brief explicitly puts inside CRM, not n8n.
4. **`SLACK_WEBHOOK_URL` via `$env`, not a credential** — a deliberate, narrow exception to this repo's own "no secret via `$env`" convention (ADR-0006/credential-management.md), justified because n8n has no purpose-built "webhook URL" credential type and the step is fully optional (disabled by omission). Documented explicitly rather than silently deviating from the stated rule.

---

# Validation

**Live, against real infrastructure** (this session — a running `eyan-ai-platform` backend, real Postgres, real Ollama with `qwen2.5-coder:7b` pulled): a lead was created, validated, and qualified by replaying `Call AI Core`'s exact HTTP request by hand against the live backend — a genuine `VALID` outcome came back (`leadScore: 30, confidence: 0.3, tier: LOW`, `latencyMs: 205382`, i.e. ~3.4 minutes for this model on this hardware). Submitting that result through `Submit Qualification`'s exact contract confirmed, in the database: the lead auto-routed `NEW → VALIDATED → AI_ANALYZED → DISQUALIFIED` (LOW-tier pipeline routing, `eyan-ai-platform` Phase 4); a `LeadAiAnalysis` row; `AI_ANALYSIS`, `STATUS_CHANGE`, and `AUTOMATION` `LeadActivity` rows in the right order and with the right wording; two `WorkflowExecutionLog` rows; and an `AiUsageLog` row written automatically by AI Core with the correct `capabilityId`/`outcome`/`latencyMs` — the full Sprint 5 audit-trail claim (Phase 8), confirmed with zero purpose-built audit code, exactly as designed. `Assign Salesperson`'s exact contract was also exercised directly and confirmed (`assignedToId` set, `ASSIGNMENT` activity written). All test data was deleted after verification.

**Not achieved this session**: an execution through n8n's own engine with the new workflow JSON (no interactive n8n UI/API-key access — the live verification above replayed the same HTTP calls by hand against the real backend, proving the backend side works correctly against exactly the payloads these workflows would send, but not that n8n's executor itself runs the new node graphs without a typo). The workflow JSON files are ready to import; a live n8n-engine round (mirroring how Workflows 1-3 were originally verified, per their own dev logs) is recommended before flipping either to `active: true`. Slack and email notifications were not live-tested (no real credentials available).

---

# Next Sprint (Recommendations, Not Committed Work)

1. Live n8n-engine execution of both changed/new workflows (via temporary trigger-input injection, matching the CLI-limitation workaround Workflows 1-3 already established) before production activation.
2. Create the "SMTP Account" credential once real SMTP details are available; live-test the email step.
3. A real Slack workspace/webhook to live-test `Send Slack Notification`.
4. If salesperson assignment needs to be more than a single default owner, that's new scope (a routing engine), not a repointing — flag explicitly if requested rather than silently expanding this sprint's footprint.
