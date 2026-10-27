#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { detect } from './detect-capabilities.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GATE_RUNNER = join(__dirname, 'gate-runner.mjs');
const VALIDATE_MANIFEST = join(__dirname, 'validate-manifest.mjs');
const DETECT_CAPABILITIES = join(__dirname, 'detect-capabilities.mjs');
const VERIFY = join(__dirname, 'verify.mjs');
const LEARN = join(__dirname, 'learn.mjs');
const INIT = join(__dirname, 'init.mjs');
const RECEIPT = join(__dirname, 'receipt.mjs');
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/;

function extractFlag(args, flag) {
  const idx = args.indexOf(flag);
  return idx === -1 || idx + 1 >= args.length ? null : args[idx + 1];
}

function hasFlag(args, flag) {
  return args.includes(flag);
}

function cmdCapabilities(args, cwd) {
  let result;
  try {
    result = detect({ cwd });
  } catch (err) {
    console.error(`buildloop capabilities: detection failed: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  if (!hasFlag(args, '--write')) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const r = spawnSync(process.execPath, [DETECT_CAPABILITIES, '--cwd', cwd, '--write'], {
    stdio: 'inherit',
    encoding: 'utf8',
  });
  if (r.error) {
    console.error(`buildloop capabilities --write: spawn failed: ${r.error.message}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = r.status ?? 1;
}

function cmdDoctor(args, cwd) {
  let result;
  try {
    result = detect({ cwd });
  } catch (err) {
    console.error(`buildloop doctor: detection failed: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  if (hasFlag(args, '--json')) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const yesNo = (value) => (value ? 'yes' : 'no');
  const maybe = (value) => (value === null || value === undefined ? 'unknown' : String(value));
  const lines = [
    'buildloop doctor - repo health check',
    '',
    'Environment',
    `  Node:     ${result.environment.node_version}`,
    `  OS:       ${result.environment.os}`,
    `  Shell:    ${result.environment.shell}`,
    `  Package:  ${result.environment.package_manager}`,
    '',
    'Git',
    `  Available:  ${yesNo(result.git.available)}`,
    `  Branch:     ${maybe(result.git.branch)}`,
    `  Clean:      ${result.git.clean === null ? 'unknown' : yesNo(result.git.clean)}`,
    `  Remote:     ${result.git.has_remote === null ? 'unknown' : yesNo(result.git.has_remote)}`,
    '',
    'Docker',
    `  Available:  ${yesNo(result.docker.available)}`,
    ...(result.docker.available ? [`  Version:    ${maybe(result.docker.version)}`] : []),
    '',
    'Governance',
    `  .buildloop.yml:     ${yesNo(result.buildloop.yml_present)}`,
    `  Manifest:           ${yesNo(result.buildloop.manifest_present)}`,
    `  Gate runner:        ${yesNo(result.buildloop.gate_runner_available)}`,
    `  CI workflows:       ${result.buildloop.ci_workflows.length ? result.buildloop.ci_workflows.join(', ') : 'none'}`,
    '',
    `Obsidian:   ${result.obsidian.configured ? `configured (${maybe(result.obsidian.vault_path)})` : 'not configured'}`,
    `Graphify:   ${result.graphify.available ? 'available' : 'not available'}`,
    '',
    `Recommendation: ${result.recommended_action}`,
  ];
  console.log(lines.join('\n'));
}

function cmdManifest(cwd) {
  const r = spawnSync(process.execPath, [VALIDATE_MANIFEST], {
    stdio: 'inherit',
    cwd,
    encoding: 'utf8',
  });
  if (r.error) {
    console.error(`buildloop manifest: spawn failed: ${r.error.message}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = r.status ?? 1;
}

function cmdGates(args, cwd) {
  const childArgs = [GATE_RUNNER];
  const config = extractFlag(args, '--config');
  if (config) childArgs.push('--config', config);

  const r = spawnSync(process.execPath, childArgs, {
    stdio: 'inherit',
    cwd,
    encoding: 'utf8',
  });
  if (r.error) {
    console.error(`buildloop gates: spawn failed: ${r.error.message}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = r.status ?? 1;
}

/** Relay to a child script with the same flags; the child owns validation and exit codes. */
function cmdDelegate(name, script, args, cwd) {
  const childArgs = args.slice(1).filter((arg, i, all) => arg !== '--cwd' && all[i - 1] !== '--cwd');
  const r = spawnSync(process.execPath, [script, ...childArgs, '--cwd', cwd], {
    stdio: 'inherit',
    cwd,
    encoding: 'utf8',
  });
  if (r.error) {
    console.error(`buildloop ${name}: spawn failed: ${r.error.message}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = r.status ?? 1;
}

function findResultInDirs(dirs) {
  for (const dir of dirs) {
    const candidate = join(dir, 'gate-results.json');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function resolveResultsPath(args, cwd) {
  const explicit = extractFlag(args, '--results');
  if (explicit) {
    const p = isAbsolute(explicit) ? explicit : resolve(cwd, explicit);
    if (existsSync(p)) return p;
    console.error(`buildloop review: --results path not found: ${p}`);
    return null;
  }

  const direct = join(cwd, 'gate-results.json');
  if (existsSync(direct)) return direct;

  const runsDir = join(cwd, '.buildloop-runs');
  if (!existsSync(runsDir)) return null;

  let entries;
  try {
    entries = readdirSync(runsDir);
  } catch {
    return null;
  }

  const timestampDirs = [];
  const otherDirs = [];
  for (const entry of entries) {
    const abs = join(runsDir, entry);
    try {
      if (!statSync(abs).isDirectory()) continue;
      if (TIMESTAMP_RE.test(entry)) timestampDirs.push(abs);
      else otherDirs.push(abs);
    } catch {
      // Ignore unreadable run entries.
    }
  }

  timestampDirs.sort((a, b) => b.localeCompare(a));
  const byTimestamp = findResultInDirs(timestampDirs);
  if (byTimestamp) return byTimestamp;

  otherDirs.sort((a, b) => {
    try {
      return statSync(b).mtimeMs - statSync(a).mtimeMs;
    } catch {
      return 0;
    }
  });
  return findResultInDirs(otherDirs);
}

function cmdReview(args, cwd) {
  const resultsPath = resolveResultsPath(args, cwd);
  if (!resultsPath) {
    console.error('buildloop review: no gate-results.json found.');
    console.error('  Run `buildloop gates` first to generate results.');
    process.exitCode = 1;
    return;
  }

  let gateResults;
  try {
    gateResults = JSON.parse(readFileSync(resultsPath, 'utf8'));
  } catch (err) {
    console.error(`buildloop review: failed to parse ${resultsPath}: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  const overall = gateResults.overall ?? 'UNKNOWN';
  const commands = Array.isArray(gateResults.commands) ? gateResults.commands : [];
  const violations = Array.isArray(gateResults.protected_paths_violated)
    ? gateResults.protected_paths_violated
    : [];

  console.log('buildloop review - gate results');
  console.log(`  file:    ${resultsPath}`);
  console.log(`  run_id:  ${gateResults.run_id ?? 'unknown'}`);
  console.log(`  overall: ${overall}`);
  console.log('');
  for (const cmd of commands) {
    const status = cmd.exit_code === 0 ? 'PASS' : 'FAIL';
    console.log(`  ${status}  ${cmd.name}: ${cmd.command}`);
  }
  if (violations.length > 0) {
    console.log('');
    console.log('  Protected path violations:');
    for (const violation of violations) console.log(`    ${violation}`);
  }
  process.exitCode = overall === 'PASS' ? 0 : 1;
}

function cmdHelp() {
  console.log([
    'buildloop - supervised headless CLI (no deploy, no auto-fix)',
    '',
    'Usage: node scripts/buildloop.mjs <command> [flags]',
    '',
    'Commands:',
    '  init           Write .buildloop.yml from detected project scripts. Flags: [--force] [--dry-run]',
    '  capabilities   Detect repo capabilities. Flags: --cwd <path> --write',
    '  doctor         Human-readable health report. Flags: --cwd <path> --json',
    '  manifest       Validate orchestrator manifest. Flags: --cwd <path>',
    '  gates          Run quality gates. Flags: --cwd <path> --config <path>',
    '  review         Review gate-results.json. Flags: --cwd <path> --results <path>',
    '  receipt        Generate an evidence receipt from gate results. Flags: --out <path> [--results <path>] [--force]',
    '  verify         Definition of Done check for one slice (scope, gates, freshness, receipt).',
    '                 Flags: --contract <path> --receipt <path> [--rerun] [--base <ref>] [--results <path>] [--ci] [--json]',
    '  learn          Measured scorecard + promotion candidates from the DoD ledger.',
    '                 Flags: [--threshold N] [--min-first-pass PCT] [--json]',
    '  help           Print this message',
    '',
    'Exit codes: 0=success/PASS, 1=failure/error, 2=invalid arguments',
    'No autonomous commands. No deploy. No auto-fix. Supervised-only.',
    'Writes only evidence (.buildloop-runs/, .buildloop/), plus files you name: init (.buildloop.yml), receipt (--out).',
  ].join('\n'));
}

function cmdUnknown(command) {
  console.error(command ? `buildloop: unknown command: ${command}` : 'buildloop: no command given');
  console.error('');
  cmdHelp();
  process.exitCode = 2;
}

function main() {
  const args = process.argv.slice(2);
  const cwd = resolve(extractFlag(args, '--cwd') || process.cwd());
  switch (args[0]) {
    case 'capabilities': return cmdCapabilities(args, cwd);
    case 'doctor': return cmdDoctor(args, cwd);
    case 'manifest': return cmdManifest(cwd);
    case 'gates': return cmdGates(args, cwd);
    case 'review': return cmdReview(args, cwd);
    case 'init': return cmdDelegate('init', INIT, args, cwd);
    case 'receipt': return cmdDelegate('receipt', RECEIPT, args, cwd);
    case 'verify': return cmdDelegate('verify', VERIFY, args, cwd);
    case 'learn': return cmdDelegate('learn', LEARN, args, cwd);
    case 'help':
    case '--help':
    case '-h': return cmdHelp();
    default: return cmdUnknown(args[0]);
  }
}

const isMain = process.argv[1] && (
  resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'))
  || process.argv[1] === new URL(import.meta.url).pathname
);
if (isMain) main();
