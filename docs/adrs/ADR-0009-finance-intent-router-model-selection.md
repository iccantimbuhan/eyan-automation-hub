# ADR-0009: Finance Intent Router — Local Model Selection

- Status: Accepted (interim — see Consequences)
- Date: 2026-08-06
- Authors: Claude Code

---

# Context

`workflows/finance/02-finance-intent-router.json` ("AI Agent - Classify Intent", node n7) classifies inbound Finance Inbox messages into one of the eight intents in the Finance Intent Catalog (`docs/adrs/ADR-0008-finance-inbox-workflow-contract.md` Decision 3) using an `@n8n/n8n-nodes-langchain.agent` (AgentV3) node backed by a local Ollama model (`lmChatOllama`) and a `outputParserStructured` node. It was built and live-tested in Phase 2 against `mistral:7b` (the value hardcoded on node n5 today), which surfaced a real, diagnosed limitation: the model's output was correctly classified but wrapped in a `format_final_json_response` tool-call envelope that `N8nStructuredOutputParser` does not unwrap, causing every classification attempt to fail with `"Model output doesn't fit required format"` — caught by `onError: continueRegularOutput` on node n7, never crashing the workflow, but never reaching the Intent Router with a real classification either.

Phase 2's own documentation flagged this as unresolved and out of scope for that phase, recommending a dedicated evaluation before picking a production default. This ADR is that evaluation: **which of this host's locally available Ollama models — `mistral:7b`, `gemma3:4b`, `qwen2.5-coder:7b` (confirmed via `docker exec eyan-n8n wget -qO- http://host.docker.internal:11434/api/tags`) — should be the Router's configured default, and does any of them actually solve the wrapper problem.**

ADR-0007 already recorded a related, independent finding: `qwen2.5-coder:7b` did not reliably satisfy a *different* task's (CRM Workflow 3's lead-qualification) JSON schema in three real attempts, for a different reason (hallucinated field shapes, not a tool-call wrapper). That finding is not assumed to transfer here — a fresh, task-specific evaluation was run rather than reusing that conclusion by analogy.

# Evaluation Method

A non-committed test harness (scratch-only, never written into the repo) generated 22 variants of the committed `02-finance-intent-router.json` — one per (model × test case) pair — each with only two changes from the committed file: node n5's `model` parameter, and node n2's `jsCode` given a hardcoded Request-contract payload in place of `$json` (the same technique Phase 2 used, since `n8n execute` does not honor `pinData` on an Execute Workflow Trigger). Each variant was imported (`n8n import:workflow`) and run live (`n8n execute --id=FinanceIntentRouterWf01 --rawOutput`) against the real local Ollama instance — no mocking, matching this repo's established live-verification standard (ADR-0007).

**Test set** (11 cases, one message per intent in the catalog plus three repeats and one deliberately ambiguous case, using the classification prompt's own examples where available for a fair, non-adversarial test):

| Case | `rawText` (or attachment) | Expected intent |
|---|---|---|
| `expense_1`/`2`/`3` | "spent $12.50 on lunch" (repeated 3×, to check run-to-run stability) | `CREATE_EXPENSE` |
| `budget_1` | "what's my budget this month?" | `GET_BUDGET` |
| `dashboard_1` | "how am I doing this month?" | `GET_DASHBOARD` |
| `question_1` | "am I overspending on food?" | `GET_FINANCE_QUESTION` |
| `income_1` | "got paid $2000" | `CREATE_INCOME` |
| `transfer_1` | "sent $50 to Alex" | `CREATE_TRANSFER` |
| `receipt_1` | (no text, one image attachment) | `UPLOAD_RECEIPT` |
| `unrecognized_1` | "hey how's it going?" | `UNRECOGNIZED` |
| `ambiguous_1` | "sent $50 to Alex for dinner" | `UNRECOGNIZED` per the system prompt's own explicit guidance ("prefer UNRECOGNIZED over guessing... a wrong guess between CREATE_EXPENSE, CREATE_INCOME, and CREATE_TRANSFER is worse") — `CREATE_TRANSFER` is a defensible secondary answer |

`gemma3:4b` was tested with a single case rather than the full 11, since its failure (below) is a model-capability property independent of message content, not something repeated trials would change.

Every run's node-by-node execution data (`AI Agent - Classify Intent`, `Ollama Chat Model`, `Validate Agent Output`) was inspected directly from `n8n execute`'s `--rawOutput` JSON, including the model's *raw, pre-parser* completion text — not just whether the workflow reported success — so a wrapper-shape failure could be distinguished from an actual wrong classification.

**CLI finding worth recording alongside ADR-0005's existing collection of such things**: `n8n execute --rawOutput`'s documented promise ("Outputs only JSON data, with no other text") does not hold in this n8n version — startup log lines (task broker readiness, license SDK, task runner registration) print to the same stdout stream ahead of the JSON payload. Any tooling parsing this output must locate the first `{` rather than trusting the whole stream is clean JSON.

# Findings

## Structured-output reliability (parses cleanly through `outputParserStructured`, no `onError` fallback)

| Model | Result |
|---|---|
| `mistral:7b` | **0/11 (0%)** — 10/11 hit the `format_final_json_response` tool-call wrapper mismatch; 1/11 (`expense_2`) hit a distinct streaming failure (`"Did not receive done or success response in stream."`) with no recoverable output at all |
| `qwen2.5-coder:7b` | **0/11 (0%)** — 11/11 hit the identical `format_final_json_response` wrapper mismatch |
| `gemma3:4b` | **0/1 (0%)**, but for an architecturally different reason (see below) — not comparable to the other two on this axis |

Neither `mistral:7b` nor `qwen2.5-coder:7b` produced a single directly-usable structured output across 22 combined attempts. This is the headline result: **the wrapper-mismatch problem diagnosed in Phase 2 is not model-specific.** Both are Ollama "tools"-capable models, and n8n's AgentV3 is a `ToolsAgent` implementation that always drives structured output through tool-calling — every tool-capable model tried wraps its answer in a tool-call envelope this exact `N8nStructuredOutputParser` version does not unwrap. This points at an Agent-node/parser-version incompatibility, not a model-quality gap (see Decision and Consequences).

## Intent-classification accuracy (the model's *raw* completion text, decoded manually, before the parser rejects it)

Despite the parser-level failure, the raw completion text was recoverable in every run except `mistral:7b`'s one streaming failure, letting classification quality be judged independently of the wrapper bug:

| Model | Correct (or defensible) / attempted | Notes |
|---|---|---|
| `mistral:7b` | 10/11 (91%) — 1/11 total non-response | Every recoverable answer matched the expected intent, including the deliberately ambiguous case answering `CREATE_TRANSFER` (a defensible, if not prompt-ideal, choice — see Risks) |
| `qwen2.5-coder:7b` | 11/11 (100%) | Every answer matched the expected intent, including the same `CREATE_TRANSFER` choice on the ambiguous case |

Both models correctly classify every canonical example. **Neither model followed the prompt's explicit instruction to prefer `UNRECOGNIZED` on genuine ambiguity** — both answered `CREATE_TRANSFER` at maximum stated confidence on `ambiguous_1`, the one case designed to test that instruction. This is a prompt-following gap common to both models, not a differentiator between them (flagged under Risks/Follow-up, not this ADR's decision axis).

## Confidence calibration

`mistral:7b` reported a spread of values (0.6–1.0), including its lowest score (0.6) on the one genuinely off-topic message (`unrecognized_1`) — some real signal. `qwen2.5-coder:7b` reported `1.0` on 9 of 11 cases (0.95 on the remaining 2), including `1.0` on the deliberately ambiguous case — closer to a constant than a real confidence estimate. Not itself disqualifying (the Router's current logic doesn't threshold on confidence), but a meaningfully weaker signal if a future phase adds confidence-based routing.

## Execution stability / latency (synchronous, user-is-waiting Slack flow)

| Model | Mean | Median | Range | Notes |
|---|---|---|---|---|
| `mistral:7b` | 34.5s | 34.1s | 20.5s – 65.5s | No severe outliers |
| `qwen2.5-coder:7b` | 50.3s | 37.9s | 26.4s – **182.8s** | One run (`expense_1`) took over 3 minutes with no distinguishing feature in the input; the other 10 were in a comparable range to `mistral:7b`'s |
| `gemma3:4b` | 4.3s (n=1) | — | — | Fails fast — see below |

`mistral:7b` was consistently faster and had no severe outlier across 11 runs; `qwen2.5-coder:7b`'s one 183-second run is a real stability concern for a synchronous Slack reply, even though its median is close to `mistral:7b`'s.

## `gemma3:4b` — reconfirmed hard incompatibility

`gemma3:4b`'s Ollama capability set (`["completion"]`, no `"tools"`) makes it structurally incompatible with n8n's `ToolsAgent`-based AgentV3, independent of prompt or message content. Reconfirmed live this phase: `"registry.ollama.ai/library/gemma3:4b does not support tools"`, failing in 4.3s (fast, since it's rejected before any generation begins) rather than after a full completion attempt. This is not a candidate for this Agent node architecture at all, and no amount of prompt tuning changes that — excluded from further comparison on that basis, matching the finding Phase 2 already made.

# Comparison Matrix

| Criterion | `mistral:7b` | `qwen2.5-coder:7b` | `gemma3:4b` |
|---|---|---|---|
| Ollama capabilities | completion, tools | completion, tools, insert | completion only |
| Compatible with AgentV3 (`ToolsAgent`) at all | Yes | Yes | **No** — hard error, architectural |
| Structured-output success rate | 0/11 | 0/11 | 0/1 (incompatible) |
| Underlying classification accuracy (raw text) | 10/11 (1 total non-response) | 11/11 | n/a |
| Confidence calibration | Some spread (0.6–1.0) | Nearly constant (~1.0) | n/a |
| Mean / median latency | 34.5s / 34.1s | 50.3s / 37.9s | 4.3s (fails immediately) |
| Latency stability | No severe outlier (max 65.5s) | One 182.8s outlier | n/a |
| Failure mode observed | Tool-call wrapper mismatch (10/11), one streaming failure (1/11) | Tool-call wrapper mismatch (11/11) | Capability rejection (not a classification attempt) |
| Graceful degradation on failure (never crashes the Router) | Yes — `onError: continueRegularOutput` catches every case | Yes — same | Yes — same |
| Prior finding this repo already has on this model | None | ADR-0007: unreliable on a *different* task's schema (CRM lead qualification) | None |

# Decision

**Recommend keeping `mistral:7b` as the Finance Intent Router's configured default.** No change to `workflows/finance/02-finance-intent-router.json` is made by this ADR — node n5's `model` parameter already holds this value from Phase 2, so this decision is a validation of the existing configuration, not a change to it.

Rationale, given that **neither compatible model actually produces usable structured output today** (see Consequences — this is explicitly not "mistral:7b works"):
1. Between two models that both fail the parser identically, `mistral:7b` is the safer default to leave configured: consistently faster (34.5s vs 50.3s mean), no severe latency outlier (vs. `qwen2.5-coder:7b`'s 183-second run), and a confidence signal that shows real variation rather than reading as a near-constant.
2. `qwen2.5-coder:7b` is a code-completion-specialized model; its use here was opportunistic (it was already present on this host for CRM's Workflow 3, per ADR-0007) rather than chosen for NLU classification. `mistral:7b` is the more general-purpose instruction-following model of the two.
3. ADR-0007 already recorded a separate, real reliability concern with `qwen2.5-coder:7b` on a different structured-output task in this same repo — not dispositive on its own, but consistent with today's finding rather than contradicting it.

`gemma3:4b` is excluded outright — not a close call, it cannot run through this Agent node architecture at all.

# Consequences

- **This is a "best of two blocked options" recommendation, not a statement that the Router works today.** With `mistral:7b` configured, the Router will classify **0% of messages successfully** through the current `outputParserStructured` node — every message will fall through to `UNRECOGNIZED` via `Validate Agent Output`'s existing safety net (never a crash, always a contract-shaped response, exactly as Phase 2's `onError` fix was built to guarantee) but never a real classification. This is unchanged from Phase 2's already-documented state; this ADR formalizes and exhaustively re-confirms it rather than discovering something new and worse.
- No code or workflow file changes result from this ADR. The `model` parameter on node n5 (`workflows/finance/02-finance-intent-router.json`) is unchanged. `docs/workflows/02-finance-intent-router.md`'s Testing section is updated to point here rather than duplicate this evaluation's detail.
- **The real blocking issue is the Agent-node/parser incompatibility with tool-calling-wrapped output, not model selection** — swapping models further within this same Agent-node architecture is very unlikely to fix it, since both tool-capable models tried produce the identical wrapper shape. Follow-up work should target the Agent/parser mechanism itself (see Follow-up Recommendations in the Phase 2.5 validation report), not a third model.
- If the wrapper issue is fixed by a future change, this ADR's latency/calibration comparison remains the relevant basis for model choice — re-run this evaluation's test set against the fix before assuming `mistral:7b` is still the better choice, since the fix itself might behave differently per model.

# Addendum (2026-08-13): model selection superseded by AI Core migration, `gemma3:4b`'s tools-capability exclusion now moot

`docs/adrs/ADR-0014-finance-ai-core-migration.md` moves intent classification off any n8n-side LLM-calling node (`lmChatOllama`, `chainLlm`) entirely, onto AI Core's `finance-intent-classification` capability. `mistral:7b` remains the configured model — this ADR's comparison-driven recommendation is what AI Core's `finance-intent-brain` Routing Policy is seeded with — but model *selection* is now AI Core admin-UI configuration, not a hardcoded n8n node parameter this ADR's Decision is pinning.

This ADR's central finding (the `format_final_json_response` tool-call-wrapper mismatch between n8n's `ToolsAgent`-based Agent node and `N8nStructuredOutputParser`) remains historically accurate and unchanged — it was already fixed for this Router by ADR-0012's replacement of the Agent-node mechanism, not by ADR-0014. What ADR-0014 changes is unrelated to that finding: it replaces ADR-0012's direct `chainLlm`-to-Ollama call with a call to AI Core, which does its own non-tool-calling, non-Agent-node call to Ollama's native `/api/chat` endpoint (architecturally similar to ADR-0012's own `chainLlm` approach, just now behind AI Core rather than inside the workflow).

This ADR's exclusion of `gemma3:4b` was scoped specifically to n8n's `ToolsAgent`-based Agent node (it lacks Ollama "tools" capability, hard-erroring against that node type). AI Core's Ollama provider adapter has no tool-calling dependency, so this exclusion never applied there and is now fully moot for this task — not contradicted, just out of scope for the mechanism actually in use.

Live-verified 2026-08-13 (see ADR-0014): a real call to `finance-intent-classification` correctly routed to `mistral:7b`, returned `VALID` with 0 retries in 234.5s, and classified the test message correctly at 0.95 confidence.

# Related Documents

- `docs/adrs/ADR-0014-finance-ai-core-migration.md` (supersedes this ADR's transport mechanism; live-verifies `mistral:7b` through the new path)
- `docs/adrs/ADR-0008-finance-inbox-workflow-contract.md` (the contract this classification serves)
- `docs/adrs/ADR-0007-n8n-ollama-connectivity-gap.md` (prior, task-different finding on `qwen2.5-coder:7b`; also the precedent for live-verification-over-mocking used here)
- `docs/adrs/ADR-0005-workflow-organization.md` (CLI-behavior findings collection, extended here with the `--rawOutput` stdout-pollution note)
- `docs/workflows/02-finance-intent-router.md`
- `workflows/finance/02-finance-intent-router.json`, `workflows/finance/prompts/intent-classification.v1.md`

# Notes

Raw per-case latency, underlying classification, and confidence data for all 22 live runs (11 cases × 2 compatible models) plus the single `gemma3:4b` reconfirmation run were captured directly from `n8n execute --rawOutput`'s `resultData.runData` for `AI Agent - Classify Intent` and `Ollama Chat Model`, not summarized from logs after the fact. Test harness and raw outputs were scratch-only (outside the repo) and are not preserved; the tables above are the complete, non-cherry-picked record of all 23 live executions performed.
