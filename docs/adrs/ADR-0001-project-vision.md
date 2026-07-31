# ADR-0001: Independent Project Vision

- Status: Accepted
- Date: 2026-07-31

---

# Context

EYAN Studio and Automation Hub target different engineering domains.

EYAN Studio demonstrates full-stack application development, AI platform engineering, RBAC, finance, content management, and business applications.

Automation Hub is focused on workflow automation, orchestration, AI integrations, infrastructure, and operational excellence using self-hosted n8n.

Although both projects share the same engineering philosophy, combining them into a single repository would reduce maintainability, increase deployment complexity, and make each portfolio project less focused.

---

# Decision

Automation Hub will be maintained as a completely independent project.

It will have its own:

- Repository
- Documentation
- Deployment
- Docker configuration
- Versioning
- Environment variables
- Secrets
- Release lifecycle

No runtime dependency on EYAN Studio will exist.

---

# Consequences

Positive:

- Clear separation of concerns
- Independent deployments
- Easier maintenance
- Better portfolio presentation
- Separate release cycles
- Independent technology evolution

Trade-offs:

- Some documentation standards may be duplicated
- Shared utilities will be managed independently unless a future shared library is intentionally introduced

---

# Future Considerations

Future integrations between EYAN Studio and Automation Hub may occur through APIs or webhooks, but neither project should require the other in order to operate.
