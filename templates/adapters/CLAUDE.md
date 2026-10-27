---
type: agent-adapter
canonical: AGENTS.md
---

# CLAUDE.md

This repo's rules live in `AGENTS.md`. Read it first; it is the single source of truth.
If anything here conflicts with `AGENTS.md`, `AGENTS.md` wins. Do not add rules to this file.

Claude Code specifics only:
- Use `/buildloop` or `/orchestrator` to start the Buildloop lifecycle.
- A slice is done only when `buildloop.mjs verify` exits 0. Report its output, not your own judgment.
