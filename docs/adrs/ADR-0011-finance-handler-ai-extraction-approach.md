# ADR-0011: Finance Handler AI Extraction Approach

- Status: Accepted
- Date: 2026-08-10
- Authors: Claude Code

---

# Context

Phase 3A builds the first Finance intent Handler, `workflows/finance/10-handle-create-expense.json` (`FinanceHandlerCreateExpenseWf01`), the target of `02-finance-intent-router.json`'s forward-referenced `Execute Handler - CREATE_EXPENSE` node. The Router deliberately extracts nothing beyond `{intent, confidence}` (ADR-0008 Notes amendment) — extracting `amount`/`category`/`paymentMethod`/`date`/`description` from `rawText` is explicitly this Handler's job, the first place in the AI Finance Inbox chain that needs to do it.

Two AI-calling patterns already exist in this repo for structured extraction against a local model:

1. **`02-finance-intent-router.json`'s own pattern** — `@n8n/n8n-nodes-langchain.agent` (AgentV3) + `lmChatOllama` + `outputParserStructured`. Diagnosed in `docs/adrs/ADR-0009-finance-intent-router-model-selection.md`: this mechanism has a **0% structured-output success rate** against both locally available tool-capable Ollama models (`mistral:7b` 0/11, `qwen2.5-coder:7b` 0/11) — the model's answer is correctly reasoned but wrapped in a `format_final_json_response` tool-call envelope that this exact n8n/LangChain version's `N8nStructuredOutputParser` does not unwrap. Every classification call through this path degrades to the `onError`/fallback safety net, never a real result.
2. **`workflows/crm/03-ai-qualification.json`'s pattern** — a plain `n8n-nodes-base.httpRequest` node calling an external AI capability, with a Code node (`Map AI Core Result`) manually parsing the JSON response. Sprint 5 replaced that workflow's own earlier LangChain-Agent-based Ollama integration with this pattern specifically because of local-model structured-output reliability problems (ADR-0007's own Consequences section).

# Decision

**The CREATE_EXPENSE Handler's expense-field extraction uses pattern 2 (direct `httpRequest` call to Ollama's native `/api/chat` endpoint, `format: "json"`, manual `JSON.parse()` in a Code node) — not pattern 1 (the Finance Intent Router's own LangChain Agent/`outputParserStructured` mechanism).**

Rationale:

1. Reusing a mechanism this same investigation (ADR-0009) already proved has a 0% success rate against local Ollama models would very likely reproduce that failure inside the Handler too — extraction is a *harder* structured-output task than the Router's single-field classification (five fields instead of one), not an easier one.
2. `format: "json"` alone — Ollama's own native JSON-mode flag, independent of any n8n LangChain node — was already shown in ADR-0009 to produce correct, well-formed JSON at the raw-completion layer (both `mistral:7b` and `qwen2.5-coder:7b`'s raw completions were correct; only the Agent-node/parser wrapper broke). Calling this endpoint directly gets that same reliable raw behavior without going through the broken wrapper at all.
3. This is not new infrastructure — `n8n-nodes-base.httpRequest` is already the most common node type in this repo (`workflows/crm/`, `workflows/integrations/`), and `$env.OLLAMA_BASE_URL` / `host.docker.internal` reachability is already established and resolved (ADR-0007). No new credential is needed (Ollama has no auth locally, same as the Router's own Ollama call today).
4. The model is hardcoded in the node (not read from `$env.OLLAMA_MODEL`) — originally `mistral:7b`, matching `02-finance-intent-router.json`'s own convention and ADR-0009's explicit recommendation for that (different) domain; see the Addendum below for why this Handler's own hardcoded value has since changed. `$env.OLLAMA_MODEL` is a separate, CRM-era config value (currently `qwen2.5-coder:7b`) unused by any workflow since Sprint 5's AI Core migration; silently inheriting it into an unrelated domain's model choice would be a coupling this Handler does not need.

**No change to `02-finance-intent-router.json` is made or implied by this ADR.** The Router's own classification mechanism is out of scope for Phase 3A — fixing it (if fixed the same way) is a separate, future decision for that specific workflow, not something this ADR pre-approves by extension.

# Alternatives Considered and Rejected

- **Reuse the Router's Agent/`outputParserStructured` pattern for consistency** — rejected: "consistency" with a mechanism already proven non-functional in this exact environment is not a real benefit; it would just relocate the same 0%-success-rate failure into a second workflow.
- **Wait for the Router's classifier to be fixed first, then mirror whatever fix is chosen** — rejected as blocking: Phase 3A's scope is the CREATE_EXPENSE Handler only, and the Handler's extraction call is a distinct node graph from the Router's classification call; nothing about building the Handler now forecloses applying the same or a different fix to the Router later.
- **A deterministic (regex/keyword) extractor instead of AI extraction** — rejected as the primary mechanism per the task's own constraint: amount/category extraction from free-form natural language is exactly the kind of task the Finance Intent Router's own classification prompt already treats as needing ambiguity-aware judgment ("never guess between two plausible categories"), which naive keyword rules cannot safely provide. The existing deterministic validation this Handler already does (real `ExpenseCategory`/`PaymentMethod` enum membership checks, amount range/type checks) is the safety net around the AI extraction, not a replacement for it.

# Consequences

- The CREATE_EXPENSE Handler's extraction call and the Finance Intent Router's classification call are now two independently-implemented AI-calling mechanisms within the same Finance domain, using different node types for structurally the same underlying task class (structured output from a local Ollama model). This is a deliberate, documented divergence, not accidental drift — revisit if/when the Router's own mechanism is fixed, at which point unifying both onto one mechanism becomes a reasonable follow-up (not required by this ADR).
- `workflows/finance/prompts/expense-extraction.v1.md` is a new prompt reference file, following the exact convention `intent-classification.v1.md` already established (a human-readable, version-controlled copy that must be kept byte-identical to the node's embedded literal string by hand — n8n has no mechanism to load a prompt from disk into either a Code node string or an Agent node's `systemMessage`).
- If a future phase migrates the Router itself onto a direct-`httpRequest` pattern (the most likely fix for ADR-0009's finding), this Handler's extraction node becomes the second, not the first, precedent for that approach within Finance — reducing the risk of that future change.

# Addendum (2026-08-12): model changed to `gemma3:4b`

This ADR's pattern-2 architecture (direct `httpRequest` to Ollama's native `/api/chat`, `format: "json"`, manual `JSON.parse()`) is unchanged and remains in effect. Only the hardcoded `model` value on "Prepare Expense Extraction Input" changed, from `mistral:7b` to `gemma3:4b`, based on production testing on this VPS (~11 GiB RAM, 8 GiB swap): `mistral:7b` was found too resource-heavy for reliable production use at this host's capacity, while `gemma3:4b` runs successfully (100% CPU, no swap thrash observed) through this Handler's own calling pattern.

This is not a reversal of ADR-0009's exclusion of `gemma3:4b` — that exclusion is specific to `02-finance-intent-router.json`'s `ToolsAgent`-based Agent node, which hard-errors on `gemma3:4b` because it lacks Ollama "tools" capability. This Handler never uses an Agent node at all (that is the entire point of this ADR's Decision); a direct `httpRequest` call with `format: "json"` has no "tools" dependency, so `gemma3:4b`'s missing tool-calling capability is irrelevant here. ADR-0009's finding and this Addendum are both correct, about two structurally different calling mechanisms.

Also confirmed in production testing: 2048 is a better `num_ctx` than Ollama's 4096 default for this workload (short single-message extraction, no need for a larger window), and `temperature: 0` is desired for deterministic extraction — both now set via an `options` block on the node's `ollamaRequestBody`, alongside the existing `format: "json"` flag.

`gemma3:4b` correctly extracts all six fields, but — without strongly constrained enum instructions — was observed returning values outside the application's contract (e.g. `category: "Food & Drink"`, `paymentMethod: "Imagin Card"`, `date: "today"`). The extraction prompt (`workflows/finance/prompts/expense-extraction.v3.md`) was strengthened with explicit negative examples and output rules to reduce this. **This does not change or weaken `Validate Expense Extraction`'s downstream validation** — the real `ExpenseCategory`/`PaymentMethod` enum checks remain the actual safety net; the prompt change only reduces how often that safety net has to fall back to a clarifying question.

# Related Documents

- `docs/adrs/ADR-0008-finance-inbox-workflow-contract.md` (the contract this Handler implements)
- `docs/adrs/ADR-0009-finance-intent-router-model-selection.md` (the diagnosis this ADR's Decision is built on)
- `docs/adrs/ADR-0007-n8n-ollama-connectivity-gap.md` (the connectivity precedent both Ollama-calling patterns rely on; also CRM Workflow 3's own move away from the LangChain-Agent pattern)
- `workflows/finance/10-handle-create-expense.json`, `workflows/finance/prompts/expense-extraction.v1.md`
- `workflows/crm/03-ai-qualification.json` (the `httpRequest`-plus-manual-parse precedent this ADR follows)
- `eyan-ai-platform` `docs/architecture/decisions/ADR-0024-finance-automation-service-contract.md` (the backend contract this Handler's Finance API call implements)
