#!/usr/bin/env bash
# Open one 'igniter serve' pane per repo inside the factory Herdr session.
# Idempotent: repos that already have a live serve pane are left alone, and
# a success line is printed only after the server's port answers.
# A pane we labelled ourselves whose serve died is restarted in place;
# any other pane without a serve is left alone and reported.
#
# Which repos: ~/.config/igniter/repos, one path per line ('#' comments and
# blank lines ignored). Each repo's port comes from its own
# .igniter/config.yaml 'listen' key (HOST:PORT, :PORT, or PORT); when the key
# is absent the default port is used. (The listen schema itself arrives with
# STA-168; until then 'igniter serve' binds its default interface.)
# Secrets (LINEAR_API_KEY) come from ~/.config/igniter/env, sourced before
# starting each server. Nothing here prints a secret.
#
# Environment overrides:
#   FACTORY_SESSION  Herdr session name (default: factory)
#   FACTORY_DEFAULT_PORT  port when no listen key exists (default: 3457)
#   FACTORY_DRY_RUN=1  print what would change without opening or starting anything
set -euo pipefail

FACTORY_SESSION="${FACTORY_SESSION:-factory}"
DEFAULT_PORT="${FACTORY_DEFAULT_PORT:-3457}"
ENV_FILE="$HOME/.config/igniter/env"
REPOS_FILE="$HOME/.config/igniter/repos"

say() { printf '%s\n' "$*"; }

if ! command -v herdr >/dev/null 2>&1; then
  say "missing: herdr is not installed; run scripts/install.sh first"
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  say "missing: curl is required to confirm a server came up; run scripts/install.sh first"
  exit 1
fi

# pane_rows_for_cwd prints one "pane_id<TAB>label" line per pane in the
# session whose cwd is $1. The label is what 'pane rename' sets, so it is
# the ownership mark factory-up itself leaves; the terminal title is the
# shell's prompt string and never equals it. herdr prints a JSON envelope;
# node (guaranteed by install.sh) parses it. Both sides go through realpath
# first: herdr reports the canonical cwd (/tmp arrives as /private/tmp), so a raw string
# comparison would miss.
pane_rows_for_cwd() {
  local want="$1"
  herdr --session "$FACTORY_SESSION" pane list 2>/dev/null | node -e "
const fs = require('fs');
const norm = (s) => { try { return fs.realpathSync(s); } catch { return s; }; };
const want = norm(process.argv[1]);
let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  let rows = [];
  try {
    const panes = JSON.parse(raw).result.panes || [];
    rows = panes
      .filter((p) => norm(p.cwd) === want)
      .map((p) => p.pane_id + '\t' + (p.label || ''));
  } catch { rows = []; }
  process.stdout.write(rows.join('\n'));
});
" "$want"
}

# pane_command prints the foreground commands of a pane (empty when unknown).
pane_command() {
  local pane="$1"
  herdr --session "$FACTORY_SESSION" pane process-info --pane "$pane" 2>/dev/null | node -e "
let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  let cmd = '';
  try {
    const procs = (JSON.parse(raw).result.process_info || {}).foreground_processes || [];
    cmd = procs.map((p) => p.cmdline || (p.argv || []).join(' ')).join('; ');
  } catch { cmd = ''; }
  process.stdout.write(cmd);
});
"
}

# listen_port prints the port from a repo's .igniter/config.yaml listen key,
# or the default when the key is absent.
listen_port() {
  local repo="$1" listen=""
  listen="$(grep -E '^[[:space:]]*listen[[:space:]]*:' "$repo/.igniter/config.yaml" 2>/dev/null | head -1 | sed -E 's/^[^:]*:[[:space:]]*//; s/[\"'\'']//g; s/[[:space:]]*$//' || true)"
  if [ -z "$listen" ]; then
    printf '%s' "$DEFAULT_PORT"
    return 0
  fi
  # HOST:PORT, :PORT, or bare PORT -> take everything after the last colon.
  printf '%s' "${listen##*:}"
}

# pane_idle_shell reports 0 when a pane_command string is just a shell
# sitting at its prompt (no serve, no agent, nothing else running).
pane_idle_shell() {
  local first base
  first="${1%% *}"
  base="${first##*/}"
  base="${base#-}"
  case "$base" in
    sh|bash|zsh|fish|dash) return 0 ;;
    *) return 1 ;;
  esac
}

# wait_for_port polls the serve health endpoint until it answers.
wait_for_port() {
  local port="$1" i
  for ((i = 0; i < 15; i++)); do
    if curl -sf -o /dev/null "http://localhost:${port}/api/health" 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

# start_serve_in_pane runs the serve command in an existing pane and only
# claims success once the port answers. $4 is the verb for the report
# (opened for a new pane, restarted for a reused one).
start_serve_in_pane() {
  local pane="$1" repo="$2" port="$3" name="$4" verb="$5"
  herdr --session "$FACTORY_SESSION" pane rename "$pane" "$name" >/dev/null || {
    say "failed: rename pane $pane to $name"
    return 1
  }
  herdr --session "$FACTORY_SESSION" pane run "$pane" igniter serve --port "$port" >/dev/null || {
    say "failed: start 'igniter serve --port $port' in pane $pane"
    return 1
  }
  if wait_for_port "$port"; then
    say "$verb: $name pane ($pane) serving $repo on port $port"
    return 0
  fi
  say "failed: pane $pane never served http://localhost:${port}/api/health; last pane output:"
  herdr --session "$FACTORY_SESSION" pane read "$pane" --lines 20 2>/dev/null || true
  return 1
}

open_serve_pane() {
  local repo="$1" port="$2" name="$3"
  local pane
  if [ "$DRY" = "1" ]; then
    say "would open: serve pane for $repo (port $port)"
    return 0
  fi
  # workspace create answers the root pane id at .result.root_pane.pane_id.
  # It works in a session with no panes yet, where pane split has nothing
  # to split from, and the id comes from herdr itself, so no cwd
  # canonicalization mismatch can orphan an unlabelled pane.
  pane="$(herdr --session "$FACTORY_SESSION" workspace create --cwd "$repo" --label "$name" --no-focus 2>/dev/null | node -e "
let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  let id = '';
  try {
    id = JSON.parse(raw).result.root_pane.pane_id || '';
  } catch { id = ''; }
  process.stdout.write(id);
});
" || true)"
  if [ -z "$pane" ]; then
    say "failed: could not open a workspace for $repo; start 'igniter serve --port $port' in the '$FACTORY_SESSION' session by hand"
    return 1
  fi
  start_serve_in_pane "$pane" "$repo" "$port" "$name" "opened"
}

DRY="${FACTORY_DRY_RUN:-0}"

main() {
  if [ ! -f "$REPOS_FILE" ]; then
    say "missing: $REPOS_FILE; run scripts/install.sh first"
    exit 1
  fi
  if [ -f "$ENV_FILE" ]; then
    # shellcheck disable=SC1090,SC1091
    . "$ENV_FILE"
  else
    say "warn: $ENV_FILE not found; servers start without LINEAR_API_KEY"
  fi
  if command -v tailscale >/dev/null 2>&1; then
    tailscale_ip="$(tailscale ip -4 2>/dev/null | head -1 || true)"
    if [ -n "$tailscale_ip" ]; then
      say "tailscale: $tailscale_ip"
    else
      say "tailscale: not connected (run 'sudo tailscale up' by hand)"
    fi
  fi
  local repo name port rows id title cmd alive orphan failed tailscale_ip
  alive=0
  failed=0
  while IFS= read -r repo || [ -n "$repo" ]; do
    case "$repo" in
      ''|\#*) continue ;;
    esac
    if [ ! -d "$repo" ]; then
      say "missing: repo dir $repo (skipped)"
      failed=1
      continue
    fi
    name="$(basename "$repo")"
    port="$(listen_port "$repo")"
    rows="$(pane_rows_for_cwd "$repo" || true)"
    alive=0
    orphan=""
    if [ -n "$rows" ]; then
      while IFS=$'\t' read -r id title; do
        [ -z "$id" ] && continue
        cmd="$(pane_command "$id" || true)"
        case "$cmd" in
          *igniter*serve*)
            say "skip: $name already serving in pane $id"
            alive=1
            break
            ;;
        esac
        # Our own labelled pane with a dead serve and an idle shell is an
        # orphan we may restart. Anything else (no label, or a foreground
        # that is not a bare shell) may be someone's work: never touch it.
        if [ -z "$orphan" ] && [ "$title" = "$name" ] && pane_idle_shell "$cmd"; then
          orphan="$id"
        fi
      done <<<"$rows"
    fi
    if [ "$alive" = "1" ]; then
      continue
    elif [ -n "$orphan" ]; then
      if [ "$DRY" = "1" ]; then
        say "would restart: serve in our pane $orphan for $name (port $port)"
      else
        say "reuse: serve died in our pane $orphan for $name; restarting"
        start_serve_in_pane "$orphan" "$repo" "$port" "$name" "restarted" || failed=1
      fi
    elif [ -n "$rows" ]; then
      say "warn: pane(s) in $repo run no 'igniter serve' and are not ours to reuse; close them (or start serve inside) and rerun"
      failed=1
    else
      open_serve_pane "$repo" "$port" "$name" || failed=1
    fi
  done <"$REPOS_FILE"
  if [ "$failed" != "0" ]; then
    say "factory-up: FAIL (see warnings above)"
    exit 1
  fi
  say "factory-up: done"
}

main "$@"
