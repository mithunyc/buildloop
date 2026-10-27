#!/usr/bin/env node

/**
 * learn.mjs — self-evaluation loop over the Definition-of-Done ledger.
 *
 * Reads .buildloop/ledger.jsonl (one line per verify.mjs run) and computes a
 * measured scorecard: first-pass DoD rate, attempts to DONE, and failure
 * frequency per check. Any check that fails repeatedly becomes a PROMOTION
 * CANDIDATE: a lesson that should be turned into a deterministic control.
 *
 * Design rule: this script measures and recommends. It never edits AGENTS.md,
 * skills, or gates. A human promotes a lesson (see templates/lessons.md), so
 * agents cannot loosen their own governance.
 *
 * Writes .buildloop/scorecard.json. Exit 0, or 1 when --min-first-pass is set
 * and the measured first-pass rate is below it (usable as a CI regression gate).
 *
 * Usage:
 *   node scripts/learn.mjs [--cwd <path>] [--threshold 3] [--min-first-pass 80] [--json]
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { flag } from './gate-runner.mjs';

// Each recurring failure maps to the cheapest control that would prevent it.
const PROMOTIONS = {
  contract: 'Generate slice contracts from the task graph; reject placeholder contracts before work starts.',
  approval: 'Add CODEOWNERS + required review for HIGH blast-radius paths so approval is enforced by the forge, not the agent.',
  scope: 'Slices are too wide or contracts too narrow: split stories, or add the recurring path to protected_paths if it must never change.',
  gates: 'Run gate-runner before claiming done; add the failing gate to a pre-push hook or required CI check.',
  'gates.fresh': 'Agents edit after gating: run verify in CI on the final commit so stale evidence cannot merge.',
  governance: 'Rule files keep changing inside slices: put .buildloop.yml, package.json, and workflows under CODEOWNERS and change them in their own reviewed PR.',
  receipt: 'Receipts disagree with evidence: generate receipt frontmatter from gate-results.json instead of hand-writing it.',
};

function pct(n, d) {
  return d === 0 ? null : Math.round((n / d) * 1000) / 10;
}

/** Returns { records, corrupt }. Corrupt lines are counted and reported, never silently dropped. */
export function readLedger(path) {
  if (!existsSync(path)) return { records: [], corrupt: 0 };
  const records = [];
  let corrupt = 0;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean)) {
    try {
      const record = JSON.parse(line);
      if (typeof record.verdict === 'string' && Array.isArray(record.failed ?? [])) records.push(record);
      else corrupt++;
    } catch {
      corrupt++;
    }
  }
  return { records, corrupt };
}

export function score(records, threshold = 3) {
  const byStory = new Map();
  for (const r of records) {
    const key = r.story ?? '(unknown)';
    if (!byStory.has(key)) byStory.set(key, []);
    byStory.get(key).push(r);
  }

  let firstPass = 0;
  let done = 0;
  let current = 0;
  const attemptsToDone = [];
  for (const runs of byStory.values()) {
    runs.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    if (runs[0].verdict === 'DONE') firstPass++;
    if (runs[runs.length - 1].verdict === 'DONE') current++; // a later failure is a regression
    const idx = runs.findIndex((r) => r.verdict === 'DONE');
    if (idx !== -1) {
      done++;
      attemptsToDone.push(idx + 1);
    }
  }

  const failures = {};
  for (const r of records) for (const id of r.failed ?? []) failures[id] = (failures[id] ?? 0) + 1;

  const candidates = Object.entries(failures)
    .filter(([, count]) => count >= threshold)
    .sort((a, b) => b[1] - a[1])
    .map(([check, count]) => ({
      check,
      count,
      promote_to: PROMOTIONS[check] ?? 'Write a deterministic check for this failure mode.',
    }));

  const stories = byStory.size;
  return {
    generated_at: new Date().toISOString(),
    verifications: records.length,
    stories,
    stories_done: done,
    first_pass_rate: pct(firstPass, stories),
    done_rate: pct(done, stories),
    current_done_rate: pct(current, stories),
    mean_attempts_to_done: attemptsToDone.length
      ? Math.round((attemptsToDone.reduce((a, b) => a + b, 0) / attemptsToDone.length) * 10) / 10
      : null,
    failures_by_check: failures,
    promotion_threshold: threshold,
    promotion_candidates: candidates,
  };
}

function main() {
  const args = process.argv.slice(2);
  const cwd = resolve(flag(args, '--cwd') ?? process.cwd());
  const threshold = Number(flag(args, '--threshold') ?? 3);
  const minFirstPass = flag(args, '--min-first-pass');
  if (!Number.isFinite(threshold) || threshold < 1 || (minFirstPass !== null && !Number.isFinite(Number(minFirstPass)))) {
    console.error('learn: --threshold must be >= 1 and --min-first-pass must be a number');
    process.exit(2);
  }

  const ledgerPath = join(cwd, '.buildloop', 'ledger.jsonl');
  const { records, corrupt } = readLedger(ledgerPath);
  if (records.length === 0) {
    console.log(`learn: no usable ledger records at ${ledgerPath}. Run verify.mjs on a slice first.`);
    // A requested quality gate with no data fails closed.
    process.exit(minFirstPass !== null ? 1 : 0);
  }

  const card = { ...score(records, threshold), corrupt_records: corrupt };
  writeFileSync(join(cwd, '.buildloop', 'scorecard.json'), JSON.stringify(card, null, 2), 'utf8');

  if (args.includes('--json')) {
    console.log(JSON.stringify(card, null, 2));
  } else {
    const show = (v, suffix = '') => (v === null ? 'n/a' : `${v}${suffix}`);
    console.log('learn - measured scorecard (from .buildloop/ledger.jsonl)');
    console.log(`  verifications:         ${card.verifications}`);
    console.log(`  stories:               ${card.stories} (${card.stories_done} done)`);
    console.log(`  first-pass DoD rate:   ${show(card.first_pass_rate, '%')}`);
    console.log(`  eventual DoD rate:     ${show(card.done_rate, '%')}`);
    console.log(`  current DoD rate:      ${show(card.current_done_rate, '%')} (latest verdict per story)`);
    if (corrupt) console.log(`  corrupt ledger lines:  ${corrupt} (ignored; investigate tampering or crashes)`);
    console.log(`  mean attempts to DONE: ${show(card.mean_attempts_to_done)}`);
    console.log('  failures by check:     ' + (Object.keys(card.failures_by_check).length
      ? Object.entries(card.failures_by_check).map(([k, v]) => `${k}=${v}`).join(', ')
      : 'none'));
    if (card.promotion_candidates.length) {
      console.log(`\n  PROMOTION CANDIDATES (failed >= ${threshold}x; human decides, record in tasks/LESSONS.md):`);
      for (const c of card.promotion_candidates) console.log(`  - ${c.check} (${c.count}x): ${c.promote_to}`);
    }
  }

  if (minFirstPass !== null && (card.first_pass_rate ?? 0) < Number(minFirstPass)) {
    console.error(`\nlearn: first-pass rate ${card.first_pass_rate ?? 0}% is below --min-first-pass ${minFirstPass}%`);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
