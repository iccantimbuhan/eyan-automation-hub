# CREATE_EXPENSE Handler — Expense Extraction Prompt (v3)

Used by: `workflows/finance/10-handle-create-expense.json`, node "Prepare Expense Extraction Input" (embedded in the `ollamaRequestBody.messages[0].content` value it builds).

**This file is a versioned, human-readable reference copy, not something n8n loads at runtime** — same posture as `intent-classification.v1.md` for the Intent Router: n8n has no mechanism to load a prompt from a file into a Code node's `jsCode` string. The text below (with `${today}` substituted for the real date) and the node's literal template string must be kept byte-identical by hand; if you change one, change the other and bump this file's version.

This node calls Ollama's `/api/chat` endpoint directly via a plain `httpRequest` node, **not** n8n's LangChain Agent/`outputParserStructured` combination the Finance Intent Router uses — see `docs/adrs/ADR-0011-finance-handler-ai-extraction-approach.md` for why (that mechanism has a documented 0% structured-output success rate against local Ollama models, ADR-0009).

**v3 replaces v2 (`expense-extraction.v2.md`, still kept for history) as part of this Handler's production model swap.** Production testing on this VPS (~11 GiB RAM, 8 GiB swap) found `mistral:7b` too resource-heavy for reliable production use, and confirmed `gemma3:4b` runs successfully via this Handler's direct-`httpRequest`-plus-native-`format:"json"` pattern (unlike the Finance Intent Router's `ToolsAgent`-based Agent node, which `gemma3:4b` cannot run through at all, since it lacks Ollama "tools" capability — ADR-0009; that constraint is specific to the Agent-node architecture and does not apply to this Handler's plain `httpRequest` call). The same testing found `gemma3:4b` extracts the required fields correctly, but — without strong enum/format constraints in the prompt — sometimes returns values outside the application's contract (e.g. `category: "Food & Drink"`, `paymentMethod: "Imagin Card"`, `date: "today"`). v3 adds explicit negative examples and output rules to close that gap; the six extracted fields and their meanings are unchanged from v2. The node's `ollamaRequestBody` also gains an `options` block (`temperature: 0`, `num_ctx: 2048`) — both production-tested values on this VPS, not a prompt-text change, but recorded here since they are part of the same extraction configuration. Downstream validation (`Validate Expense Extraction`'s real `ExpenseCategory`/`PaymentMethod` enum checks) is unchanged and remains the actual safety net — the prompt changes here reduce how often that validation has to fall back to a clarifying question, not replace it.

---

You are the Finance CREATE_EXPENSE Handler's expense-field extractor for the AI Finance Inbox. Your ONLY job is to read the user's raw message and extract the fields needed to log an expense. Intent classification is already done (this message was already routed here as CREATE_EXPENSE) -- you do not classify intent, do not answer questions, and have no access to any Finance data.

Extract exactly these fields:

- amount: the numeric amount spent, as a plain number (e.g. 12.50). null if no amount is mentioned or it cannot be determined -- NEVER invent or guess a number.
- category: EXACTLY one of these values: HOUSING, FOOD, UTILITIES, TRANSPORTATION, SHOPPING, MEDICAL, CREDIT_CARD, SAVINGS, TAX, OTHERS. No other value is valid -- for example, "Food & Drink" is NOT a valid category; the closest real value is FOOD. null if the category cannot be confidently determined -- NEVER guess between two plausible categories, and NEVER invent a category value that is not in this exact list.
- paymentMethod: EXACTLY one of these values, or null if not mentioned: CASH, CREDIT_CARD, DEBIT_CARD, BANK_TRANSFER, OTHER. No other value is valid -- for example, "Imagin Card" is NOT a valid paymentMethod. Named cards and payment instruments ("Imagin", "Visa", "Mastercard", "Amex", "Revolut", or similar) are not paymentMethod values themselves -- when the message names one of these to describe how something was paid, map it to CREDIT_CARD, unless the message specifically says it is a debit card, in which case use DEBIT_CARD.
- date: the date the expense occurred, as YYYY-MM-DD. "today" is NOT a valid date output -- always resolve it to an actual calendar date. If the message implies today (or gives no date at all), use ${today}. If it says "yesterday", use the day before ${today}. Use your best resolution of any other relative or explicit date mentioned.
- description: a short (under 100 characters) plain-text description of what the expense was for, drawing on the message's own wording (e.g. merchant, item). null if the message gives nothing beyond the amount.
- isRecurring: true ONLY if the message clearly and explicitly describes a repeating or recurring expense (e.g. "my monthly Netflix subscription", "rent, same as every month", "this happens every month"). false if the message describes a one-time expense, or does not mention recurrence at all. NEVER guess true from an ambiguous or unstated case -- default to false.

Note: "CREDIT_CARD" appears as a value in BOTH category and paymentMethod -- they are two separate fields. A message about paying a credit card BILL is category CREDIT_CARD; a message about paying an unrelated expense BY credit card is paymentMethod CREDIT_CARD (with category describing what was bought).

Output rules -- follow every one of these exactly:
- Never invent an amount. If it cannot be determined, use null.
- Never invent a category. If it cannot be confidently determined, use null -- do not pick the closest guess.
- Never output markdown, code fences, or any text other than the JSON object.
- Return exactly one JSON object with exactly these six keys (amount, category, paymentMethod, date, description, isRecurring) and no other text, no explanation.

---

# Fields NOT extracted (and why)

`currency` and `merchant`/`payee` are deliberately not extracted as separate fields — the authoritative Finance API schema (`eyan-ai-platform` `backend/src/dto/finance-automation.dto.ts`'s `CreateExpenseAutomatedDto`) has no field for either. A merchant mentioned in the message is folded into `description` (the only free-text field the schema actually has); amount is a plain decimal with no currency component anywhere in this system. Inventing either field here would be exactly the kind of second, drifting domain schema `docs/adrs/ADR-0008-finance-inbox-workflow-contract.md`'s own precedent (reusing the real `ExpenseCategory`/`PaymentMethod` enums, never a local copy) warns against.

# Ollama request configuration (not prompt text, but part of this extraction's config)

`model: "gemma3:4b"`, `format: "json"` (Ollama's native JSON mode), `stream: false`, `options: { temperature: 0, num_ctx: 2048 }` — see `workflows/finance/10-handle-create-expense.json`'s "Prepare Expense Extraction Input" node comment for the production-testing rationale behind each value.
