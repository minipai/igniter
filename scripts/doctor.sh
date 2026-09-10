#!/usr/bin/env bash
# Check everything scripts/install.sh is responsible for and print a
# green/red list. Read-only: changes nothing. Exit 0 when all green,
# 1 when anything is red.
#
# Environment overrides mirror install.sh:
#   FACTORY_SESSION, FACTORY_DIR
set -uo pipefail

FACTORY_SESSION="${FACTORY_SESSION:-factory}"
FACTORY_DIR="${FACTORY_DIR:-$HOME/igniter}"
ENV_FILE="$HOME/.config/igniter/env"

RED=0
GREEN='\033[32m'
RED_C='\033[31m'
RESET='\033[0m'

say() { printf '%s\n' "$*"; }
ok() { printf "${GREEN}ok${RESET}   %s\n" "$*"; }
bad() { printf "${RED_C}FAIL${RESET} %s\n" "$*"; RED=1; }

have() { command -v "$1" >/dev/null 2>&1; }

check_present() {
  if have "$1"; then
    ok "$1 present"
  else
    bad "$1 missing (run scripts/install.sh)"
  fi
}

check_node() {
  local major
  if ! have node; then
    bad "node missing (need >= 22)"
    return 0
  fi
  major="$(node --version | sed -E 's/^v([0-9]+).*/\1/')"
  if [ -n "$major" ] && [ "$major" -ge 22 ] 2>/dev/null; then
    ok "node $(node --version) >= 22"
  else
    bad "node $(node --version) too old (need >= 22)"
  fi
}

check_chromium() {
  if have chromium || have chromium-browser || have google-chrome || have google-chrome-stable; then
    ok "chromium present"
  else
    bad "no chromium binary (run scripts/install.sh)"
  fi
}

check_igniter() {
  local igniter_out
  if [ -d "$FACTORY_DIR/.git" ]; then
    ok "igniter checkout at $FACTORY_DIR"
  else
    bad "no igniter checkout at $FACTORY_DIR"
  fi
  # A bare have check passes a linked-but-broken bin entry, so run the
  # command and look for its usage line, the way install.sh verifies it.
  # Its output never reaches the report.
  if ! have igniter; then
    bad "igniter command not on PATH (rerun install.sh)"
    return 0
  fi
  # 'igniter --help' exits 1 by design (usage goes to stderr), so capture
  # first and let grep alone decide.
  igniter_out="$(igniter --help 2>&1 || true)"
  if printf '%s' "$igniter_out" | grep -q 'usage: igniter'; then
    ok "igniter command runs"
  else
    bad "igniter on PATH but does not run (rerun install.sh)"
  fi
}

check_env_file() {
  if [ ! -f "$ENV_FILE" ]; then
    bad "$ENV_FILE missing"
    return 0
  fi
  ok "$ENV_FILE exists"
  local mode
  mode="$(stat -c '%a' "$ENV_FILE" 2>/dev/null || stat -f '%Lp' "$ENV_FILE" 2>/dev/null || true)"
  if [ "$mode" = "600" ]; then
    ok "$ENV_FILE mode 600"
  else
    bad "$ENV_FILE mode $mode (want 600)"
  fi
}

# ni_resolve reports 0 when a non-interactive shell finds the named tool.
# Factory consumers (ssh commands and agent runners) never see an
# interactive shell, so resolving here must not depend on one either: Linux
# sources exactly the rc files install.sh writes (bash reads ~/.bashrc even
# non-interactively over ssh, before its guard), while zsh always reads
# ~/.zshenv on its own. Login shells are covered by the same files.
ni_resolve() {
  if [ "$(uname -s)" = "Darwin" ]; then
    if ! have zsh; then
      return 1
    fi
    env -i HOME="$HOME" PATH=/usr/bin:/bin "WANT=$1" zsh -c 'command -v "$WANT" >/dev/null 2>&1' 2>/dev/null
  else
    if ! have bash; then
      return 1
    fi
    env -i HOME="$HOME" PATH=/usr/bin:/bin "WANT=$1" bash -c '
      { [ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"; } >/dev/null 2>&1
      { [ -f "$HOME/.profile" ] && . "$HOME/.profile"; } >/dev/null 2>&1
      command -v "$WANT" >/dev/null 2>&1
    ' 2>/dev/null
  fi
}

check_shell_path() {
  local t missing=""
  for t in herdr node pnpm bun opencode claude codex agent-browser git gh tailscale curl igniter; do
    if ! ni_resolve "$t"; then
      missing="$missing $t"
    fi
  done
  if ! ni_resolve chromium && ! ni_resolve chromium-browser && ! ni_resolve google-chrome && ! ni_resolve google-chrome-stable; then
    missing="$missing chromium"
  fi
  if [ -z "$missing" ]; then
    ok "non-interactive shells resolve every tool"
  else
    bad "non-interactive shells cannot find:$missing (rerun install.sh)"
  fi
}

# Login state for the three tools install.sh names. Each probe is read-only
# and prints nothing but ok/FAIL: tokens and emails never reach the output.
check_opencode_login() {
  if ! have opencode; then
    bad "opencode not installed (login unchecked)"
    return 0
  fi
  # 'opencode auth list' prints one ● line per stored credential.
  if opencode auth list 2>/dev/null | grep -q '●'; then
    ok "opencode logged in"
  else
    bad "opencode needs login: opencode auth login"
  fi
}

check_claude_login() {
  if ! have claude; then
    bad "claude not installed (login unchecked)"
    return 0
  fi
  # 'claude auth status' prints JSON with a loggedIn boolean.
  if claude auth status 2>/dev/null | node -e "
let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  let loggedIn = false;
  try { loggedIn = JSON.parse(raw).loggedIn === true; } catch { loggedIn = false; }
  process.exit(loggedIn ? 0 : 1);
});
"; then
    ok "claude logged in"
  else
    bad "claude needs login: run 'claude' once and finish the browser login"
  fi
}

check_gh_login() {
  if ! have gh; then
    bad "gh not installed (login unchecked)"
    return 0
  fi
  if gh auth status >/dev/null 2>&1; then
    ok "gh logged in"
  else
    bad "gh needs login: gh auth login"
  fi
}

check_pnpm_store() {
  if ! have pnpm; then
    bad "pnpm missing (store-dir unchecked)"
    return 0
  fi
  local current want
  want="${FACTORY_PNPM_STORE:-$HOME/.local/share/pnpm/store}"
  current="$(pnpm config get store-dir 2>/dev/null || true)"
  if [ "$current" = "undefined" ] || [ -z "$current" ]; then
    current="(unset)"
  fi
  if [ "$current" = "$want" ]; then
    ok "pnpm store-dir shared ($want)"
  else
    bad "pnpm store-dir is '$current' (want '$want')"
  fi
}

check_persist_linux() {
  if loginctl show-user "$USER" 2>/dev/null | grep -q '^Linger=yes'; then
    ok "linger enabled for $USER"
  else
    bad "linger off for $USER"
  fi
  if [ -f "$HOME/.config/systemd/user/factory.slice" ]; then
    ok "factory.slice present"
  else
    bad "factory.slice missing"
  fi
  if systemctl --user is-enabled factory.service >/dev/null 2>&1; then
    ok "factory.service enabled"
  else
    bad "factory.service not enabled"
  fi
  if systemctl --user is-active factory.service >/dev/null 2>&1; then
    ok "factory.service active"
  else
    bad "factory.service not active"
  fi
}

check_persist_macos() {
  local plist="$HOME/Library/LaunchAgents/dev.igniter.factory.plist" pid
  if [ -f "$plist" ]; then
    ok "dev.igniter.factory plist present"
  else
    bad "dev.igniter.factory plist missing"
  fi
  # launchctl list shows known jobs, not live ones: a crash-looping agent
  # still appears. The PID column is '-' unless the job has a live process.
  pid="$(launchctl list 2>/dev/null | awk '$3 == "dev.igniter.factory" {print $1}')"
  if [ -n "$pid" ] && [ "$pid" != "-" ]; then
    ok "dev.igniter.factory alive (PID $pid)"
  else
    bad "dev.igniter.factory not running"
  fi
}

check_swap_linux() {
  if [ -n "${FACTORY_NO_SWAP:-}" ]; then
    ok "swap check skipped (FACTORY_NO_SWAP)"
    return 0
  fi
  if [ "$(tail -n +2 /proc/swaps 2>/dev/null | wc -l)" -gt 0 ]; then
    ok "swap active"
  else
    bad "no active swap"
  fi
}

main() {
  local os
  os="$(uname -s)"
  say "doctor: factory host ($os)"
  check_present herdr
  check_node
  check_present pnpm
  check_present bun
  check_present opencode
  check_present claude
  check_present codex
  check_present agent-browser
  check_chromium
  check_present git
  check_present curl
  check_present gh
  check_present tailscale
  check_igniter
  check_env_file
  check_shell_path
  check_opencode_login
  check_claude_login
  check_gh_login
  check_pnpm_store
  case "$os" in
    Linux)
      check_persist_linux
      check_swap_linux
      ;;
    Darwin)
      check_persist_macos
      ;;
    *)
      bad "unsupported OS $os"
      ;;
  esac
  if [ "$RED" -ne 0 ]; then
    say "doctor: FAIL"
    exit 1
  fi
  say "doctor: all green"
}

main "$@"
