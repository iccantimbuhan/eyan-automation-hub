# Sprint 5 Development Log — Production Stabilization (this repo's numbering; "Sprint 5.2" in eyan-ai-platform's cross-repo sequence)

Status: Complete

---

# Objective

Sprint 4's Workflow 4 (Sales Automation) had never actually delivered a Slack notification on its real, unmodified execution path — only on isolated test paths that happened to skip the salesperson-assignment step. Discovered and fixed while live-validating a separate, eyan-ai-platform-side pipeline fix (full root cause and cross-repo context: `eyan-ai-platform/tasks/completed/sprint-5-2-production-stabilization.md`).

---

# Root Cause

`Send Slack Notification` (and `Send Email Notification`, same mechanism) built their message from `$json.lead`/`$json.qualification`/`$json.pipelineStage`. In n8n, `$json` is the *immediately preceding connected node's* output — and on the real path (`Assignment Needed?` → `Assign Salesperson` → `Slack Configured?` → `Send Slack Notification`), that preceding node is `Assign Salesperson`, whose own HTTP response has no `lead`/`qualification`/`pipelineStage` keys. Every `$json.lead.contactName`-style reference therefore resolved against the wrong object. n8n reported the resulting failure as a generic `"The value in the \"JSON Body\" field is not valid JSON"` regardless of the real cause — and because `onError: "continueRegularOutput"` is set on that node (by design, so a notification failure never blocks the workflow), the whole execution still reported `status: success`, hiding the failure from the execution list at a glance.

This was invisible to every prior diagnostic test (including this session's own first attempts) because those all pre-set `assignedToId` to skip `Assign Salesperson` entirely, which coincidentally left `$json` pointing at the original webhook payload — the correct data, for the wrong reason.

---

# Fix

`workflows/crm/04-sales-automation.json` — both notification nodes now reference `$('Verify & Parse').item.json` explicitly instead of bare `$json`, the same pattern Workflow 3's own `Map AI Core Result` node already established for identical reasons. No node added or removed, no connections changed.

---

# Validation

Isolated via fast, directly-signed webhook calls to `POST /webhook/crm/lead-qualified` (reusing the real HMAC signing secret) to avoid burning multi-minute Ollama cycles per iteration while narrowing the cause — first reproducing the failure, then confirming a fix candidate, then confirming it specifically on the *real* path (a genuine lead with `assignedToId: null`, so `Assign Salesperson` actually runs first). Final proof was a real headless-browser (Playwright) submission through `https://eyan.fyi/contact` on the eyan-ai-platform side, traced through this repo's real execution log end to end: all four CRM workflows `status: success`, the Slack node's own recorded output `{"data": "ok"}` (Slack's real API response), and the user independently confirmed the message arrived. Reproduced this exact result twice after the fix (once mid-investigation, once as the final unmodified end-to-end run).

The Email node received the identical fix by direct pattern analogy — genuinely untested, since no SMTP credential exists in this environment (a standing Sprint 4 gap).

---

# Next Sprint (Recommendations, Not Committed Work)

1. Live-test the Email notification path once real SMTP credentials exist.
2. No automated test harness in this repo can catch this class of bug — the existing `vm`-based logic tests only exercise Code-node `jsCode`, not HTTP-node body/header expressions or n8n's `$json`-scoping behavior. Any future change to a body/header expression in these workflows should be validated via a live execution (a fast direct signed-webhook call is usually sufficient), not assumed correct from the logic-test suite alone.
