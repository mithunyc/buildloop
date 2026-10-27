---
type: agent-adapter
canonical: AGENTS.md
---

# GEMINI.md

This repo's rules live in `AGENTS.md`. Read it first; it is the single source of truth.
If anything here conflicts with `AGENTS.md`, `AGENTS.md` wins. Do not add rules to this file.

Gemini CLI / Antigravity specifics only:
- Start with: "Use enterprise-ai-dev as my master CTO orchestrator for this repo."
- A slice is done only when `buildloop.mjs verify` exits 0. Report its output, not your own judgment.
- Headless runs cannot answer permission prompts. Grant read-only commands explicitly; never use a skip-all-permissions flag.
