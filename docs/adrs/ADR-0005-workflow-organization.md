# ADR-0005: Workflow Organization

- Status: Accepted
- Date: 2026-07-31
- Authors: Claude Code

---

# Context

`workflows/` was scaffolded with domain subfolders (`ai/`, `crm/`, `customer-support/`, `finance/`, `integrations/`, `marketing/`, `operations/`, `archive/`, `templates/`) before any real workflow existed — `docs/architecture/workflow-architecture.md` describes the philosophy (workflows as production assets and portfolio deliverables) but deliberately left concrete file/naming/ID conventions undecided until a first real domain arrived. The CRM domain (Lead Intake, Validation — see `eyan-ai-platform`'s `.claude/decisions/ADR-0018`/`ADR-0019`) is that first domain. This ADR fixes the conventions those two workflows already follow, so the next domain (support, finance, marketing) doesn't have to rediscover them.

# Decision

**One workflow, one file.** Each n8n workflow is exported/authored as a single JSON file — never multiple workflows bundled in one file, never a workflow split across files.

**Naming**: `workflows/<domain>/NN-workflow-name.json`, `NN` a two-digit sequence number reflecting execution order within the domain (`01-lead-intake.json`, `02-validation.json`, ...) — matches the `docs/workflows/<NN-workflow-name>.md` documentation file for the same workflow, following `templates/workflow/workflow-template.md`'s structure.

**Stable, hand-assigned workflow IDs.** Every workflow JSON carries an explicit top-level `"id"` (e.g. `CrmLeadIntakeWf01`, `CrmValidationWf01`) rather than leaving n8n to auto-generate one on import. This is required for `n8n import:workflow` to succeed at all (a JSON without an `id` fails with a database not-null constraint on repeat import in this n8n version — a real, undocumented CLI quirk discovered this sprint, not an n8n bug report), and it's also what makes cross-workflow references stable: Workflow 1's "Execute Workflow" node references Workflow 2 by this fixed ID, so re-importing either file (e.g. after an edit) never breaks the link. ID convention: `<Domain><Purpose>Wf<NN>` (PascalCase, no separators — n8n IDs are plain strings with no enforced format, this is a house convention for readability in the database/CLI output, not an n8n requirement).

**Cross-workflow calls use n8n's native Execute Workflow / Execute Workflow Trigger pair**, chaining Workflow N → Workflow N+1 directly — not a shared queue or message bus. Redis is present in this stack (`docker-compose.yml`) for n8n's own internal queue-mode scaling, not as an application-level message bus between workflows; introducing one for two sequentially-chained workflows would be unjustified complexity for what n8n's built-in sub-workflow call already does correctly (including passing structured JSON data and, per TDD §10, still allowing any workflow in the chain to be triggered standalone with manual/CLI test data for debugging).

**Domain-specific security/credential decisions get their own ADR the first time they matter**, rather than being folded into this one — see ADR-0006 for the CRM domain's specific choices (which secret goes in which n8n credential type, why one workflow reads `$env` and none read secrets that way). This ADR is scoped to file/naming/ID/chaining conventions only, applicable to every future domain unchanged.

# Consequences

## Positive

- Every workflow's location, ID, and matching doc file are derivable from its name alone — no lookup table needed.
- `n8n import:workflow --input=<file>` is idempotent (re-importing the same file with the same `id` updates in place, never creates a duplicate row) — verified directly against the running instance this sprint.
- A domain's entire workflow set lives in one folder, reviewable as a unit in a PR.

## Negative

- Hand-assigned IDs are a small manual bookkeeping cost — a future domain must pick an ID that doesn't collide with an existing one (mitigated by the `<Domain><Purpose>Wf<NN>` convention keeping IDs domain-namespaced by construction).

## Risks

- Nothing enforces the naming/ID convention automatically (no lint/CI check exists for it) — relies on the same documentation-first discipline this repo's Sprint 0 already established. Worth revisiting if the workflow count grows large enough that manual review stops catching drift.

# Related Documents

- `docs/architecture/workflow-architecture.md`
- `docs/adrs/ADR-0002-repository-architecture.md`
- `ADR-0006-crm-workflow-authentication.md` (this sprint's domain-specific follow-up)
- `templates/workflow/workflow-template.md`
- `docs/workflows/01-lead-intake.md`, `docs/workflows/02-validation.md`, `docs/workflows/03-ai-qualification.md`, `docs/workflows/04-sales-automation.md`

# Notes

Implementation notes worth preserving for the next person authoring an n8n workflow file by hand in this repo (none of this is documented in n8n's own CLI `--help` output):

- `n8n import:workflow`/`import:credentials` both require an explicit `"id"` field in the JSON — omitting it throws a Postgres not-null constraint error on the `id` column, not a friendlier validation message.
- `n8n import:workflow --activeState=fromJson` (activate on import) only works when n8n runs in queue or multi-main mode; this stack runs in regular mode, so workflows always import inactive and must be activated through the editor UI (or, for future automated deployment, a queue-mode instance).
- Production webhook activation is not just a `workflow_entity.active = true` flip — n8n also tracks a separate versioning/publish state (`Active version not found for workflow` was the observed error when only the `active` column was set directly). This wasn't reverse-engineered further this sprint since the editor UI's own activation toggle handles it correctly; only relevant if ever scripting activation outside the UI.
- `n8n execute --id=<id>` only supports workflows starting from a Manual Trigger or an Execute Workflow Trigger — it cannot simulate an inbound Webhook call (`Missing node to start execution` / `Please make sure the workflow you're calling contains an Execute Workflow Trigger node`). A Webhook-triggered workflow's logic downstream of the trigger is still testable by temporarily inserting a Code node that injects representative trigger output, run once, then discarded — never checked in.
- `pinData` (for testing a workflow with fixed input without a real trigger event) must wrap each item as `{"json": {...}}`, matching n8n's standard `INodeExecutionData` shape — a bare object is silently accepted by `import:workflow` but produces empty data at runtime.
- This n8n version blocks `$env` access from node expressions by default (`N8N_BLOCK_ENV_ACCESS_IN_NODE`), unlike older n8n defaults — see ADR-0006 for why and how this repo opts back in narrowly.
