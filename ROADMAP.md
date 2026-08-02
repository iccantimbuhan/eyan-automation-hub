# EYAN Automation Hub Roadmap

## Vision

Build a world-class automation engineering portfolio centered around self-hosted n8n, AI integrations, and production-ready infrastructure.

The project will evolve incrementally through clearly defined milestones, emphasizing architecture, documentation, operational excellence, and maintainability.

---

# Phase 0 — Foundation

Status: In Progress

Objectives:

- Repository initialization
- Documentation structure
- Architecture definition
- ADR framework
- Development standards
- Product roadmap

Deliverables:

- README
- Architecture documentation
- Roadmap
- ADR templates
- Standards documentation

---

# Phase 1 — Platform Foundation

Objectives:

- Repository organization
- Docker architecture design
- Environment strategy
- Deployment planning
- Security planning

Deliverables:

- Deployment documentation
- Security model
- Repository standards

---

# Phase 2 — Infrastructure

Objectives:

- Self-hosted n8n
- Reverse proxy
- SSL
- Environment variables
- Secret management
- Persistent storage

Deliverables:

- Production-ready infrastructure

---

# Phase 3 — Operations

Objectives:

- Monitoring
- Logging
- Health checks
- Backup strategy
- Disaster recovery

Deliverables:

- Operational documentation
- Recovery procedures

---

# Phase 4 — Workflow Framework

Status: Started 2026-07-31 (CRM domain — see ADR-0005, ADR-0006, ADR-0007)

Objectives:

- Workflow standards
- Naming conventions
- Folder organization
- Reusable templates
- Documentation templates

Deliverables:

- Workflow development framework

---

# Phase 5 — Portfolio Workflows

Status: Started 2026-07-31 — Lead Qualification Automation. Milestone 1 (Lead Intake + Validation) complete. Milestone 2 (AI Qualification) revised 2026-08-02 (Sprint 5): Workflow 3 no longer calls Ollama directly — it now calls `eyan-ai-platform`'s AI Core `lead-qualification` Capability, which owns provider selection/prompt versioning/retries itself (see `eyan-ai-platform` ADR-0021, superseding the provider-in-this-repo parts of ADR-0020). Milestone 3 (notifications) partially complete: Workflow 4 (assign salesperson, Slack, email) built and logic-tested; Slack/email not live-verified (no real credentials this session) — see `docs/workflows/04-sales-automation.md`.

Target flagship workflows include:

- AI Blog Generator
- AI Research Assistant
- Lead Qualification Automation
- Social Media Content Pipeline
- Customer Support Automation

These may evolve as better portfolio opportunities are identified.

---

# Future Expansion

Potential future capabilities include:

- MCP integrations
- Multi-environment deployments
- Workflow versioning
- CI/CD automation
- Custom n8n nodes
- Enterprise monitoring
- Additional AI providers

---

# Guiding Principles

- Documentation before implementation
- Security by design
- Maintainability
- Scalability
- Reusability
- Independent architecture
- Production-quality engineering
