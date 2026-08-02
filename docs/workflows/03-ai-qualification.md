# CRM - 03 - AI Qualification

Status: Active (imported, inactive by default — see Testing). Sprint 5: re-pointed at `eyan-ai-platform`'s AI Core instead of calling Ollama directly.

Category: CRM

Owner: Automation Hub

Version: 2.0

---

# Purpose

Sprint 3 built a real, provider-agnostic AI qualification step that called Ollama directly from this workflow. Sprint 5's brief made that a rule violation ("do not bypass AI Core, do not call providers directly") — `eyan-ai-platform` had, in parallel, built a `lead-qualification` AI Core Capability (Brain, versioned prompt, routing policy, confidence-tier computation) that nothing actually called yet. This version re-points the workflow at that Capability over HTTP instead: n8n no longer selects a provider, loads a prompt file, or runs its own retry loop — AI Core's `AiRoutingService` already does all of that (brain/routing-policy resolution, up to 3 retries, HIGH/MEDIUM/LOW confidence-tier computation from the model's own numeric confidence). This workflow's job shrinks to: call the Capability, map its response onto the CRM's qualification write-back contract, and hand off to `Submit Qualification` — same downstream contract Sprint 2/3 already proved, unchanged.

---

# Trigger

- Execute Workflow Trigger (called by Workflow 2 — see `02-validation.md`). `inputSource: passthrough`, so it also runs standalone with manually-provided test data without any code change.

---

# Inputs

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `lead` | object | Yes | `{ id, contactName, email, phone, company, industry, companySize, source, createdAt }` — forwarded from Workflow 2 |
| `workflowExecutionId` | string | Yes | n8n's own execution ID — the ADR-0019 idempotency key |

---

# Workflow Steps

1. **When Called by Another Workflow** (Execute Workflow Trigger) — receives `{ lead, workflowExecutionId }`.
2. **Load Config** (Code) — no longer resolves provider/prompt/threshold config (AI Core owns all of that now); just carries `lead`/`workflowExecutionId` forward and records `startedAt` for duration tracking.
3. **Call AI Core** (HTTP Request, `onError: continueRegularOutput`) — `POST {EYAN_API_BASE_URL}/ai-core/service/capabilities/lead-qualification/invoke`, authenticated via the same "EYAN Service API" credential `Submit Qualification` already used (ADR-0006 — no new credential). Body: `{ input: { contactName, email, phone, company, industry, companySize, source, createdAt }, context: { expectJson: true, workflowName, workflowExecutionId } }`. A 300s timeout matches AI Core's own routing-policy timeout. Failures are captured as data (`$json.error`), not a stopped workflow — same resilience posture the old `Call Ollama` node had.
4. **Map AI Core Result** (Code) — replaces the old Select Provider / Load Prompt Template / Build Initial Prompt / Prepare Attempt / Call Ollama / Classify Ollama Result / Outcome Router / Check Retry Budget / Prepare Retry chain in full:
   - `outcome: "VALID"` with a parsed `outputJson` → flattens the AI's fields (`leadScore` rounded, `budgetEstimate` split into `budgetEstimateMin/Max/Currency`, etc.) into the qualification payload, carries `confidence` (AI Core's own HIGH/MEDIUM/LOW tier — a **new** field, `confidenceTier`, driving EYAN's Phase 4 pipeline auto-routing) and `needsManualReview` straight through from AI Core's response rather than recomputing them. `MEDIUM` tier gets the same `[AI-assisted, review recommended]` annotation on `recommendedAction` as before.
   - Any other outcome (`SCHEMA_INVALID`, `TRANSIENT_FAILURE`, `DEFINITIVE_FAILURE` — AI Core already exhausted its own retries by the time it returns one of these) or an HTTP-level failure reaching AI Core at all → a manual-review payload (`needsManualReview: true`, `leadScore`/`confidence` 0, no `confidenceTier` so EYAN leaves the lead at `AI_ANALYZED` rather than auto-routing on data it doesn't trust) — same "never strand a lead" guarantee as Sprint 3, just with a single unified failure branch instead of three classified ones (the classification/retry work now happens once, inside AI Core, not duplicated here).
5. **Submit Qualification** (`PATCH /crm/service/leads/:id/qualification`) — same endpoint, same credential, unchanged. The one new field in the body, `confidenceTier`, is additive — EYAN's validator accepts it optionally.

---

# Integrations

- **EYAN AI Platform — AI Core** (`eyan-ai-platform`) — `Call AI Core` hits `/api/v1/ai-core/service/capabilities/lead-qualification/invoke`, authenticated via the "EYAN Service API" credential (same one, reused — ADR-0006). This route is new (Sprint 5); it mirrors `/crm/service/*`'s auth pattern exactly, added as a separate route group rather than folding into the human-JWT `/ai-core/capabilities/*` surface (that architecture is frozen per `eyan-ai-platform`'s ADR-0021).
- **EYAN AI Platform — CRM** (`eyan-ai-platform`) — `Submit Qualification` calls `/api/v1/crm/service/*`, unchanged from Sprint 3.
- Ollama is no longer called from this repo at all — it's now exclusively AI Core's concern, one hop away, inside `eyan-ai-platform`.

---

# Outputs

- The lead's EYAN-side status moves to `AI_ANALYZED`, then (Sprint 5, EYAN-side) auto-routes to `QUALIFIED` (HIGH confidence) or `DISQUALIFIED` (LOW confidence) — `MEDIUM`/missing tier stays at `AI_ANALYZED` as the review bucket. Score/priority/confidence and the full AI analysis persist in `LeadAiAnalysis`; `rawResponse` on that row now also contains AI Core's routing metadata (brain, outcome, retryCount, latencyMs) verbatim.
- A `WorkflowExecutionLog` row (`workflowName: "03-ai-qualification"`), an `AI_ANALYSIS` `LeadActivity`, a `STATUS_CHANGE` activity for the pipeline move (if any), and an `AUTOMATION` activity recording the recommended next action — all EYAN-side (Sprint 5 additions), not new work in this workflow.
- An `AiUsageLog` row on the AI Core side, written automatically by `AiRoutingService` the moment `Call AI Core` runs — this workflow gets full AI-invocation audit trail for free, without emitting anything extra itself.

---

# Error Handling

AI Core now owns retry/backoff and failure classification internally (its `AiRoutingPolicy`, `maxRetries: 3`) — this workflow only distinguishes two cases:

1. **AI Core returned a non-VALID outcome** (it already retried internally and gave up) — `Map AI Core Result` builds a manual-review payload with the outcome in `errorMessage`.
2. **The HTTP call to AI Core itself failed** (network error, AI Core unreachable) — same manual-review payload, `errorMessage` prefixed `[request_failed]`.

Both still submit through the same `Submit Qualification` contract — a lead is never stranded at `VALIDATED`.

---

# Security

Authentication: outbound calls to EYAN (both `Call AI Core` and `Submit Qualification`) use the "EYAN Service API" credential (ADR-0006) — the same credential, reused across both, per ADR-0006's "any future domain reusing `AUTOMATION_SERVICE_API_KEY` should reuse the same credential" guidance.

Authorization: EYAN's `authenticateService` middleware is the actual authority for both routes; this workflow has no authorization logic of its own.

Secrets Used: `AUTOMATION_SERVICE_API_KEY` via credential. `EYAN_API_BASE_URL` is plain config via `$env` (not a secret). No Ollama-specific config (`OLLAMA_BASE_URL`, `AI_PROVIDER`, etc.) is read from this workflow anymore — that's entirely AI Core's concern now, inside `eyan-ai-platform`.

Sensitive Data: lead contact fields pass through this workflow as before; the model's full analysis (including `reasoning`) is no longer visible in this workflow's own execution history in as much detail as before (it arrives already-summarized in AI Core's response) but is still fully captured in `LeadAiAnalysis.rawResponse` on the EYAN side.

---

# Monitoring

Success Metrics: n8n's execution list; `WorkflowExecutionLog`/`LeadAiAnalysis` on the EYAN side, plus (new, Sprint 5) `AiUsageLog` for per-invocation AI Core telemetry (outcome, retryCount, latencyMs).

Failure Alerts: not configured (Workflow 5 / notifications — still not built; see `04-sales-automation.md` for the narrower notification scope that *was* built this sprint).

Logging: n8n's own execution log; `LeadAiAnalysis.rawResponse` remains the full audit trail per analysis attempt, now inclusive of AI Core's own routing metadata.

---

# Testing

**Live, end-to-end against real infrastructure** (this session): a real lead was created via `POST /crm/leads`, manually validated via `PATCH /crm/service/leads/:id/validation` (simulating Workflow 2's write-back), then `Call AI Core`'s exact HTTP request was replayed by hand against the running `eyan-ai-platform` backend (real Postgres, real Ollama `qwen2.5-coder:7b`) — a real `VALID` outcome came back (`leadScore: 30, confidence: 0.3, tier: LOW, needsManualReview: true`, `latencyMs: 205382`). The resulting payload was then submitted to `Submit Qualification` exactly as `Map AI Core Result` would build it, and confirmed end-to-end in the database: `LeadAiAnalysis` row written correctly; lead auto-routed `NEW → VALIDATED → AI_ANALYZED → DISQUALIFIED` (LOW tier, Phase 4); `LeadActivity` rows for `AI_ANALYSIS`, the pipeline `STATUS_CHANGE`, and the recommended-action `AUTOMATION` activity all present and correctly worded; `WorkflowExecutionLog` rows for both write-backs; an `AiUsageLog` row written automatically with the correct `capabilityId`/`outcome`/`latencyMs`. Test lead and its rows were deleted after verification.

**Algorithm-level, against the actual committed code**: `tests/workflows/crm/03-ai-qualification.logic.test.js` was rewritten for the new `Map AI Core Result` node (the old file tested the now-deleted `Classify Ollama Result`/`Compute Confidence and Route` nodes) — 25 assertions covering the VALID/HIGH/MEDIUM/LOW paths, `budgetEstimate` flattening (including the null case), every non-VALID AI Core outcome, and the network-failure path. Run: `node tests/workflows/crm/03-ai-qualification.logic.test.js`. All 25 pass.

**Not verified this session**: production webhook/workflow activation via the n8n UI (no interactive n8n UI/API-key access this session, same limitation as prior sprints); a live execution *through the actual n8n engine* with these exact node changes (the equivalent Sprint 3 round-trip test) — the live verification above replayed the same HTTP calls by hand against the real backend rather than through n8n's executor, since this session had container/API access to the backend and Ollama but not an interactive n8n session. The workflow JSON itself was updated and is ready to import; a live n8n-engine execution round is recommended before flipping `active: true`.

---

# Related Documentation

Architecture: `eyan-ai-platform` `docs/ARCHITECTURE.md`

ADR: `eyan-ai-platform` `.claude/decisions/ADR-0020-ai-provider-contract.md` (superseded in part by Sprint 5 — AI Core now owns what this ADR originally scoped to this workflow), `.claude/decisions/ADR-0021-ai-core-foundation.md` (the Capability/Brain/RoutingService architecture this workflow now depends on), `docs/adrs/ADR-0005-workflow-organization.md`, `docs/adrs/ADR-0006-crm-workflow-authentication.md`, `docs/adrs/ADR-0007-n8n-ollama-connectivity-gap.md` (no longer this repo's concern, but explains why AI Core's own Ollama connectivity works)

Issue: n/a
