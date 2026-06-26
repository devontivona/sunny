#!/usr/bin/env bash
#
# migrate-runtime-home.sh — one-time migration of a legacy `~/.sunny` to the
# runtime-home topology (runtime-home change).
#
# Legacy layout (what this migrates FROM):
#   ~/.sunny/.git            ← ~/.sunny is itself a git repo
#   ~/.sunny/config.json     ← tracked
#   ~/.sunny/.gitignore      ← tracked, ignores skills/
#   ~/.sunny/memory/         ← tracked
#   ~/.sunny/credentials.json← untracked
#   ~/.sunny/sites/          ← untracked
#   ~/.sunny/skills/authored ← nested clone (the embedded-repo antipattern)
#
# Target layout (what this migrates TO):
#   ~/.sunny/                ← plain namespace dir, NO top-level .git
#   ~/.sunny/config.json     ← local, unsynced bootstrap (untracked, stays put)
#   ~/.sunny/state/.git      ← the `state` repo (private remote)
#   ~/.sunny/state/memory/   ← tracked (history preserved from the moved .git)
#   ~/.sunny/state/credentials.json, sites/ ← tracked
#   ~/.sunny/skills/, media/ ← independent siblings (unchanged)
#
# GUARDED + IDEMPOTENT: it only acts when `~/.sunny/.git` is the top-level repo, and
# refuses if `state/` already looks migrated. The original `.git` is backed up to
# `.git.legacy-bak` and preserved until you verify — that's the rollback.
#
# PREREQUISITES (do these first — see the proposal's Migration Plan):
#   1. Stop the Sunny service (so nothing writes mid-migration).
#   2. The private state remote must already exist (e.g. github.com/devontivona/sunny-state),
#      passed via SUNNY_STATE_REPO or already set in ~/.sunny/config.json's state.repo.
#   3. The canonical skills repo must already be restructured to `skills/<name>/` and pushed,
#      so the authored re-clone (final step) lands as authored/skills/<name>/.
#
# Usage:
#   SUNNY_STATE_REPO=devontivona/sunny-state ./scripts/migrate-runtime-home.sh           # migrate
#   DRY_RUN=1 ./scripts/migrate-runtime-home.sh                                          # print only
#   ./scripts/migrate-runtime-home.sh --reclone-skills devontivona/skills               # also re-clone authored
set -euo pipefail

HOME_DIR="${SUNNY_HOME:-$HOME/.sunny}"
STATE_DIR="$HOME_DIR/state"
DRY_RUN="${DRY_RUN:-0}"

run() {
  echo "+ $*"
  if [[ "$DRY_RUN" != "1" ]]; then "$@"; fi
}

git_state() { git -C "$STATE_DIR" "$@"; }

# Resolve the state remote: explicit env wins, else read config.json's state.repo.
resolve_state_repo() {
  if [[ -n "${SUNNY_STATE_REPO:-}" ]]; then echo "$SUNNY_STATE_REPO"; return; fi
  if [[ -f "$HOME_DIR/config.json" ]] && command -v node >/dev/null; then
    node -e "try{process.stdout.write((require('$HOME_DIR/config.json').state?.repo)||'')}catch{}" || true
  fi
}

# Expand owner/repo shorthand to a clone URL (mirrors cloneUrl / repoUrl).
clone_url() {
  case "$1" in
    https://*|git@*|ssh://*|file://*|/*|./*|../*) echo "$1" ;;
    *) echo "https://github.com/$1.git" ;;
  esac
}

# --- guards ----------------------------------------------------------------
if [[ ! -d "$HOME_DIR/.git" ]]; then
  echo "Nothing to migrate: $HOME_DIR has no top-level .git (already migrated, or a fresh host)." >&2
  exit 0
fi
if [[ -e "$STATE_DIR/.git" ]]; then
  echo "Refusing to run: $STATE_DIR/.git already exists — looks already migrated." >&2
  exit 1
fi

STATE_REPO="$(resolve_state_repo || true)"
if [[ -z "$STATE_REPO" ]]; then
  echo "WARNING: no state remote (SUNNY_STATE_REPO unset and config.json has no state.repo)." >&2
  echo "         Migration will proceed LOCAL-ONLY (no remote configured, no push)." >&2
fi

echo "==> Migrating $HOME_DIR to the runtime-home topology"
[[ "$DRY_RUN" == "1" ]] && echo "    (DRY RUN — no changes will be made)"
echo "    state remote: ${STATE_REPO:-(none)}"

# --- 1. assemble state/ ----------------------------------------------------
run mkdir -p "$STATE_DIR"

# Move durable state into state/. memory/ is tracked (git mv preserves it once .git
# is relocated); credentials.json + sites/ are untracked, plain mv.
[[ -e "$HOME_DIR/memory" ]]           && run mv "$HOME_DIR/memory" "$STATE_DIR/memory"
[[ -e "$HOME_DIR/credentials.json" ]] && run mv "$HOME_DIR/credentials.json" "$STATE_DIR/credentials.json"
[[ -e "$HOME_DIR/sites" ]]            && run mv "$HOME_DIR/sites" "$STATE_DIR/sites"

# 5.2: drop the stray test fixture if present.
[[ -e "$HOME_DIR/test-image.jpg" ]] && run rm -f "$HOME_DIR/test-image.jpg"

# --- 2. relocate .git to back state/ (history preserved) -------------------
# Back up the original first — this is the rollback until verification passes.
run cp -a "$HOME_DIR/.git" "$HOME_DIR/.git.legacy-bak"
run mv "$HOME_DIR/.git" "$STATE_DIR/.git"

# The relocated index still tracks the old root paths (config.json, .gitignore).
# Untrack them: config.json becomes the local bootstrap (stays in ~/.sunny), and the
# legacy `skills/` ignore (5.1) is no longer needed now that nothing nests under a
# tracked tree. `--cached` leaves any in-worktree file alone.
run git_state rm --cached --quiet --ignore-unmatch config.json .gitignore
# 5.1: remove the legacy top-level skills/ ignore file outright.
[[ -e "$HOME_DIR/.gitignore" ]] && run rm -f "$HOME_DIR/.gitignore"

# --- 3. wire the private remote + commit ----------------------------------
if [[ -n "$STATE_REPO" ]]; then
  URL="$(clone_url "$STATE_REPO")"
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "+ git -C $STATE_DIR remote add/set-url origin $URL"
  elif git_state remote | grep -qx origin 2>/dev/null; then
    run git_state remote set-url origin "$URL"
  else
    run git_state remote add origin "$URL"
  fi
fi
run git_state add -A
run git_state commit -q -m "migrate: relocate state into ~/.sunny/state (runtime-home)" || true
if [[ -n "$STATE_REPO" ]]; then
  echo "+ git -C $STATE_DIR push -u origin HEAD   (best-effort)"
  if [[ "$DRY_RUN" != "1" ]]; then
    git_state push -u origin HEAD || echo "  (push failed — commit is local; push later once the remote is reachable)" >&2
  fi
fi

# --- 4. re-point the authored skills clone (optional) ----------------------
# Only meaningful AFTER the canonical skills repo is restructured to skills/<name>/.
if [[ "${1:-}" == "--reclone-skills" && -n "${2:-}" ]]; then
  SKILLS_URL="$(clone_url "$2")"
  echo "==> Re-cloning authored skills from $SKILLS_URL (so it lands as authored/skills/<name>/)"
  run rm -rf "$HOME_DIR/skills/authored"
  run git clone --quiet "$SKILLS_URL" "$HOME_DIR/skills/authored"
fi

# --- 5. verify (6.3) -------------------------------------------------------
echo "==> Post-migration checks"
[[ ! -d "$HOME_DIR/.git" ]] && echo "  OK: no top-level ~/.sunny/.git" || echo "  WARN: ~/.sunny/.git still present"
[[ -d "$STATE_DIR/.git" ]] && echo "  OK: state/ is a git repo" || echo "  WARN: state/ is not a git repo"
if [[ "$DRY_RUN" != "1" && -d "$STATE_DIR/.git" ]]; then
  if [[ -z "$(git_state status --porcelain)" ]]; then echo "  OK: state working tree clean"; else echo "  WARN: state tree dirty"; fi
fi
echo
echo "Done. Verify Sunny boots, a memory edit lands in 'git -C $STATE_DIR log', and an"
echo "authored skill round-trips to the canonical repo. THEN remove the backup:"
echo "    rm -rf $HOME_DIR/.git.legacy-bak"
echo "On failure, roll back:  mv $STATE_DIR/.git -; mv $HOME_DIR/.git.legacy-bak $HOME_DIR/.git"
