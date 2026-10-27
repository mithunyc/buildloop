#!/usr/bin/env node

/**
 * sandbox-run.mjs
 *
 * Isolated Docker sandbox runner for untrusted operations.
 * Docker is optional for normal mode; required only for L4.
 *
 * Design constraints (BUILD_SPEC Phase 8):
 *   - Zero external dependencies. Node built-ins only.
 *   - Export testable functions; CLI wrapper sets exit code at end only.
 *   - All process execution through injected exec/spawn for tests.
 *   - Default mode: dry-run (safely non-destructive).
 *   - Default network: offline.
 *   - Exported functions never terminate the process directly.
 *   - Logs write only under .buildloop-runs/.
 *   - All paths resolve under target cwd unless explicitly allowed.
 *   - Reject path traversal, secret mounts, Docker socket mounts.
 *   - Windows/WSL path handling deterministic and testable.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { homedir, platform } from 'node:os';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Blocked mount patterns - security contract
// ---------------------------------------------------------------------------

const BLOCKED_MOUNT_PATTERNS = [
  // .env files
  /(?:^|[\\/])\.env(?:\..+)?$/i,
  // Home directory secrets
  /(?:^|[\\/])\.ssh(?:[\\/]|$)/i,
  /(?:^|[\\/])\.aws(?:[\\/]|$)/i,
  /(?:^|[\\/])\.config(?:[\\/]|$)/i,
  // Docker socket
  /(?:^|[\\/])docker\.sock$/i,
  /^\/var\/run\/docker\.sock$/i,
];

const HOME_SECRET_DIRS = ['.ssh', '.aws', '.config'];
// Docker reads anything starting with "-" as a flag, and a volume "name" containing
// "/" becomes a host bind mount. Both are host-escape vectors, so values are
// restricted to plain image references and plain volume names.
const IMAGE_REF_PATTERN = /^[a-z0-9][a-z0-9._\/-]*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[a-f0-9]{64})?$/;
const VOLUME_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const CONTAINER_PATH_PATTERN = /^\/[^:,\s]*$/;
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const BLOCKED_ENV_KEY_PATTERN = /(?:SECRET|TOKEN|PASSWORD|CREDENTIAL|PRIVATE_KEY|API_KEY|ACCESS_KEY|AWS_|GITHUB_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY)/i;

// ---------------------------------------------------------------------------
// Schema loading
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, '..', 'schemas', 'sandbox-config.schema.json');

/**
 * Load and return the sandbox config schema.
 * @returns {object} Parsed JSON schema
 */
export function loadSchema() {
  const raw = readFileSync(SCHEMA_PATH, 'utf8');
  return JSON.parse(raw);
}

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

/**
 * Validate a sandbox config object against the schema contract.
 * Returns { valid: boolean, errors: string[] }.
 *
 * @param {object} config - The sandbox config to validate
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateConfig(config) {
  const errors = [];

  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return { valid: false, errors: ['Config must be a non-null object.'] };
  }

  // Required: command
  if (!Array.isArray(config.command) || config.command.length === 0) {
    errors.push('command is required and must be a non-empty array of strings.');
  } else {
    for (let i = 0; i < config.command.length; i++) {
      if (typeof config.command[i] !== 'string') {
        errors.push(`command[${i}] must be a string.`);
      }
    }
  }

  // network_mode enum
  const validModes = ['offline', 'allowlist', 'full'];
  const mode = config.network_mode || 'offline';
  if (!validModes.includes(mode)) {
    errors.push(`network_mode must be one of: ${validModes.join(', ')}. Got: ${mode}`);
  }

  // allowlist mode requires non-empty allowlist
  if (mode === 'allowlist') {
    if (!Array.isArray(config.network_allowlist) || config.network_allowlist.length === 0) {
      errors.push('network_mode "allowlist" requires a non-empty network_allowlist array.');
    }
    // Docker cannot enforce a DNS allowlist, so allowlist == full network in practice.
    if (config.full_network_approved !== true) {
      errors.push('network_mode "allowlist" is NOT enforced (Docker bridge network) and requires full_network_approved: true.');
    }
  }

  // full mode requires explicit approval
  if (mode === 'full') {
    if (config.full_network_approved !== true) {
      errors.push('network_mode "full" requires full_network_approved: true.');
    }
  }

  // additionalProperties check
  const allowedKeys = new Set([
    'command', 'cwd', 'image', 'network_mode', 'network_allowlist',
    'full_network_approved', 'mounts', 'cache_mounts', 'timeout_seconds',
    'log_dir', 'env',
  ]);
  for (const key of Object.keys(config)) {
    if (!allowedKeys.has(key)) {
      errors.push(`Unknown property: "${key}".`);
    }
  }

  if (config.image !== undefined && (typeof config.image !== 'string' || !IMAGE_REF_PATTERN.test(config.image))) {
    errors.push(`image must be a plain image reference (e.g. node:22-slim). Got: ${config.image}`);
  }

  // timeout_seconds range
  if (config.timeout_seconds !== undefined) {
    if (!Number.isInteger(config.timeout_seconds) || config.timeout_seconds < 1 || config.timeout_seconds > 28800) {
      errors.push('timeout_seconds must be an integer between 1 and 28800.');
    }
  }

  if (config.mounts !== undefined) {
    if (!Array.isArray(config.mounts)) {
      errors.push('mounts must be an array.');
    } else {
      for (let i = 0; i < config.mounts.length; i++) {
        const mount = config.mounts[i];
        if (!mount || typeof mount !== 'object' || Array.isArray(mount)) {
          errors.push(`mounts[${i}] must be an object.`);
          continue;
        }
        for (const key of Object.keys(mount)) {
          if (!['host_path', 'container_path', 'readonly'].includes(key)) {
            errors.push(`mounts[${i}] unknown property: "${key}".`);
          }
        }
        if (typeof mount.host_path !== 'string' || mount.host_path.length === 0) {
          errors.push(`mounts[${i}].host_path must be a non-empty string.`);
        }
        if (typeof mount.container_path !== 'string' || !CONTAINER_PATH_PATTERN.test(mount.container_path)) {
          errors.push(`mounts[${i}].container_path must be an absolute container path without ':' ',' or spaces.`);
        }
        if (mount.readonly !== undefined && typeof mount.readonly !== 'boolean') {
          errors.push(`mounts[${i}].readonly must be a boolean.`);
        }
      }
    }
  }

  if (config.cache_mounts !== undefined) {
    if (!Array.isArray(config.cache_mounts)) {
      errors.push('cache_mounts must be an array.');
    } else {
      for (let i = 0; i < config.cache_mounts.length; i++) {
        const cache = config.cache_mounts[i];
        if (!cache || typeof cache !== 'object' || Array.isArray(cache)) {
          errors.push(`cache_mounts[${i}] must be an object.`);
          continue;
        }
        for (const key of Object.keys(cache)) {
          if (!['name', 'container_path'].includes(key)) {
            errors.push(`cache_mounts[${i}] unknown property: "${key}".`);
          }
        }
        if (typeof cache.name !== 'string' || !VOLUME_NAME_PATTERN.test(cache.name)) {
          errors.push(`cache_mounts[${i}].name must be a plain Docker volume name (no '/', no host paths).`);
        }
        if (typeof cache.container_path !== 'string' || !CONTAINER_PATH_PATTERN.test(cache.container_path)) {
          errors.push(`cache_mounts[${i}].container_path must be an absolute container path without ':' ',' or spaces.`);
        }
      }
    }
  }

  if (config.env !== undefined) {
    if (!config.env || typeof config.env !== 'object' || Array.isArray(config.env)) {
      errors.push('env must be an object.');
    } else {
      for (const [key, value] of Object.entries(config.env)) {
        if (!ENV_KEY_PATTERN.test(key)) {
          errors.push(`env key "${key}" is not a valid variable name.`);
        }
        if (BLOCKED_ENV_KEY_PATTERN.test(key)) {
          errors.push(`env key "${key}" looks secret-bearing and is blocked.`);
        }
        if (typeof value !== 'string') {
          errors.push(`env.${key} must be a string.`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Path security
// ---------------------------------------------------------------------------

function normalizeForBoundary(p) {
  const normalized = normalize(p);
  return platform() === 'win32' ? normalized.toLowerCase() : normalized;
}

function isSameOrInside(parentPath, targetPath) {
  const parent = normalizeForBoundary(parentPath);
  const target = normalizeForBoundary(targetPath);
  if (target === parent) {
    return true;
  }
  const parentWithSep = parent.endsWith(sep) ? parent : `${parent}${sep}`;
  return target.startsWith(parentWithSep);
}

/**
 * Check if a host path is a blocked secret path.
 * @param {string} hostPath - The host path to check
 * @param {string} [home] - Home directory override for testing
 * @returns {{ blocked: boolean, reason: string }}
 */
export function checkMountSecurity(hostPath, home) {
  const resolvedHome = home || homedir();
  const normalizedPath = normalize(hostPath);

  // Check against blocked patterns
  for (const pattern of BLOCKED_MOUNT_PATTERNS) {
    if (pattern.test(normalizedPath) || pattern.test(hostPath)) {
      return { blocked: true, reason: `Blocked mount pattern: ${hostPath}` };
    }
  }

  // Check home directory secret directories
  for (const secretDir of HOME_SECRET_DIRS) {
    const homeSecret = join(resolvedHome, secretDir);
    const normalizedSecret = normalize(homeSecret);
    if (normalizedPath === normalizedSecret || normalizedPath.startsWith(normalizedSecret + sep)) {
      return { blocked: true, reason: `Home secret directory blocked: ${hostPath}` };
    }
    // Also check Unix-style paths on Windows
    if (hostPath === homeSecret || hostPath.startsWith(homeSecret + '/')) {
      return { blocked: true, reason: `Home secret directory blocked: ${hostPath}` };
    }
  }

  // Check Docker socket explicitly
  if (hostPath === '/var/run/docker.sock' || normalizedPath.endsWith('docker.sock')) {
    return { blocked: true, reason: 'Docker socket mount blocked.' };
  }

  return { blocked: false, reason: '' };
}

/**
 * Check that a path does not escape the project cwd via traversal.
 * @param {string} targetPath - Path to validate
 * @param {string} projectCwd - The project root directory
 * @returns {{ safe: boolean, resolved: string, reason: string }}
 */
export function checkPathTraversal(targetPath, projectCwd) {
  const resolvedCwd = resolve(projectCwd);
  const resolvedTarget = resolve(projectCwd, targetPath);
  const normalizedTarget = normalize(resolvedTarget);

  if (!isSameOrInside(resolvedCwd, normalizedTarget)) {
    return {
      safe: false,
      resolved: normalizedTarget,
      reason: `Path escapes project directory: ${targetPath} resolves to ${normalizedTarget}`,
    };
  }

  return { safe: true, resolved: normalizedTarget, reason: '' };
}

/**
 * Validate that the log directory resolves under .buildloop-runs/.
 * @param {string} logDir - The log directory path
 * @param {string} projectCwd - The project root directory
 * @returns {{ valid: boolean, resolved: string, reason: string }}
 */
export function validateLogDir(logDir, projectCwd) {
  const resolvedCwd = resolve(projectCwd);
  const resolvedLog = resolve(projectCwd, logDir);

  // Must contain .buildloop-runs in the path
  const runsDir = join(resolvedCwd, '.buildloop-runs');
  if (!isSameOrInside(runsDir, resolvedLog)) {
    return {
      valid: false,
      resolved: resolvedLog,
      reason: `Log directory must resolve under .buildloop-runs/. Got: ${resolvedLog}`,
    };
  }

  return { valid: true, resolved: resolvedLog, reason: '' };
}

// ---------------------------------------------------------------------------
// Windows/WSL path handling
// ---------------------------------------------------------------------------

/**
 * Normalize a Windows path to a consistent format.
 * @param {string} p - The path to normalize
 * @returns {string} Normalized path
 */
export function normalizeWindowsPath(p) {
  if (!p) return p;
  // Normalize backslashes to forward slashes for Docker
  let normalized = p.replace(/\\/g, '/');
  // Handle drive letter casing: C: -> c:
  if (/^[A-Z]:/.test(normalized)) {
    normalized = normalized[0].toLowerCase() + normalized.slice(1);
  }
  return normalized;
}

/**
 * Translate a Windows host path to a WSL-compatible path for Docker mounts.
 * E.g., C:\repo\project -> /mnt/c/repo/project
 * @param {string} windowsPath - The Windows path
 * @returns {string} WSL-compatible path
 */
export function windowsToWslPath(windowsPath) {
  if (!windowsPath) return windowsPath;
  const normalized = windowsPath.replace(/\\/g, '/');
  const driveMatch = normalized.match(/^([A-Za-z]):\//);
  if (driveMatch) {
    return `/mnt/${driveMatch[1].toLowerCase()}/${normalized.slice(3)}`;
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// Docker availability check
// ---------------------------------------------------------------------------

/**
 * Check if Docker is available.
 * @param {object} [options]
 * @param {Function} [options.exec] - Command executor (defaults to spawnSync)
 * @returns {{ available: boolean, version: string|null, error: string }}
 */
export function checkDockerAvailable(options = {}) {
  const exec = options.exec || defaultExec;
  try {
    const result = exec('docker', ['--version'], {});
    if (result.status !== 0 || result.error) {
      return {
        available: false,
        version: null,
        error: 'Docker is not available. Install Docker Desktop or Docker Engine to use sandbox mode.',
      };
    }
    const stdout = (result.stdout || '').trim();
    const match = stdout.match(/Docker version\s+([\d.]+)/i);
    return {
      available: true,
      version: match ? match[1] : stdout || null,
      error: '',
    };
  } catch {
    return {
      available: false,
      version: null,
      error: 'Docker check failed unexpectedly.',
    };
  }
}

// ---------------------------------------------------------------------------
// Docker command builder
// ---------------------------------------------------------------------------

/**
 * Build the Docker run command array from a validated config.
 * Does NOT execute Docker - returns the command plan.
 *
 * @param {object} config - Validated sandbox config
 * @param {string} projectCwd - Absolute path to project root
 * @param {object} [options]
 * @param {string} [options.platform] - OS platform override for testing
 * @param {Function} [options.pathTranslator] - Path translator for WSL
 * @returns {{ args: string[], warnings: string[], errors: string[] }}
 */
const ENV_SCAN_SKIP = new Set(['.git', 'node_modules', '.venv', 'venv', 'target', 'dist', 'build']);

/** Relative paths of .env* entries up to 6 levels deep. */
function findEnvFiles(root, rel = '', depth = 0) {
  if (depth > 6) return [];
  let entries = [];
  try {
    entries = readdirSync(join(root, rel), { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = rel ? `${rel}/${entry.name}` : entry.name;
    if (/^\.env/.test(entry.name)) found.push(path);
    else if (entry.isDirectory() && !ENV_SCAN_SKIP.has(entry.name)) found.push(...findEnvFiles(root, path, depth + 1));
  }
  return found;
}

export function buildDockerCommand(config, projectCwd, options = {}) {
  const errors = [];
  const warnings = [];
  const containerName = options.containerName || `buildloop-sandbox-${process.pid}-${Date.now()}`;
  const args = [
    'run', '--rm',
    '--name', containerName,
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--pids-limit', '512',
  ];

  const currentPlatform = options.platform || platform();
  const translatePath = options.pathTranslator || (
    currentPlatform === 'win32' ? windowsToWslPath : (p) => p
  );

  // Image (re-checked here: buildDockerCommand is exported and may skip validateConfig)
  const image = config.image || 'node:22-slim';
  if (!IMAGE_REF_PATTERN.test(image)) errors.push(`Refusing image reference: ${image}`);

  // Network mode
  const mode = config.network_mode || 'offline';
  if (mode === 'offline') {
    args.push('--network', 'none');
  } else if (mode === 'allowlist') {
    // Docker doesn't natively support DNS allowlists; use network=none + manual DNS
    // For now, we use bridge network with a note
    args.push('--network', 'bridge');
    warnings.push('WARNING: allowlist is NOT enforced. The container has unrestricted bridge network access.');
  } else if (mode === 'full') {
    warnings.push('WARNING: Full network mode enabled. Container has unrestricted network access.');
    // Default bridge network - no flag needed
  }

  // Timeout
  const timeout = config.timeout_seconds || 300;
  args.push('--stop-timeout', String(timeout));

  // Working directory mount
  const translatedCwd = translatePath(resolve(projectCwd));
  args.push('-v', `${translatedCwd}:/workspace`);
  args.push('-w', '/workspace');

  // Git hooks run on the host, so a writable .git is a container-to-host escape.
  if (existsSync(join(projectCwd, '.git'))) {
    args.push('-v', `${translatePath(resolve(projectCwd, '.git'))}:/workspace/.git:ro`);
  }
  // Shadow .env* files (any depth, skipping dependency folders) so workspace
  // secrets are not readable inside the container.
  // A tmpfs mount needs a directory target, so files are covered with /dev/null.
  for (const rel of findEnvFiles(projectCwd)) {
    args.push('-v', `/dev/null:/workspace/${rel}:ro`);
    warnings.push(`Shadowed ${rel} inside the container.`);
  }

  // cwd inside container
  if (config.cwd && config.cwd !== '.') {
    const cwdCheck = checkPathTraversal(config.cwd, projectCwd);
    if (!cwdCheck.safe) {
      errors.push(cwdCheck.reason);
    } else {
      args.push('-w', `/workspace/${config.cwd}`);
    }
  }

  // Log directory mount
  const logDir = config.log_dir || '.buildloop-runs';
  const logCheck = validateLogDir(logDir, projectCwd);
  if (!logCheck.valid) {
    errors.push(logCheck.reason);
  }

  // Additional mounts
  if (Array.isArray(config.mounts)) {
    for (const mount of config.mounts) {
      const security = checkMountSecurity(mount.host_path);
      if (security.blocked) {
        errors.push(security.reason);
        continue;
      }

      const traversal = checkPathTraversal(mount.host_path, projectCwd);
      if (!traversal.safe) {
        errors.push(traversal.reason);
        continue;
      }

      const translatedHost = translatePath(traversal.resolved);
      const mountFlag = mount.readonly ? ':ro' : '';
      args.push('-v', `${translatedHost}:${mount.container_path}${mountFlag}`);
    }
  }

  // Cache mounts (named volumes)
  if (Array.isArray(config.cache_mounts)) {
    for (const cache of config.cache_mounts) {
      if (!VOLUME_NAME_PATTERN.test(String(cache.name)) || !CONTAINER_PATH_PATTERN.test(String(cache.container_path))) {
        errors.push(`Refusing cache mount: ${cache.name}:${cache.container_path}`);
        continue;
      }
      args.push('-v', `${cache.name}:${cache.container_path}`);
    }
  }

  // Environment variables
  if (config.env && typeof config.env === 'object') {
    for (const [key, value] of Object.entries(config.env)) {
      args.push('-e', `${key}=${value}`);
    }
  }

  // Image
  args.push(image);

  // Command - array form, no shell interpolation
  if (Array.isArray(config.command)) {
    args.push(...config.command);
  }

  return { args, warnings, errors, containerName };
}

// ---------------------------------------------------------------------------
// Default exec wrapper
// ---------------------------------------------------------------------------

function defaultExec(cmd, args, opts) {
  return spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
    ...opts,
  });
}

// ---------------------------------------------------------------------------
// Sandbox runner (orchestrator)
// ---------------------------------------------------------------------------

/**
 * Run the sandbox with the given config.
 *
 * @param {object} config - Sandbox config object
 * @param {object} [options]
 * @param {string} [options.cwd] - Project root directory
 * @param {boolean} [options.dryRun] - If true, print plan without executing
 * @param {Function} [options.exec] - Command executor for DI
 * @param {string} [options.platform] - OS platform override
 * @param {Function} [options.pathTranslator] - Path translator override
 * @returns {{ success: boolean, dryRun: boolean, plan: object|null, output: string, errors: string[] }}
 */
export function runSandbox(config, options = {}) {
  const cwd = resolve(options.cwd || process.cwd());
  const dryRun = options.dryRun !== false; // Default: true (dry-run)
  const exec = options.exec || defaultExec;

  // Validate config
  const validation = validateConfig(config);
  if (!validation.valid) {
    return {
      success: false,
      dryRun,
      plan: null,
      output: '',
      errors: validation.errors,
    };
  }

  // Build Docker command
  const plan = buildDockerCommand(config, cwd, {
    platform: options.platform,
    pathTranslator: options.pathTranslator,
  });

  if (plan.errors.length > 0) {
    return {
      success: false,
      dryRun,
      plan,
      output: '',
      errors: plan.errors,
    };
  }

  // Dry-run: print plan and return
  if (dryRun) {
    return {
      success: true,
      dryRun: true,
      plan,
      output: `docker ${plan.args.join(' ')}`,
      errors: [],
    };
  }

  // Check Docker availability
  const docker = checkDockerAvailable({ exec });
  if (!docker.available) {
    return {
      success: false,
      dryRun: false,
      plan,
      output: '',
      errors: [docker.error],
    };
  }

  // Ensure log directory exists
  const logDir = config.log_dir || '.buildloop-runs';
  const resolvedLogDir = resolve(cwd, logDir);
  try {
    mkdirSync(resolvedLogDir, { recursive: true });
  } catch {
    // Best effort - log dir may already exist
  }

  // Execute
  const timeoutMs = (config.timeout_seconds || 300) * 1000;
  const result = exec('docker', plan.args, { cwd, timeout: timeoutMs });
  if (result.error) {
    // Killing the docker client does not stop the container; remove it explicitly.
    exec('docker', ['rm', '-f', plan.containerName], { cwd, timeout: 30_000 });
  }
  const stdout = (result.stdout || '').trim();
  const stderr = (result.stderr || '').trim();
  const output = [stdout, stderr].filter(Boolean).join('\n');

  if (result.error) {
    return {
      success: false,
      dryRun: false,
      plan,
      output,
      errors: [`Docker execution failed: ${result.error.message || result.error}`],
    };
  }

  // Write log
  const logFile = join(resolvedLogDir, `sandbox-${Date.now()}.log`);
  try {
    const logContent = [
      `Timestamp: ${new Date().toISOString()}`,
      `Command: docker ${plan.args.join(' ')}`,
      `Exit code: ${result.status}`,
      '',
      '--- stdout ---',
      stdout,
      '',
      '--- stderr ---',
      stderr,
    ].join('\n');
    writeFileSync(logFile, logContent, 'utf8');
  } catch {
    // Best effort logging
  }

  const success = result.status === 0 && !result.error;
  return {
    success,
    dryRun: false,
    plan,
    output,
    errors: success ? [] : [`Docker exited with code ${result.status}.`],
  };
}

// ---------------------------------------------------------------------------
// CLI wrapper
// ---------------------------------------------------------------------------

function printHelp() {
  console.log([
    'sandbox-run - Buildloop Docker sandbox runner',
    '',
    'Usage:',
    '  node scripts/sandbox-run.mjs --help',
    '  node scripts/sandbox-run.mjs --dry-run --cwd <path> -- <command...>',
    '  node scripts/sandbox-run.mjs --config <sandbox-config.json> [--dry-run]',
    '',
    'Options:',
    '  --help          Show this help message',
    '  --dry-run       Print Docker plan without executing (default)',
    '  --execute       Actually run Docker (overrides dry-run default)',
    '  --cwd <path>    Project root directory (default: current directory)',
    '  --config <path> Load config from JSON file',
    '  --image <img>   Docker image (default: node:22-slim)',
    '  --network <m>   Network mode: offline, allowlist, full (default: offline)',
    '',
    'Security:',
    '  - .env* mounts are always blocked',
    '  - ~/.ssh, ~/.aws, ~/.config mounts are always blocked',
    '  - /var/run/docker.sock mount is always blocked',
    '  - Path traversal outside project directory is blocked',
    '  - Logs are written only under .buildloop-runs/',
  ].join('\n'));
}

function cli() {
  const rawArgs = process.argv.slice(2);

  if (rawArgs.includes('--help') || rawArgs.includes('-h')) {
    printHelp();
    return;
  }

  let config;

  // --config mode
  const configIdx = rawArgs.indexOf('--config');
  if (configIdx !== -1 && rawArgs[configIdx + 1]) {
    const configPath = resolve(rawArgs[configIdx + 1]);
    try {
      const raw = readFileSync(configPath, 'utf8');
      config = JSON.parse(raw);
    } catch (err) {
      console.error(`sandbox-run: failed to load config: ${err.message}`);
      process.exitCode = 1;
      return;
    }
  } else {
    // Inline command mode: -- <command...>
    const dashIdx = rawArgs.indexOf('--');
    if (dashIdx === -1 || dashIdx + 1 >= rawArgs.length) {
      console.error('sandbox-run: provide a command after -- or use --config <file>');
      process.exitCode = 1;
      return;
    }
    const command = rawArgs.slice(dashIdx + 1);
    config = { command };

    // Apply CLI flags
    const imageIdx = rawArgs.indexOf('--image');
    if (imageIdx !== -1 && rawArgs[imageIdx + 1]) {
      config.image = rawArgs[imageIdx + 1];
    }

    const networkIdx = rawArgs.indexOf('--network');
    if (networkIdx !== -1 && rawArgs[networkIdx + 1]) {
      config.network_mode = rawArgs[networkIdx + 1];
    }
  }

  // Resolve cwd
  let cwd = process.cwd();
  const cwdIdx = rawArgs.indexOf('--cwd');
  if (cwdIdx !== -1 && rawArgs[cwdIdx + 1]) {
    cwd = resolve(rawArgs[cwdIdx + 1]);
  }

  const dryRun = !rawArgs.includes('--execute');

  const result = runSandbox(config, { cwd, dryRun });

  if (result.errors.length > 0) {
    for (const err of result.errors) {
      console.error(`sandbox-run: ${err}`);
    }
    process.exitCode = 1;
    return;
  }

  if (result.dryRun) {
    console.log('[DRY-RUN] Docker command plan:');
    console.log(`  ${result.output}`);
    if (result.plan && result.plan.warnings.length > 0) {
      for (const w of result.plan.warnings) {
        console.log(`  WARNING: ${w}`);
      }
    }
    return;
  }

  // Real execution
  if (result.plan && result.plan.warnings.length > 0) {
    for (const w of result.plan.warnings) {
      console.error(`WARNING: ${w}`);
    }
  }

  if (result.success) {
    console.log(result.output || 'Sandbox execution completed successfully.');
  } else {
    console.error(result.output || 'Sandbox execution failed.');
    process.exitCode = 1;
  }
}

// Run CLI when executed directly
const isMain = process.argv[1] && (
  resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'))
  || process.argv[1] === new URL(import.meta.url).pathname
);
if (isMain) cli();
