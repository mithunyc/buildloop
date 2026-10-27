# Buildloop

[![CI](https://github.com/mithunyc/buildloop/actions/workflows/ci.yml/badge.svg)](https://github.com/mithunyc/buildloop/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-v2.1.0-green.svg)](https://github.com/mithunyc/buildloop/releases/tag/v2.1.0)

**Spec-to-production control plane for AI-assisted software delivery.**

Curated skills, templates, schemas, supervised CLI tools, gate scripts, and sandbox controls that give AI coding agents (Codex, Claude Code, Cursor, Antigravity) enterprise-grade planning, verification, security, and release discipline on any stack.

---

## Who This Is For

- **Founders:** Build software with AI without losing control of the architecture.
- **Product Owners:** Enforce PRDs, scope boundaries, and release readiness.
- **Developers:** Adopt stricter testing, debugging, and security workflows.
- **Engineering Teams:** Replace open-ended vibe coding with deterministic, evidence-based delivery.

---

## Install In One Command

Restart your AI coding agent after installing.

The installer is designed for fresh machines: it downloads the Buildloop payload if needed, installs the local Buildloop skills, and automatically installs the curated upstream skills for the selected tier at pinned commit SHAs. It requires internet access and `git`.

### macOS / Linux

**OpenAI Codex**
```bash
curl -fsSL https://raw.githubusercontent.com/mithunyc/buildloop/main/scripts/install.sh | bash -s -- --target codex
```

**Claude Code**
```bash
curl -fsSL https://raw.githubusercontent.com/mithunyc/buildloop/main/scripts/install.sh | bash -s -- --target claude
```

**Cursor**
```bash
curl -fsSL https://raw.githubusercontent.com/mithunyc/buildloop/main/scripts/install.sh | bash -s -- --target cursor
```

**Google Antigravity**
```bash
curl -fsSL https://raw.githubusercontent.com/mithunyc/buildloop/main/scripts/install.sh | bash -s -- --target antigravity
```

**All agents at once**
```bash
curl -fsSL https://raw.githubusercontent.com/mithunyc/buildloop/main/scripts/install.sh | bash -s -- --target all
```

---

### Windows (PowerShell)

**OpenAI Codex**
```powershell
powershell -ExecutionPolicy Bypass -Command "$p=Join-Path $env:TEMP 'install.ps1'; Invoke-WebRequest 'https://raw.githubusercontent.com/mithunyc/buildloop/main/scripts/install.ps1' -OutFile $p; & $p -Target codex"
```

**Claude Code**
```powershell
powershell -ExecutionPolicy Bypass -Command "$p=Join-Path $env:TEMP 'install.ps1'; Invoke-WebRequest 'https://raw.githubusercontent.com/mithunyc/buildloop/main/scripts/install.ps1' -OutFile $p; & $p -Target claude"
```

**Cursor**
```powershell
powershell -ExecutionPolicy Bypass -Command "$p=Join-Path $env:TEMP 'install.ps1'; Invoke-WebRequest 'https://raw.githubusercontent.com/mithunyc/buildloop/main/scripts/install.ps1' -OutFile $p; & $p -Target cursor"
```

**Google Antigravity**
```powershell
powershell -ExecutionPolicy Bypass -Command "$p=Join-Path $env:TEMP 'install.ps1'; Invoke-WebRequest 'https://raw.githubusercontent.com/mithunyc/buildloop/main/scripts/install.ps1' -OutFile $p; & $p -Target antigravity"
```

**All agents at once**
```powershell
powershell -ExecutionPolicy Bypass -Command "$p=Join-Path $env:TEMP 'install.ps1'; Invoke-WebRequest 'https://raw.githubusercontent.com/mithunyc/buildloop/main/scripts/install.ps1' -OutFile $p; & $p -Target all"
```

---

## Install Targets

| Target | Install Directory | Confidence |
|--------|-------------------|------------|
| `codex` | `$CODEX_HOME/skills` or `~/.codex/skills` | Tested (install suite + local install) |
| `claude` | `~/.claude/skills` plus `/orchestrator` and `/buildloop` aliases in `~/.claude/commands` | Tested (install suite + local install) |
| `cursor` | `~/.cursor/skills` | Experimental |
| `antigravity` | `~/.gemini/antigravity/skills` | Experimental |

> **Security note:** These are remote one-line installers. Read `scripts/install.*` before running on sensitive machines. See [SECURITY.md](SECURITY.md).
> Existing skills and command aliases are skipped by default so the installer is safe to rerun. Use `--force` or `-Force` only when you intentionally want to overwrite installed Buildloop files.

---

## Prefer Inspecting First?

```bash
git clone https://github.com/mithunyc/buildloop.git
cd buildloop
bash scripts/install.sh --target codex          # macOS / Linux
```

```powershell
git clone https://github.com/mithunyc/buildloop.git
cd buildloop
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -Target codex   # Windows
```

---

## Skill Tiers

Choose the tier that matches your project complexity. The default install mode is `core`; pass `--mode minimal`, `--mode core`, `--mode full`, or `--mode contributor` when you want a different tier.

| Tier | Skills | Best For |
|------|--------|----------|
| **MINIMAL** | `enterprise-ai-dev`, `karpathy-guidelines`, `brainstorming`, `tdd`, `diagnose` — **5 skills** | Solo developers, small context windows, simple projects |
| **CORE** | Everything in MINIMAL + `awesome-design-md`, `caveman`, `writing-plans`, `executing-plans`, `grill-with-docs`, `to-prd`, `verification-before-completion`, `security-best-practices` — **13 skills** | Default for most projects. |
| **FULL** | Everything in CORE + `grill-me`, `triage`, `improve-codebase-architecture`, `zoom-out`, `finishing-a-development-branch`, `requesting-code-review`, `security-threat-model`, `setup-matt-pocock-skills` — **21 skills** | Teams, complex projects, full review and release discipline |
| **CONTRIBUTOR** | `write-a-skill` — for skill authors | Writing or publishing new skills |

Tier counts are derived from [`curated-skills.json`](curated-skills.json) and validated by CI.

---

## Verify Your Installation

Start a fresh agent session and use this exact prompt:

```text
Use enterprise-ai-dev as my master CTO orchestrator for this repo.
```

Buildloop currently installs the main orchestrator skill under the canonical skill name `enterprise-ai-dev` for compatibility with existing agent skill discovery.

### Invocation Matrix

| Agent | Best Invocation | Notes |
|-------|-----------------|-------|
| OpenAI Codex | `Use enterprise-ai-dev as my master CTO orchestrator for this repo.` | Codex custom slash-command aliases are not claimed by Buildloop. |
| Claude Code | `/orchestrator` or `/buildloop` | The Claude installer adds these aliases under `~/.claude/commands/`. `/enterprise-ai-dev` may also work because Claude Code can invoke installed skills directly. |
| Cursor | `Use enterprise-ai-dev as my master CTO orchestrator for this repo.` | Skill-directory behavior is experimental. |
| Google Antigravity | `Use enterprise-ai-dev as my master CTO orchestrator for this repo.` | Skill-directory behavior is experimental. |

If the agent does not see the skill or command, restart the app. If it still does not respond correctly, rerun the installer for that target with `--force` or `-Force`.

---

## The Lifecycle (What the Agent Does)

Two phases. Every project uses both.

### Planning Phase — Steps 0–8
Produces PRD, architecture decision, slice contracts, and human approval before any code is written.

| Step | What Happens |
|------|-------------|
| **0 — Classify** | Detects GREENFIELD, BROWNFIELD, GOVERNED, REVIEW\_ONLY, or AUTONOMOUS profile |
| **1A — Minimal Audit** | `git status`, branch, runtime, package manager, existing governance files |
| **1B — Full Diagnostic** | Brownfield only. Runs lint / test / build. Produces `diagnostic_baseline.md`. Blocks features if broken. |
| **2 — PRD** | Gathers requirements. Asks only questions that affect architecture, risk, or UX. |
| **3 — Adversarial Spec** | Stress-tests the PRD. Risk-scaled probes: Low=1–2, Medium=3, High=5–7. |
| **4 — Architecture Checkpoint** | Simplest version that works. Karpathy check: not overcomplicated? |
| **7 — Slice Contract** | Defines `allowed_files`, `blast_radius`, `evidence_required` per story. |
| **8 — Human Approval** | DECISION REQUIRED gate. No execution without approval. |

### Execution Phase — Steps 9–16
Deterministic gates with an independent witness. No self-grading.

| Step | What Happens |
|------|-------------|
| **9 — TDD** | Red-green-refactor inside slice boundaries. Characterization tests first for brownfield. |
| **11 — Gate Runner** | Reads `.buildloop.yml`, executes commands, writes `gate-results.json`. |
| **12 — AI Review** | Independent reviewer reads `gate-results.json`. Produces GO / CONDITIONAL\_GO / NO\_GO. |
| **13 — Definition of Done** | `buildloop verify` checks scope vs `allowed_files`, gate PASS and freshness, receipt consistency, and HIGH-risk approval. Exit 0 or the slice is not done. |
| **14 — PR / Preview** | Evidence receipt references `gate-results.json`. Run `verify` in CI ([template](templates/workflows/buildloop-verify.yml)) so the evidence comes from a runner the agent does not control. |
| **15–17 — Release** | [`release-plan.md`](templates/release-plan.md): rollback rehearsed in preview, smoke test, owner. Production deploy is always a human action. |
| **18 — Learn** | `buildloop learn` measures first-pass DoD rate and flags checks that fail repeatedly; a human promotes them into tests or gates ([`lessons.md`](templates/lessons.md)). |

### Definition of Done and the learning loop

```bash
node scripts/buildloop.mjs init                                # writes .buildloop.yml from your package scripts
node scripts/gate-runner.mjs                                   # run your gates, record evidence
node scripts/buildloop.mjs receipt --out tasks/US-001.receipt.md   # receipt generated from the evidence
node scripts/buildloop.mjs verify --contract tasks/US-001.md --receipt tasks/US-001.receipt.md --rerun --base main
node scripts/buildloop.mjs learn                               # measured scorecard + promotion candidates
```

`--rerun` makes verify run the gates itself, so a hand-edited `gate-results.json` cannot produce DONE.

After an install, the same scripts live inside the skill, for example `~/.codex/skills/enterprise-ai-dev/runtime/scripts/`.

**What this does and doesn't promise.** Buildloop can't tell you your software is correct. What it enforces is narrower: a slice isn't marked DONE unless the gates passed on the current code, every changed file is inside the contract, the receipt matches the evidence, and high-risk work names a human approver. Each rule has a test in `tests/verify.test.mjs` that breaks if the rule stops holding. That includes one test for each way other models got past verify while we were testing it: edited gate results, code hidden in ignored folders, tests that rewrite their own source, skipped test gates, local ignore rules, skip-worktree flags, and moved files. How often your agents reach DONE on the first try depends on your repo and your agents, so `learn` measures it instead of this README guessing.

---

## What's in the Repo

```
skills/             Local skills installed directly (enterprise-ai-dev, awesome-design-md, ...)
commands/           Claude Code slash command aliases for /orchestrator and /buildloop
templates/          Reusable governance artifacts (PRD, slice contracts, receipts, AGENTS template)
schemas/            JSON schemas validating all frontmatter and YAML contracts
reference/          Deep-reference docs for lifecycle, advisory bridges, and sandbox security
playbooks/          System optimization and skill acquisition playbooks
scripts/            buildloop.mjs, gate-runner.mjs, verify.mjs, learn.mjs, init.mjs, receipt.mjs, detect-capabilities.mjs, sandbox-run.mjs, validators, installers
examples/           Working greenfield and brownfield fixture walkthroughs
tests/              install, capability, CLI, sandbox, and Definition-of-Done tests run in CI
curated-skills.json Upstream skill registry with pinned commit SHAs
```

---

## What's New in v2.x

- **`enterprise-ai-dev` orchestrator** — greenfield, brownfield, governed, and autonomous profiles; claim labels (FACT / INFERENCE / JUDGMENT / UNVERIFIED); delegation rules.
- **Templates** — PRD, slice contracts, evidence receipts, adversarial review, diagnostic baseline, handoff, AGENTS.md template.
- **Schemas** — JSON Schema draft-07 validation for all frontmatter contracts.
- **Gate runner** — reads `.buildloop.yml`, executes quality gates, writes `gate-results.json` as independent witness.
- **Capability detection** - `detect-capabilities.mjs` reports package manager, CI, Docker, Graphify, Obsidian, and Buildloop readiness without writing unless `--write` is used.
- **Supervised CLI** - `buildloop.mjs` exposes read-only `capabilities`, `doctor`, `manifest`, `gates`, and `review` commands. No deploy, no auto-fix, no overnight autonomy.
- **Advisory bridges** - Obsidian and Graphify references define read-only/advisory integration boundaries; no runtime bridge writes are implemented.
- **Docker sandbox foundation** - `sandbox-run.mjs` provides dry-run-first Docker command planning, blocked secret mounts, offline default networking, scoped logs, and mocked CI tests.
- **Definition of Done as code (unreleased)** - `verify.mjs` reads the slice contract, gate results, and receipt and returns DONE or NOT_DONE. `learn.mjs` reads the history of those verdicts, reports first-pass rates, and lists checks that keep failing so a human can turn them into tests or gates. `init.mjs` writes `.buildloop.yml` from your package scripts, and `receipt.mjs` writes the receipt from the gate evidence.
- **Sandbox hardening (unreleased)** - capability drop, no-new-privileges, read-only `.git`, shadowed `.env*`, injection-safe image and volume names, timeout cleanup; allowlist mode is labeled as not enforced.
- **Runtime ships with the skill (unreleased)** - installers bundle scripts, schemas, templates, and references under `enterprise-ai-dev/runtime/`.
- **Brownfield bootstrap compiler** — `orchestrator-manifest.json` schema for machine-readable repo governance.
- **Supply chain pinning** — upstream skills pinned to full SHA commits in `curated-skills.json`.
- **CI** — validates templates, schemas, and scripts on every push.
- **Reference docs** — phase engine, security triggers, architecture boundaries, quality gates, drift control, autonomous execution.
- **Examples** — greenfield walkthrough and brownfield diagnostic fixture.
- **Claude command aliases** — `/orchestrator` and `/buildloop` convenience commands installed for Claude Code.

---

## Design Philosophy

- Prefer fewer default skills over a huge prompt surface.
- Prefer upstream provenance over vendored copies.
- Prefer boring, proven engineering practices over framework theater.
- Prefer evidence: tests, builds, diffs, logs, reproducible commands.
- Treat autonomous agents as useful only after requirements and verification are clear.
- Read remote installer scripts before running on sensitive machines.

---

## License

Original skills in this repository are MIT licensed. Upstream skills are installed from their source repositories under their upstream licenses.
