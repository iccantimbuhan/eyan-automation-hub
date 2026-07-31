# Git Workflow

Version: 1.0
Status: Approved

---

# Purpose

This document defines the Git workflow for EYAN Automation Hub.

The objective is to maintain a clean, traceable, and professional project history throughout the lifecycle of the repository.

---

# Branch Strategy

The primary branch is:

- main

Future feature development may use short-lived feature branches when appropriate.

Examples:

- feature/workflow-blog-generator
- feature/security-review
- docs/system-overview-update
- fix/webhook-validation

---

# Commit Message Convention

Commit messages should clearly describe the purpose of the change.

Examples:

docs(architecture): define deployment architecture

docs(workflows): add workflow documentation template

feat(workflows): add AI blog generator

fix(security): improve webhook validation

refactor(repository): reorganize workflow categories

---

# Pull Requests

For collaborative development, pull requests should include:

- Summary
- Motivation
- Testing performed
- Documentation updates
- Related ADRs (if applicable)

---

# Versioning

The project will follow Semantic Versioning.

Examples:

v0.1.0

v0.2.0

v1.0.0

Major architectural milestones should be tagged.

---

# Documentation Requirement

Documentation should accompany implementation.

Major architectural changes should reference an ADR.

---

# Release Philosophy

Releases should represent stable milestones.

Every release should include:

- Updated documentation
- Architecture review
- Release notes
- Version tag

---

# Related Documents

- Documentation Standards
- ADR-0001
- System Overview
