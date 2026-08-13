# ADR-0014: Finance AI Core Migration

- Status: Accepted
- Date: 2026-08-13
- Authors: Claude Code

---

# Context

Finance had two independently-built, direct-Ollama-calling AI mechanisms, each the subject of its own prior ADR:

- **`02-finance-intent-router.json`'s intent classification** — a `chainLlm` node calling a local `Ollama Chat Model` node directly (ADR-0012), configured for `mistral:7b` (ADR-0009).
- **`10-handle-create-expense.json`'s expense-field extraction** — a plain `httpRequest` node calling Ollama's native `/api/chat` endpoint directly (ADR-0011), configured for `gemma3:4b` (ADR-0011 Addendum).

Both mechanisms worked (ADR-0012's live validation: 11/11; ADR-0011's production use), but both bypassed `eyan-ai-platform`'s AI Core orchestration layer entirely — the only AI-powered feature set in the system that did so. CRM's `lead-qualification` capability (`workflows/crm/03-ai-qualification.json`) already called AI Core's `Capability → Brain → RoutingPolicy → Provider → Model → Prompt` pipeline instead of calling Ollama directly. Finance's direct calls meant:

- No `AiUsageLog` entries for either Finance AI task — every call was invisible to AI Core's usage/audit trail.
- No way to change either task's model or timeout without editing and redeploying the workflow JSON itself.
- Two structurally similar "call a local model, parse the JSON" implementations maintained independently instead of through one shared, tested pipeline.

`ADR-0011`'s own Consequences section anticipated this: "If a future phase migrates the Router itself onto a direct-`httpRequest` pattern... this Handler's extraction node becomes the second, not the first, precedent for that approach within Finance." This ADR is that future phase, but the direction taken is not "make the Router match the Handler's direct-`httpRequest`-to-Ollama pattern" — it's moving both onto AI Core, so neither calls Ollama directly anymore.

# Decision

**Move both Finance AI tasks onto AI Core's existing Capability → Brain → Routing Policy → Model → Prompt pipeline. n8n becomes orchestration-only for both calls — it invokes an AI Core capability over HTTP and consumes the structured response; it no longer knows which model, provider, or prompt version is in use.**

## New architecture

```
n8n workflow (httpRequest node)
  → POST /ai-core/service/capabilities/{key}/invoke
  → AiCapability
  → AiBrain
  → AiRoutingPolicy  (selects Provider + Model, retry/timeout/confidence config)
  → AiModel (+ AiProvider)
  → AiPrompt (versioned)
```

| Capability | Brain | Model |
|---|---|---|
| `finance-intent-classification` | `finance-intent-brain` | `mistral:7b` |
| `expense-extraction` | `expense-extraction-brain` | `gemma3:4b` |

Both are seeded in `eyan-ai-platform/backend/prisma/seed-ai-core.ts` (`seedFinanceBrains()`), following the exact upsert pattern every other Brain in that file already uses. No new `AiProvider` or `AiModel` rows were created — both models already existed as rows (created by `seedGeneralChatBrain()` for an unrelated feature); `seedFinanceBrains()`'s own upserts for them resolve to those existing rows.

Both prompts are new `AiPrompt` rows at `version: 'v1'` (the first version for these Brains — not a renumbering of the n8n-era `v2`/`v3` files), copied from `intent-classification.v2.md` / `expense-extraction.v3.md` with two changes: an added sentence describing AI Core's `JSON.stringify(input)`-as-user-message convention, and (extraction prompt only) the `${today}` JS template literal replaced with a `{{today}}` AI Core placeholder resolved from the `input.today` field the Handler now passes explicitly.

## Workflow changes

- **`02-finance-intent-router.json`**: `Ollama Chat Model` node and its `ai_languageModel` connection deleted. `Classify Intent (Chain)` (`chainLlm`) replaced by `Call AI Core - Intent Classification` (`httpRequest`, `POST {{$env.EYAN_API_BASE_URL}}/ai-core/service/capabilities/finance-intent-classification/invoke`, the same `HkpCn7QOHOauRVq1` "EYAN Service API" credential CRM's own AI Core call already uses). `Parse Classification Output` rewritten to read `$json.data.outputJson`/`$json.data.outcome` instead of `$json.text`; its local fence-stripping/JSON-extraction logic was removed (AI Core's `extractJson()` now does that server-side) but the 8-value intent enum + `confidence ∈ [0,1]` validation from ADR-0012 is preserved verbatim as defense-in-depth.
- **`10-handle-create-expense.json`**: `Prepare Expense Extraction Input` rewritten to build an AI Core `{input, context}` body instead of an `ollamaRequestBody`. `Call Ollama - Extract Expense` replaced by `Call AI Core - Extract Expense` (`httpRequest`, `.../capabilities/expense-extraction/invoke`, same shared credential). `Validate Expense Extraction`'s entry point changed from `$json.message.content` to `$json.data.outputJson`; every field-level validation rule from ADR-0011 (amount/category/paymentMethod/date/description/isRecurring enum and range checks) is preserved verbatim.

Neither workflow's non-AI logic (contract validation, the Intent Router Switch, Finance API request/response handling) changed.

## Routing policy configuration

Both seeded `AiRoutingPolicy` rows use `maxRetries: 3`, `confidenceHighThreshold: 0.75`, `confidenceMediumThreshold: 0.4` (matching every other Brain in the file), and no fallback provider/model (also matching every other Brain — none has one configured today).

**`timeoutMs: 300_000` (300s) for both** — not the Handler's previous 90s `httpRequest` timeout. This was an open decision at planning time, resolved in favor of AI Core's universal default over preserving the old value, on the reasoning that `maxRetries: 3` means a slow call plus retries could legitimately need longer than 90s to reach a final answer. **The live verification below confirms this was necessary, not just conservative**: real calls against this host's Ollama took 234.5s (intent classification) and 176.8s (expense extraction) — both would have exceeded the Handler's old 90s timeout, and the intent-classification call came within 66 seconds of the 300s ceiling itself. 300s is the currently-required floor for this host's actual model latency, not headroom for a hypothetical.

`expense-extraction-brain`'s confidence thresholds are seeded for schema consistency but are inert: the extraction prompt has no `confidence` field by design (ADR-0011's field-enum validation is the real safety net for that task, not a self-reported score), so `AiRoutingService`'s confidence classification never fires for this Brain.

## AI Core usage logging

Every invocation of either capability now produces an `AiUsageLog` row (`brainId`, `capabilityId`, `providerId`, `modelId`, `outcome`, `retryCount`, `latencyMs`, `workflowExecutionId`) — the audit trail that did not exist under the direct-Ollama pattern. `workflowExecutionId` is the same value threaded through the whole Finance Inbox chain (ADR-0008), so a Finance AI call can now be correlated back to the exact end-user message and n8n execution that triggered it.

# Live End-to-End Verification

Run 2026-08-13 against the real, imported workflows and the real local Ollama instance — no mocking, matching this repo's established live-verification standard (ADR-0007, ADR-0009, ADR-0012). Test message: `"I spent $0.01 on coffee today, paid by cash."`, routed through a temporary test-caller workflow into the real `FinanceIntentRouterWf01` → `FinanceHandlerCreateExpenseWf01` chain (`workflowExecutionId: ai-core-migration-test-1786631341431`).

| Step | Capability | Brain | Model | Outcome | Retries | Latency |
|---|---|---|---|---|---|---|
| Intent classification | `finance-intent-classification` | `finance-intent-brain` | `mistral:7b` | `VALID` | 0 | 234.5s |
| Expense extraction | `expense-extraction` | `expense-extraction-brain` | `gemma3:4b` | `VALID` | 0 | 176.8s |

- Classifier returned `{"intent": "CREATE_EXPENSE", "confidence": 0.95}` — correct, `HIGH` confidence tier, `needsManualReview: false`.
- Extractor returned its JSON wrapped in a Markdown ` ```json ` fence. **AI Core's `extractJson()` correctly stripped the fence and parsed the object** (`{"amount":0.01,"category":"FOOD","paymentMethod":"CASH","date":"2026-08-13","description":"coffee","isRecurring":false}`) — the same class of formatting variance ADR-0009 diagnosed as fatal under n8n's `ToolsAgent`/`outputParserStructured` mechanism does not reproduce here, because AI Core's Ollama provider adapter calls the native `/api/chat` endpoint directly (no tool-calling, no LangChain Agent node) and does its own fence-tolerant extraction, architecturally the same "raw completion + manual parse" approach ADR-0011/ADR-0012 already independently arrived at for n8n's side of the call.
- The real Finance API call succeeded and created a real `Expense` row (`id: cmsrmf3r2000o82krq9th3v6b`, `amount: 0.01`, `category: FOOD`, `paymentMethod: CASH`, `description: coffee`, `createdBy: web-chat:ai-core-migration-test`) — the full chain from n8n test trigger through both AI Core capabilities to a real Finance domain write was exercised, not just the AI Core calls in isolation.
- No direct Ollama call occurred anywhere in either executed node graph — confirmed both structurally (no `httpRequest`/`lmChatOllama` node in either workflow targets an Ollama URL; the only remaining occurrences of the word "Ollama" in either file are historical/explanatory code comments) and behaviorally (the executed node sequence for both workflows contains only `Call AI Core - *` nodes for the AI step).
- `tests/workflows/finance/02-finance-intent-router.logic.test.js`: 87/87 assertions passing.
- `tests/workflows/finance/10-handle-create-expense.logic.test.js`: 147/147 assertions passing.

# Consequences

- Finance AI calls are now visible in AI Core's usage/audit trail and admin routing UI, matching CRM's `lead-qualification` capability. Either Finance model can be changed via the AI Core admin UI's routing-policy activation mechanism (the same mechanism used to switch `AiRoutingPolicy.isActive`) without touching or redeploying either workflow's JSON.
- Both workflows lose direct knowledge of which model or provider serves their AI call — this is the intended effect of the migration, not a side effect. `mistral:7b` and `gemma3:4b` are no longer hardcoded in `workflows/finance/*.json`; they are configuration inside `eyan-ai-platform`.
- The 300s `timeoutMs` on both Routing Policies is now empirically load-bearing, not just a conservative default — see the timeout discussion above. If this host's Ollama latency increases further (e.g. under concurrent load from CRM's own AI Core calls sharing the same local Ollama instance), 300s may need to be revisited; this ADR does not attempt to pre-solve that.
- ADR-0009's and ADR-0012's findings about n8n's Agent-node/`outputParserStructured` tool-call-wrapper incompatibility remain historically accurate for that mechanism — this migration does not use it and never revisits that finding, it simply removes both Finance tasks from using any n8n-side LLM-calling node at all (`lmChatOllama`, `chainLlm`) in favor of a plain `httpRequest` call to AI Core, the same node type CRM's own workflow already used for this reason.
- `workflows/finance/prompts/intent-classification.v2.md` and `expense-extraction.v3.md` are retained as human-readable historical mirrors; the runtime source of truth for both prompts is now the corresponding `AiPrompt` row (`version: 'v1'`, scoped per-Brain) in `eyan-ai-platform`.

# Related Documents

- `docs/adrs/ADR-0009-finance-intent-router-model-selection.md` (superseded transport-wise by this migration; addendum added)
- `docs/adrs/ADR-0011-finance-handler-ai-extraction-approach.md` (superseded transport-wise by this migration; addendum added)
- `docs/adrs/ADR-0012-finance-intent-router-deterministic-classification.md` (the Router's parsing/validation logic this migration preserves as defense-in-depth; addendum added)
- `docs/adrs/ADR-0008-finance-inbox-workflow-contract.md` (the Request/Response contract, unchanged by this migration)
- `workflows/finance/02-finance-intent-router.json`, `workflows/finance/10-handle-create-expense.json`
- `eyan-ai-platform/backend/prisma/seed-ai-core.ts` (`seedFinanceBrains()`)
- `workflows/crm/03-ai-qualification.json` (the AI-Core-calling precedent this migration follows)

# Notes

At the time of the live verification above, `finance-intent-brain` briefly had a second, unrelated `AiRoutingPolicy` (targeting `qwen2.5-coder:7b`) made active via the AI Core admin UI outside of this migration's own work; it was identified via `AiAuditEvent` before the live test and the `mistral:7b` policy this migration seeded was reactivated (through `AiRoutingPolicyService.activate()`, preserving the audit trail) prior to running the verification recorded above. This is recorded here because it is a real property of the new architecture worth knowing: a Brain's routing policy is live-editable through the admin UI independently of this repo's seed data, which is the intended flexibility this migration provides, not a defect.
