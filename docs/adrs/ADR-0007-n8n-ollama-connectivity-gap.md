# ADR-0007: n8n-to-Ollama Connectivity Gap

- Status: Resolved
- Date: 2026-07-31 (opened deferred; resolved same day)
- Authors: Claude Code

---

# Context

Workflow 3 (`workflows/crm/03-ai-qualification.json`, `eyan-ai-platform` ADR-0020) calls Ollama over HTTP. Ollama runs natively on the host (`OllamaProvider`, `eyan-ai-platform`), not inside this repo's Docker stack, and is bound to `127.0.0.1:11434` only (confirmed via `ss -tlnp` — `LISTEN 127.0.0.1:11434`). `eyan-n8n` runs inside the isolated `automation-network` Docker bridge (this repo's own ADR-0001). A container's `127.0.0.1` is its own network namespace, not the host's — so `eyan-n8n` cannot reach a loopback-only host service, confirmed directly: `wget` from inside `eyan-n8n` to the bridge gateway (`172.30.0.1:11434`) returned `Connection refused`, because Ollama isn't listening on that interface at all.

ADR-0020 Decision 1 (`eyan-ai-platform`) states Ollama needs "a local network call to the same host" but doesn't specify how a *containerized* n8n reaches a *loopback-only* host service — this ADR fills that gap, which surfaced only once Workflow 3 was actually being built (Sprint 3), not during ADR-0020's own design.

This session had no `sudo` access (`ufw status`/`iptables -L` both returned "password required"), which ruled out any host-level firewall/systemd fix as an option this sprint regardless of which approach was preferred.

# Decision

**Defer the fix. Build and verify Workflow 3 completely against the frozen contract, using a mocked Ollama response for end-to-end verification, and leave live connectivity as a named follow-up.** Per explicit instruction after this gap was raised: complete Workflow 3 exactly as designed (provider selection, prompt loading, schema validation, retry, confidence routing, CRM write-back), verify against a mock, and do not redesign the workflow around this temporary limitation.

Verification performed without a real Ollama call: a plain Node HTTP server, shaped like Ollama's `/api/chat` response, was bound to the Docker bridge gateway IP (`172.30.0.1`, already assigned to the host by Docker — no `sudo` required to bind a non-privileged port to it) and used as `OLLAMA_BASE_URL` for a series of live `n8n execute` runs against the real Workflow 3, covering the happy path, both confidence-annotated tiers, low-confidence manual review, a schema-invalid-then-successful-retry (proving the retry loop's back-edge actually works in n8n's real execution engine, not just in isolated logic), a transient failure exhausting all retries, a definitive (400) failure skipping retries entirely, and the unsupported-provider fallback branch. All seven scenarios produced the correct EYAN-side write-back, confirmed against a real (throwaway) EYAN backend instance and its database — see `docs/workflows/03-ai-qualification.md` Testing section and `docs/development-log/sprint-3-ai-qualification.md`.

Two real, viable fixes were identified for whoever picks this up next — recorded here, neither implemented:

1. **`network_mode: host` for the `eyan-n8n` container.** `eyan-n8n` would share the host's network namespace directly, reaching `127.0.0.1:11434` exactly like `eyan-ai-platform`'s own backend does. No change to Ollama, no `sudo` needed. Cost: `postgres`/`redis` lose Docker-DNS name resolution from `eyan-n8n` in host-network mode, so they'd need published ports on `127.0.0.1` and `eyan-n8n`'s `DB_POSTGRESDB_HOST`/Redis host values would change from the service names (`postgres`/`redis`) to `127.0.0.1` — a real topology change to a currently-working stack, requiring careful reapplication and reverification of the existing Postgres/Redis connection before being called done.
2. **Bind Ollama to `0.0.0.0` (`OLLAMA_HOST=0.0.0.0` via a systemd override) plus a host firewall rule restricting `:11434` to the `172.30.0.0/24` bridge subnet.** Requires root (unavailable this session) and touches host-level systemd/firewall configuration outside both repos' scope — `eyan-ai-platform` and `eyan-automation-hub` are the only repositories this engagement may modify. **Risk if the firewall step is skipped or misconfigured**: since `ufw` is currently disabled host-wide, binding Ollama to `0.0.0.0` without the accompanying restriction would expose its API to the public internet, not just the docker bridge.

**Alternative considered and rejected**: a manually-run `socat`/relay process bound to the bridge gateway, forwarding to `127.0.0.1:11434`, as a permanent fix rather than a test-only mock. Rejected — an ad hoc background process outside Docker Compose and outside version control is exactly the kind of undocumented, non-reproducible infrastructure this repo's own principles (`ROADMAP.md`: "Documentation before implementation," "Production-quality engineering") argue against. The mock-server technique above is fine as a *disposable test tool*, torn down after use (see Testing section); it is not proposed as the real fix.

# Resolution (same day, after real verification)

The gap above was closed outside this session's authority (host-level Ollama/firewall configuration is out of scope for both repos this engagement may modify) and reported back for verification. **Independently confirmed, not taken on trust**, before any workflow change: `ss -tlnp` on the host now shows Ollama listening on `*:11434` (was `127.0.0.1:11434` only), and `docker exec eyan-n8n wget -qO- http://host.docker.internal:11434/api/tags` returns the real model list. `docker-compose.yml`'s `n8n` service now carries `extra_hosts: ["host.docker.internal:host-gateway"]`, resolving to the real Docker gateway address (`172.17.0.1` on this host, confirmed via a real-condition test below) rather than a disposable stand-in — this is the fix, applied to the actual `n8n` service definition, not a workaround layered on top of it.

`OLLAMA_BASE_URL` in `.env`/`.env.example` was updated from the loopback value to `http://host.docker.internal:11434`. No change to Workflow 3's node graph, the AI JSON schema, the retry/confidence/error-classification logic, or ADR-0020 was needed — exactly as this ADR's original Consequences predicted: the gap was purely network-reachability, not a workflow-logic gap.

**Every scenario was rerun against the real service** (not the disposable mock this ADR originally used), each confirmed via the resulting `LeadAiAnalysis` row, not just n8n's execution log:

- **Real transient failure**: `OLLAMA_BASE_URL` temporarily pointed at a closed port on the same host (`host.docker.internal:19999`) — a genuine `ECONNREFUSED` from the real network stack (resolving through the real `host.docker.internal` mapping to `172.17.0.1`, not a test double), correctly classified `transient`, retried 3 times, then `needsManualReview: true`.
- **Real definitive failure**: `OLLAMA_MODEL` temporarily set to a nonexistent model name against the real, reachable Ollama server — a genuine `404` (`"model 'nonexistent-model-xyz' not found"`), correctly classified `definitive`, zero retries, `needsManualReview: true`.
- **Unsupported provider**: `AI_PROVIDER=gemini` — the fallback branch fired correctly; zero calls reached Ollama.
- **Happy path / schema validation / retry, against the real model** — attempted three times (`qwen2.5-coder:7b`, a code-completion model, via the real Ollama endpoint). All three real attempts produced a genuine finding, not a workflow defect: the model consistently returned JSON matching a *different*, hallucinated CRM-record shape (`leadId`, `companyName`, `employeeCount`, `revenue`, `website`...) rather than the prompt's specified schema, missing required fields (`recommendedAction`, `summary`, `reasoning`) even after three corrective retries each time (the model's own bad output plus the exact validation error, per ADR-0020 Decision 5). Every attempt was correctly classified `schema_invalid`, correctly retried 3 times, and correctly landed in `needsManualReview: true` on exhaustion — the exact "never strand a lead" behavior ADR-0020 requires, now proven against a real, imperfect model rather than a mock engineered to succeed. **Confidence-tier routing on a genuinely valid real response was not achieved in these three attempts** — that specific code path (the three-tier threshold logic itself) was already exhaustively verified via the mock (all three tiers, real n8n engine) and 27 standalone assertions against the actual node code; this real-model round additionally proves the schema-invalid/retry/manual-review path end-to-end with a real, unreliable model, which the mock could only simulate.

Full detail, raw model output, and reproduction steps: `docs/development-log/sprint-3-ai-qualification.md`.

# Consequences

- Workflow 3 now works end-to-end against a real Ollama call. The one remaining open question is **model selection/prompting for this specific task**, not connectivity or workflow logic — `qwen2.5-coder:7b` did not reliably satisfy the qualification JSON schema in three real attempts (see Resolution above). This is a model/prompt-quality concern for a future sprint, explicitly out of this ADR's scope (which was connectivity only) and not fixed here, per "do not redesign the architecture."
- **Security note, not this repo's to fix**: Ollama now listens on `0.0.0.0` (`*:11434`), and `ufw` was confirmed disabled earlier this same session (`ufw status` / `iptables -L` both required a password this session had no access to). If no other host-level restriction was applied alongside this change, Ollama's API is reachable from the public internet, not just the Docker bridge — flagged here for whoever owns host infrastructure, since neither `eyan-ai-platform` nor `eyan-automation-hub` can fix a host firewall rule.
- `.env`/`.env.example` document the resolved state inline next to `OLLAMA_BASE_URL`.
- No change to Workflow 3's design, the AI JSON schema, or ADR-0020 was made or is implied by this resolution — it was purely a network-reachability fix.

# Related Documents

- `eyan-ai-platform` `.claude/decisions/ADR-0020-ai-provider-contract.md` (Decision 1 — the assumption this ADR fills a gap in)
- `docs/workflows/03-ai-qualification.md`
- `docs/development-log/sprint-3-ai-qualification.md`
- `docker-compose.yml`, `.env` / `.env.example`

# Notes

Confirmed directly (not assumed) via `ss -tlnp` inside the host and `wget` from inside `eyan-n8n`: Ollama listens on `127.0.0.1:11434` only, and the container cannot reach it via the bridge gateway. `SecurityConfig.restrictFileAccessTo` (a separate, unrelated n8n file-access restriction hit while building Workflow 3's prompt-loading step) defaults to `~/.n8n-files` in this n8n version — the prompts volume mount targets that path for the same underlying reason this ADR exists: reading n8n's own source was necessary to find the real constraint rather than guessing at one.
