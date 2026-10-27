---
type: slice-contract
story: "[US-XXX: Story title — one sentence]"
allowed_files:
  - "[path/to/file1]"
  - "[path/to/file2]"
  # [CUSTOMIZE] List ALL files this slice is allowed to touch
blast_radius: LOW           # LOW | MEDIUM | HIGH
rollback: "[uncommitted: git restore -- <allowed files> | committed: git revert <sha>]"
depends_on:
  - "[US-XXX or phase name this must complete before starting]"
evidence_required:
  - "[command → expected exit code]"
  - "[check → expected result]"
approved_by: "[human who approved this contract — required when blast_radius is HIGH]"
approved_at: "[ISO date]"
---

# Slice Contract Template

A slice contract defines the boundary of a single vertical slice of work.
Every story needs one. The agent must not touch files outside `allowed_files`.
If the story requires out-of-bounds changes, stop and revise the contract first.

---

## Contract Template

```text
SLICE CONTRACT: [US-XXX] — [Story title]

Story:
- [One sentence describing what this slice delivers]
- [Why it matters — user value or unblocking dependency]

Acceptance criteria:
- [ ] [Criterion 1 — measurable, verifiable]
- [ ] [Criterion 2]
- [ ] [Criterion 3]

Vertical layers this slice touches:
- [ ] Schema / migration
- [ ] Domain / business logic
- [ ] Contracts / interfaces
- [ ] API / routes
- [ ] UI / screens
- [ ] Tests

Allowed files:
- [Full list — agent may ONLY modify these files]

Out-of-bounds (must NOT touch):
- .env* and secrets
- [YOUR_INFRA_DIR]/**
- [YOUR_MIGRATIONS_DIR]/** (unless this slice IS a migration)
- Any file not in allowed_files above

Blast radius: LOW / MEDIUM / HIGH
- [Explain what breaks if this goes wrong]

Dependencies:
- depends_on: [story or phase that must be done first]
- blocks: [story or phase that depends on this]

Evidence required (all must pass before marking DONE):
- [exact command → expected exit code or output]
- [targeted test → expected result]
- [manual check if needed → expected behavior]

Rollback:
- [exact git command]

Estimated size: [number of files] files, ~[N] new lines of logic
Context window: fits / borderline / too large (split if too large)
```

---

## Vertical Slice Pattern

Each slice must cut through ALL required integration layers end-to-end.
Do NOT build one layer for all stories, then the next layer for all stories.

```text
RIGHT (vertical):
  Slice A: schema + domain + tests for [feature X]
  Slice B: API + UI + E2E for [feature X]

WRONG (horizontal):
  Slice A: all schema migrations
  Slice B: all API routes
  Slice C: all UI pages
```

## Sizing Rules

| Size | Files | Action |
|------|-------|--------|
| ≤5 files, ≤100 lines logic | Small | Proceed |
| 6–15 files, 1–2 layers | Medium | Proceed with care |
| 15+ files or 3+ layers | Large | Split before starting |

## Context Overflow Protocol

If context fills mid-story:
1. Stop at nearest safe commit point
2. Commit completed work
3. Note exact stopping point in `tasks/STATE.md`
4. End session cleanly — next session picks up from STATE.md

---

*Source: buildloop/templates/slice-contract.md*
