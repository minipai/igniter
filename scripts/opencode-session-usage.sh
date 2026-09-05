#!/usr/bin/env bash
# Report OpenCode session token usage for one repository.
#
#   scripts/opencode-session-usage.sh <repo path> <since ms>
#   scripts/opencode-session-usage.sh            # igniter stage contract
#
# The two-argument form prints two lines: the summed `tokens_input` and the
# completed-compaction count for sessions whose `directory` is the repo path
# or below it and whose `time_updated >= since` (both in the OpenCode
# SQLite database). The no-argument form prints only the first line, a
# single integer, which is what `igniter stage` (`defaultReadUsage` in
# src/stage/stage.ts) accepts. With no arguments the repo defaults to the
# current directory and `since` to 0.
#
# Read-only: opens the database with `sqlite3 -readonly` and never writes.
# `OPENCODE_DB` overrides the database path (tests point it at a fixture).
set -uo pipefail

DB="${OPENCODE_DB:-$HOME/.local/share/opencode/opencode.db}"

if ! command -v sqlite3 >/dev/null 2>&1; then
  printf 'opencode-session-usage: sqlite3 not found\n' >&2
  exit 1
fi
if [ ! -f "$DB" ]; then
  printf 'opencode-session-usage: database not found: %s\n' "$DB" >&2
  exit 1
fi

REPO="${1:-$(pwd -P)}"
SINCE="${2:-0}"
# Match the repo itself or anything below it, never a sibling prefix
# (e.g. sta-176-wt must not match sta-176).
REPO="${REPO%/}"
REPO_ESCAPED="${REPO//\'/\'\'}"
# LIKE wildcards in the path must match literally: escape the escape
# character first, then % and _.
REPO_LIKE="${REPO_ESCAPED//\\/\\\\}"
REPO_LIKE="${REPO_LIKE//%/\\%}"
REPO_LIKE="${REPO_LIKE//_/\\_}"
DIR_MATCH="(directory = '$REPO_ESCAPED' OR directory LIKE '$REPO_LIKE' || '/%' ESCAPE '\\')"

case "$SINCE" in
  ''|*[!0-9]*) printf 'opencode-session-usage: since must be epoch ms, got: %s\n' "$SINCE" >&2; exit 1;;
esac

# Tokens count `tokens_input` only: cache-read tokens are context reuse,
# not fresh spend against the budget. Subagent sessions (parent_id set)
# are included: they spend tokens too. Compactions are counted from
# `part` rows with type compaction; `session.time_compacting` is only a
# transient in-progress marker (NULL once finished) and is not a counter.
TOKENS_SQL="SELECT COALESCE(SUM(tokens_input), 0) FROM session WHERE $DIR_MATCH AND time_updated >= $SINCE;"
COMPACTIONS_SQL="SELECT COUNT(*) FROM part WHERE json_extract(data, '\$.type') = 'compaction' AND session_id IN (SELECT id FROM session WHERE $DIR_MATCH AND time_updated >= $SINCE);"

run_query() {
  local sql="$1"
  local out
  if out="$(sqlite3 -readonly -batch -noheader "$DB" "$sql" 2>/dev/null)"; then
    printf '%s' "$out"
    return 0
  fi
  sleep 1
  if out="$(sqlite3 -readonly -batch -noheader "$DB" "$sql" 2>/dev/null)"; then
    printf '%s' "$out"
    return 0
  fi
  return 1
}

if ! TOKENS="$(run_query "$TOKENS_SQL")"; then
  printf 'opencode-session-usage: query failed (database busy or unreadable): %s\n' "$DB" >&2
  exit 1
fi
printf '%s\n' "$TOKENS"

if [ "$#" -ge 2 ]; then
  if ! COMPACTIONS="$(run_query "$COMPACTIONS_SQL")"; then
    printf 'opencode-session-usage: query failed (database busy or unreadable): %s\n' "$DB" >&2
    exit 1
  fi
  printf '%s\n' "$COMPACTIONS"
fi
