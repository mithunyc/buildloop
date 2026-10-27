#!/usr/bin/env node

/**
 * verify.mjs — Definition of Done as code.
 *
 * Decides whether one slice is DONE from evidence on disk, not from agent claims.
 * Checks, in order:
 *   contract   slice contract frontmatter is complete (no template placeholders)
 *   approval   HIGH blast radius requires a recorded human approver
 *   scope      every changed file matches the contract's allowed_files
 *   gates      gate-results.json is PASS and was produced for the current workspace
 *   receipt    evidence receipt agrees with gate-results.json (no GO on FAIL)
 *
 * Writes dod-results.json next to the gate results and appends one line to
 * .buildloop/ledger.jsonl, which learn.mjs turns into a measured scorecard.
 *
 * Exit codes: 0 = DONE, 1 = NOT_DONE, 2 = invalid arguments.
 * Zero external dependencies. Read-only except for the two output files above.
 *
 * Usage:
 *   node scripts/verify.mjs --contract <slice-contract.md> --receipt <receipt.md>
 *     [--results <gate-results.json>] [--base <git-ref>] [--cwd <path>] [--ci] [--json]
 *
 * --ci: the gates were re-run by CI, so the receipt's local gate_results_ref
 * cannot match. The receipt must still agree with the CI gate status.
 * --rerun: verify runs gate-runner itself and judges that fresh run, so a
 * hand-edited gate-results.json cannot produce DONE. Recommended locally.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  fingerprintInventory,
  getChangedAndUntrackedFiles,
  getGitHead,
  globToRegExp,
  parseYAML,
  fileHashes,
} from './gate-runner.mjs';

const GATE_RUNNER = join(dirname(fileURLToPath(import.meta.url)), 'gate-runner.mjs');
// Files that define the rules themselves. Changing them inside a slice needs a human.
const GOVERNANCE_RE = /^(?:\.buildloop\.yml|AGENTS\.md|CLAUDE\.md|GEMINI\.md|CODEOWNERS|\.github\/CODEOWNERS|\.github\/workflows\/.+)$/;
const BLAST_RADIUS = ['LOW', 'MEDIUM', 'HIGH'];
const GATE_STATUS = ['PASS', 'FAIL', 'PARTIAL', 'NOT_RUN'];
const RECEIPT_STATUS = ['GO', 'CONDITIONAL_GO', 'NO_GO'];
const CONFIDENCE = ['HIGH', 'MEDIUM', 'LOW'];

function flag(args, name) {
  const idx = args.indexOf(name);
  return idx === -1 || idx + 1 >= args.length ? null : args[idx + 1];
}

/** Template placeholders look like "[YOUR_X]" or "[US-XXX: ...]". */
function isPlaceholder(value) {
  return typeof value === 'string' && /^\[.*\]$/.test(value.trim());
}

function asList(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === '' || value === '[]') return [];
  return [value];
}

/** Parse the YAML frontmatter block of a markdown file. Returns null if absent. */
export function readFrontmatter(path) {
  const raw = readFileSync(path, 'utf8');
  const lines = raw.split(/\r?\n/);
  if (lines[0] !== '---') return null;
  const end = lines.findIndex((line, i) => i > 0 && line === '---');
  if (end === -1) return null;
  return parseYAML(lines.slice(1, end).join('\n'));
}

function git(cwd, args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', shell: false });
  return !res.error && res.status === 0 ? res.stdout.trim() : null;
}

/** Changed files = committed since --base (if given) ∪ uncommitted/untracked. */
function collectChangedFiles(cwd, base) {
  const errors = [];
  const files = new Set(getChangedAndUntrackedFiles(cwd, errors));
  if (errors.length) throw new Error(`cannot inspect changed files (${errors.join('; ')}); is this a git repo?`);
  if (base) {
    const committed = git(cwd, ['-c', 'core.quotePath=false', 'diff', '--name-only', '--no-renames', `${base}...HEAD`]);
    if (committed === null) throw new Error(`cannot diff against base ref '${base}'`);
    for (const f of committed.split('\n')) if (f && !/^\.buildloop(-runs|-tool)?\//.test(f)) files.add(f);
  }
  return [...files];
}

function latestGateResults(cwd) {
  const runsDir = join(cwd, '.buildloop-runs');
  if (!existsSync(runsDir)) return null;
  const runs = readdirSync(runsDir)
    .filter((entry) => existsSync(join(runsDir, entry, 'gate-results.json')))
    .sort();
  return runs.length ? join(runsDir, runs[runs.length - 1], 'gate-results.json') : null;
}

/** A label counts as filled when text follows it on the same line or the next lines. */
function filledIn(body, label) {
  const lines = body.split(/\r?\n/);
  const i = lines.findIndex((l) => l.startsWith(label));
  if (i === -1) return false;
  if (lines[i].slice(label.length).trim()) return true;
  for (const next of lines.slice(i + 1)) {
    if (!next.trim()) continue;
    return !/^[A-Z][A-Za-z ()>-]*:\s*\*?\s*$/.test(next.trim()) && !next.startsWith('#');
  }
  return false;
}

// ---------------------------------------------------------------------------
// Checks. Each returns { id, status: PASS|FAIL|WARN|SKIP, detail }.
// ---------------------------------------------------------------------------

function checkContract(contract) {
  if (!contract) return { id: 'contract', status: 'FAIL', detail: 'slice contract has no frontmatter' };
  const problems = [];
  if (contract.type !== 'slice-contract') problems.push(`type must be slice-contract`);
  if (!contract.story || isPlaceholder(contract.story)) problems.push('story missing or placeholder');
  if (!BLAST_RADIUS.includes(contract.blast_radius)) problems.push(`blast_radius must be one of ${BLAST_RADIUS.join('|')}`);
  if (!contract.rollback || isPlaceholder(contract.rollback)) problems.push('rollback missing or placeholder');
  const allowed = asList(contract.allowed_files);
  if (allowed.length === 0 || allowed.some(isPlaceholder)) problems.push('allowed_files empty or placeholder');
  const evidence = asList(contract.evidence_required);
  if (evidence.length === 0 || evidence.some(isPlaceholder)) problems.push('evidence_required empty or placeholder');
  return problems.length
    ? { id: 'contract', status: 'FAIL', detail: problems.join('; ') }
    : { id: 'contract', status: 'PASS', detail: `${contract.story}` };
}

/** "PENDING-HUMAN", "TBD", "none" and similar are statements that approval is missing. */
function realApprover(contract) {
  const approver = contract?.approved_by;
  if (!approver || isPlaceholder(approver)) return null;
  return /^(pending|tbd|todo|none|n\/?a|unknown|nobody|-+)\b/i.test(String(approver).trim()) ? null : approver;
}

function checkApproval(contract) {
  if (!contract || contract.blast_radius !== 'HIGH') {
    return { id: 'approval', status: 'SKIP', detail: 'no recorded approver required below HIGH; plan approval stays a human step' };
  }
  const approver = realApprover(contract);
  if (!approver) {
    return { id: 'approval', status: 'FAIL', detail: 'HIGH blast radius requires approved_by (human) in the slice contract' };
  }
  return { id: 'approval', status: 'PASS', detail: `approved_by ${approver}${contract.approved_at ? ` at ${contract.approved_at}` : ''}` };
}

/** Did this file exist at the comparison point (base, else HEAD)? */
function existedBefore(cwd, file, base) {
  return git(cwd, ['cat-file', '-e', `${base ?? 'HEAD'}:${file}`]) !== null;
}

function checkGovernance(contract, changedFiles, contractRel, cwd, base) {
  const touched = changedFiles.filter((f) => GOVERNANCE_RE.test(f));
  // An existing contract edited inside its own slice can widen its own scope.
  if (contractRel && changedFiles.includes(contractRel) && existedBefore(cwd, contractRel, base)) touched.push(contractRel);
  if (touched.length === 0) return { id: 'governance', status: 'SKIP', detail: 'no rule files changed' };
  const approver = realApprover(contract);
  return approver
    ? { id: 'governance', status: 'PASS', detail: `rule files changed (${touched.join(', ')}); approved_by ${approver}` }
    : { id: 'governance', status: 'FAIL', detail: `rule files changed without a human approved_by: ${touched.join(', ')}` };
}

function checkScope(contract, changedFiles, exempt) {
  const allowed = asList(contract?.allowed_files).filter((p) => !isPlaceholder(p));
  if (allowed.length === 0) return { id: 'scope', status: 'FAIL', detail: 'no usable allowed_files' };
  if (changedFiles.length === 0) return { id: 'scope', status: 'WARN', detail: 'no changed files detected (pass --base for committed work)' };
  const regexps = allowed.map((p) => globToRegExp(p));
  const work = changedFiles.filter((f) => !exempt.has(f));
  const outside = work.filter((f) => !regexps.some((re) => re.test(f)));
  return outside.length
    ? { id: 'scope', status: 'FAIL', detail: `outside allowed_files: ${outside.join(', ')}` }
    : { id: 'scope', status: 'PASS', detail: `${work.length} changed file(s) within contract (contract/receipt not counted)` };
}

function checkGates(results) {
  if (!results) return { id: 'gates', status: 'FAIL', detail: 'no gate-results.json found; run gate-runner first' };
  // Recompute instead of trusting `overall`: a hand-edited PASS must not survive
  // a failed command, a protected-path violation, or a failed git inspection.
  const commands = Array.isArray(results.commands) ? results.commands : [];
  const failedCommands = commands.filter((c) => c.exit_code !== 0).map((c) => c.name);
  const violations = asList(results.protected_paths_violated);
  const inspection = asList(results.git_inspection_errors);
  const mutated = results.workspace_mutated_by_gates === true;
  const recomputed = failedCommands.length || violations.length || inspection.length || mutated ? 'FAIL' : 'PASS';
  if (results.overall !== recomputed) {
    return { id: 'gates', status: 'FAIL', detail: `gate-results.json is inconsistent: overall=${results.overall} but evidence says ${recomputed}` };
  }
  if (recomputed !== 'PASS') {
    const why = [
      failedCommands.length ? `failed: ${failedCommands.join(', ')}` : '',
      violations.length ? `protected paths: ${violations.join(', ')}` : '',
      inspection.length ? 'git inspection failed' : '',
      mutated ? 'gates modified the workspace they tested' : '',
    ].filter(Boolean).join('; ');
    return { id: 'gates', status: 'FAIL', detail: `gate-runner FAIL (${why})` };
  }
  const skipped = commands.filter((c) => String(c.command).trim().toLowerCase() === 'n/a');
  const ran = commands.length - skipped.length;
  if (ran === 0) return { id: 'gates', status: 'FAIL', detail: 'every gate was n/a; nothing was verified' };
  const test = commands.find((c) => c.name === 'test');
  if (!test || skipped.includes(test)) return { id: 'gates', status: 'FAIL', detail: 'no test gate ran; a slice cannot be DONE without executed tests' };
  return {
    id: 'gates',
    status: skipped.length ? 'WARN' : 'PASS',
    detail: `${ran} gate(s) passed${skipped.length ? `; skipped: ${skipped.map((c) => c.name).join(', ')}` : ''}`,
  };
}

function checkFreshness(results, cwd, exempt) {
  if (!results) return { id: 'gates.fresh', status: 'SKIP', detail: 'no gate results' };
  if (!results.file_hashes || typeof results.file_hashes !== 'object') {
    return { id: 'gates.fresh', status: 'FAIL', detail: 'gate-results.json has no file_hashes; re-run gate-runner' };
  }
  const head = getGitHead(cwd);
  if ((results.git_head ?? null) !== head) {
    return { id: 'gates.fresh', status: 'FAIL', detail: `HEAD moved after the gate run (${String(results.git_head).slice(0, 7)} -> ${String(head).slice(0, 7)}); re-run gate-runner` };
  }
  // Only the exact contract and receipt given to verify may differ: they are written after the gates.
  const before = results.file_hashes;
  const now = fileHashes(cwd, fingerprintInventory(cwd));
  const changed = [...new Set([...Object.keys(before), ...Object.keys(now)])]
    .filter((f) => !exempt.has(f) && before[f] !== now[f]);
  return changed.length
    ? { id: 'gates.fresh', status: 'FAIL', detail: `changed after the gate run: ${changed.join(', ')}; re-run gate-runner` }
    : { id: 'gates.fresh', status: 'PASS', detail: 'gate results match the current workspace' };
}

function checkReceipt(receipt, receiptPath, resultsPath, results, scopeStatus, cwd, ci) {
  if (!receiptPath) return { id: 'receipt', status: 'FAIL', detail: 'no evidence receipt given (--receipt); no receipt = not done' };
  if (!receipt) return { id: 'receipt', status: 'FAIL', detail: 'receipt has no frontmatter' };
  const problems = [];
  if (receipt.type !== 'evidence-receipt') problems.push('type must be evidence-receipt');
  if (!GATE_STATUS.includes(receipt.gate_status)) problems.push(`gate_status must be one of ${GATE_STATUS.join('|')}`);
  if (!CONFIDENCE.includes(receipt.confidence)) problems.push(`confidence must be one of ${CONFIDENCE.join('|')}`);
  if (!RECEIPT_STATUS.includes(receipt.status)) problems.push(`status must be one of ${RECEIPT_STATUS.join('|')}`);
  const ref = receipt.gate_results_ref;
  if (!ref || /\[.*\]/.test(ref)) {
    problems.push('gate_results_ref missing or placeholder');
  } else if (!ci && resultsPath && resolve(cwd, ref) !== resolve(resultsPath)) {
    problems.push(`gate_results_ref points to ${ref}, but the verified run is ${relative(cwd, resultsPath).replace(/\\/g, '/')}`);
  }
  if (results && receipt.gate_status !== results.overall) {
    problems.push(`receipt claims gate_status=${receipt.gate_status}, gate-runner recorded ${results.overall}`);
  }
  if (receipt.status === 'GO' && (results?.overall !== 'PASS' || scopeStatus === 'FAIL')) {
    problems.push('status GO is not allowed when gates or scope fail');
  }
  if (receipt.status === 'NO_GO') problems.push('receipt recommends NO_GO');
  // Generated receipts mark the human-judgment lines verify requires with "*".
  const body = readFileSync(receiptPath, 'utf8');
  for (const label of ['Acceptance criteria -> proof:', 'Rollback:']) {
    if (body.includes(`${label} *`) && !filledIn(body, `${label} *`)) problems.push(`"${label}" is empty`);
  }
  if (problems.length) return { id: 'receipt', status: 'FAIL', detail: problems.join('; ') };
  return receipt.status === 'CONDITIONAL_GO'
    ? { id: 'receipt', status: 'WARN', detail: 'receipt is CONDITIONAL_GO; the human reviewer must accept the stated conditions' }
    : { id: 'receipt', status: 'PASS', detail: 'receipt GO agrees with gate evidence' };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/** Run the gates now, under verify's control, and return the new results path. */
function rerunGates(cwd) {
  const before = latestGateResults(cwd);
  const r = spawnSync(process.execPath, [GATE_RUNNER], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Error(`could not run gate-runner: ${r.error.message}`);
  process.stderr.write(r.stdout ?? '');
  process.stderr.write(r.stderr ?? '');
  const after = latestGateResults(cwd);
  if (!after || after === before) throw new Error('gate-runner produced no new gate-results.json');
  return after;
}

export function verify({ cwd, contractPath, receiptPath, resultsPath, base, ci = false, rerun = false }) {
  const contract = existsSync(contractPath) ? readFrontmatter(contractPath) : null;
  const receipt = receiptPath && existsSync(receiptPath) ? readFrontmatter(receiptPath) : null;
  // --rerun: evidence is produced now by verify itself, so stored JSON is not trusted.
  const resolvedResults = rerun ? rerunGates(cwd) : resultsPath ?? latestGateResults(cwd);
  const results = resolvedResults && existsSync(resolvedResults)
    ? JSON.parse(readFileSync(resolvedResults, 'utf8'))
    : null;

  // Only the explicit contract and receipt are exempt from scope. Exemption by
  // file content would let an agent disguise an out-of-scope edit.
  const exempt = new Set([contractPath, receiptPath].filter(Boolean).map((p) => relative(cwd, p).replace(/\\/g, '/')));
  const changedFiles = collectChangedFiles(cwd, base);

  const scope = checkScope(contract, changedFiles, exempt);
  const contractRel = relative(cwd, contractPath).replace(/\\/g, '/');
  const checks = [
    checkContract(contract),
    checkApproval(contract),
    checkGovernance(contract, changedFiles, contractRel, cwd, base),
    scope,
    checkGates(results),
    checkFreshness(results, cwd, exempt),
    checkReceipt(receipt, receiptPath, resolvedResults, results, scope.status, cwd, ci || rerun),
  ];
  const verdict = checks.some((c) => c.status === 'FAIL') ? 'NOT_DONE' : 'DONE';

  return {
    verified_at: new Date().toISOString(),
    story: contract?.story ?? null,
    blast_radius: contract?.blast_radius ?? null,
    git_head: getGitHead(cwd),
    gate_results: resolvedResults ? relative(cwd, resolvedResults).replace(/\\/g, '/') : null,
    changed_files: changedFiles,
    checks,
    verdict,
  };
}

function main() {
  const args = process.argv.slice(2);
  const cwd = resolve(flag(args, '--cwd') ?? process.cwd());
  const abs = (p) => (p ? (isAbsolute(p) ? p : resolve(cwd, p)) : null);
  const contractPath = abs(flag(args, '--contract'));

  if (!contractPath) {
    console.error('verify: --contract <slice-contract.md> is required');
    console.error('usage: node scripts/verify.mjs --contract <path> --receipt <path> [--results <path>] [--base <ref>] [--cwd <path>] [--ci] [--rerun] [--json]');
    process.exit(2);
  }
  if (!existsSync(contractPath)) {
    console.error(`verify: contract not found: ${contractPath}`);
    process.exit(2);
  }

  let report;
  try {
    report = verify({
      cwd,
      contractPath,
      receiptPath: abs(flag(args, '--receipt')),
      resultsPath: abs(flag(args, '--results')),
      base: flag(args, '--base'),
      ci: args.includes('--ci'),
      rerun: args.includes('--rerun'),
    });
  } catch (err) {
    console.error(`verify: ${err.message}`);
    process.exit(1);
  }

  if (report.gate_results) {
    writeFileSync(join(dirname(resolve(cwd, report.gate_results)), 'dod-results.json'), JSON.stringify(report, null, 2), 'utf8');
  }
  const ledgerDir = join(cwd, '.buildloop');
  mkdirSync(ledgerDir, { recursive: true });
  appendFileSync(join(ledgerDir, 'ledger.jsonl'), JSON.stringify({
    ts: report.verified_at,
    story: report.story,
    blast_radius: report.blast_radius,
    git_head: report.git_head,
    verdict: report.verdict,
    failed: report.checks.filter((c) => c.status === 'FAIL').map((c) => c.id),
    warned: report.checks.filter((c) => c.status === 'WARN').map((c) => c.id),
  }) + '\n', 'utf8');

  if (args.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`verify - Definition of Done for ${report.story ?? '(unknown story)'}`);
    for (const c of report.checks) console.log(`  ${c.status.padEnd(4)}  ${c.id.padEnd(11)} ${c.detail}`);
    console.log(`\n  verdict: ${report.verdict}`);
  }
  process.exit(report.verdict === 'DONE' ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
