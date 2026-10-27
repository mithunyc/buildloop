---
type: lessons-ledger
promotion_threshold: 3      # matches `buildloop learn --threshold`
---

# Lessons Ledger

Copy to `tasks/LESSONS.md`. This is how Buildloop learns without letting agents rewrite their own rules.

**Loop:** `verify` writes one ledger line per slice → `learn` measures the first-pass DoD rate and lists checks that failed repeatedly → a human records the lesson here and decides how far to promote it.

**Promotion ladder (cheapest durable control wins):**

1. **Lesson** — recorded here, advisory.
2. **Runbook** — operational step a human follows.
3. **Test or gate** — a failing test, `.buildloop.yml` command, `protected_paths` entry, or CI check. Prefer this: it enforces itself.
4. **`AGENTS.md` rule** — only if universal, repeated, and not mechanically enforceable.

**Rules:**
- A human approves every promotion. Agents may propose, never promote.
- Lessons never weaken a gate, widen `allowed_files`, or remove a protected path.
- Revalidate promoted lessons when the stack changes; delete stale ones.

---

## Ledger

| Date | Source (learn check / incident / review) | Lesson | Evidence | Promoted to | Approved by |
|------|------------------------------------------|--------|----------|-------------|-------------|
| | `scope` failed 3x | | `.buildloop/scorecard.json` | lesson / runbook / gate / AGENTS.md | |

## Scorecard history

Record `buildloop learn` output at each milestone, so improvement is measured rather than claimed.

| Date | Stories | First-pass DoD % | Current DoD % | Mean attempts | Top failing check |
|------|---------|------------------|---------------|---------------|-------------------|
| | | | | | |

---

*Source: buildloop/templates/lessons.md*
