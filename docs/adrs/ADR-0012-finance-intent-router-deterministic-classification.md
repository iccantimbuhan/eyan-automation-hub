# ADR-0012: Finance Intent Router — Deterministic Classification Pipeline (Replacing the AI Agent + Structured Output Parser)

- Status: Accepted
- Date: 2026-08-10
- Authors: Claude Code

---

# Context

ADR-0009 formally evaluated whether a different local Ollama model would fix the Finance Intent Router's classification failure and concluded it would not: `mistral:7b` and `qwen2.5-coder:7b` both failed the `outputParserStructured` node on **0/11 attempts each** (22/22 total), every failure the identical `format_final_json_response` tool-call-wrapper mismatch first diagnosed in Phase 2. Decoded manually, both models' raw completions were classified correctly in nearly every case (10/11 and 11/11) — the models understand the task. The blocker is architectural: n8n's `@n8n/n8n-nodes-langchain.agent` node (AgentV3) is a `ToolsAgent` implementation that, whenever an output parser is attached (`hasOutputParser: true`), always drives structured output through LangChain tool-calling, defining a `format_final_json_response` tool and requiring the model to respond via a tool call matching that schema. Every Ollama "tools"-capable model tried wraps its answer in that tool-call envelope, and `N8nStructuredOutputParser` in this n8n/LangChain version does not unwrap it.

Per explicit instruction, this phase does **not** try further models against the same Agent + Structured Output Parser combination — ADR-0009 already proved that axis is exhausted. This ADR instead replaces the classification *mechanism* itself: no `n8n AI Agent` node, no LangChain Structured Output Parser, with the classification-output contract enforced entirely by hand-written, auditable Code-node logic instead of an opaque LangChain component.

# Decision

**Replace the `Ollama Chat Model → AI Agent (with Structured Output Parser) → Validate Agent Output` sub-pipeline with `Ollama Chat Model → Classify Intent (Chain) → Parse Classification Output → Merge Context With Classification`.**

## New nodes

- **Ollama Chat Model** (`lmChatOllama`, kept, same node) — `options.format: "json"` **removed**. See "Why `format: "json"` was removed" below.
- **Classify Intent (Chain)** (`@n8n/n8n-nodes-langchain.chainLlm`, "Basic LLM Chain", typeVersion 1.9, `onError: continueRegularOutput`) — replaces `AI Agent - Classify Intent`. `hasOutputParser: false`, no `ai_outputParser` connection. This node type is **not** an agent — it does not do tool-calling, does not loop, and does not bind any tools to the model (confirmed by reading the compiled node source: `ChainLlm.node.js`'s `execute()` calls `getOptionalOutputParser`, which returns `undefined` when no `ai_outputParser` input is connected; `chainExecutor.js`'s `executeChain` takes the `if (!outputParser)` branch straight to `executeSimpleChain`, which never constructs a tool schema or forces tool-calling). The model's raw text completion is returned unmodified as `$json.text`.
- **Parse Classification Output** (`n8n-nodes-base.code`, new) — the entire classification-output contract is enforced here, not by any LangChain component. Reads `$json.text`, tolerates a ```` ```json ... ``` ```` or bare ``` ``` ``` fence and/or surrounding prose, parses the JSON, and validates: the result is an object (not an array or scalar); `intent` is a string in the eight-value Intent Catalog; `confidence` is a finite number in `[0, 1]`. Any failure — Chat Model error, unparseable text, wrong shape, out-of-catalog intent, out-of-range confidence — falls back to `{intent: "UNRECOGNIZED", confidence: 0}`. Never throws (all `JSON.parse` calls are wrapped in `try`/`catch`; every other check is a plain `typeof`/range comparison). Returns **only** `intent` and `confidence` — any extra field in the model's raw text is dropped, not passed through.
- **Merge Context With Classification** (renamed from `Validate Agent Output`, same node/id) — now a pure merge: takes the parser's already-validated `{intent, confidence}` and the original request context (read back from `Validate Request Contract` by node name, unchanged pattern from Phase 2) and produces the combined record the Intent Router and Handlers need. No re-validation — that responsibility moved entirely to `Parse Classification Output`.
- **Intent Output Parser** (`outputParserStructured`) and **AI Agent - Classify Intent** (`agent`) — **removed**. Zero nodes of either type remain in this workflow (test-enforced, see Testing).

No other node changed. `Request Valid?`, `Intent Router`, all 8 `Execute Handler - *` nodes, and `Return Handler Response` are untouched except for `Return Handler Response`'s `$('Validate Agent Output')` reference, updated to `$('Merge Context With Classification')` to match the rename.

## Why `format: "json"` was removed from the Ollama Chat Model node

This is a deliberate choice, not an oversight, and is exactly the kind of decision this ADR exists to make explicit rather than leave as an implicit side effect. Reading `chainExecutor.js`: when no explicit output parser is attached (our case), `executeSimpleChain` still calls `getOutputParserForLLM(llm)` internally, which inspects the connected Chat Model node for `options.format === 'json'` and, if set, silently wraps the response in a `NaiveJsonOutputParser` — attempting `JSON.parse` and, on success, returning an **already-parsed JS object** rather than a string. Combined with `shouldUnwrapObjects` (true for typeVersion ≥ 1.6), this means `$json` at the Chain node's output would be **either** `{text: "<raw string>"}` **or** the classification object directly, depending on whether Ollama's constrained JSON output happened to parse cleanly — an implicit, format-dependent response shape decided by a LangChain internal, not by this workflow's own code.

This is precisely the class of hidden framework-level coercion that caused the original bug (an invisible tool-calling mechanism the workflow author didn't choose or see). Removing `options.format: "json"` guarantees `isModelWithFormat(llm)` is false, so `getOutputParserForLLM` falls through to a plain `StringOutputParser`, and `$json.text` is **always** a string, with zero exceptions. `Parse Classification Output` performs 100% of the JSON extraction itself, deterministically, from that one guaranteed shape — matching the explicit requirement that the parser "not use fragile assumptions about a single exact model response format": the *parser*, not the framework, is what's expected to be robust to formatting variance (Markdown fences, prose), and it can only do that reliably from a raw string, not from an input whose shape the framework silently changes underneath it.

## Prompt (v2)

`workflows/finance/prompts/intent-classification.v2.md` (embedded verbatim in the Chain node's system message). v1 targeted the Agent node's structured-output mode and never needed to instruct the model about tool calls or Markdown, since the (broken) parser was supposed to enforce shape. v2 targets a plain chat completion and is explicit about everything the mechanism no longer enforces for it: JSON only, no Markdown fences, no explanations, no tool calls, no invented fields beyond `intent`/`confidence`, no Finance-field extraction, exactly one of the eight catalog intents, confidence in `[0, 1]`, and five concrete ambiguity rules (use `UNRECOGNIZED` when unclear; don't guess expense-vs-transfer; don't guess income-vs-expense; don't guess whether an unclear-intent message's attachment is a receipt), each with a worked example including three genuinely ambiguous cases. v1 is kept for history, not deleted.

# Live Validation

- `n8n import:workflow` / `n8n export:workflow` round-trip: byte-for-byte match across all 18 nodes and every connection (including the new `ai_languageModel` wiring and the absence of any `ai_outputParser` connection).
- `node tests/workflows/finance/02-finance-intent-router.logic.test.js`: 80/80 assertions passing, including a dedicated regression test that feeds `Parse Classification Output` the exact `format_final_json_response`-wrapped text that broke the original design and confirms it is correctly rejected (falls to `UNRECOGNIZED`, not accidentally accepted).
- **Live `n8n execute` against real Ollama** (`mistral:7b`, the ADR-0009 default), the same 11-case test set ADR-0009 used (one message per intent + repeats + the deliberately ambiguous case), run end-to-end through the real, imported workflow: see results below.

**Result: 11/11 (100%) clean structured-output success and 11/11 (100%) correct classification** — a complete reversal of ADR-0009's 0/11:

| Case | `rawText` | Latency | Model's raw text | Parsed `intent` | `confidence` | Correct? |
|---|---|---|---|---|---|---|
| `expense_1` | "spent $12.50 on lunch" | 10.7s | `{"intent": "CREATE_EXPENSE", "confidence": 0.99}` | `CREATE_EXPENSE` | 0.99 | ✓ |
| `expense_2` | (repeat) | 18.9s | `{"intent": "CREATE_EXPENSE", "confidence": 0.99}` | `CREATE_EXPENSE` | 0.99 | ✓ |
| `expense_3` | (repeat) | 19.0s | `{"intent": "CREATE_EXPENSE", "confidence": 0.98}` | `CREATE_EXPENSE` | 0.98 | ✓ |
| `budget_1` | "what's my budget this month?" | 12.5s | `` `{"intent": "GET_BUDGET", "confidence": 0.95}` `` (wrapped in single backticks — an unanticipated format neither the fence regex nor a direct parse matches; correctly recovered by the span-extraction fallback) | `GET_BUDGET` | 0.95 | ✓ |
| `dashboard_1` | "how am I doing this month?" | 11.5s | `{"intent": "GET_DASHBOARD", "confidence": 0.95}` | `GET_DASHBOARD` | 0.95 | ✓ |
| `question_1` | "am I overspending on food?" | 12.6s | `{"intent": "GET_FINANCE_QUESTION", "confidence": 0.95}` | `GET_FINANCE_QUESTION` | 0.95 | ✓ |
| `income_1` | "got paid $2000" | 9.2s | `{"intent": "CREATE_INCOME", "confidence": 0.98}` | `CREATE_INCOME` | 0.98 | ✓ |
| `transfer_1` | "sent $50 to Alex" | 16.4s | `{"intent": "CREATE_TRANSFER", "confidence": 0.95}` | `CREATE_TRANSFER` | 0.95 | ✓ |
| `receipt_1` | (attachment, no text) | 12.6s | `{"intent": "UPLOAD_RECEIPT", "confidence": 0.8}` | `UPLOAD_RECEIPT` | 0.8 | ✓ |
| `unrecognized_1` | "hey how's it going?" | 11.9s | `{"intent": "UNRECOGNIZED", "confidence": 0.9}` | `UNRECOGNIZED` | 0.9 | ✓ |
| `ambiguous_1` | "sent $50 to Alex for dinner" | 17.2s | `{"intent": "CREATE_TRANSFER", "confidence": 0.85}` | `CREATE_TRANSFER` | 0.85 | ✓ (defensible — see below) |

**Latency**: mean 13.9s, range 9.2s–19.0s. Roughly **2.5x faster** than the old Agent-based mechanism's 34.5s mean (ADR-0009) — expected, since there is no tool-calling round trip and no Agent reasoning loop, just one plain chat completion.

**The `budget_1` case is a genuine, unplanned robustness proof**: the model wrapped its JSON in single backticks (`` `{...}` ``, likely echoing the inline-code backtick style used around the JSON examples in the v2 prompt) — a format neither the ```` ``` ```` fence regex nor a direct `JSON.parse` matches on its own. `extractJsonObject`'s span-extraction fallback (first `{` to last `}`) correctly recovered it anyway. This is exactly the "harmless formatting" tolerance the parser was required to survive, caught by a real model response, not a hand-constructed test case.

**`ambiguous_1` still does not follow the "prefer UNRECOGNIZED on genuine ambiguity" instruction** — `mistral:7b` answered `CREATE_TRANSFER` at 0.85 confidence rather than `UNRECOGNIZED`, the same behavior ADR-0009 observed under the old mechanism. This is a prompt-following limitation, not something this ADR's architectural fix targets or claims to have solved — flagged again under Consequences/Follow-up.

# Consequences

- **The Router can now classify real messages.** This is the direct fix for the state ADR-0009 documented as a known limitation ("the Router will classify 0% of messages successfully"). Whether it does so *well* in production depends on the live results above and on the Handler workflows' own robustness to occasional `UNRECOGNIZED` results, not on this ADR alone.
- No change to the Finance Inbox Workflow Contract (ADR-0008), the Request/Response shapes, the Intent Catalog, or any Handler workflow. `01-finance-inbox-entry.json` (the Router's only caller) required no change — the Router's external contract (`Execute Workflow` in, Response contract out) is identical to before.
- `docs/workflows/02-finance-intent-router.md`'s Testing section is updated with this phase's findings rather than duplicating this ADR's detail.
- The Chain-node approach (`chainLlm`, no output parser) is now the established pattern in this repo for "get a raw completion and parse it yourself" — worth reusing over the Agent-node pattern for any future n8n + local-Ollama classification/extraction task in this repo, unless that task genuinely needs the Agent's tool-calling/multi-step-reasoning capability (which intent classification never did).
- This ADR does not revisit ADR-0009's model recommendation — `mistral:7b` remains the configured default. If this fix meaningfully changes relative model performance (since the failure mode ADR-0009 measured no longer applies), that comparison would need to be re-run, but is not required for this phase.
- **Not fixed by this ADR, and not in its scope**: the model still does not reliably follow the prompt's "prefer `UNRECOGNIZED` on genuine ambiguity" instruction — `mistral:7b` answered `CREATE_TRANSFER` (not `UNRECOGNIZED`) on the deliberately ambiguous live test case, the same behavior ADR-0009 observed under the old mechanism. This is a prompt-following/model-behavior question, independent of the mechanism replaced here — a candidate for future prompt iteration (few-shot weighting, or restructuring the ambiguity rule), not a sign this fix is incomplete.

# Addendum (2026-08-13): transport superseded by AI Core migration, validation logic retained as defense-in-depth

`docs/adrs/ADR-0014-finance-ai-core-migration.md` removes the `Ollama Chat Model` (`lmChatOllama`) and `Classify Intent (Chain)` (`chainLlm`) nodes this ADR introduced, replacing them with an `httpRequest` call to AI Core's `finance-intent-classification` capability. AI Core's own `extractJson()` now performs the fence-stripping/span-extraction this ADR's `Parse Classification Output` node used to do itself — including recovering the exact "wrapped in stray backticks" case this ADR's live validation caught in `budget_1` (see above); that class of formatting variance is now handled server-side, once, for every AI Core capability, not per-workflow.

`Parse Classification Output`'s **business-shape validation is preserved verbatim**: the 8-value Intent Catalog membership check and `confidence ∈ [0, 1]` finite-number check still run against `$json.data.outputJson` (previously `$json.text`, manually parsed), because AI Core enforces no per-capability schema — "is this parseable JSON" is the limit of what AI Core itself guarantees, exactly as this ADR's own Findings anticipated needing when it noted the parser must not use "fragile assumptions about a single exact model response format." This ADR's `{intent: "UNRECOGNIZED", confidence: 0}` fallback contract is unchanged and still the same value the Intent Router receives on any failure — AI Core call error, non-`VALID` outcome, or a malformed `outputJson`.

`mistral:7b` remains the configured model. Live-verified 2026-08-13 (see ADR-0014): a real call through the new path returned `VALID` with 0 retries in 234.5s and classified the test message correctly at 0.95 confidence — this ADR's fix (a working classification mechanism) is not reversed by removing the `chainLlm` node, since AI Core's provider adapter is architecturally the same "raw completion + manual/server-side parse" approach this ADR's Decision established, just relocated behind AI Core rather than inside the workflow.

# Related Documents

- `docs/adrs/ADR-0014-finance-ai-core-migration.md` (supersedes this ADR's transport mechanism; preserves and live-verifies this ADR's validation logic)
- `docs/adrs/ADR-0009-finance-intent-router-model-selection.md` (the evaluation that ruled out "try another model" as the fix, and whose test set this ADR's live validation reuses)
- `docs/adrs/ADR-0008-finance-inbox-workflow-contract.md` (the contract this workflow implements, unchanged by this ADR)
- `docs/workflows/02-finance-intent-router.md`
- `workflows/finance/02-finance-intent-router.json`, `workflows/finance/prompts/intent-classification.v2.md`
- `tests/workflows/finance/02-finance-intent-router.logic.test.js`

# Notes

Node-source research performed by reading the actual compiled files inside the live n8n container (`ChainLlm.node.js`, `config.js`, `processItem.js`, `chainExecutor.js`, `responseFormatter.js` under `@n8n/n8n-nodes-langchain`'s installed package), the same technique used throughout this project for every previously-unused n8n node type — not guessed from documentation or assumed by analogy to the Agent node's behavior. The exact `SystemMessagePromptTemplate.lc_name()` string required for the `messages.messageValues[].type` field (`"SystemMessagePromptTemplate"`) was confirmed by executing the installed `@langchain/core` package directly inside the container, not assumed.
