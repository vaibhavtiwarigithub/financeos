---
name: architecture-first
description: Use before any feature, UI, screen, API, data model, backend workflow, or infrastructure implementation. Forces architecture review before coding.
---

# Architecture First Skill

Do not write or edit implementation code during this skill. Produce a complete architecture proposal before implementation.

## Required Reading

1. `CLAUDE.md`
2. `ARCHITECTURE.md`
3. `PROJECT_RULES.md`
4. `PROJECT_DECISIONS.md`
5. Relevant `features/<name>/FEATURE_ARCHITECTURE.md` if it exists

## Required Output Format

### 1. User Intention
### 2. Current Architecture
### 3. Proposed Architecture
### 4. User Journey / System Flow
### 5. UI / API / Data / Interaction Model
### 6. States and Edge Cases
### 7. Files That May Be Touched Later
### 8. Risks / Decisions Needed
### 9. Acceptance Criteria
### 10. Approval Gate

End with: "Architecture is ready for review. I will not write code until you approve this architecture."

## Hard Constraints

Do not call Edit/Write tools on implementation files (src, app, components, pages, styles, lib, server, api, routes, services, db, prisma, supabase, scripts, ios, android).

Only architecture and documentation files may be created/updated before approval.
