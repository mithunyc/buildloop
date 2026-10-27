#!/usr/bin/env bash
set -euo pipefail

FORCE=0
DRY_RUN=0
TARGETS="codex"
MODE="core"
BUILDLOOP_REPO_URL="${BUILDLOOP_REPO_URL:-https://github.com/mithunyc/buildloop.git}"
BUILDLOOP_TEMP_ROOT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force)
      FORCE=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --target)
      TARGETS="${2:-codex}"
      shift 2
      ;;
    --mode)
      MODE="${2:-core}"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      echo "Usage: scripts/install.sh [--target codex|claude|cursor|antigravity|all] [--mode minimal|core|full|contributor] [--force] [--dry-run]" >&2
      exit 1
      ;;
  esac
done

# Validate mode
case "$MODE" in
  minimal|core|full|contributor) ;;
  *) echo "Unknown mode: $MODE. Valid modes: minimal, core, full, contributor." >&2; exit 1 ;;
esac

cleanup() {
  if [[ -n "$BUILDLOOP_TEMP_ROOT" && -d "$BUILDLOOP_TEMP_ROOT" ]]; then
    rm -rf "$BUILDLOOP_TEMP_ROOT"
  fi
}
trap cleanup EXIT

resolve_repo_root() {
  local candidate
  candidate="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd || true)"

  if [[ -n "$candidate" && -f "$candidate/curated-skills.json" && -d "$candidate/skills" ]]; then
    repo_root="$candidate"
    return
  fi

  if ! command -v git >/dev/null 2>&1; then
    echo "Buildloop installer needs git when run as a one-line remote installer." >&2
    echo "Install git, or clone https://github.com/mithunyc/buildloop and run scripts/install.sh locally." >&2
    exit 1
  fi

  BUILDLOOP_TEMP_ROOT="$(mktemp -d)"
  echo "  source: downloading buildloop installer payload..."
  if ! git clone -q --depth 1 "$BUILDLOOP_REPO_URL" "$BUILDLOOP_TEMP_ROOT"; then
    echo "Failed to download buildloop from $BUILDLOOP_REPO_URL" >&2
    exit 1
  fi

  if [[ ! -f "$BUILDLOOP_TEMP_ROOT/curated-skills.json" || ! -d "$BUILDLOOP_TEMP_ROOT/skills" ]]; then
    echo "Downloaded buildloop payload is missing curated-skills.json or skills/." >&2
    exit 1
  fi

  repo_root="$BUILDLOOP_TEMP_ROOT"
}

repo_root=""
resolve_repo_root
manifest_path="$repo_root/curated-skills.json"

is_full_sha() {
  local value="$1"
  [[ "$value" =~ ^[0-9a-fA-F]{40}$ ]]
}

get_pinned_commit() {
  local repo="$1"
  if command -v node >/dev/null 2>&1; then
    node - "$manifest_path" "$repo" <<'NODE'
const fs = require('fs');

const [manifestPath, repo] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const entry = Array.isArray(manifest.upstreamSkills)
  ? manifest.upstreamSkills.find((item) => item && item.repo === repo)
  : null;

if (!entry) {
  console.error(`Missing upstream repo in curated-skills.json: ${repo}`);
  process.exit(2);
}

if (typeof entry.commit !== 'string' || entry.commit.length === 0) {
  console.error(`Missing pinned commit in curated-skills.json for ${repo}`);
  process.exit(2);
}

process.stdout.write(entry.commit);
NODE
    return
  fi

  awk -v repo="$repo" '
    BEGIN { found = 0 }
    index($0, "\"repo\"") && index($0, "\"" repo "\"") {
      found = 1
      next
    }
    found && index($0, "\"commit\"") {
      line = $0
      sub(/^.*"commit"[[:space:]]*:[[:space:]]*"/, "", line)
      sub(/".*$/, "", line)
      if (line != "") {
        print line
        exit 0
      }
    }
    END {
      if (!found) {
        print "Missing upstream repo in curated-skills.json: " repo > "/dev/stderr"
        exit 2
      }
    }
  ' "$manifest_path"
}

# -- Skill lists per mode ---------------------------------------------------
local_skills_for_mode() {
  case "$1" in
    minimal) echo "enterprise-ai-dev karpathy-guidelines" ;;
    core) echo "enterprise-ai-dev karpathy-guidelines awesome-design-md caveman" ;;
    full) echo "enterprise-ai-dev karpathy-guidelines awesome-design-md caveman grill-me" ;;
    contributor) echo "" ;;
  esac
}

mattpocock_paths_for_mode() {
  case "$1" in
    minimal) echo "skills/engineering/tdd skills/engineering/diagnose" ;;
    core) echo "skills/engineering/tdd skills/engineering/diagnose skills/engineering/grill-with-docs skills/engineering/to-prd" ;;
    full) echo "skills/engineering/tdd skills/engineering/diagnose skills/engineering/grill-with-docs skills/engineering/to-prd skills/engineering/triage skills/engineering/improve-codebase-architecture skills/engineering/zoom-out skills/engineering/setup-matt-pocock-skills" ;;
    contributor) echo "skills/productivity/write-a-skill" ;;
  esac
}

obra_paths_for_mode() {
  case "$1" in
    minimal) echo "skills/brainstorming" ;;
    core) echo "skills/brainstorming skills/writing-plans skills/executing-plans skills/verification-before-completion" ;;
    full) echo "skills/brainstorming skills/writing-plans skills/executing-plans skills/verification-before-completion skills/requesting-code-review skills/finishing-a-development-branch" ;;
    contributor) echo "" ;;
  esac
}

openai_paths_for_mode() {
  case "$1" in
    minimal) echo "" ;;
    core) echo "skills/.curated/security-best-practices" ;;
    full) echo "skills/.curated/security-best-practices skills/.curated/security-threat-model" ;;
    contributor) echo "" ;;
  esac
}

# -- Target resolution ------------------------------------------------------
resolve_dest_roots() {
  local targets="$1"
  local expanded=()
  IFS=',' read -ra requested <<< "$targets"
  for target in "${requested[@]}"; do
    case "$target" in
      all)
        expanded+=(codex claude cursor antigravity)
        ;;
      codex|claude|cursor|antigravity)
        expanded+=("$target")
        ;;
      *)
        echo "Unknown target: $target" >&2
        exit 1
        ;;
    esac
  done

  printf '%s\n' "${expanded[@]}" | awk '!seen[$0]++'
}

target_to_dir() {
  local target="$1"
  case "$target" in
    codex) echo "${CODEX_HOME:-$HOME/.codex}/skills" ;;
    claude) echo "$HOME/.claude/skills" ;;
    cursor) echo "$HOME/.cursor/skills" ;;
    antigravity) echo "$HOME/.gemini/antigravity/skills" ;;
  esac
}

# -- Copy helpers -----------------------------------------------------------
normalize_skill() {
  local skill_path="$1"
  local skill_md="$skill_path/SKILL.md"
  [[ -f "$skill_md" ]] || { echo "Missing SKILL.md in $skill_path" >&2; exit 1; }
  sed -i.bak '/^disable-model-invocation:[[:space:]]*true$/d' "$skill_md"
  rm -f "$skill_md.bak"
}

copy_skill() {
  local source="$1"
  local name="$2"
  local dest_root="$3"
  local dest="$dest_root/$name"

  if [[ -e "$dest" && "$FORCE" != "1" ]]; then
    echo "  skip  $name (exists; use --force to overwrite)"
    return
  fi
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "  dry   $name -> $dest"
    if [[ "$name" == "enterprise-ai-dev" ]]; then echo "  dry   enterprise-ai-dev/runtime -> $dest/runtime"; fi
    return
  fi
  rm -rf "$dest"
  mkdir -p "$(dirname "$dest")"
  cp -R "$source" "$dest"
  normalize_skill "$dest"
  echo "  added $name"
  if [[ "$name" == "enterprise-ai-dev" ]]; then install_runtime "$dest/runtime"; fi
}

# The orchestrator skill carries the deterministic runtime (gates, verify, learn,
# sandbox) plus schemas, templates, and references, so installed agents can run
# the controls instead of only reading about them.
RUNTIME_SCRIPTS="buildloop.mjs gate-runner.mjs verify.mjs learn.mjs init.mjs receipt.mjs detect-capabilities.mjs sandbox-run.mjs validate-manifest.mjs"

install_runtime() {
  local dest="$1"
  mkdir -p "$dest/scripts"
  for script in $RUNTIME_SCRIPTS; do
    cp "$repo_root/scripts/$script" "$dest/scripts/$script"
  done
  for dir in schemas templates reference; do
    cp -R "$repo_root/$dir" "$dest/$dir"
  done
  echo "  added enterprise-ai-dev/runtime (scripts, schemas, templates, reference)"
}

copy_command() {
  local source="$1"
  local name="$2"
  local dest_root="$3"
  local dest="$dest_root/$name.md"

  if [[ -e "$dest" && "$FORCE" != "1" ]]; then
    echo "  skip  /$name (exists; use --force to overwrite)"
    return
  fi
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "  dry   /$name -> $dest"
    return
  fi
  mkdir -p "$dest_root"
  cp "$source" "$dest"
  echo "  added /$name"
}

target_to_command_dir() {
  local target="$1"
  case "$target" in
    claude) echo "$HOME/.claude/commands" ;;
    *) echo "" ;;
  esac
}

install_commands_for_target() {
  local target="$1"
  local command_root
  command_root="$(target_to_command_dir "$target")"
  if [[ -z "$command_root" ]]; then return; fi

  echo
  echo "[$target] Installing slash command aliases..."
  for command_name in orchestrator buildloop; do
    local source="$repo_root/commands/claude/$command_name.md"
    if [[ ! -f "$source" ]]; then
      echo "  Warning: Claude command not found: $command_name - skipping" >&2
      continue
    fi
    copy_command "$source" "$command_name" "$command_root"
  done
}

install_from_repo() {
  local repo="$1"
  local dest_root="$2"
  shift 2
  local paths=("$@")
  local pinned_commit

  if [[ ${#paths[@]} -eq 0 ]]; then return; fi

  pinned_commit="$(get_pinned_commit "$repo")"
  if ! is_full_sha "$pinned_commit"; then
    echo "Refusing to install $repo: curated-skills.json commit must be a full 40-character SHA, got '$pinned_commit'." >&2
    exit 1
  fi

  if [[ "$DRY_RUN" == "1" ]]; then
    echo "  pin   $repo@$pinned_commit"
    for path in "${paths[@]}"; do
      local name="$(basename "$path")"
      echo "  dry   $name -> $dest_root/$name"
    done
    return
  fi

  local temp
  temp="$(mktemp -d)"
  echo "  fetching $repo@$pinned_commit..."
  if ! git init -q "$temp"; then
    echo "git init failed for $repo" >&2
    rm -rf "$temp"
    exit 1
  fi
  if ! git -C "$temp" remote add origin "https://github.com/$repo.git"; then
    echo "git remote add failed for $repo" >&2
    rm -rf "$temp"
    exit 1
  fi
  if ! git -C "$temp" fetch -q --depth 1 origin "$pinned_commit"; then
    echo "git fetch failed for $repo@$pinned_commit" >&2
    rm -rf "$temp"
    exit 1
  fi
  if ! git -C "$temp" checkout -q --detach "$pinned_commit"; then
    echo "git checkout failed for $repo@$pinned_commit" >&2
    rm -rf "$temp"
    exit 1
  fi
  local checked_commit
  checked_commit="$(git -C "$temp" rev-parse HEAD)"
  if [[ "$checked_commit" != "$pinned_commit" ]]; then
    echo "Pinned checkout verification failed for $repo: expected $pinned_commit, got $checked_commit" >&2
    rm -rf "$temp"
    exit 1
  fi

  for path in "${paths[@]}"; do
    local source="$temp/$path"
    if [[ ! -d "$source" ]]; then
      echo "  Warning: Path not found in $repo: $path - skipping" >&2
      continue
    fi
    local name="$(basename "$path")"
    copy_skill "$source" "$name" "$dest_root"
  done
  rm -rf "$temp"
}

# -- Main -------------------------------------------------------------------
resolved_targets=()
while IFS= read -r target; do
  resolved_targets+=("$target")
done < <(resolve_dest_roots "$TARGETS")

echo
echo "buildloop installer"
echo "  Mode   : $MODE"
echo "  Target : $TARGETS"
if [[ "$DRY_RUN" == "1" ]]; then echo "  DRY RUN - no files will be written"; fi
echo

for target in "${resolved_targets[@]}"; do
  dest_root="$(target_to_dir "$target")"
  if [[ "$DRY_RUN" != "1" ]]; then mkdir -p "$dest_root"; fi

  # Conflict detection reporting
  echo "[] Conflict Report (omitted, check manual output)..." >/dev/null

  # Local skills
  echo "[$target] Installing local skills..."
  for skill_name in $(local_skills_for_mode "$MODE"); do
    source="$repo_root/skills/$skill_name"
    if [[ ! -d "$source" ]]; then
      echo "  Warning: Local skill not found: $skill_name - skipping" >&2
      continue
    fi
    copy_skill "$source" "$skill_name" "$dest_root"
  done

  # Upstream skills
  echo
  echo "[$target] Installing upstream skills..."

  mattpocock_paths="$(mattpocock_paths_for_mode "$MODE")"
  if [[ -n "$mattpocock_paths" ]]; then
    install_from_repo "mattpocock/skills" "$dest_root" $mattpocock_paths
  fi

  obra_paths="$(obra_paths_for_mode "$MODE")"
  if [[ -n "$obra_paths" ]]; then
    install_from_repo "obra/superpowers" "$dest_root" $obra_paths
  fi

  openai_paths="$(openai_paths_for_mode "$MODE")"
  if [[ -n "$openai_paths" ]]; then
    install_from_repo "openai/skills" "$dest_root" $openai_paths
  fi

  install_commands_for_target "$target"

  echo
done

echo "Done. Restart your AI coding agent to pick up new skills."
echo
echo "Install modes available: minimal | core (default) | full | contributor"
echo "Usage: ./scripts/install.sh --target antigravity --mode full"
