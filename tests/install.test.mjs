#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import {
  basename,
  dirname,
  extname,
  join,
  relative,
  resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

function readText(path) {
  return readFileSync(path, 'utf8');
}

function walkFiles(dir) {
  const files = [];

  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      files.push(...walkFiles(path));
    } else {
      files.push(path);
    }
  }

  return files;
}

function displayPath(path) {
  return relative(ROOT, path).replaceAll('\\', '/');
}

function parseJson(path) {
  return JSON.parse(readText(path));
}

function namesForTier(list, tier) {
  return list
    .filter((item) => Array.isArray(item.tier) && item.tier.includes(tier))
    .map((item) => item.name);
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

function frontmatterFor(path) {
  const raw = readText(path);
  assert.ok(raw.startsWith('---\n') || raw.startsWith('---\r\n'), `${displayPath(path)} must start with frontmatter`);

  const lines = raw.split(/\r?\n/);
  const end = lines.findIndex((line, index) => index > 0 && line === '---');
  assert.notEqual(end, -1, `${displayPath(path)} frontmatter must have a closing delimiter`);

  return lines.slice(1, end);
}

function validateYamlFrontmatter(path) {
  const lines = frontmatterFor(path);
  const keys = new Set();
  let inBlockScalar = false;

  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 2;
    const trimmed = line.trim();

    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }

    if (/^[A-Za-z_][A-Za-z0-9_-]*\s*:(?:\s.*)?$/.test(line)) {
      const key = line.slice(0, line.indexOf(':')).trim();
      keys.add(key);
      inBlockScalar = /:\s*[>|][+-]?\s*(?:#.*)?$/.test(line);
      continue;
    }

    if (/^\s+(-\s+.*|[A-Za-z_][A-Za-z0-9_-]*\s*:(?:\s.*)?|#.*)$/.test(line)) {
      continue;
    }

    if (inBlockScalar && /^\s+\S/.test(line)) {
      continue;
    }

    assert.fail(`${displayPath(path)}:${lineNumber} unsupported frontmatter line: ${line}`);
  }

  assert.ok(keys.size > 0, `${displayPath(path)} frontmatter must have at least one top-level key`);
  return keys;
}

function check(label, fn) {
  try {
    const count = fn();
    const suffix = Number.isInteger(count) ? ` (${count})` : '';
    console.log(`PASS ${label}${suffix}`);
  } catch (error) {
    console.error(`FAIL ${label}`);
    console.error(error.message);
    process.exitCode = 1;
  }
}

let manifest;

check('curated-skills.json parses and has installer sections', () => {
  manifest = parseJson(resolve(ROOT, 'curated-skills.json'));
  assert.equal(typeof manifest, 'object', 'manifest must be an object');
  assert.ok(manifest.tiers && typeof manifest.tiers === 'object', 'manifest must include tiers');
  assert.ok(Array.isArray(manifest.localSkills), 'manifest must include localSkills array');
  assert.ok(Array.isArray(manifest.upstreamSkills), 'manifest must include upstreamSkills array');
});

check('manifest local skills resolve to SKILL.md files', () => {
  assert.ok(manifest, 'manifest must be parsed before local skill checks');
  assert.ok(manifest.localSkills.length > 0, 'manifest.localSkills must not be empty');

  for (const skill of manifest.localSkills) {
    assert.equal(typeof skill.name, 'string', 'local skill must include name');
    assert.equal(typeof skill.path, 'string', `${skill.name} must include path`);

    const skillDir = resolve(ROOT, skill.path);
    const skillFile = resolve(skillDir, 'SKILL.md');
    assert.ok(existsSync(skillDir), `${skill.name} path does not exist: ${displayPath(skillDir)}`);
    assert.ok(existsSync(skillFile), `${skill.name} is missing ${displayPath(skillFile)}`);
  }

  return manifest.localSkills.length;
});

check('local SKILL.md files have name and description frontmatter', () => {
  const skillFiles = walkFiles(resolve(ROOT, 'skills')).filter((file) => basename(file) === 'SKILL.md');
  assert.ok(skillFiles.length > 0, 'No local SKILL.md files found');

  for (const skillFile of skillFiles) {
    const keys = validateYamlFrontmatter(skillFile);
    assert.ok(keys.has('name'), `${displayPath(skillFile)} frontmatter must include name`);
    assert.ok(keys.has('description'), `${displayPath(skillFile)} frontmatter must include description`);
  }

  return skillFiles.length;
});

check('markdown templates have frontmatter with top-level keys', () => {
  const templateFiles = walkFiles(resolve(ROOT, 'templates'))
    .filter((file) => extname(file).toLowerCase() === '.md');
  assert.ok(templateFiles.length > 0, 'No markdown template files found');

  for (const templateFile of templateFiles) {
    validateYamlFrontmatter(templateFile);
  }

  return templateFiles.length;
});

check('Claude command aliases are packaged and installer-wired', () => {
  const commandFiles = [
    resolve(ROOT, 'commands', 'claude', 'orchestrator.md'),
    resolve(ROOT, 'commands', 'claude', 'buildloop.md'),
  ];

  for (const commandFile of commandFiles) {
    assert.ok(existsSync(commandFile), `${displayPath(commandFile)} must exist`);
    const keys = validateYamlFrontmatter(commandFile);
    assert.ok(keys.has('name'), `${displayPath(commandFile)} frontmatter must include name`);
    assert.ok(keys.has('description'), `${displayPath(commandFile)} frontmatter must include description`);
    assert.match(
      readText(commandFile),
      /Use enterprise-ai-dev as my master CTO orchestrator for this repo\./,
      `${displayPath(commandFile)} must preserve the canonical invocation contract`,
    );
  }

  const bashInstaller = readText(resolve(ROOT, 'scripts', 'install.sh'));
  const psInstaller = readText(resolve(ROOT, 'scripts', 'install.ps1'));

  assert.ok(
    bashInstaller.includes('install_commands_for_target "$target"'),
    'install.sh must install command aliases for supported targets',
  );
  assert.ok(
    bashInstaller.includes('commands/claude/$command_name.md'),
    'install.sh must source Claude command aliases from commands/claude',
  );
  assert.ok(
    psInstaller.includes('function Install-ClaudeCommands'),
    'install.ps1 must install Claude command aliases',
  );
  assert.ok(
    psInstaller.includes('commands\\claude\\$commandName.md'),
    'install.ps1 must source Claude command aliases from commands/claude',
  );

  return commandFiles.length;
});

check('schema files parse as JSON', () => {
  const schemaFiles = walkFiles(resolve(ROOT, 'schemas'))
    .filter((file) => extname(file).toLowerCase() === '.json');
  assert.ok(schemaFiles.length > 0, 'No JSON schema files found');

  for (const schemaFile of schemaFiles) {
    parseJson(schemaFile);
  }

  return schemaFiles.length;
});

check('installers bootstrap full payload for one-line installs', () => {
  const bashInstaller = readText(resolve(ROOT, 'scripts', 'install.sh'));
  const psInstaller = readText(resolve(ROOT, 'scripts', 'install.ps1'));

  assert.ok(
    bashInstaller.includes('BUILDLOOP_REPO_URL="${BUILDLOOP_REPO_URL:-https://github.com/mithunyc/buildloop.git}"'),
    'install.sh must define an overrideable Buildloop repo URL',
  );
  assert.ok(
    bashInstaller.includes('resolve_repo_root'),
    'install.sh must resolve or download the Buildloop payload when run standalone',
  );
  assert.ok(
    !bashInstaller.includes('declare -A'),
    'install.sh must not require Bash 4 associative arrays; macOS default Bash is older',
  );
  assert.ok(
    !bashInstaller.includes('mapfile'),
    'install.sh must not require mapfile; macOS default Bash is older',
  );

  assert.ok(
    psInstaller.includes('$BuildloopRepoUrl = if ($env:BUILDLOOP_REPO_URL)'),
    'install.ps1 must define an overrideable Buildloop repo URL',
  );
  assert.ok(
    psInstaller.includes('function Resolve-BuildloopRoot'),
    'install.ps1 must resolve or download the Buildloop payload when run standalone',
  );
});

check('public docs describe Claude command install behavior', () => {
  const readme = readText(resolve(ROOT, 'README.md'));
  const security = readText(resolve(ROOT, 'SECURITY.md'));

  assert.ok(
    readme.includes('~/.claude/commands'),
    'README.md must disclose the Claude command install directory',
  );
  assert.ok(
    readme.includes('/orchestrator') && readme.includes('/buildloop'),
    'README.md must document the Claude slash command aliases',
  );
  assert.ok(
    security.includes('~/.claude/commands'),
    'SECURITY.md must disclose the Claude command install directory',
  );
  assert.ok(
    !security.includes("Does **not** modify any file outside the agent's skills directory."),
    'SECURITY.md must not claim the installer writes only to skills directories',
  );
});

check('manifest tier summaries match installer skill declarations', () => {
  assert.ok(manifest, 'manifest must be parsed before tier parity checks');

  const allTiers = Object.keys(manifest.tiers);
  assert.deepEqual(
    sortedUnique(allTiers),
    ['contributor', 'core', 'full', 'minimal'],
    'manifest.tiers must define the supported installer modes',
  );

  for (const tier of allTiers) {
    const declared = sortedUnique([
      ...(manifest.tiers[tier].localSkills ?? []),
      ...(manifest.tiers[tier].upstreamSkills ?? []),
    ]);

    const expected = sortedUnique([
      ...namesForTier(manifest.localSkills, tier),
      ...manifest.upstreamSkills.flatMap((repo) => namesForTier(repo.skills ?? [], tier)),
    ]);

    assert.deepEqual(declared, expected, `${tier} tier summary must match per-skill tier declarations`);
  }

  const bashInstaller = readText(resolve(ROOT, 'scripts', 'install.sh'));
  const psInstaller = readText(resolve(ROOT, 'scripts', 'install.ps1'));

  for (const repo of manifest.upstreamSkills) {
    for (const skill of repo.skills ?? []) {
      assert.ok(
        bashInstaller.includes(skill.path),
        `install.sh must include upstream skill path from manifest: ${skill.path}`,
      );
      assert.ok(
        psInstaller.includes(skill.path.replaceAll('/', '\\')) || psInstaller.includes(skill.path),
        `install.ps1 must include upstream skill path from manifest: ${skill.path}`,
      );
    }
  }
});

check('installers bundle the same runtime scripts, and every one exists', () => {
  const bash = readText(join(ROOT, 'scripts', 'install.sh'));
  const ps = readText(join(ROOT, 'scripts', 'install.ps1'));
  const bashList = bash.match(/RUNTIME_SCRIPTS="([^"]+)"/)?.[1].split(/\s+/) ?? [];
  const psList = [...(ps.match(/\$RuntimeScripts = @\(([^)]+)\)/)?.[1] ?? '').matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(bashList.length > 0, 'install.sh must declare RUNTIME_SCRIPTS');
  assert.deepEqual([...psList].sort(), [...bashList].sort(), 'bash and PowerShell runtime lists must match');
  for (const script of ['verify.mjs', 'learn.mjs', 'gate-runner.mjs', 'buildloop.mjs']) {
    assert.ok(bashList.includes(script), `runtime must include ${script}`);
  }
  for (const script of bashList) {
    assert.ok(existsSync(join(ROOT, 'scripts', script)), `runtime script missing: ${script}`);
  }
});

if (process.exitCode) {
  process.exit(process.exitCode);
}
