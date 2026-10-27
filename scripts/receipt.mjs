#!/usr/bin/env node

/**
 * receipt.mjs — generate an evidence receipt from gate-results.json.
 *
 * Hand-written receipts drift from the evidence. This derives the frontmatter
 * (gate status, confidence, GO / NO_GO) from the recorded gate run, lists the
 * commands and exit codes, and leaves only the human-judgment sections blank.
 * The status is never more optimistic than the evidence: FAIL -> NO_GO,
 * skipped gates -> CONDITIONAL_GO.
 *
 * Exit codes: 0 = written, 1 = no evidence / refused, 2 = invalid arguments.
 *
 * Usage:
 *   node scripts/receipt.mjs --out <receipt.md> [--results <gate-results.json>] [--cwd <path>] [--force]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { flag, latestGateResults } from './gate-runner.mjs';

export function buildReceipt(results, ref) {
  const commands = Array.isArray(results.commands) ? results.commands : [];
  const skipped = commands.filter((c) => String(c.command).trim().toLowerCase() === 'n/a');
  const failed = commands.filter((c) => c.exit_code !== 0);
  const violations = results.protected_paths_violated ?? [];
  const test = commands.find((c) => c.name === 'test');
  // gate_status mirrors what gate-runner recorded; verify compares the two.
  const pass = failed.length === 0 && violations.length === 0 && (results.git_inspection_errors ?? []).length === 0
    && results.workspace_mutated_by_gates !== true;
  const testsRan = Boolean(test) && !skipped.includes(test);

  const gateStatus = pass ? 'PASS' : 'FAIL';
  const status = !pass || !testsRan ? 'NO_GO' : skipped.length ? 'CONDITIONAL_GO' : 'GO';
  const confidence = !pass || !testsRan ? 'LOW' : skipped.length ? 'MEDIUM' : 'HIGH';

  return [
    '---',
    'type: evidence-receipt',
    `gate_results_ref: "${ref}"`,
    `gate_status: ${gateStatus}`,
    `confidence: ${confidence}`,
    `status: ${status}`,
    '---',
    '',
    '# Evidence Receipt (generated)',
    '',
    `Generated from \`${ref}\` (run ${results.run_id ?? 'unknown'}, HEAD ${results.git_head ? results.git_head.slice(0, 12) : 'none'}).`,
    'Do not edit the frontmatter by hand. Re-run gates and regenerate instead.',
    '',
    '## Commands run',
    '',
    ...commands.map((c) => `- \`${c.command}\` -> exit ${c.exit_code}${String(c.command).trim().toLowerCase() === 'n/a' ? ' (skipped)' : ''}`),
    '',
    '## Changed files',
    '',
    ...((results.changed_files ?? []).length ? results.changed_files.map((f) => `- ${f}`) : ['- none recorded']),
    '',
    ...(violations.length ? ['## Protected path violations', '', ...violations.map((v) => `- ${v}`), ''] : []),
    ...(status === 'CONDITIONAL_GO'
      ? [`Conditions: ${skipped.map((c) => c.name).join(', ')} not verified (n/a). The reviewer accepts or rejects this.`, '']
      : []),
    '## Human judgment (fill in)',
    '',
    'verify requires the two lines marked * to be filled in.',
    '',
    'KEY DECISION FOR HUMAN:',
    'Acceptance criteria -> proof: *',
    'UNVERIFIED (what these gates do not prove):',
    'Known risks:',
    'Rollback: *',
    '',
  ].join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const cwd = resolve(flag(args, '--cwd') ?? process.cwd());
  const abs = (p) => (p ? (isAbsolute(p) ? p : resolve(cwd, p)) : null);
  const out = abs(flag(args, '--out'));
  if (!out) {
    console.error('receipt: --out <receipt.md> is required');
    process.exit(2);
  }
  if (existsSync(out) && !args.includes('--force')) {
    console.error(`receipt: ${out} exists. Re-run with --force to regenerate it.`);
    process.exit(1);
  }
  const resultsPath = abs(flag(args, '--results')) ?? latestGateResults(cwd);
  if (!resultsPath || !existsSync(resultsPath)) {
    console.error('receipt: no gate-results.json found. Run gate-runner first.');
    process.exit(1);
  }
  const results = JSON.parse(readFileSync(resultsPath, 'utf8'));
  const ref = relative(cwd, resultsPath).replace(/\\/g, '/');
  mkdirSync(dirname(out), { recursive: true });
  const text = buildReceipt(results, ref);
  writeFileSync(out, text, 'utf8');
  const summary = text.split('\n').filter((l) => /^(gate_status|confidence|status):/.test(l)).join(', ');
  console.log(`receipt: wrote ${relative(cwd, out).replace(/\\/g, '/')} (${summary})`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
