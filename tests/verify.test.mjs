#!/usr/bin/env node

/**
 * tests/verify.test.mjs
 *
 * Black-box tests for scripts/verify.mjs (Definition of Done) and
 * scripts/learn.mjs (scorecard + promotion candidates). Each scenario builds a
 * throwaway git repo, runs the real gate-runner, then verifies.
 *
 *  1. happy path: in-scope change, gates PASS, honest receipt -> DONE
 *  2. receipt written after gates does not make evidence stale
 *  3. out-of-scope file -> scope FAIL
 *  4. edit after gate run -> gates.fresh FAIL
 *  5. receipt claims PASS/GO while gates FAIL -> receipt FAIL
 *  6. HIGH blast radius without approved_by -> approval FAIL; with it -> PASS
 *  7. unfilled template contract -> contract FAIL
 *  8. missing receipt -> receipt FAIL
 *  9. every gate n/a -> gates FAIL
 * 10. --base catches committed out-of-scope work
 * 11. receipt pointing at a different run -> receipt FAIL
 * 12. learn: first-pass rate, attempts, promotion candidates
 * 13. learn --min-first-pass below rate -> exit 1; no ledger -> exit 0
 * 14. CLI `buildloop verify` relays exit code
 * 15. hand-edited overall PASS over a failed command -> gates FAIL
 * 16. NO_GO receipt -> FAIL; CONDITIONAL_GO -> WARN but DONE
 * 17. markdown disguised as a receipt is still a scope violation
 * 18. glob semantics for deny-lists vs allow-lists
 * 19. gate-runner flags nested .env files
 * 20. --ci mode for CI re-runs (receipt status still bound to CI evidence)
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { globToRegExp } from '../scripts/gate-runner.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const GATE_RUNNER = join(ROOT, 'scripts', 'gate-runner.mjs');
const VERIFY = join(ROOT, 'scripts', 'verify.mjs');
const LEARN = join(ROOT, 'scripts', 'learn.mjs');
const CLI = join(ROOT, 'scripts', 'buildloop.mjs');

let passed = 0;
let failed = 0;
const tempDirs = [];

function check(label, fn) {
  try {
    fn();
    console.log(`PASS ${label}`);
    passed++;
  } catch (error) {
    console.error(`FAIL ${label}`);
    console.error(`     ${error.message}`);
    failed++;
  }
}

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function write(cwd, file, content) {
  mkdirSync(dirname(join(cwd, file)), { recursive: true });
  writeFileSync(join(cwd, file), content, 'utf8');
}

/** Fresh repo with one commit, a passing test gate, and .buildloop ignored. */
function makeRepo({ testCommand = 'node -e "process.exit(0)"', lint = 'n/a' } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'buildloop-verify-'));
  tempDirs.push(cwd);
  git(cwd, ['init', '-q']);
  git(cwd, ['config', 'user.email', 'test@example.com']);
  git(cwd, ['config', 'user.name', 'test']);
  git(cwd, ['config', 'core.autocrlf', 'false']);
  write(cwd, '.gitignore', '.buildloop/\n.buildloop-runs/\n');
  write(cwd, '.buildloop.yml', [
    'adoption_mode: greenfield',
    'commands:',
    `  lint: "${lint.replace(/"/g, '\\"')}"`,
    '  typecheck: "n/a"',
    `  test: "${testCommand.replace(/"/g, '\\"')}"`,
    '  build: "n/a"',
    'protected_paths:',
    '  - ".env*"',
    '',
  ].join('\n'));
  write(cwd, 'src/app.js', 'export const a = 1;\n');
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-q', '-m', 'init']);
  return cwd;
}

function contract(cwd, { allowed = ['src/**'], blast = 'LOW', extra = '' } = {}) {
  write(cwd, 'tasks/US-001.contract.md', [
    '---',
    'type: slice-contract',
    'story: "US-001: change app constant"',
    'allowed_files:',
    ...allowed.map((p) => `  - "${p}"`),
    `blast_radius: ${blast}`,
    'rollback: "git revert HEAD"',
    'depends_on: []',
    'evidence_required:',
    '  - "node test -> exit 0"',
    extra,
    '---',
    '',
    '# Contract',
    '',
  ].filter((l) => l !== '').join('\n') + '\n');
  return 'tasks/US-001.contract.md';
}

function runGates(cwd) {
  const r = spawnSync(process.execPath, [GATE_RUNNER], { cwd, encoding: 'utf8' });
  const runs = readdirSync(join(cwd, '.buildloop-runs')).sort();
  return { status: r.status, ref: `.buildloop-runs/${runs[runs.length - 1]}/gate-results.json` };
}

function receipt(cwd, { ref, gate = 'PASS', status = 'GO' }) {
  write(cwd, 'tasks/US-001.receipt.md', [
    '---',
    'type: evidence-receipt',
    `gate_results_ref: "${ref}"`,
    `gate_status: ${gate}`,
    'confidence: HIGH',
    `status: ${status}`,
    '---',
    '',
    '# Receipt',
    '',
    'Acceptance criteria -> proof: AC1 -> node test exit 0',
    'Rollback: git restore -- src/app.js',
    '',
  ].join('\n'));
  return 'tasks/US-001.receipt.md';
}

function verify(cwd, args) {
  const r = spawnSync(process.execPath, [VERIFY, ...args, '--json'], { cwd, encoding: 'utf8' });
  let report = null;
  try {
    report = JSON.parse(r.stdout);
  } catch {
    // leave null; assertions will show stderr
  }
  return { status: r.status, report, stderr: r.stderr };
}

const statusOf = (report, id) => report.checks.find((c) => c.id === id)?.status;

// ---------------------------------------------------------------------------

check('1. happy path -> DONE', () => {
  const cwd = makeRepo();
  write(cwd, 'src/app.js', 'export const a = 2;\n');
  const c = contract(cwd);
  const { ref } = runGates(cwd);
  const r = verify(cwd, ['--contract', c, '--receipt', receipt(cwd, { ref })]);
  assert.equal(r.status, 0, r.stderr || JSON.stringify(r.report?.checks));
  assert.equal(r.report.verdict, 'DONE');
  assert.ok(existsSync(join(cwd, dirname(ref), 'dod-results.json')), 'dod-results.json written');
});

check('2. receipt written after gates is not stale evidence', () => {
  const cwd = makeRepo();
  write(cwd, 'src/app.js', 'export const a = 3;\n');
  const c = contract(cwd);
  const { ref } = runGates(cwd);
  const rc = receipt(cwd, { ref }); // written after the gate run, on purpose
  const r = verify(cwd, ['--contract', c, '--receipt', rc]);
  assert.equal(statusOf(r.report, 'gates.fresh'), 'PASS');
});

check('3. out-of-scope change -> scope FAIL', () => {
  const cwd = makeRepo();
  write(cwd, 'src/app.js', 'export const a = 2;\n');
  write(cwd, 'infra/main.tf', 'resource {}\n');
  const c = contract(cwd);
  const { ref } = runGates(cwd);
  const r = verify(cwd, ['--contract', c, '--receipt', receipt(cwd, { ref })]);
  assert.equal(r.status, 1);
  assert.equal(statusOf(r.report, 'scope'), 'FAIL');
  assert.match(r.report.checks.find((x) => x.id === 'scope').detail, /infra\/main\.tf/);
});

check('4. edit after gate run -> gates.fresh FAIL', () => {
  const cwd = makeRepo();
  write(cwd, 'src/app.js', 'export const a = 2;\n');
  const c = contract(cwd);
  const { ref } = runGates(cwd);
  write(cwd, 'src/app.js', 'export const a = "untested";\n');
  const r = verify(cwd, ['--contract', c, '--receipt', receipt(cwd, { ref })]);
  assert.equal(r.status, 1);
  assert.equal(statusOf(r.report, 'gates.fresh'), 'FAIL');
});

check('5. receipt claims PASS/GO while gates FAIL -> receipt FAIL', () => {
  const cwd = makeRepo({ testCommand: 'node -e "process.exit(3)"' });
  write(cwd, 'src/app.js', 'export const a = 2;\n');
  const c = contract(cwd);
  const { status, ref } = runGates(cwd);
  assert.equal(status, 1, 'gate-runner should fail');
  const r = verify(cwd, ['--contract', c, '--receipt', receipt(cwd, { ref, gate: 'PASS', status: 'GO' })]);
  assert.equal(r.status, 1);
  assert.equal(statusOf(r.report, 'gates'), 'FAIL');
  assert.equal(statusOf(r.report, 'receipt'), 'FAIL');
  assert.match(r.report.checks.find((x) => x.id === 'receipt').detail, /claims gate_status=PASS/);
});

check('6. HIGH blast radius requires approved_by', () => {
  const cwd = makeRepo();
  write(cwd, 'src/app.js', 'export const a = 2;\n');
  let c = contract(cwd, { blast: 'HIGH' });
  let { ref } = runGates(cwd);
  let r = verify(cwd, ['--contract', c, '--receipt', receipt(cwd, { ref })]);
  assert.equal(statusOf(r.report, 'approval'), 'FAIL');
  c = contract(cwd, { blast: 'HIGH', extra: 'approved_by: "founder@example.com"' });
  ({ ref } = runGates(cwd));
  r = verify(cwd, ['--contract', c, '--receipt', receipt(cwd, { ref })]);
  assert.equal(statusOf(r.report, 'approval'), 'PASS');
  assert.equal(r.report.verdict, 'DONE', JSON.stringify(r.report.checks));
});

check('6b. pending-style approvals are not approvals', () => {
  const cwd = makeRepo();
  write(cwd, 'src/app.js', 'export const a = 2;\n');
  for (const value of ['PENDING-HUMAN', 'TBD', 'none', 'N/A', 'todo: ask founder']) {
    const c = contract(cwd, { blast: 'HIGH', extra: `approved_by: "${value}"` });
    const { ref } = runGates(cwd);
    const r = verify(cwd, ['--contract', c, '--receipt', receipt(cwd, { ref })]);
    assert.equal(statusOf(r.report, 'approval'), 'FAIL', `approved_by "${value}" must not count`);
  }
});

check('7. unfilled template contract -> contract FAIL', () => {
  const cwd = makeRepo();
  write(cwd, 'tasks/template.md', readFileSync(join(ROOT, 'templates', 'slice-contract.md'), 'utf8'));
  const { ref } = runGates(cwd);
  const r = verify(cwd, ['--contract', 'tasks/template.md', '--receipt', receipt(cwd, { ref })]);
  assert.equal(statusOf(r.report, 'contract'), 'FAIL');
});

check('8. missing receipt -> receipt FAIL', () => {
  const cwd = makeRepo();
  write(cwd, 'src/app.js', 'export const a = 2;\n');
  const c = contract(cwd);
  runGates(cwd);
  const r = verify(cwd, ['--contract', c]);
  assert.equal(r.status, 1);
  assert.equal(statusOf(r.report, 'receipt'), 'FAIL');
});

check('9. every gate n/a -> gates FAIL', () => {
  const cwd = makeRepo({ testCommand: 'n/a' });
  write(cwd, 'src/app.js', 'export const a = 2;\n');
  const c = contract(cwd);
  const { ref } = runGates(cwd);
  const r = verify(cwd, ['--contract', c, '--receipt', receipt(cwd, { ref })]);
  assert.equal(statusOf(r.report, 'gates'), 'FAIL');
});

check('10. --base catches committed out-of-scope work', () => {
  const cwd = makeRepo();
  const base = git(cwd, ['rev-parse', 'HEAD']);
  write(cwd, 'src/app.js', 'export const a = 2;\n');
  write(cwd, 'scripts/deploy.sh', 'echo deploy\n');
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-q', '-m', 'work']);
  const c = contract(cwd);
  const { ref } = runGates(cwd);
  const withoutBase = verify(cwd, ['--contract', c, '--receipt', receipt(cwd, { ref })]);
  assert.notEqual(statusOf(withoutBase.report, 'scope'), 'FAIL', 'committed work is invisible without --base');
  const withBase = verify(cwd, ['--contract', c, '--receipt', receipt(cwd, { ref }), '--base', base]);
  assert.equal(statusOf(withBase.report, 'scope'), 'FAIL');
});

check('11. receipt pointing at a different run -> receipt FAIL', () => {
  const cwd = makeRepo();
  write(cwd, 'src/app.js', 'export const a = 2;\n');
  const c = contract(cwd);
  const first = runGates(cwd);
  const second = runGates(cwd);
  assert.notEqual(first.ref, second.ref);
  const r = verify(cwd, ['--contract', c, '--receipt', receipt(cwd, { ref: first.ref }), '--results', second.ref]);
  assert.equal(statusOf(r.report, 'receipt'), 'FAIL');
});

check('12. learn computes first-pass rate and promotion candidates', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'buildloop-learn-'));
  tempDirs.push(cwd);
  const lines = [
    { ts: '2026-01-01T00:00:00Z', story: 'US-1', verdict: 'NOT_DONE', failed: ['scope'] },
    { ts: '2026-01-01T01:00:00Z', story: 'US-1', verdict: 'DONE', failed: [] },
    { ts: '2026-01-02T00:00:00Z', story: 'US-2', verdict: 'DONE', failed: [] },
    { ts: '2026-01-03T00:00:00Z', story: 'US-3', verdict: 'NOT_DONE', failed: ['scope', 'gates.fresh'] },
    { ts: '2026-01-03T01:00:00Z', story: 'US-3', verdict: 'NOT_DONE', failed: ['scope'] },
  ];
  write(cwd, '.buildloop/ledger.jsonl', lines.map((l) => JSON.stringify(l)).join('\n') + '\nnot-json\n');
  const r = spawnSync(process.execPath, [LEARN, '--json'], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const card = JSON.parse(r.stdout);
  assert.equal(card.stories, 3);
  assert.equal(card.first_pass_rate, 33.3);
  assert.equal(card.done_rate, 66.7);
  assert.equal(card.mean_attempts_to_done, 1.5);
  assert.equal(card.current_done_rate, 66.7);
  assert.equal(card.corrupt_records, 1, 'corrupt lines are counted, not silently dropped');
  assert.equal(card.failures_by_check.scope, 3);
  assert.deepEqual(card.promotion_candidates.map((c) => c.check), ['scope']);
  assert.ok(existsSync(join(cwd, '.buildloop', 'scorecard.json')));
});

check('13. learn --min-first-pass gate and empty ledger', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'buildloop-learn-'));
  tempDirs.push(cwd);
  let r = spawnSync(process.execPath, [LEARN], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /no usable ledger records/);
  assert.equal(spawnSync(process.execPath, [LEARN, '--min-first-pass', '1'], { cwd, encoding: 'utf8' }).status, 1, 'gate with no data fails closed');
  write(cwd, '.buildloop/ledger.jsonl', JSON.stringify({ ts: 't', story: 'US-1', verdict: 'NOT_DONE', failed: ['gates'] }) + '\n');
  r = spawnSync(process.execPath, [LEARN, '--min-first-pass', '80'], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 1);
});

check('14. CLI verify relays exit code and writes the ledger', () => {
  const cwd = makeRepo();
  write(cwd, 'src/app.js', 'export const a = 2;\n');
  const c = contract(cwd);
  const { ref } = runGates(cwd);
  const ok = spawnSync(process.execPath, [CLI, 'verify', '--cwd', cwd, '--contract', c, '--receipt', receipt(cwd, { ref })], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  const bad = spawnSync(process.execPath, [CLI, 'verify', '--cwd', cwd, '--contract', c], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  const ledger = readFileSync(join(cwd, '.buildloop', 'ledger.jsonl'), 'utf8').trim().split('\n');
  assert.equal(ledger.length, 2);
  const usage = spawnSync(process.execPath, [CLI, 'verify', '--cwd', cwd], { encoding: 'utf8' });
  assert.equal(usage.status, 2);
});

check('15. forged overall PASS over a failed command -> gates FAIL', () => {
  const cwd = makeRepo({ testCommand: 'node -e "process.exit(4)"' });
  write(cwd, 'src/app.js', 'export const a = 2;\n');
  const c = contract(cwd);
  const { ref } = runGates(cwd);
  const forged = JSON.parse(readFileSync(join(cwd, ref), 'utf8'));
  forged.overall = 'PASS';
  writeFileSync(join(cwd, ref), JSON.stringify(forged), 'utf8');
  const r = verify(cwd, ['--contract', c, '--receipt', receipt(cwd, { ref })]);
  assert.equal(r.status, 1);
  assert.match(r.report.checks.find((x) => x.id === 'gates').detail, /inconsistent/);
});

check('16. NO_GO receipt fails; CONDITIONAL_GO warns but can be DONE', () => {
  const cwd = makeRepo();
  write(cwd, 'src/app.js', 'export const a = 2;\n');
  const c = contract(cwd);
  const { ref } = runGates(cwd);
  let r = verify(cwd, ['--contract', c, '--receipt', receipt(cwd, { ref, status: 'NO_GO' })]);
  assert.equal(statusOf(r.report, 'receipt'), 'FAIL');
  r = verify(cwd, ['--contract', c, '--receipt', receipt(cwd, { ref, status: 'CONDITIONAL_GO' })]);
  assert.equal(statusOf(r.report, 'receipt'), 'WARN');
  assert.equal(r.report.verdict, 'DONE');
});

check('17. markdown disguised as a receipt is still a scope violation', () => {
  const cwd = makeRepo();
  write(cwd, 'src/app.js', 'export const a = 2;\n');
  write(cwd, 'docs/SECURITY-POLICY.md', '---\ntype: evidence-receipt\n---\nweakened policy\n');
  const c = contract(cwd);
  const { ref } = runGates(cwd);
  const r = verify(cwd, ['--contract', c, '--receipt', receipt(cwd, { ref })]);
  assert.equal(statusOf(r.report, 'scope'), 'FAIL');
  assert.match(r.report.checks.find((x) => x.id === 'scope').detail, /SECURITY-POLICY/);
});

check('18. glob semantics: deny-lists match at any depth, allow-lists stay anchored', () => {
  const deny = (p, f) => globToRegExp(p, { anyDepth: true }).test(f);
  const allow = (p, f) => globToRegExp(p).test(f);
  assert.ok(deny('.env*', '.env') && deny('.env*', 'apps/web/.env.local'));
  assert.ok(!deny('.env*', 'src/config.environment.ts'));
  assert.ok(deny('**/*.pem', 'key.pem') && deny('**/*.pem', 'a/b/key.pem'));
  assert.ok(deny('.github/workflows/**', '.github/workflows/ci.yml'));
  assert.ok(!deny('.github/workflows/**', 'docs/.github/workflows/ci.yml'));
  assert.ok(allow('src/**', 'src/a/b.js') && !allow('src/**', 'lib/src/b.js'));
  assert.ok(allow('README.md', 'README.md') && !allow('README.md', 'docs/README.md'));
});

check('19. gate-runner flags nested .env files', () => {
  const cwd = makeRepo();
  write(cwd, 'apps/web/.env.local', 'SECRET=1\n');
  const { status, ref } = runGates(cwd);
  assert.equal(status, 1);
  const results = JSON.parse(readFileSync(join(cwd, ref), 'utf8'));
  assert.deepEqual(results.protected_paths_violated, ['apps/web/.env.local']);
});

check('20. --ci accepts a re-run gate but still binds receipt status to it', () => {
  const cwd = makeRepo();
  const base = git(cwd, ['rev-parse', 'HEAD']);
  write(cwd, 'src/app.js', 'export const a = 2;\n');
  const c = contract(cwd);
  const local = runGates(cwd);
  const rc = receipt(cwd, { ref: local.ref });
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-q', '-m', 'slice']);
  write(cwd, '.buildloop-tool/scripts/verify.mjs', '// CI checkout of the runtime\n');
  const ciRun = runGates(cwd);
  let r = verify(cwd, ['--contract', c, '--receipt', rc, '--results', ciRun.ref, '--base', base, '--ci']);
  assert.equal(r.report.verdict, 'DONE', JSON.stringify(r.report.checks));
  r = verify(cwd, ['--contract', c, '--receipt', rc, '--results', ciRun.ref, '--base', base]);
  assert.equal(statusOf(r.report, 'receipt'), 'FAIL', 'without --ci the run path must match');
});

const INIT = join(ROOT, 'scripts', 'init.mjs');
const RECEIPT = join(ROOT, 'scripts', 'receipt.mjs');

check('21. init writes real gate commands from package.json and refuses overwrite', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'buildloop-init-'));
  tempDirs.push(cwd);
  write(cwd, 'package.json', JSON.stringify({ scripts: { lint: 'eslint .', test: 'vitest run', build: 'vite build' } }));
  write(cwd, 'pnpm-lock.yaml', '');
  write(cwd, 'tsconfig.json', '{}');
  let r = spawnSync(process.execPath, [INIT, '--cwd', cwd], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const yml = readFileSync(join(cwd, '.buildloop.yml'), 'utf8');
  assert.match(yml, /lint: "pnpm run lint"/);
  assert.match(yml, /typecheck: "npx tsc --noEmit"/);
  assert.match(yml, /test: "pnpm run test"/);
  assert.doesNotMatch(yml, /\[YOUR_/);
  assert.match(readFileSync(join(cwd, '.gitignore'), 'utf8'), /\.buildloop-runs\//);
  r = spawnSync(process.execPath, [INIT, '--cwd', cwd], { encoding: 'utf8' });
  assert.equal(r.status, 1, 'must refuse to overwrite');
});

check('22. init treats the npm placeholder test script as missing', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'buildloop-init-'));
  tempDirs.push(cwd);
  write(cwd, 'package.json', JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
  const r = spawnSync(process.execPath, [INIT, '--cwd', cwd], { encoding: 'utf8' });
  assert.match(readFileSync(join(cwd, '.buildloop.yml'), 'utf8'), /test: "n\/a"/);
  assert.match(r.stdout, /no test command found/);
});

check('23. generated receipt passes verify on PASS and is NO_GO on FAIL', () => {
  const cwd = makeRepo();
  write(cwd, 'src/app.js', 'export const a = 2;\n');
  const c = contract(cwd);
  runGates(cwd);
  let r = spawnSync(process.execPath, [RECEIPT, '--cwd', cwd, '--out', 'tasks/gen.receipt.md'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  let v = verify(cwd, ['--contract', c, '--receipt', 'tasks/gen.receipt.md']);
  assert.equal(v.report.verdict, 'NOT_DONE', 'blank acceptance->proof and rollback must not pass');
  assert.match(v.report.checks.find((x) => x.id === 'receipt').detail, /Acceptance criteria -> proof:" is missing or empty/);
  const genPath = join(cwd, 'tasks', 'gen.receipt.md');
  writeFileSync(genPath, readFileSync(genPath, 'utf8')
    .replace('Acceptance criteria -> proof: *', 'Acceptance criteria -> proof: * AC1 -> node test exit 0')
    .replace('Rollback: *', 'Rollback: * git restore -- src/app.js'), 'utf8');
  v = verify(cwd, ['--contract', c, '--receipt', 'tasks/gen.receipt.md']);
  assert.equal(v.report.verdict, 'DONE', JSON.stringify(v.report.checks));
  assert.match(readFileSync(genPath, 'utf8'), /Conditions: lint, typecheck, build not verified/);

  const bad = makeRepo({ testCommand: 'node -e "process.exit(1)"' });
  runGates(bad);
  r = spawnSync(process.execPath, [RECEIPT, '--cwd', bad, '--out', 'r.md'], { encoding: 'utf8' });
  assert.match(readFileSync(join(bad, 'r.md'), 'utf8'), /status: NO_GO/);
  r = spawnSync(process.execPath, [RECEIPT, '--cwd', bad, '--out', 'r.md'], { encoding: 'utf8' });
  assert.equal(r.status, 1, 'must refuse to overwrite without --force');
});

check('24. files hidden by local ignore rules are still in scope', () => {
  const cwd = makeRepo();
  const base = git(cwd, ['rev-parse', 'HEAD']);
  const c = contract(cwd);
  write(cwd, '.git/info/exclude', 'lib/hidden.js\n');
  write(cwd, 'lib/hidden.js', 'export const x = 1;\n');
  write(cwd, 'lib2/.gitignore', '*\n');           // self-ignoring nested .gitignore
  write(cwd, 'lib2/also-hidden.js', 'export const y = 1;\n');
  git(cwd, ['config', 'core.excludesFile', join(cwd, 'tasks', 'none')]);
  write(cwd, 'src/app.js', 'export const a = 2;\n');
  const { ref } = runGates(cwd);
  const r = verify(cwd, ['--contract', c, '--receipt', receipt(cwd, { ref }), '--base', base]);
  const detail = r.report.checks.find((x) => x.id === 'scope').detail;
  assert.equal(statusOf(r.report, 'scope'), 'FAIL');
  assert.match(detail, /lib\/hidden\.js/);
  assert.match(detail, /lib2\/\.gitignore/);
});

check('25. skip-worktree / assume-unchanged edits are still in scope', () => {
  const cwd = makeRepo();
  write(cwd, 'config/settings.js', 'export const s = 1;\n');
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-q', '-m', 'settings']);
  const c = contract(cwd);
  write(cwd, 'config/settings.js', 'export const s = "tampered";\n');
  git(cwd, ['update-index', '--skip-worktree', 'config/settings.js']);
  write(cwd, 'src/app.js', 'export const a = 2;\n');
  const { ref } = runGates(cwd);
  const r = verify(cwd, ['--contract', c, '--receipt', receipt(cwd, { ref })]);
  assert.equal(statusOf(r.report, 'scope'), 'FAIL');
  assert.match(r.report.checks.find((x) => x.id === 'scope').detail, /config\/settings\.js/);
});

check('26. moving an out-of-scope file into scope is visible (no rename folding)', () => {
  const cwd = makeRepo();
  write(cwd, 'config/payments.js', 'export const p = 1;\n');
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-q', '-m', 'payments']);
  const base = git(cwd, ['rev-parse', 'HEAD']);
  git(cwd, ['mv', 'config/payments.js', 'src/payments.js']);
  git(cwd, ['commit', '-q', '-m', 'move']);
  const c = contract(cwd);
  const { ref } = runGates(cwd);
  const r = verify(cwd, ['--contract', c, '--receipt', receipt(cwd, { ref }), '--base', base]);
  assert.equal(statusOf(r.report, 'scope'), 'FAIL');
  assert.match(r.report.checks.find((x) => x.id === 'scope').detail, /config\/payments\.js/);
});

// Regression tests for the Codex gpt-6-astra QA findings (E1-E4).

check('27. E1: --rerun ignores a forged, internally consistent gate-results.json', () => {
  const cwd = makeRepo({ testCommand: 'node -e "process.exit(1)"' });
  write(cwd, 'src/app.js', 'export const a = 2;\n');
  const c = contract(cwd);
  const { ref } = runGates(cwd);
  const forged = JSON.parse(readFileSync(join(cwd, ref), 'utf8'));
  for (const cmd of forged.commands) cmd.exit_code = 0;
  forged.overall = 'PASS';
  writeFileSync(join(cwd, ref), JSON.stringify(forged), 'utf8');
  const rc = receipt(cwd, { ref });
  const r = verify(cwd, ['--contract', c, '--receipt', rc, '--rerun']);
  assert.equal(r.status, 1);
  assert.equal(statusOf(r.report, 'gates'), 'FAIL');
});

check('28. E2: code imported from an ignored folder is part of freshness', () => {
  const cwd = makeRepo();
  write(cwd, '.buildloop-runs/cart.js', 'export const a = 2;\n');
  write(cwd, 'src/app.js', "export { a } from '../.buildloop-runs/cart.js';\n");
  const c = contract(cwd);
  const { ref } = runGates(cwd);
  write(cwd, '.buildloop-runs/cart.js', 'export const a = "broken";\n');
  const r = verify(cwd, ['--contract', c, '--receipt', receipt(cwd, { ref })]);
  assert.equal(statusOf(r.report, 'gates.fresh'), 'FAIL');
});

check('29. E3: gates that rewrite their own inputs fail', () => {
  const cwd = makeRepo({ testCommand: 'node src/selfmod.mjs' });
  write(cwd, 'src/selfmod.mjs', "import { writeFileSync } from 'node:fs';\nwriteFileSync(new URL(import.meta.url), 'export const broken = true;\\n');\n");
  const c = contract(cwd);
  const { status, ref } = runGates(cwd);
  assert.equal(status, 1, 'gate-runner must reject a self-modifying run');
  const results = JSON.parse(readFileSync(join(cwd, ref), 'utf8'));
  assert.equal(results.workspace_mutated_by_gates, true);
  const r = verify(cwd, ['--contract', c, '--receipt', receipt(cwd, { ref, gate: 'FAIL', status: 'NO_GO' })]);
  assert.match(r.report.checks.find((x) => x.id === 'gates').detail, /modified the workspace/);
});

check('30. E4: skipped test gate fails; rule-file edits need a human approver', () => {
  const cwd = makeRepo({ testCommand: 'n/a', lint: 'node -e "process.exit(0)"' });
  write(cwd, 'src/app.js', 'export const a = 2;\n');
  let c = contract(cwd, { allowed: ['src/**', '.buildloop.yml'] });
  write(cwd, '.buildloop.yml', readFileSync(join(cwd, '.buildloop.yml'), 'utf8') + '# loosened\n');
  let { ref } = runGates(cwd);
  let r = verify(cwd, ['--contract', c, '--receipt', receipt(cwd, { ref })]);
  assert.match(r.report.checks.find((x) => x.id === 'gates').detail, /no test gate ran/);
  assert.equal(statusOf(r.report, 'governance'), 'FAIL');
  c = contract(cwd, { allowed: ['src/**', '.buildloop.yml'], extra: 'approved_by: "founder@example.com"' });
  r = verify(cwd, ['--contract', c, '--receipt', receipt(cwd, { ref })]);
  assert.equal(statusOf(r.report, 'governance'), 'PASS');
});

check('31. editing an existing committed contract counts as a rule change', () => {
  const cwd = makeRepo();
  const c = contract(cwd);
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-q', '-m', 'contract']);
  contract(cwd, { allowed: ['src/**', 'infra/**'] });
  write(cwd, 'src/app.js', 'export const a = 2;\n');
  const { ref } = runGates(cwd);
  const r = verify(cwd, ['--contract', c, '--receipt', receipt(cwd, { ref })]);
  assert.equal(statusOf(r.report, 'governance'), 'FAIL');
});

check('32. a markdown file dressed as a receipt is not exempt from freshness', () => {
  const cwd = makeRepo();
  write(cwd, 'src/prices.md', '---\ntype: evidence-receipt\n---\nprice: 10\n');
  const c = contract(cwd);
  const { ref } = runGates(cwd);
  write(cwd, 'src/prices.md', '---\ntype: evidence-receipt\n---\nprice: 0\n');
  const r = verify(cwd, ['--contract', c, '--receipt', receipt(cwd, { ref })]);
  assert.equal(statusOf(r.report, 'gates.fresh'), 'FAIL');
  assert.match(r.report.checks.find((x) => x.id === 'gates.fresh').detail, /src\/prices\.md/);
});

check('33. ignored output written by the gates is not stale evidence', () => {
  // The test gate writes an ignored file and a nested project's run folder.
  const cwd = makeRepo({ testCommand: "node -e \"require('fs').mkdirSync('pkg/.buildloop-runs/r1',{recursive:true});require('fs').writeFileSync('pkg/.buildloop-runs/r1/gate-results.json','{}');require('fs').writeFileSync('.buildloop/out.txt','x')\"" });
  mkdirSync(join(cwd, '.buildloop'), { recursive: true });
  write(cwd, '.gitignore', '.buildloop/\n.buildloop-runs/\n');
  write(cwd, 'src/app.js', 'export const a = 2;\n');
  const c = contract(cwd);
  const { status, ref } = runGates(cwd);
  assert.equal(status, 0, 'ignored test output is not a workspace mutation');
  const r = verify(cwd, ['--contract', c, '--receipt', receipt(cwd, { ref })]);
  assert.equal(statusOf(r.report, 'gates.fresh'), 'PASS', JSON.stringify(r.report.checks));
});

check('34. --rerun never executes gates from an unapproved .buildloop.yml change', () => {
  const cwd = makeRepo();
  const c = contract(cwd, { allowed: ['src/**', '.buildloop.yml'] });
  const yml = readFileSync(join(cwd, '.buildloop.yml'), 'utf8')
    .replace(/test: ".*"/, `test: "node -e \\"require('fs').writeFileSync('PWNED','1')\\""`);
  write(cwd, '.buildloop.yml', yml);
  write(cwd, 'src/app.js', 'export const a = 2;\n');
  const rc = receipt(cwd, { ref: 'none' });
  const r = verify(cwd, ['--contract', c, '--receipt', rc, '--rerun']);
  assert.equal(statusOf(r.report, 'governance'), 'FAIL');
  assert.match(r.report.checks.find((x) => x.id === 'gates').detail, /not run/);
  assert.ok(!existsSync(join(cwd, 'PWNED')), 'gate command must not have executed');
});

check('35. inline YAML lists parse as lists, quoted brackets stay placeholders', () => {
  const cwd = makeRepo();
  write(cwd, 'tasks/inline.md', '---\ntype: slice-contract\nstory: "US-9: inline"\nallowed_files: [src/app.js, "src/b.js"]\nblast_radius: LOW\nrollback: "git restore -- src"\ndepends_on: []\nevidence_required: [node test]\n---\n');
  write(cwd, 'src/app.js', 'export const a = 2;\n');
  const { ref } = runGates(cwd);
  const r = verify(cwd, ['--contract', 'tasks/inline.md', '--receipt', receipt(cwd, { ref })]);
  assert.equal(statusOf(r.report, 'contract'), 'PASS', JSON.stringify(r.report.checks));
  assert.equal(statusOf(r.report, 'scope'), 'PASS');
});

check('36. force-committed files under .buildloop/ are still in scope', () => {
  const cwd = makeRepo();
  const base = git(cwd, ['rev-parse', 'HEAD']);
  write(cwd, '.buildloop/payload.js', 'export const p = 1;\n');
  git(cwd, ['add', '-f', '.buildloop/payload.js']);
  git(cwd, ['commit', '-q', '-m', 'hidden']);
  const c = contract(cwd);
  write(cwd, 'src/app.js', 'export const a = 2;\n');
  const { ref } = runGates(cwd);
  const r = verify(cwd, ['--contract', c, '--receipt', receipt(cwd, { ref }), '--base', base]);
  assert.equal(statusOf(r.report, 'scope'), 'FAIL');
  assert.match(r.report.checks.find((x) => x.id === 'scope').detail, /\.buildloop\/payload\.js/);
});

for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
