# CRM - 03 - AI Qualification

Status: Active (imported, inactive by default — see Testing). Real Ollama connectivity resolved — see Security and ADR-0007.

Category: CRM

Owner: Automation Hub

Version: 1.0

---

# Purpose

Replaces Sprint 2's dummy/stub qualification payload with a real, provider-agnostic AI qualification step (`eyan-ai-platform` ADR-0020): loads a versioned prompt, calls the configured AI provider, validates the response against the frozen JSON schema, retries on failure, applies the three-tier confidence policy, and writes the result back to EYAN through the exact same contract Sprint 2 already proved. Only Ollama is implemented this sprint; the architecture (config-driven provider selection, a single schema-validation gate every provider branch converges on) supports adding OpenAI/Claude/Gemini later without a redesign.

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
2. **Load Config** (Code) — reads every provider/prompt/retry/confidence/timeout setting from `$env`, with defaults (ADR-0020: nothing here is hardcoded). `AI_PROVIDER` is the one value an operator changes to swap providers.
3. **Select Provider** (Switch, config-driven on `provider`) — routes to the `ollama` branch, or a fallback ("Unsupported Provider") for any other value.
   - **Unsupported Provider** → **Build Unsupported Provider Payload** (Code) — a real, deliberate definitive-failure outcome (not a fake implementation of the missing provider) → **Submit Qualification**, `needsManualReview: true`.
4. **Load Prompt Template** (Read/Write Files From Disk, read) — loads `lead-qualification.{promptVersion}.md` from the read-only mounted `workflows/crm/prompts/` (ADR-0020 Decision 2: prompts are never embedded in a node).
5. **Build Initial Prompt** (Code) — parameterizes the template with the lead's fields.
6. **Prepare Attempt** (Code) — a stable re-entry point for the retry loop; both the first attempt and every retry flow through here so downstream nodes have one consistent place to read "the state used for this attempt" from.
7. **Call Ollama** (HTTP Request, `onError: continueRegularOutput`) — `POST {OLLAMA_BASE_URL}/api/chat`, matching `eyan-ai-platform`'s own `OllamaProvider` request shape. Failures are captured as data, not a stopped workflow.
8. **Classify Ollama Result** (Code) — parses the model's response (tolerating markdown fences / surrounding prose despite prompt instructions), validates it against the full AI JSON schema (ADR-0020 Decision 3), and classifies the outcome: `valid`, `schema_invalid`, `transient` (timeout/5xx/connection error), or `definitive` (400/401/403/404 — the provider itself rejected the request).
9. **Outcome Router** (Switch) — branches on the classification:
   - **valid** → **Compute Confidence and Route** (Code) — three-tier policy (ADR-0020 Decision 6): High (≥0.75) automated; Medium (0.4–0.75) automated with the `recommendedAction` annotated `[AI-assisted, review recommended]`; Low (<0.4) → `needsManualReview: true`. → **Submit Qualification**.
   - **retryable** (`schema_invalid` or `transient`) → **Check Retry Budget** (IF: `retryCount < maxRetries`).
     - **true** → **Prepare Retry** (Code) — increments `retryCount`; for `schema_invalid`, appends the model's own bad output plus the specific validation error to the prompt (ADR-0020 Decision 5's corrective-retry shape) → loops back to **Prepare Attempt**.
     - **false** (retries exhausted) → **Build Manual Review Payload**.
   - **definitive** → **Build Manual Review Payload** directly, no retry (ADR-0020 Decision 8, class 3).
   - **Unexpected** (defensive fallback) → **Build Manual Review Payload**.
10. **Build Manual Review Payload** (Code) — every non-`valid` terminal outcome writes back through the same contract, `needsManualReview: true`, `errorMessage` describing exactly what failed → **Submit Qualification**.
11. **Submit Qualification** (`PATCH /crm/service/leads/:id/qualification`) — the same endpoint and payload shape Sprint 2's dummy payload already exercised; Sprint 3 changes what produces the payload, never the contract receiving it.

---

# Integrations

- **Ollama** — `POST {OLLAMA_BASE_URL}/api/chat`, no n8n credential (ADR-0020 Decision 1 — a local network call, not a hosted API needing a key). Reachable via `http://host.docker.internal:11434` (`docker-compose.yml`'s `extra_hosts: host.docker.internal:host-gateway` on the `n8n` service) — see ADR-0007.
- **EYAN AI Platform** (`eyan-ai-platform`) — `Submit Qualification` calls `/api/v1/crm/service/*`, authenticated via the "EYAN Service API" credential (ADR-0006), identical to Workflows 1/2.

---

# Outputs

- The lead's EYAN-side status moves to `AI_ANALYZED`, with a real (or, on failure, manual-review-flagged) score/priority/confidence and the full AI analysis persisted in `LeadAiAnalysis`.
- A `WorkflowExecutionLog` row (`workflowName: "03-ai-qualification"`) and a `LeadActivity` row (`type: AI_ANALYSIS`), same as Sprint 2's dummy payload produced.

---

# Error Handling

Three failure classes (ADR-0020 Decision 8), each with a distinct, real outcome — never a silent drop, never a stuck lead:

1. **Schema-invalid** (malformed JSON, missing/invalid field) — retried up to `AI_MAX_RETRIES` with corrective feedback, then `needsManualReview: true`.
2. **Transient** (timeout, 5xx, connection error) — retried up to `AI_MAX_RETRIES` with the same prompt, then `needsManualReview: true`.
3. **Definitive** (400/401/403/404) — no retry, immediate `needsManualReview: true` with the provider's own rejection reason in `errorMessage`.

An unsupported `AI_PROVIDER` value is its own real, non-AI-call outcome (`needsManualReview: true`, clear `errorMessage`) — not an error the workflow crashes on.

---

# Security

Authentication: outbound calls to EYAN use the "EYAN Service API" credential (ADR-0006), same as Workflows 1/2. Ollama needs no credential (ADR-0020 Decision 1).

Authorization: EYAN's `authenticateService` middleware is the actual authority; this workflow has no authorization logic of its own.

Secrets Used: `AUTOMATION_SERVICE_API_KEY` via credential. `EYAN_API_BASE_URL`, `OLLAMA_BASE_URL`, `AI_PROVIDER`, and every retry/confidence/timeout value are plain config via `$env` — none are secrets (Ollama needs no credential; there is nothing to protect).

Sensitive Data: lead contact fields and the model's full analysis (including `reasoning`) pass through this workflow — visible in n8n's execution history and in `LeadAiAnalysis.rawResponse`, not forwarded anywhere beyond EYAN.

**Resolved connectivity, one open note**: `eyan-n8n` now reaches Ollama via `host.docker.internal` (ADR-0007). Ollama now listens on all interfaces (`0.0.0.0:11434`, previously loopback-only) — `ufw` was confirmed disabled earlier this same session, so whether Ollama's API is restricted to the Docker bridge or reachable from the public internet depends on host-level configuration outside both repos' scope. Flagged in ADR-0007's Consequences for whoever owns host infrastructure, not fixed here.

---

# Monitoring

Success Metrics: n8n's execution list; `WorkflowExecutionLog`/`LeadAiAnalysis` on the EYAN side (`provider`, `model`, `confidence`, `needsManualReview` per row).

Failure Alerts: not configured this sprint (Workflow 5 / notifications, per the TDD, not built).

Logging: n8n's own execution log; `LeadAiAnalysis.rawResponse` is the full audit trail per analysis attempt.

---

# Testing

Two rounds: an initial mock-based round (while Ollama connectivity was blocked, ADR-0007) and a follow-up round against the real Ollama service once connectivity was resolved. Both rounds run live against the real n8n execution engine (`n8n execute`, via a temporarily-injected trigger-input node — the same CLI-limitation workaround as Workflows 1/2, since Execute Workflow Trigger nodes don't accept CLI-supplied input directly) and a real, temporary EYAN backend instance. Every result below is confirmed via the resulting `LeadAiAnalysis`/`Lead` rows in the database, not just n8n's own execution log.

**Round 1 — mocked Ollama** (a plain Node HTTP server shaped like Ollama's `/api/chat` response, bound to the Docker bridge gateway IP): 7 scenarios, all correct — happy path (HIGH confidence 0.91, score 82, priority HIGH); schema-invalid then valid on retry (confirms the retry loop's back-edge — `Prepare Retry` → `Prepare Attempt` → `Call Ollama` — actually re-executes in n8n's real engine, not just in isolated logic); transient failure exhausting all retries (a real `ECONNREFUSED` encountered incidentally when the mock was briefly down between runs); medium confidence (0.55, `recommendedAction` annotated `[AI-assisted, review recommended]`); low confidence (0.2, `needsManualReview: true`); definitive failure (mock returns HTTP 400, zero retries, confirmed via the mock's request log showing exactly one call); unsupported provider (`AI_PROVIDER=claude`, zero calls reached the mock).

**Round 2 — real Ollama, once ADR-0007's connectivity fix (`host.docker.internal`) was confirmed reachable**:

- **Real transient failure**: `OLLAMA_BASE_URL` temporarily pointed at a closed port on the same host — a genuine `ECONNREFUSED` through the real `host.docker.internal` → real Docker gateway (`172.17.0.1`) path, correctly classified `transient`, retried 3 times, then `needsManualReview: true`.
- **Real definitive failure**: `OLLAMA_MODEL` temporarily set to a nonexistent model name against the real, reachable Ollama server — a genuine HTTP 404 (`"model 'nonexistent-model-xyz' not found"`), correctly classified `definitive`, zero retries, `needsManualReview: true`.
- **Unsupported provider, rerun**: `AI_PROVIDER=gemini` — fallback fired correctly; zero real Ollama calls made.
- **Happy path / schema validation / retry, against the real model** (three separate attempts, `qwen2.5-coder:7b`): every attempt reached the real Ollama server and received a real response, but the model consistently returned JSON shaped like a *different*, hallucinated CRM-record schema (`leadId`, `companyName`, `employeeCount`, `revenue`, `website`, ...) instead of the prompt's specified fields, still missing `recommendedAction`/`summary`/`reasoning` even after 3 corrective retries each time. All three attempts were correctly classified `schema_invalid`, correctly retried 3 times with the model's own bad output plus the specific validation error (ADR-0020 Decision 5), and correctly landed in `needsManualReview: true` on exhaustion — real, live confirmation of "never strand a lead" against a genuinely unreliable model, not a mock engineered to fail predictably. **Not achieved**: a genuinely valid real-model response to observe confidence-tier routing on live data — the routing logic itself (all three tiers, exact threshold boundaries) was already exhaustively proven in Round 1 (real n8n engine) and the algorithm tests below; this round additionally proves the schema-invalid/retry/manual-review path with a real model, which Round 1's mock could only simulate. Full raw model output and analysis: `docs/adrs/ADR-0007-n8n-ollama-connectivity-gap.md` (Resolution) and `docs/development-log/sprint-3-ai-qualification.md`.

**Algorithm-level, against the actual committed code**: `tests/workflows/crm/03-ai-qualification.logic.test.js` extracts the real `jsCode` strings from `03-ai-qualification.json` (not a re-implementation) and runs them in a mocked n8n Code-node context — 27 assertions covering schema validation edge cases (markdown-fenced JSON, JSON embedded in prose, truncated JSON, every field's invalid-value case, `budgetEstimate` null/valid/malformed), error classification (every transient/definitive case from the live tests plus additional boundary cases), and confidence-tier boundaries (exactly at each threshold, just below each threshold, `leadScore` rounding, `budgetEstimate` flattening into the DTO's flat field shape). Run: `node tests/workflows/crm/03-ai-qualification.logic.test.js`. All 27 pass.

**Not verified**: production webhook/workflow activation (same limitation as Workflows 1/2 — no interactive n8n UI/API-key access this session); confidence-tier routing observed against a genuinely valid real-model response (see above — the routing code itself is fully proven, just not yet exercised by a real model that satisfied the schema).

All test leads, both temporary EYAN backend instances, the mock Ollama server, and every temporarily-injected test node were removed after verification; only the clean, final workflow JSON (real `OLLAMA_BASE_URL`, real `AI_PROVIDER=ollama`) is imported into the live instance.

---

# Related Documentation

Architecture: `eyan-ai-platform` `docs/ARCHITECTURE.md`

ADR: `eyan-ai-platform` `.claude/decisions/ADR-0020-ai-provider-contract.md` (the contract this workflow implements), `docs/adrs/ADR-0005-workflow-organization.md`, `docs/adrs/ADR-0006-crm-workflow-authentication.md`, `docs/adrs/ADR-0007-n8n-ollama-connectivity-gap.md`

Issue: n/a
