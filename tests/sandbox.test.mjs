#!/usr/bin/env node

/**
 * tests/sandbox.test.mjs
 *
 * Test harness for scripts/sandbox-run.mjs (Phase 8).
 * All Docker interaction is mocked via dependency injection.
 * No real Docker required. Fully safe for CI.
 *
 * 20 test scenarios per BUILD_SPEC Phase 8:
 *   1.  Schema parses as JSON
 *   2.  Valid minimal config passes
 *   3.  Invalid network mode fails
 *   4.  Dry-run works without Docker
 *   5.  Docker unavailable handled cleanly
 *   6.  Offline mode emits no network
 *   7.  Allowlist mode requires explicit allowlist
 *   8.  Full mode requires explicit approval flag
 *   9.  .env* mount blocked
 *  10.  ~/.ssh mount blocked
 *  11.  ~/.aws mount blocked
 *  12.  ~/.config mount blocked
 *  13.  /var/run/docker.sock mount blocked
 *  14.  Path traversal blocked
 *  15.  Logs resolve only under .buildloop-runs/
 *  16.  Windows path normalization
 *  17.  WSL path translation
 *  18.  Command args preserve spaces/quotes
 *  19.  No shell interpolation by default
 *  20.  Exported functions do not call process.exit()
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadSchema,
  validateConfig,
  checkMountSecurity,
  checkPathTraversal,
  validateLogDir,
  normalizeWindowsPath,
  windowsToWslPath,
  checkDockerAvailable,
  buildDockerCommand,
  runSandbox,
} from '../scripts/sandbox-run.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

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

function mockExec(overrides = {}) {
  return (cmd, args, opts) => {
    if (overrides[cmd]) {
      const entry = overrides[cmd];
      if (typeof entry === 'function') return entry(cmd, args, opts);
      return { status: entry.status ?? 0, stdout: entry.stdout ?? '', stderr: entry.stderr ?? '', error: entry.error ?? null };
    }
    return { status: 1, stdout: '', stderr: `${cmd}: not found`, error: new Error(`${cmd}: not found`) };
  };
}

function mockDockerAvailable() {
  return mockExec({ docker: { status: 0, stdout: 'Docker version 24.0.7, build abc', stderr: '', error: null } });
}

function mockDockerUnavailable() {
  return mockExec({ docker: { status: 1, stdout: '', stderr: 'docker: not found', error: new Error('ENOENT') } });
}

// Minimal valid config
function minimalConfig() {
  return { command: ['npm', 'test'] };
}

// ---------------------------------------------------------------------------
// Test 1: Schema parses as JSON
// ---------------------------------------------------------------------------

check('1. schema parses as JSON', () => {
  const raw = readFileSync(join(ROOT, 'schemas', 'sandbox-config.schema.json'), 'utf8');
  const schema = JSON.parse(raw);
  assert.equal(schema.$schema, 'http://json-schema.org/draft-07/schema#');
  assert.equal(schema.title, 'BuildloopSandboxConfig');
  assert.equal(schema.additionalProperties, false);
  assert.ok(schema.properties.network_mode);
  assert.deepStrictEqual(schema.properties.network_mode.enum, ['offline', 'allowlist', 'full']);
});

// ---------------------------------------------------------------------------
// Test 2: Valid minimal config passes
// ---------------------------------------------------------------------------

check('2. valid minimal config passes validation', () => {
  const result = validateConfig(minimalConfig());
  assert.equal(result.valid, true, `Expected valid, got errors: ${result.errors.join(', ')}`);
  assert.equal(result.errors.length, 0);
});

// ---------------------------------------------------------------------------
// Test 3: Invalid network mode fails
// ---------------------------------------------------------------------------

check('3. invalid network mode fails validation', () => {
  const config = { command: ['echo'], network_mode: 'yolo' };
  const result = validateConfig(config);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('network_mode')));
});

// ---------------------------------------------------------------------------
// Test 4: Dry-run works without Docker
// ---------------------------------------------------------------------------

check('4. dry-run works without Docker installed', () => {
  const config = minimalConfig();
  const result = runSandbox(config, {
    cwd: ROOT,
    dryRun: true,
    exec: mockDockerUnavailable(),
  });
  assert.equal(result.success, true, `Dry-run should succeed: ${result.errors.join(', ')}`);
  assert.equal(result.dryRun, true);
  assert.ok(result.output.includes('docker'), 'Dry-run should print docker command');
});

// ---------------------------------------------------------------------------
// Test 5: Docker unavailable handled cleanly
// ---------------------------------------------------------------------------

check('5. Docker unavailable handled cleanly (no crash)', () => {
  const config = minimalConfig();
  const result = runSandbox(config, {
    cwd: ROOT,
    dryRun: false,
    exec: mockDockerUnavailable(),
  });
  assert.equal(result.success, false);
  assert.ok(result.errors.length > 0);
  assert.ok(result.errors[0].includes('not available'), `Expected informational error, got: ${result.errors[0]}`);
});

// ---------------------------------------------------------------------------
// Test 6: Offline mode emits no network
// ---------------------------------------------------------------------------

check('6. offline mode emits --network none', () => {
  const config = { ...minimalConfig(), network_mode: 'offline' };
  const plan = buildDockerCommand(config, ROOT);
  assert.ok(plan.args.includes('--network'));
  const netIdx = plan.args.indexOf('--network');
  assert.equal(plan.args[netIdx + 1], 'none');
});

// ---------------------------------------------------------------------------
// Test 7: Allowlist mode requires explicit allowlist
// ---------------------------------------------------------------------------

check('7. allowlist mode requires non-empty network_allowlist', () => {
  const config = { command: ['npm', 'install'], network_mode: 'allowlist' };
  const result = validateConfig(config);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('allowlist')));

  // Allowlist is not enforced by Docker, so it also needs full-network approval.
  const unapproved = { command: ['npm', 'install'], network_mode: 'allowlist', network_allowlist: ['registry.npmjs.org'] };
  const unapprovedResult = validateConfig(unapproved);
  assert.equal(unapprovedResult.valid, false);
  assert.ok(unapprovedResult.errors.some(e => e.includes('NOT enforced')));

  const validConfig = { ...unapproved, full_network_approved: true };
  const validResult = validateConfig(validConfig);
  assert.equal(validResult.valid, true, `Expected valid: ${validResult.errors.join(', ')}`);
});

// ---------------------------------------------------------------------------
// Test 8: Full mode requires explicit approval
// ---------------------------------------------------------------------------

check('8. full mode requires full_network_approved: true', () => {
  const config = { command: ['echo'], network_mode: 'full' };
  const result = validateConfig(config);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('full_network_approved')));

  const approved = { command: ['echo'], network_mode: 'full', full_network_approved: true };
  const validResult = validateConfig(approved);
  assert.equal(validResult.valid, true, `Expected valid: ${validResult.errors.join(', ')}`);
});

// ---------------------------------------------------------------------------
// Test 9: .env* mount blocked
// ---------------------------------------------------------------------------

check('9. .env* mount blocked', () => {
  const cases = ['.env', '.env.local', '.env.production', 'subdir/.env'];
  for (const p of cases) {
    const result = checkMountSecurity(p);
    assert.equal(result.blocked, true, `Expected ${p} to be blocked`);
  }
});

// ---------------------------------------------------------------------------
// Test 10: ~/.ssh mount blocked
// ---------------------------------------------------------------------------

check('10. ~/.ssh mount blocked', () => {
  const result = checkMountSecurity('/repo/profile/.ssh', '/repo/profile');
  assert.equal(result.blocked, true, 'Expected ~/.ssh to be blocked');

  const result2 = checkMountSecurity('/repo/profile/.ssh/id_rsa', '/repo/profile');
  assert.equal(result2.blocked, true, 'Expected ~/.ssh/id_rsa to be blocked');
});

// ---------------------------------------------------------------------------
// Test 11: ~/.aws mount blocked
// ---------------------------------------------------------------------------

check('11. ~/.aws mount blocked', () => {
  const result = checkMountSecurity('/repo/profile/.aws', '/repo/profile');
  assert.equal(result.blocked, true, 'Expected ~/.aws to be blocked');

  const result2 = checkMountSecurity('/repo/profile/.aws/credentials', '/repo/profile');
  assert.equal(result2.blocked, true, 'Expected ~/.aws/credentials to be blocked');
});

// ---------------------------------------------------------------------------
// Test 12: ~/.config mount blocked
// ---------------------------------------------------------------------------

check('12. ~/.config mount blocked', () => {
  const result = checkMountSecurity('/repo/profile/.config', '/repo/profile');
  assert.equal(result.blocked, true, 'Expected ~/.config to be blocked');
});

// ---------------------------------------------------------------------------
// Test 13: /var/run/docker.sock mount blocked
// ---------------------------------------------------------------------------

check('13. /var/run/docker.sock mount blocked', () => {
  const result = checkMountSecurity('/var/run/docker.sock');
  assert.equal(result.blocked, true, 'Expected docker.sock to be blocked');
});

// ---------------------------------------------------------------------------
// Test 14: Path traversal blocked
// ---------------------------------------------------------------------------

check('14. path traversal blocked', () => {
  const projectCwd = '/repo/project';
  const cases = ['../../etc/passwd', '../../../root', '../../.ssh/id_rsa', '../project-evil/file'];
  for (const p of cases) {
    const result = checkPathTraversal(p, projectCwd);
    assert.equal(result.safe, false, `Expected ${p} to be blocked as traversal`);
  }

  // Valid relative path should pass
  const valid = checkPathTraversal('src/index.js', projectCwd);
  assert.equal(valid.safe, true, 'Expected src/index.js to be safe');
});

// ---------------------------------------------------------------------------
// Test 15: Logs resolve only under .buildloop-runs/
// ---------------------------------------------------------------------------

check('15. logs resolve only under .buildloop-runs/', () => {
  const cwd = '/repo/project';
  const valid = validateLogDir('.buildloop-runs', cwd);
  assert.equal(valid.valid, true, `Expected .buildloop-runs to be valid: ${valid.reason}`);

  const subdir = validateLogDir('.buildloop-runs/2026-01-01', cwd);
  assert.equal(subdir.valid, true, `Expected .buildloop-runs/subdir to be valid: ${subdir.reason}`);

  const invalid = validateLogDir('logs', cwd);
  assert.equal(invalid.valid, false, 'Expected logs/ to be rejected');

  const escape = validateLogDir('../other-project/logs', cwd);
  assert.equal(escape.valid, false, 'Expected traversal log dir to be rejected');

  const prefixEscape = validateLogDir('.buildloop-runs-evil', cwd);
  assert.equal(prefixEscape.valid, false, 'Expected .buildloop-runs-evil prefix trick to be rejected');
});

// ---------------------------------------------------------------------------
// Test 15b: Absolute mounts must stay under project root
// ---------------------------------------------------------------------------

check('15b. absolute bind mounts outside project root are blocked', () => {
  const config = {
    command: ['echo', 'ok'],
    mounts: [{ host_path: '/repo/other/file.txt', container_path: '/mnt/file.txt', readonly: true }],
  };
  const plan = buildDockerCommand(config, '/repo/project');
  assert.ok(plan.errors.some(e => e.includes('Path escapes project directory')), `Expected escape error: ${plan.errors.join(', ')}`);

  const valid = {
    command: ['echo', 'ok'],
    mounts: [{ host_path: '/repo/project/fixtures/file.txt', container_path: '/mnt/file.txt', readonly: true }],
  };
  const validPlan = buildDockerCommand(valid, '/repo/project');
  assert.equal(validPlan.errors.length, 0, `Expected in-project absolute mount to pass: ${validPlan.errors.join(', ')}`);
});

// ---------------------------------------------------------------------------
// Test 15c: Secret-looking env keys are blocked
// ---------------------------------------------------------------------------

check('15c. secret-looking env keys are blocked', () => {
  const result = validateConfig({ command: ['echo'], env: { OPENAI_API_KEY: 'sk-test' } });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('looks secret-bearing')));

  const safe = validateConfig({ command: ['echo'], env: { NODE_ENV: 'test' } });
  assert.equal(safe.valid, true, `Expected safe env to pass: ${safe.errors.join(', ')}`);
});

// ---------------------------------------------------------------------------
// Test 16: Windows path normalization
// ---------------------------------------------------------------------------

check('16. Windows path normalization', () => {
  assert.equal(normalizeWindowsPath('C:\\repo\\project'), 'c:/repo/project');
  assert.equal(normalizeWindowsPath('D:\\Work\\repo'), 'd:/Work/repo');
  assert.equal(normalizeWindowsPath('/unix/path'), '/unix/path');
  assert.equal(normalizeWindowsPath(''), '');
});

// ---------------------------------------------------------------------------
// Test 17: WSL path translation
// ---------------------------------------------------------------------------

check('17. WSL path translation', () => {
  assert.equal(windowsToWslPath('C:\\repo\\project'), '/mnt/c/repo/project');
  assert.equal(windowsToWslPath('D:\\Work\\repo'), '/mnt/d/Work/repo');
  assert.equal(windowsToWslPath('/unix/path'), '/unix/path');
  assert.equal(windowsToWslPath(''), '');
});

// ---------------------------------------------------------------------------
// Test 18: Command args preserve spaces/quotes
// ---------------------------------------------------------------------------

check('18. command args preserve spaces/quotes', () => {
  const config = { command: ['echo', 'hello world', 'it\'s "fine"'] };
  const plan = buildDockerCommand(config, '/tmp/project');
  // Command args should be passed as separate array elements (no shell join)
  const cmdIdx = plan.args.indexOf('node:22-slim');
  assert.ok(cmdIdx >= 0, 'Image should be in args');
  // Args after image should be the command exactly as given
  const commandArgs = plan.args.slice(cmdIdx + 1);
  assert.deepStrictEqual(commandArgs, ['echo', 'hello world', 'it\'s "fine"']);
});

// ---------------------------------------------------------------------------
// Test 19: No shell interpolation by default
// ---------------------------------------------------------------------------

check('19. no shell interpolation by default', () => {
  const config = { command: ['echo', '$HOME', '$(whoami)', '`id`'] };
  const plan = buildDockerCommand(config, '/tmp/project');
  const cmdIdx = plan.args.indexOf('node:22-slim');
  const commandArgs = plan.args.slice(cmdIdx + 1);
  // Arguments should be literal, not shell-expanded
  assert.deepStrictEqual(commandArgs, ['echo', '$HOME', '$(whoami)', '`id`']);
  // No -c or /bin/sh in args (which would enable interpolation)
  assert.ok(!plan.args.includes('/bin/sh'), 'Should not use shell');
  assert.ok(!plan.args.includes('-c'), 'Should not use -c flag');
});

// ---------------------------------------------------------------------------
// Test 20: Exported functions do not call process.exit()
// ---------------------------------------------------------------------------

check('20. exported functions do not call process.exit()', () => {
  const source = readFileSync(join(ROOT, 'scripts', 'sandbox-run.mjs'), 'utf8');

  // Extract exported function bodies - they should not contain process.exit
  // The CLI wrapper (cli function) IS allowed to set process.exitCode, but
  // exported functions must not call process.exit().
  const exportedFns = [
    'loadSchema', 'validateConfig', 'checkMountSecurity', 'checkPathTraversal',
    'validateLogDir', 'normalizeWindowsPath', 'windowsToWslPath',
    'checkDockerAvailable', 'buildDockerCommand', 'runSandbox',
  ];

  // Check that process.exit( does not appear before the CLI wrapper
  const cliMarker = 'function cli()';
  const cliIdx = source.indexOf(cliMarker);
  assert.ok(cliIdx > 0, 'Should have a cli() function');

  const exportedSection = source.slice(0, cliIdx);
  const exitCalls = exportedSection.match(/process\.exit\s*\(/g);
  assert.equal(exitCalls, null, `Exported functions must not call process.exit(). Found: ${exitCalls}`);

  // Verify all expected functions are exported
  for (const fn of exportedFns) {
    assert.ok(source.includes(`export function ${fn}`), `Missing export: ${fn}`);
  }
});

// ---------------------------------------------------------------------------
// Bonus: buildDockerCommand integration with full config
// ---------------------------------------------------------------------------

check('bonus: full config produces correct Docker command plan', () => {
  const config = {
    command: ['npm', 'test'],
    image: 'node:20-alpine',
    network_mode: 'offline',
    timeout_seconds: 600,
    cwd: '.',
    log_dir: '.buildloop-runs',
    cache_mounts: [{ name: 'npm-cache', container_path: '/root/.npm' }],
    env: { NODE_ENV: 'test' },
  };
  const plan = buildDockerCommand(config, '/tmp/test-project');
  assert.equal(plan.errors.length, 0, `Unexpected errors: ${plan.errors.join(', ')}`);
  assert.ok(plan.args.includes('--network'));
  assert.ok(plan.args.includes('none'));
  assert.ok(plan.args.includes('node:20-alpine'));
  assert.ok(plan.args.includes('npm'));
  assert.ok(plan.args.includes('test'));
});

// ---------------------------------------------------------------------------
// Bonus: checkDockerAvailable with mock
// ---------------------------------------------------------------------------

check('bonus: checkDockerAvailable with mock', () => {
  const available = checkDockerAvailable({ exec: mockDockerAvailable() });
  assert.equal(available.available, true);
  assert.equal(available.version, '24.0.7');
  assert.equal(available.error, '');

  const unavailable = checkDockerAvailable({ exec: mockDockerUnavailable() });
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.version, null);
  assert.ok(unavailable.error.length > 0);
});

// ---------------------------------------------------------------------------
// Bonus: real execution passes configured timeout and reports spawn errors
// ---------------------------------------------------------------------------

check('bonus: runSandbox enforces timeout and reports spawn errors', () => {
  const calls = [];
  const exec = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (args[0] === '--version') {
      return { status: 0, stdout: 'Docker version 24.0.7, build abc', stderr: '', error: null };
    }
    return { status: null, stdout: '', stderr: '', error: new Error('spawn failed') };
  };

  const result = runSandbox({ command: ['npm', 'test'], timeout_seconds: 7 }, {
    cwd: ROOT,
    dryRun: false,
    exec,
  });

  assert.equal(result.success, false);
  assert.ok(result.errors.some(e => e.includes('spawn failed')), `Expected spawn error: ${result.errors.join(', ')}`);
  const runCall = calls.find(call => call.args[0] === 'run');
  assert.ok(runCall, 'Expected docker run call');
  assert.equal(runCall.opts.timeout, 7000);
});

// ---------------------------------------------------------------------------
// Test 26-29: host-escape vectors found in adversarial review
// ---------------------------------------------------------------------------

check('26. option-like or malformed image references are rejected', () => {
  for (const image of ['--privileged', '-v/:/host', 'node:22 --privileged', 'UPPER/case']) {
    const result = validateConfig({ command: ['true'], image });
    assert.equal(result.valid, false, `image ${image} should be rejected`);
    const plan = buildDockerCommand({ command: ['true'], image }, ROOT);
    assert.ok(plan.errors.length > 0, `buildDockerCommand should refuse ${image}`);
  }
  assert.equal(validateConfig({ command: ['true'], image: 'ghcr.io/org/app:1.2.3' }).valid, true);
});

check('27. cache volume names cannot become host bind mounts', () => {
  for (const name of ['/var/run/docker.sock', '../etc', 'C:\Windows', '-v']) {
    const config = { command: ['true'], cache_mounts: [{ name, container_path: '/cache' }] };
    assert.equal(validateConfig(config).valid, false, `cache name ${name} should be rejected`);
    assert.ok(buildDockerCommand(config, ROOT).errors.length > 0, `buildDockerCommand should refuse ${name}`);
  }
  const ok = { command: ['true'], cache_mounts: [{ name: 'npm-cache', container_path: '/root/.npm' }] };
  assert.equal(validateConfig(ok).valid, true);
});

check('28. docker run drops capabilities and protects .git', () => {
  const plan = buildDockerCommand({ command: ['npm', 'test'] }, ROOT, { pathTranslator: (p) => p });
  const joined = plan.args.join(' ');
  assert.ok(joined.includes('--cap-drop ALL'));
  assert.ok(joined.includes('--security-opt no-new-privileges'));
  assert.ok(joined.includes('--pids-limit'));
  assert.ok(plan.args.includes('--name') && plan.containerName);
  assert.ok(plan.args.some(a => a.endsWith(':/workspace/.git:ro')), 'repo .git must be mounted read-only');
});

check('29. timed-out docker client triggers explicit container removal', () => {
  const calls = [];
  const exec = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (args[0] === '--version') return { status: 0, stdout: 'Docker version 27', stderr: '' };
    if (args[0] === 'run') return { status: null, stdout: '', stderr: '', error: new Error('ETIMEDOUT') };
    return { status: 0, stdout: '', stderr: '' };
  };
  runSandbox({ command: ['sleep', '999'], timeout_seconds: 1 }, { cwd: ROOT, dryRun: false, exec });
  const rm = calls.find(c => c.args[0] === 'rm');
  assert.ok(rm, 'expected docker rm -f after timeout');
  assert.deepEqual(rm.args.slice(0, 2), ['rm', '-f']);
});

check('30. nested .env files are shadowed, dependency folders are skipped', () => {
  const root = mkdtempSync(join(tmpdir(), 'bl-sbx-'));
  mkdirSync(join(root, 'apps', 'web'), { recursive: true });
  mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(root, '.env'), 'A=1');
  writeFileSync(join(root, 'apps', 'web', '.env.local'), 'B=2');
  writeFileSync(join(root, 'node_modules', 'pkg', '.env'), 'C=3');
  const plan = buildDockerCommand({ command: ['true'] }, root, { pathTranslator: (p) => p });
  const mounts = plan.args.filter((a) => a.startsWith('/dev/null:'));
  rmSync(root, { recursive: true, force: true });
  // tmpfs cannot target a file; /dev/null bind mounts can.
  assert.ok(!plan.args.some((a) => a.startsWith('type=tmpfs')), 'no tmpfs mounts over files');
  assert.ok(mounts.includes('/dev/null:/workspace/.env:ro'));
  assert.ok(mounts.includes('/dev/null:/workspace/apps/web/.env.local:ro'));
  assert.ok(!mounts.some((m) => m.includes('node_modules')));
});

// ---------------------------------------------------------------------------
// Cleanup and report
// ---------------------------------------------------------------------------

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);

if (failed > 0) {
  process.exitCode = 1;
}
