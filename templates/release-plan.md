---
type: release-plan
release: "[vX.Y.Z or change name]"
risk: MEDIUM                # LOW | MEDIUM | HIGH
approved_by: "[human name or handle — required before production]"
rollback_command: "[exact command or console step that restores the previous version]"
smoke_command: "[command or URL check that proves the core flow works]"
owner: "[person on call for this release]"
---

# Release Plan

Fill this in **before** production. A release without a rehearsed rollback is not ready.
Production deploy is always a human action; agents prepare this plan, they do not execute it.

---

## 1. What ships

- Change summary (plain language):
- Linked slices / receipts (each `buildloop verify` DONE):
- User-visible impact:
- Data or schema changes: none / additive / destructive (destructive needs a backup + restore test)

## 2. Pre-release checks

- [ ] All slices in this release verified DONE (`dod-results.json` per slice)
- [ ] Preview / staging deploy exercised the core flow
- [ ] Rollback rehearsed in preview: `rollback_command` ran and the previous version came back
- [ ] Secrets and config present in the target environment (names only, never values)
- [ ] Monitoring: error rate and latency dashboards or alerts identified:

## 3. Release

- Window:
- Steps (human-run):
  1.
  2.
- Stop and roll back immediately if: smoke fails, error rate rises above baseline, or data integrity is in doubt.

## 4. Post-deploy verification

| Check | Command / signal | Expected | Actual | Result |
|-------|------------------|----------|--------|--------|
| Smoke | `smoke_command` | exit 0 / 200 | | PASS / FAIL |
| Errors | error-rate signal | <= baseline | | PASS / FAIL |
| Key metric | | | | PASS / FAIL |

Outcome: KEPT / ROLLED_BACK

## 5. Lessons

Anything surprising goes to `tasks/LESSONS.md` (see `templates/lessons.md`).

---

*Source: buildloop/templates/release-plan.md*
