# Sprint 3 Development Log — AI Qualification Engine

Sprint: 3

Status: Complete

---

# Objective

Replace Sprint 2's dummy/stub qualification payload with the real, provider-agnostic AI Qualification Engine (Workflow 3), per `eyan-ai-platform` `.claude/decisions/ADR-0020-ai-provider-contract.md`: provider selection, prompt loading/versioning, AI request, JSON schema validation, retry strategy, confidence-tiered routing, and CRM write-back — reusing the exact `PATCH /crm/service/leads/:id/qualification` contract Sprint 2 already proved.

Per the sprint brief: implement the first production provider (Ollama) completely; the architecture must support OpenAI/Claude/Gemini without containing fake implementations or duplicated workflow logic for them. No notification workflows, no analytics workflow, no Workflow 5, no Workflow 6.

---

# Deliverables

Completed:

- `workflows/crm/prompts/lead-qualification.v1.md` — the versioned prompt template (never embedded in a node), parameterized with the lead's fields.
- `workflows/crm/03-ai-qualification.json` — 15 nodes: config loading, config-driven provider selection (Switch, real fallback for unsupported providers — not a fake implementation), prompt loading from disk, a retry loop (real cyclic back-edge in n8n's execution engine, not simulated), response classification into three failure classes plus the happy path, three-tier confidence routing, and CRM write-back.
- `workflows/crm/02-validation.json` — updated: the dummy qualification payload Sprint 2 built inline is replaced with a real call to Workflow 3 (`Build Workflow 3 Input` → `Call Workflow 3 - AI Qualification`).
- `docs/adrs/ADR-0007-n8n-ollama-connectivity-gap.md` (new) — a real infrastructure gap discovered mid-implementation (the `eyan-n8n` container cannot reach the host-bound, loopback-only Ollama instance), surfaced to the user before proceeding, deferred per explicit instruction rather than silently worked around.
- `docker-compose.yml` — a read-only volume mount so Workflow 3 can load the prompt file at runtime (`./workflows/crm/prompts` → `/home/node/.n8n-files/prompts`, the one path n8n's own `SecurityConfig.restrictFileAccessTo` allows by default in this version — discovered by reading n8n's source after an initial mount target was rejected with "Access to the file is not allowed").
- `.env` / `.env.example` — `AI_PROVIDER`, `AI_PROMPT_VERSION`, `AI_MAX_RETRIES`, `AI_CONFIDENCE_HIGH_THRESHOLD`, `AI_CONFIDENCE_MEDIUM_THRESHOLD`, `OLLAMA_BASE_URL`, `OLLAMA_MODEL`, `AI_OLLAMA_TIMEOUT_MS` — none are secrets (Ollama needs no n8n credential, ADR-0020 Decision 1), so all are plain `$env` config, not credential-store entries.
- `docs/workflows/03-ai-qualification.md` (new, per the workflow template) and `docs/workflows/02-validation.md` (updated — Purpose/Steps/Outputs/Testing sections corrected to reflect the real Workflow 3 handoff, not the retired dummy payload).
- `tests/workflows/crm/03-ai-qualification.logic.test.js` (new — this repo's first test file; no framework added, since the logic under test has zero external dependencies) — extracts the actual `jsCode` from the workflow JSON and runs it in a mocked n8n Code-node context. 27 assertions, all passing.
- Live end-to-end verification against a real, temporary `eyan-ai-platform` backend instance and a disposable mock Ollama server (see Validation below).

Not built (explicit sprint exclusions): OpenAI/Claude/Gemini provider implementations (the architecture supports them — config-driven `AI_PROVIDER`, one schema-validation gate every branch converges on — but no branch exists for them yet), notifications (Workflow 5), analytics/telemetry (Workflow 6).

---

# Key Architectural Decisions

See `docs/adrs/ADR-0007-n8n-ollama-connectivity-gap.md` for the connectivity-gap decision. Summary of the rest, made during implementation (not requiring a new ADR — all within ADR-0020's already-frozen contract):

1. **Retry loop as a real cyclic graph, not a simulated one.** `Prepare Attempt` is a stable re-entry node both the first attempt and every retry flow through, so `Classify Ollama Result` can always reference "the state used for this attempt" via a single, consistent node reference regardless of which iteration produced it. Verified this actually executes correctly in n8n's real engine (not just in isolated logic) via a live schema-invalid-then-successful-retry run.
2. **Failure classification lives in one Code node, not scattered across IF nodes.** `Classify Ollama Result` produces a single `outcome` field (`valid`/`schema_invalid`/`transient`/`definitive`) that a single downstream Switch (`Outcome Router`) branches on — keeps the three-failure-class policy (ADR-0020 Decision 8) in one place rather than duplicated across multiple conditionals.
3. **Unsupported-provider handling is a real, deliberate branch, not a placeholder.** `Select Provider`'s fallback output (any `AI_PROVIDER` value other than `ollama`) routes straight to a manual-review write-back with a clear `errorMessage` — satisfying "must NOT contain fake implementations, placeholder code" by making the absence of OpenAI/Claude/Gemini an explicit, correct outcome rather than an unhandled crash or a stub pretending to call a provider that isn't there.
4. **Prompt-loading path fix**: the prompts volume was initially mounted at `/home/node/prompts`, which n8n's Read/Write Files From Disk node rejected ("Access to the file is not allowed") — this n8n version's `SecurityConfig.restrictFileAccessTo` defaults to `~/.n8n-files`, confirmed by reading `file-system-helper-functions.js` directly rather than guessing. Fixed by remounting to `/home/node/.n8n-files/prompts`, the default-allowed path — no new security override introduced.

---

# Validation

- **Standalone algorithm tests** (`tests/workflows/crm/03-ai-qualification.logic.test.js`): 27 assertions against the actual `jsCode` extracted from the committed workflow JSON — schema validation (markdown-fenced JSON, JSON-in-prose, truncated JSON, every field's invalid case, `budgetEstimate` null/valid/malformed), error classification (transient vs. definitive, including boundary cases beyond what the live tests exercised), confidence-tier boundaries (exactly at / just below each threshold), `leadScore` rounding, `budgetEstimate` flattening into the write-back DTO's flat field shape. All 27 pass.
- **Live, full-stack, seven scenarios** — a temporary `eyan-ai-platform` backend instance (spare port, throwaway secrets matching this repo's own) plus a disposable mock Ollama HTTP server (bound to the Docker bridge gateway IP, reachable from `eyan-n8n` — Ollama itself is not, see ADR-0007), each scenario executed via `n8n execute` against the real, imported Workflow 3 (a temporarily-injected trigger-input node stood in for a live Execute Workflow Trigger call, the same CLI-limitation workaround Workflows 1/2 used) and confirmed against the resulting `Lead`/`LeadAiAnalysis` rows in the database, not just n8n's execution log:
  1. Happy path (HIGH confidence 0.91) → `AI_ANALYZED`, score 82, priority HIGH, not flagged for review.
  2. Transient failure (a real `ECONNREFUSED`, encountered incidentally between test runs) exhausting all 3 retries → `needsManualReview: true`, `errorMessage` correctly reports the transient failure and retry count.
  3. Schema-invalid on the first call, valid on retry → succeeded on the second attempt — confirms the retry loop's back-edge genuinely re-executes in n8n's real engine.
  4. Medium confidence (0.55) → automated, `recommendedAction` correctly annotated `[AI-assisted, review recommended]`.
  5. Low confidence (0.2) → `needsManualReview: true`, no annotation.
  6. Definitive failure (mock returns HTTP 400) → immediate manual review, confirmed via the mock's request log that exactly one call was made (no retry attempted).
  7. Unsupported provider (`AI_PROVIDER=claude`) → the fallback branch fired; the mock Ollama server received zero requests for this run; clear "no implemented provider branch" reasoning recorded.
- All test leads, the temporary EYAN backend process, the mock Ollama server, and every temporarily-injected test node were removed after verification. The clean, final `03-ai-qualification.json` (no test scaffolding) is what's imported into the live instance — confirmed by reimporting it fresh after the test runs and diffing the live workflow against the committed file.
- Production webhook/workflow activation was not exercised — same limitation as Sprint 2 (no interactive n8n UI/API-key access this session).

---

# Lessons Learned

- **A real architectural gap surfaced during implementation, not during design** — n8n-container-to-host-Ollama connectivity wasn't (and couldn't have been) fully specified by ADR-0020, since it depends on this specific host's network topology, not on the AI provider contract itself. Surfacing it before proceeding (rather than silently working around it, e.g. by quietly binding Ollama to `0.0.0.0` without a firewall rule) avoided introducing an undocumented security exposure.
- **A disposable mock server bound to the Docker bridge gateway IP is a legitimate, no-`sudo`-needed way to exercise a real n8n execution against a stand-in for an unreachable service** — meaningfully stronger verification than a purely algorithmic test, since it proves the actual HTTP node, actual retry back-edge, and actual credential-authenticated write-back all function together in the real engine, not just that the extracted logic is individually correct.
- **n8n's file-access restriction (`SecurityConfig.restrictFileAccessTo`, default `~/.n8n-files`) is not the same restriction as `N8N_BLOCK_ENV_ACCESS_IN_NODE`** (which Sprint 2 already discovered and worked around) — a second, unrelated default-deny mechanism, only found by reading this exact n8n version's source after the first mount attempt failed with a generic "Access to the file is not allowed" error.
- **A claimed infrastructure fix was independently re-verified, not taken on trust** — before touching any config, `ss -tlnp` and a real `wget` from inside `eyan-n8n` confirmed Ollama's new bind address and actual reachability, matching what was reported. This is also what surfaced a real secondary concern (Ollama now on `0.0.0.0` with `ufw` disabled) that a claim-plus-trust approach would have missed.
- **A real model can fail a schema in ways a mock never will** — `qwen2.5-coder:7b` consistently returned a plausible-looking but entirely wrong JSON shape (a generic CRM-record schema, not the prompt's specified fields) across three real attempts, never a mock would produce. The retry/classification/manual-review machinery handled this correctly every time, which is a stronger real-world proof of ADR-0020's "never strand a lead" principle than the mock-only round could offer — but it's also a genuine signal that model/prompt selection for this specific task deserves attention in a future sprint (out of scope here; not touched, per "do not redesign").

---

# Post-Sprint Update — Real Ollama Verification (same day)

The n8n-to-Ollama connectivity gap (ADR-0007) was resolved outside this session (host-level Ollama reconfiguration + `docker-compose.yml`'s `extra_hosts: host.docker.internal:host-gateway`, applied to the `n8n` service). Independently confirmed before proceeding: `ss -tlnp` now shows Ollama on `*:11434` (was `127.0.0.1` only), and `wget http://host.docker.internal:11434/api/tags` from inside `eyan-n8n` returns the real model list. `OLLAMA_BASE_URL` updated to `http://host.docker.internal:11434` in `.env`/`.env.example`. No workflow, schema, or ADR-0020 logic changed — exactly the "network gap only" diagnosis ADR-0007 made originally.

Every scenario re-run against the real service (not the disposable mock), each confirmed via `LeadAiAnalysis` rows:

- **Real transient failure** (closed port on `host.docker.internal`) → genuine `ECONNREFUSED`, correctly classified `transient`, retried 3x, `needsManualReview: true`.
- **Real definitive failure** (nonexistent model name against the real server) → genuine HTTP 404, correctly classified `definitive`, zero retries, `needsManualReview: true`.
- **Unsupported provider** (`AI_PROVIDER=gemini`) → fallback fired, zero real Ollama calls.
- **Real happy path / schema validation / retry** — three separate real attempts against `qwen2.5-coder:7b`. All three: real prompt sent, real response received, but the model returned a hallucinated, unrelated CRM-record JSON shape instead of the prompt's schema, missing `recommendedAction` even after 3 corrective retries each time. Every attempt correctly classified `schema_invalid`, correctly retried, correctly landed in `needsManualReview: true` on exhaustion. Confidence-tier routing on a genuinely valid real response was not observed in these three attempts — that logic was already fully proven via the mock round and the 27 algorithm tests, both unchanged.

All new test leads, the second temporary EYAN backend instance, and every temporarily-injected test node were removed after verification; `.env` restored to `AI_PROVIDER=ollama`/production `EYAN_API_BASE_URL`; the clean workflow JSON reimported. Full detail: `docs/adrs/ADR-0007-n8n-ollama-connectivity-gap.md` (Resolution section).

---

# Next Sprint

Two independent follow-ups, neither started or approved:

1. **Model/prompt quality for the qualification task** — `qwen2.5-coder:7b` did not reliably satisfy the qualification schema in three real attempts (see Post-Sprint Update). Worth investigating: a more instruction-following model, a larger `num_predict`, or few-shot examples in the prompt. Not attempted this sprint (would be tuning application behavior beyond "verify the contract works," and risks looking like forcing a result rather than reporting one honestly).
2. **A second AI provider** (OpenAI, Claude, or Gemini) — additive per ADR-0020 Decision 1: a new `Select Provider` branch plus a new n8n credential, no change to the schema, the write-back endpoint, or the confidence/fallback policy.
3. **Security note carried over from ADR-0007**: confirm whether Ollama's new `0.0.0.0` bind is restricted by a host firewall rule — `ufw` was disabled as of this session's last check. Not this repo's to fix, but worth a deliberate answer rather than an assumption.
