---
name: enterprise-ai-dev
description: >
  End-to-end enterprise-grade AI software delivery workflow. The master CTO
  orchestrator for spec-to-production development. Prefer explicit invocation
  with "Use enterprise-ai-dev as my master CTO orchestrator for this repo."
  Treat /orchestrator or similar natural-language phrasing as best-effort
  aliasing, not a guaranteed platform command. Use when asked to build, fix,
  refactor, launch, review, harden, or operate software — especially when the
  request involves: enterprise-grade, production-ready, brownfield project,
  new project, PRD, architecture, TDD, QA, security, deployment, or release.
  Automatically selects GREENFIELD, BROWNFIELD, GOVERNED, REVIEW_ONLY,
  RELEASE, or AUTONOMOUS_LOOP profile. Uses Buildloop runtime tools only when
  they are present in the current repo.
---

# Enterprise AI Dev — Spec-to-Production Control Plane

## Prime Directive

Ship the smallest production-grade vertical slice that proves product value, with tests, security review, and rollback thinking. Optimize for **verified outcomes**, not impressive activity.

This skill improves workflow reliability. It does not guarantee software correctness.

---

## Claim Labels

Use in all important decisions, receipts, and reviews:
- **FACT:** directly supported by repo file, command output, test, diff, or user source
- **INFERENCE:** reasoned conclusion from facts
- **JUDGMENT:** decision made because higher authority is silent
- **UNVERIFIED:** plausible but not yet proven

---

## Authority Order

1. Current repo truth: files, tests, CI, migrations, package scripts, runtime config
2. Approved PRD / spec / task graph / slice contract
3. Latest STATE.md / receipt / gate-results.json
4. Project AGENTS.md / local governance
5. External memory or generated maps (Obsidian, Graphify) if configured
6. Agent judgment (must be labeled JUDGMENT)

Project-local governance always overrides these global fallback rules.

---

## Optional Buildloop Runtime Tools

The installer ships them inside this skill at `runtime/scripts/` (plus `runtime/schemas`, `runtime/templates`, `runtime/reference`). Run them from the target repo as `node <this-skill-dir>/runtime/scripts/<tool> --cwd .`, or as `node scripts/<tool>` when the repo vendors them. Never invent a tool that is not present, install Docker, or assume availability.

| Tool | When To Use | Boundary |
|------|-------------|----------|
| `buildloop.mjs init` | Step 1A: create `.buildloop.yml` from the repo's own scripts | Refuses to overwrite without `--force` |
| `buildloop.mjs receipt --out <r>` | After gates: generate receipt frontmatter from evidence | Never more optimistic than the evidence |
| `buildloop.mjs verify --contract <c> --receipt <r> --rerun` | Definition of Done for every slice (Step 13) | Runs gates itself; writes only run evidence and `.buildloop/ledger.jsonl` |
| `buildloop.mjs learn` | Measured scorecard + recurring-failure promotion candidates (Step 18) | Recommends only; never edits governance |
| `node scripts/detect-capabilities.mjs` | Read-only capability scan during Step 0 / Step 1A | Writes only with explicit `--write` |
| `node scripts/buildloop.mjs doctor` | Human-readable repo readiness report | Supervised/read-only |
| `node scripts/buildloop.mjs gates` | Run `.buildloop.yml` gates | Uses project-defined commands |
| `node scripts/buildloop.mjs review` | Review latest `gate-results.json` | Reads evidence; does not self-grade |
| `node scripts/sandbox-run.mjs --dry-run` | Inspect Docker sandbox plan for untrusted commands | Dry-run by default |
| `node scripts/sandbox-run.mjs --execute` | Run a sandboxed command only after explicit approval | Docker required; no secrets; offline network default |

Obsidian and Graphify context is advisory-only. Read only explicit configured paths, respect token budgets, never auto-promote lessons, and never write bridge output unless a future approved phase explicitly changes that contract.

L4/overnight autonomy is not enabled by this skill. Any L4+ action requires a separate threat model, explicit human approval, and verified sandbox evidence.

---

## Step 0: Classify and Select Profile

Before anything else, classify the project:

| Signal | Classification |
|--------|---------------|
| Empty or near-empty directory | GREENFIELD |
| Existing files + git history, no governance | BROWNFIELD |
| Existing files + AGENTS.md + receipts + state | GOVERNED |
| Governance exists but conflicts with repo reality | STALE_OR_MIXED |
| User asks for analysis, not code changes | REVIEW_ONLY |
| User asks to ship, deploy, or prepare release | RELEASE |
| Steps 0–8 already approved, looping on stories | AUTONOMOUS_LOOP |

If Buildloop runtime tools are present, prefer `buildloop doctor` or `detect-capabilities.mjs` as supporting evidence for classification. If they are absent, continue with normal repo inspection.

---

## GREENFIELD Path

Steps: `0 → 1A → 2 → 3 → 4 → 7 → 8 → 9 → 11 → 14`

**Rule:** Build first, govern after proof. Do NOT front-load ceremony.

1. **Step 1A — Minimal audit:** `git status`, branch, runtime, package manager, existing files.
2. **Step 2 — PRD:** Clarify outcome. Ask only questions that affect architecture, risk, or UX.
3. **Step 3 — Adversarial Spec:** Apply grill-me to the PRD. Risk-scaled probe count (see below).
4. **Step 4 — Architecture Checkpoint:** Simplest version that works. Karpathy check: "Would a senior engineer say this is overcomplicated?"
5. **Step 7 — Slice Contract:** Define `allowed_files`, `blast_radius`, `evidence_required`.
6. **Step 8 — Human Approval (Planning Gate):** Present DECISION REQUIRED block. Wait for approval.
7. **Steps 9–11 — Build, self-review, deterministic gates.**
8. **Step 14 — PR / Preview.**

---

## BROWNFIELD Path

Steps: `0 → 1A → 1B → [STABILIZE if needed] → 2 → full lifecycle`

**Rule:** Never build on a broken foundation. Diagnose before building.

### Step 1A — Minimal Audit (all brownfield)
- `git status`, branch, file count, package manager, runtime
- Check for: `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, CI config, existing skills

### Step 1B — Full Diagnostic
Run the repo's native checks:
```
lint / typecheck / test / build
```
Produce `diagnostic_baseline.md` with frontmatter:
```yaml
---
type: diagnostic-baseline
repo_state: B | C | D
health:              # ok | warn | fail | unknown (see runtime/schemas/diagnostic-baseline.schema.json)
  install: ok
  tests: ok          # also: none
  lint: ok
  typecheck: ok      # also: n/a
  ci: ok             # also: n/a
  build: ok
stabilization_required: true | false
---
```

### Stabilization Gate
If `stabilization_required: true`:
- Present stabilization plan (minimum changes to unblock features)
- **BLOCK feature work until human approves and foundation is verified**
- If repo healthy → generate `.buildloop.yml` → proceed to Step 2

### Brownfield Non-Negotiables

| Existing | Do | Never |
|----------|-----|-------|
| AGENTS.md | Read. Suggest improvements. | Overwrite. |
| CLAUDE.md | Add skill routing only if missing. | Replace. |
| CI / Makefile | Respect it. .buildloop.yml adapts. | Replace. |
| Task tracker | Use existing (Issues/Jira). | Force prd.json. |
| Skills | Deduplicate. Skip overlap. | Install duplicates. |
| Test framework | Run existing. | Replace framework. |

---

## AUTONOMOUS Path

**Prerequisite:** Steps 0–8 must be **fully approved** before this path runs.

Loop: `9 (TDD) → 10 (self-review) → 11 (gates) → 12 (AI review) → receipt → commit → next approved slice`

Autonomous mode reads `.buildloop.yml` for commands and `protected_paths`. If stuck (3+ consecutive failures): emit STUCK signal, escalate to human.

Autonomous loop is still supervised slice execution. It is not L4 overnight autonomy and must not run deploy, auto-fix, credential, migration, or production actions without explicit human approval.

---

## Risk-Scaled Grill-Me Probes

Apply when stress-testing PRD, architecture, or slice contract:

| Risk Level | Probe Count |
|-----------|-------------|
| Low (cosmetic / additive) | 1–2 probes |
| Medium (new feature, integration) | 3 probes |
| High (auth, schema, billing, external API) | 5–7 probes |

**Never exceed 7 probes unless human asks.** Each probe: Q + recommended A. Human approves/modifies/rejects.

---

## Gate Format (Required at Every Human Checkpoint)

```
DECISION REQUIRED
Recommendation: PROCEED / FIX / HALT
Why: [1–2 sentences, plain language]
Risk: LOW / MEDIUM / HIGH
What I need from you: approve / modify / reject
If approved, next action: [explicit next step]
```

---

## Deterministic Gates (Step 11)

Gate-runner reads `.buildloop.yml`:
```yaml
adoption_mode: greenfield | brownfield | autonomous
risk_level: low | medium | high
commands:
  lint: "[your lint command]"
  typecheck: "[your typecheck command]"
  test: "[your test command]"
  build: "[your build command]"
protected_paths:
  - ".env*"
  - "**/*.key"
  - ".github/workflows/**"
```

Gate-runner produces `gate-results.json`. Evidence receipt references it. Gate-runner is the independent witness — the agent does not self-grade.

If `buildloop.mjs` is available, use `buildloop.mjs gates` and `buildloop.mjs review` as the preferred supervised wrapper. If it is absent, run the repo's native checks directly and label any missing gate witness as UNVERIFIED.

---

## Definition of Done (Step 13)

Flow: `buildloop.mjs init` once (writes `.buildloop.yml` from the repo's scripts) → build the slice → `buildloop.mjs receipt --out <receipt.md>` (generated from gate evidence; never hand-write the frontmatter) → `buildloop.mjs verify --contract <slice-contract.md> --receipt <receipt.md> --rerun --base <start-sha>`.

A slice is DONE only when verify exits 0. `--rerun` makes verify run the gates itself, so stored evidence is not trusted. It fails the slice when any of these holds:
- the contract has placeholders, or a HIGH blast radius has no real `approved_by`
- a changed file is outside `allowed_files` (including files hidden by local ignore rules, skip-worktree, or moves)
- rule files (`.buildloop.yml`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, workflows, CODEOWNERS, an existing contract) changed without a human `approved_by`
- gates FAIL, no test gate ran, the gates modified the files they tested, or the evidence is older than the workspace
- the receipt disagrees with the gate evidence, points at another run, or says NO_GO

If the slice needs a file outside `allowed_files` (for example a broken `package.json` script), stop and ask the human to widen the contract. Do not work around the gate.

Never edit `gate-results.json`, `dod-results.json`, or `.buildloop/ledger.jsonl` by hand. If verify fails, fix the work or revise the contract with the human; do not argue with the verdict. In CI, run verify on the final commit (`runtime/templates/workflows/buildloop-verify.yml`) so the evidence comes from a runner the agent does not control.

---

## Release, Observe, Learn (Steps 15–18)

- **Before production:** fill `templates/release-plan.md` (rollback command, health checks, smoke test, owner). Production deploy is always a human action.
- **After deploy:** run the smoke test and record the result in the release plan. A failed smoke means rollback first, diagnosis second.
- **Learn:** run `buildloop.mjs learn`. Record each promotion candidate in `tasks/LESSONS.md` (`templates/lessons.md`). Promotion order: lesson → runbook → test or gate → `AGENTS.md` only if universal. A human approves every promotion. Agents never loosen or rewrite their own governance.

---

## Delegation Rule

The orchestrator routes work to specialists. It does not pretend to be every skill.

| Need | Delegate To |
|------|------------|
| TDD execution | `tdd`, `writing-plans`, `executing-plans` |
| Architecture refactor | `improve-codebase-architecture`, `zoom-out` |
| UI / design | `awesome-design-md` |
| Plan stress-test | `grill-me` |
| Requirements / PRD | `grill-with-docs`, `to-prd`, `brainstorming` |
| Token compression | `caveman` |
| Anti-overcomplication | `karpathy-guidelines` |
| Debugging | `diagnose` |
| Code review / release | `requesting-code-review`, `verification-before-completion`, `finishing-a-development-branch` |
| Security | `security-best-practices`, `security-threat-model` |
| Issue triage | `triage` |

Read `runtime/reference/quality-gates.md` and `runtime/reference/security-triggers.md` (or `reference/` in the Buildloop repo) for risk-level controls.

---

## Quality Gates (Do Not Ship Without These)

- [ ] Acceptance criteria mapped to concrete verification
- [ ] Tests cover changed behavior + at least one failure path
- [ ] Security-sensitive flows: auth, authorization, validation considered
- [ ] Data changes: migration and rollback path verified
- [ ] No unrelated drive-by changes in the diff
- [ ] `gate-results.json` exists and shows PASS
- [ ] `buildloop.mjs verify` verdict is DONE for this slice

---

## Self-Review Checklist

Before claiming any task complete, answer:
1. Did I stay inside allowed files?
2. Did I verify each acceptance criterion?
3. What remains UNVERIFIED?
4. What changed outside planned scope?
5. What test/check would fail if I am wrong?
6. What rollback exists?

---

## Output Contract

**Planning output:**
1. Assumptions
2. Repo Truth / Known Facts
3. Recommended Profile
4. Plan
5. Risks
6. Human Decision Needed
7. Next Action

**Execution output:**
1. Slice Contract
2. Implementation Summary
3. Gate Results
4. Evidence Receipt
5. Review Findings
6. Remaining Risks
7. Human Decision Needed

---

## Stop Conditions

Pause and ask before:
- Deleting data, force-pushing, rotating production credentials
- Touching `protected_paths` from `.buildloop.yml`
- Making irreversible architecture choices when requirement is unclear
- Proceeding when tests cannot run and change is high-risk
- Taking any action at L4+ autonomy level without explicit opt-in
- Running `sandbox-run --execute`, full network mode, deploys, migrations, or production-impacting commands without explicit human approval
- About to guess architecture instead of inspecting repo truth
- Gate/test/build failure persists after 3 fix attempts — halt and report
