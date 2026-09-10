#!/usr/bin/env bash
# Provision this machine as an igniter factory host: tools, an igniter
# checkout, a Herdr session that survives reboots, and a low-priority
# resource group for agents and dispatch.
#
# Idempotent: every mutation is guarded by a check, so re-running changes
# nothing. Detects the OS package manager (apt, brew) and branches on that,
# never on a hostname. Nothing here is specific to one machine.
#
# Reads no secrets and writes none: it creates ~/.config/igniter/env empty
# (mode 600) and the operator puts LINEAR_API_KEY in it by hand.
# Logins are never performed; the script ends by listing the exact commands.
#
# Environment overrides:
#   FACTORY_SESSION     Herdr session name (default: factory)
#   FACTORY_DIR         igniter checkout path (default: ~/igniter)
#   FACTORY_REPO        igniter git URL (default: github.com/minipai/igniter)
#   FACTORY_CPU_WEIGHT  factory.slice CPUWeight on Linux (default: 30)
#   FACTORY_NO_SWAP=1   skip the Linux swapfile step
#   FACTORY_DRY_RUN=1   print what would change without changing anything
set -euo pipefail

FACTORY_SESSION="${FACTORY_SESSION:-factory}"
FACTORY_DIR="${FACTORY_DIR:-$HOME/igniter}"
FACTORY_REPO="${FACTORY_REPO:-https://github.com/minipai/igniter.git}"
FACTORY_CPU_WEIGHT="${FACTORY_CPU_WEIGHT:-30}"
FACTORY_PNPM_STORE="${FACTORY_PNPM_STORE:-$HOME/.local/share/pnpm/store}"
DRY_RUN="${FACTORY_DRY_RUN:-0}"

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  echo "usage: install.sh   (FACTORY_DRY_RUN=1 prints the plan without changing anything)"
  exit 0
fi

say() { printf '%s\n' "$*"; }
skip() { say "skip: $*"; }
changed() {
  if [ "$DRY_RUN" = "1" ]; then
    say "planned: $*"
  else
    say "done: $*"
  fi
}

# run executes a mutation, or just prints it under FACTORY_DRY_RUN=1.
# Detection and version checks always run for real; only writes are gated.
run() {
  if [ "$DRY_RUN" = "1" ]; then
    say "would run: $*"
  else
    "$@"
  fi
}

# run_root is run with sudo when this script is not root.
run_root() {
  if [ -n "$SUDO" ]; then
    run "$SUDO" "$@"
  else
    run "$@"
  fi
}

# as_root executes immediately with sudo when not root.
as_root() {
  if [ -n "$SUDO" ]; then
    "$SUDO" "$@"
  else
    "$@"
  fi
}

FAILED=""
SLICE_CHANGED=0

# step runs one provisioning step by name. A failure is recorded and the run
# continues, so one broken step does not hide the rest; main() lists every
# failed step at the end and exits non-zero.
step() {
  local name="$1"
  shift
  if "$@"; then
    return 0
  fi
  say "recorded failure: $name (continuing)"
  if [ -z "$FAILED" ]; then
    FAILED="$name"
  else
    FAILED="$FAILED $name"
  fi
  return 0
}

have() { command -v "$1" >/dev/null 2>&1; }

OS="$(uname -s)"
SUDO=""
# Root is only ever needed on Linux (apt, /usr/bin shims, /usr/lib modules,
# swap, loginctl). On macOS everything lives in the user-owned brew prefix,
# where sudo would create root-owned files Homebrew explicitly warns about.
if [ "$OS" = "Linux" ] && [ "$(id -u)" -ne 0 ] && have sudo; then
  SUDO="sudo"
fi

# write_file writes stdin to a path only when the content differs, so a
# re-run is a no-op. Prints nothing when already current.
write_file() {
  local path="$1" tmp
  tmp="$(mktemp)"
  cat >"$tmp"
  if [ -f "$path" ] && cmp -s "$tmp" "$path"; then
    rm -f "$tmp"
    return 1
  fi
  if [ "$DRY_RUN" = "1" ]; then
    say "would write: $path"
    rm -f "$tmp"
    return 0
  fi
  mkdir -p "$(dirname "$path")"
  cat "$tmp" >"$path"
  rm -f "$tmp"
  return 0
}

node_major() {
  node --version 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/'
}

apt_update_once() {
  if [ "${APT_UPDATED:-0}" = "0" ]; then
    run_root apt-get update || return 1
    APT_UPDATED=1
  fi
}

apt_install() {
  apt_update_once || return 1
  run_root apt-get install -y "$@"
}

brew_install() {
  run brew install "$@"
}

# --- Node 22+ with pnpm -------------------------------------------------

ensure_node_apt() {
  local major
  major="$(node_major || true)"
  if [ -n "$major" ] && [ "$major" -ge 22 ] 2>/dev/null; then
    skip "node $(node --version) already >= 22"
    return 0
  fi
  say "install: node 22 (nodesource)"
  apt_update_once
  run_root apt-get install -y ca-certificates curl gnupg || {
    say "failed: apt-get install ca-certificates curl gnupg"
    return 1
  }
  if [ "$DRY_RUN" = "1" ]; then
    say "would run: nodesource setup_22.x | sudo bash, then apt-get install nodejs"
  elif [ -n "$SUDO" ]; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | "$SUDO" bash - || {
      say "failed: nodesource setup_22.x"
      return 1
    }
    "$SUDO" apt-get install -y nodejs || {
      say "failed: apt-get install nodejs"
      return 1
    }
  else
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - || {
      say "failed: nodesource setup_22.x"
      return 1
    }
    apt-get install -y nodejs || {
      say "failed: apt-get install nodejs"
      return 1
    }
  fi
  if [ "$DRY_RUN" = "1" ]; then
    changed "node 22"
  else
    changed "node $(node --version)"
  fi
}

ensure_node_brew() {
  local major
  major="$(node_major || true)"
  if [ -n "$major" ] && [ "$major" -ge 22 ] 2>/dev/null; then
    skip "node $(node --version) already >= 22"
    return 0
  fi
  brew_install node || {
    say "failed: brew install node"
    return 1
  }
  if [ "$DRY_RUN" = "1" ]; then
    changed "node 22"
  else
    changed "node $(node --version)"
  fi
}

ensure_pnpm() {
  if have pnpm; then
    skip "pnpm $(pnpm --version) already present"
    return 0
  fi
  say "install: pnpm (corepack)"
  # enable symlinks the pnpm shim into the install prefix's bin dir: /usr/bin
  # on Linux (needs root) but the user-owned brew prefix on macOS, where
  # run_root correctly runs unprivileged. prepare then pre-warms the
  # invoking user's own corepack cache either way.
  run_root corepack enable || {
    say "failed: corepack enable"
    return 1
  }
  run corepack prepare pnpm --activate || {
    say "failed: corepack prepare pnpm --activate"
    return 1
  }
  if [ "$DRY_RUN" = "1" ]; then
    changed "pnpm (latest stable via corepack)"
    return 0
  fi
  pnpm_ver="$(pnpm --version 2>/dev/null || true)"
  if [ -n "$pnpm_ver" ]; then
    changed "pnpm $pnpm_ver"
  else
    changed "pnpm installed (version unclear; run 'pnpm --version' by hand)"
  fi
}

share_pnpm_store() {
  local current
  current="$(pnpm config get store-dir 2>/dev/null || true)"
  if [ "$current" = "$FACTORY_PNPM_STORE" ]; then
    skip "pnpm store-dir already $FACTORY_PNPM_STORE"
    return 0
  fi
  run mkdir -p "$FACTORY_PNPM_STORE" || {
    say "failed: mkdir $FACTORY_PNPM_STORE"
    return 1
  }
  if [ "$DRY_RUN" = "1" ]; then
    say "would run: pnpm config set store-dir $FACTORY_PNPM_STORE"
  else
    pnpm config set store-dir "$FACTORY_PNPM_STORE" || {
      say "failed: pnpm config set store-dir $FACTORY_PNPM_STORE"
      return 1
    }
  fi
  changed "pnpm store-dir -> $FACTORY_PNPM_STORE"
}

# --- Bun, OpenCode, Claude Code, Codex, agent-browser ---------------------

# Bun's installer needs unzip, which clean Ubuntu images do not ship.
ensure_unzip_apt() {
  if have unzip; then
    skip "unzip already present"
    return 0
  fi
  apt_install unzip || {
    say "failed: apt-get install unzip"
    return 1
  }
  changed "unzip installed"
}

ensure_bun() {
  if have bun; then
    skip "bun $(bun --version) already present"
    return 0
  fi
  say "install: bun"
  if [ "$DRY_RUN" = "1" ]; then
    say "would run: curl https://bun.sh/install | bash"
  else
    curl -fsSL https://bun.sh/install | bash || {
      say "failed: bun install script"
      return 1
    }
  fi
  changed "bun installed (open a new shell for PATH)"
}

ensure_opencode() {
  if have opencode; then
    skip "opencode already present"
    return 0
  fi
  say "install: opencode"
  if [ "$DRY_RUN" = "1" ]; then
    say "would run: curl https://opencode.ai/install | bash"
  else
    curl -fsSL https://opencode.ai/install | bash || {
      say "failed: opencode install script"
      return 1
    }
  fi
  changed "opencode installed"
}

ensure_npm_tool() {
  local bin="$1" pkg="$2"
  if have "$bin"; then
    skip "$bin already present"
    return 0
  fi
  if ! have npm; then
    say "missing: node/npm is required for $pkg but was not installed; rerun after node works"
    return 1
  fi
  say "install: $pkg"
  # Installed for all users on Linux (binaries land in /usr/bin, on PATH for
  # doctor.sh and agent runners with no shell init changes); into the
  # user-owned brew prefix on macOS, where run_root runs unprivileged.
  run_root npm install -g "$pkg" || {
    say "failed: npm install -g $pkg"
    return 1
  }
  changed "$bin installed"
}

ensure_chromium_apt() {
  if have chromium || have chromium-browser || have google-chrome || have google-chrome-stable; then
    skip "a chromium binary already present"
    return 0
  fi
  # Ubuntu 24.04 ships chromium-browser as a snap shim; if snap is absent
  # this step warns and leaves the binary to the operator (doctor flags it).
  apt_install chromium-browser || {
    say "warn: apt chromium install failed; install a chromium build by hand"
    return 1
  }
  changed "chromium installed"
}

ensure_chromium_brew() {
  if have chromium || have chromium-browser || have google-chrome || have "/Applications/Chromium.app/Contents/MacOS/Chromium"; then
    skip "a chromium binary already present"
    return 0
  fi
  run brew install --cask chromium || {
    say "failed: brew install --cask chromium"
    return 1
  }
  changed "chromium installed"
}

ensure_herdr_apt() {
  if have herdr; then
    skip "herdr already present ($(herdr --version 2>/dev/null))"
    return 0
  fi
  say "install: herdr"
  if [ "$DRY_RUN" = "1" ]; then
    say "would run: curl https://herdr.dev/install | sh"
  else
    # POSIX installer; drops the binary into $HERDR_INSTALL_DIR,
    # default $HOME/.local/bin (on the factory PATH below).
    curl -fsSL https://herdr.dev/install | sh || {
      say "failed: herdr install script"
      return 1
    }
  fi
  changed "herdr installed (in $HOME/.local/bin; open a new shell for PATH)"
}

ensure_herdr_brew() {
  if have herdr; then
    skip "herdr already present ($(herdr --version 2>/dev/null))"
    return 0
  fi
  brew_install herdr || {
    say "failed: brew install herdr"
    return 1
  }
  changed "herdr installed"
}

ensure_tailscale_apt() {
  if have tailscale; then
    skip "tailscale already present"
    return 0
  fi
  say "install: tailscale"
  if [ "$DRY_RUN" = "1" ]; then
    say "would run: curl https://tailscale.com/install.sh | sh"
  else
    curl -fsSL https://tailscale.com/install.sh | sh || {
      say "failed: tailscale install script"
      return 1
    }
  fi
  changed "tailscale installed (run 'sudo tailscale up' by hand)"
}

ensure_tailscale_brew() {
  if have tailscale || [ -d "/Applications/Tailscale.app" ]; then
    skip "tailscale already present"
    return 0
  fi
  run brew install --cask tailscale || {
    say "failed: brew install --cask tailscale"
    return 1
  }
  changed "tailscale installed (sign in by hand)"
}

# --- igniter checkout -----------------------------------------------------

ensure_igniter() {
  if [ -d "$FACTORY_DIR/.git" ]; then
    say "update: igniter checkout at $FACTORY_DIR"
    if [ "$DRY_RUN" = "1" ]; then
      say "would run: git -C $FACTORY_DIR pull --ff-only; bun install; bun link"
      return 0
    fi
    git -C "$FACTORY_DIR" pull --ff-only || {
      say "failed: git pull in $FACTORY_DIR (diverged history or local edits? resolve by hand, then rerun)"
      return 1
    }
    (cd "$FACTORY_DIR" && bun install) || {
      say "failed: bun install in $FACTORY_DIR"
      return 1
    }
    (cd "$FACTORY_DIR" && bun link) || {
      say "failed: bun link in $FACTORY_DIR"
      return 1
    }
    verify_igniter_cmd || return 1
    changed "igniter updated and linked"
    return 0
  fi
  say "install: clone igniter to $FACTORY_DIR"
  if ! have gh || ! gh auth status >/dev/null 2>&1; then
    say "note: gh is not authenticated; if $FACTORY_REPO is private, run 'gh auth login' first or the checkout below will fail"
  fi
  if [ "$DRY_RUN" = "1" ]; then
    say "would run: git clone $FACTORY_REPO $FACTORY_DIR; bun install; bun link"
    return 0
  fi
  clone_err="$(git clone "$FACTORY_REPO" "$FACTORY_DIR" 2>&1)" || {
    say "$clone_err"
    case "$clone_err" in
      *[Aa]uthentication*|*"could not read Username"*|*"access denied"*|*"Permission denied"*|*"not found"*|*"403"*)
        say "failed: git clone $FACTORY_REPO — looks like an authentication problem (private repository? run 'gh auth login' first, then rerun)"
        ;;
      *)
        say "failed: git clone $FACTORY_REPO to $FACTORY_DIR"
        ;;
    esac
    return 1
  }
  (cd "$FACTORY_DIR" && bun install) || {
    say "failed: bun install in $FACTORY_DIR"
    return 1
  }
  (cd "$FACTORY_DIR" && bun link) || {
    say "failed: bun link in $FACTORY_DIR"
    return 1
  }
  verify_igniter_cmd || return 1
  changed "igniter cloned and linked"
}

# The link step succeeding does not mean an igniter command exists (a
# package without a bin entry links fine and provides nothing) or runs (a
# non-executable cli fails with Permission denied). Confirm both before
# any 'done' line claims success.
verify_igniter_cmd() {
  local out
  if ! have igniter; then
    say "failed: no 'igniter' command on PATH after bun link — the checkout's package bin entry is likely missing; fix the package, then rerun"
    return 1
  fi
  out="$(igniter --help 2>&1 || true)"
  case "$out" in
    *"usage: igniter"*) return 0 ;;
    *)
      say "failed: 'igniter' is on PATH but does not run (got: $out)"
      return 1
      ;;
  esac
}

ensure_env_file() {
  local env_file="$HOME/.config/igniter/env" mode
  if [ -f "$env_file" ]; then
    # Existence is not enough: this file will hold LINEAR_API_KEY, so its
    # mode is re-asserted on every run, healing hand-loosened permissions.
    mode="$(stat -c '%a' "$env_file" 2>/dev/null || stat -f '%Lp' "$env_file" 2>/dev/null || true)"
    if [ "$mode" = "600" ]; then
      skip "$env_file already exists with mode 600 (values never written by this script)"
      return 0
    fi
    if [ "$DRY_RUN" = "1" ]; then
      say "would run: chmod 600 $env_file (currently $mode)"
      return 0
    fi
    chmod 600 "$env_file" || {
      say "failed: chmod 600 $env_file"
      return 1
    }
    changed "$env_file mode set to 600 (was $mode)"
    return 0
  fi
  if [ "$DRY_RUN" = "1" ]; then
    say "would write: $env_file (empty, mode 600)"
    return 0
  fi
  mkdir -p "$(dirname "$env_file")" || {
    say "failed: mkdir for $env_file"
    return 1
  }
  : >"$env_file" || {
    say "failed: create $env_file"
    return 1
  }
  chmod 600 "$env_file" || {
    say "failed: chmod 600 $env_file"
    return 1
  }
  changed "$env_file created empty; put LINEAR_API_KEY in it by hand"
}

# --- non-interactive PATH --------------------------------------------------
# bun and opencode install into the home directory and append PATH lines to
# the END of shell rc files, below bash's 'not running interactively, don't
# do anything' guard — so non-interactive shells (ssh commands, systemd user
# services and agent runners never see the tools. doctor.sh runs
# non-interactively, so the PATH itself must be fixed, in this
# shell (for have-checks later in the same run) and on disk (for every
# future shell and for the systemd user manager, which reads neither rc
# files nor ssh environments).
PATH_MARKER="# igniter factory PATH"
PATH_END="# igniter factory PATH (end)"

path_block() {
  printf '%s\n' \
    "$PATH_MARKER (tools installed into the home directory)" \
    'for _igniter_dir in "$HOME/.opencode/bin" "$HOME/.bun/bin" "$HOME/.local/bin"; do' \
    '  case ":$PATH:" in' \
    '    *":$_igniter_dir:"*) ;;' \
    '    *) PATH="$_igniter_dir:$PATH" ;;' \
    '  esac' \
    'done' \
    'unset _igniter_dir' \
    'export PATH' \
    "$PATH_END"
}

# install_rc writes tmpfile to dest without breaking a symlink at dest:
# operator dotfiles (chezmoi, dotbot, stow) are symlinks, and mv would
# replace the link with a plain file. Always rm the tmpfile afterwards.
install_rc() {
  if [ -L "$2" ]; then
    cat "$1" >"$2"
  else
    mv "$1" "$2"
  fi
  rm -f "$1"
}

# ensure_rc_block keeps exactly one copy of the factory PATH block in an rc
# file: when the marker is present the block is compared by content and a
# stale block is replaced in place, never duplicated. The block ends at the
# first '^esac' (blocks written before the end marker existed) or end-marker
# line after the start marker. $1 = file, $2 = prepend|append when absent.
ensure_rc_block() {
  local rc="$1" position="$2" tmp start rel end current
  if [ -f "$rc" ] && grep -qs "$PATH_MARKER" "$rc"; then
    start="$(grep -n "$PATH_MARKER" "$rc" | head -1 | cut -d: -f1)"
    rel="$(tail -n "+$start" "$rc" | grep -n -e '^esac$' -e "$PATH_END" | head -1 | cut -d: -f1 || true)"
    if [ -z "$rel" ]; then
      say "failed: $rc has a factory PATH marker but no block end; remove those lines by hand, then rerun"
      return 1
    fi
    end="$((start + rel - 1))"
    current="$(sed -n "${start},${end}p" "$rc")"
    if [ "$current" = "$(path_block)" ]; then
      skip "$rc already carries the current factory PATH"
      return 0
    fi
    if [ "$DRY_RUN" = "1" ]; then
      say "would replace: stale factory PATH block in $rc"
      return 0
    fi
    tmp="$(mktemp "$(dirname "$rc")/.rcblock.XXXXXX")"
    if [ "$start" -gt 1 ]; then
      head -n "$((start - 1))" "$rc" >"$tmp"
    else
      : >"$tmp"
    fi
    path_block >>"$tmp"
    tail -n "+$((end + 1))" "$rc" >>"$tmp"
    install_rc "$tmp" "$rc"
    changed "$rc factory PATH block updated"
    return 0
  fi
  if [ "$DRY_RUN" = "1" ]; then
    if [ "$position" = "prepend" ]; then
      say "would prepend: factory PATH block to $rc (above the interactive guard)"
    else
      say "would append: factory PATH block to $rc"
    fi
    return 0
  fi
  if [ "$position" = "prepend" ]; then
    tmp="$(mktemp "$(dirname "$rc")/.rcblock.XXXXXX")"
    path_block >"$tmp"
    if [ -f "$rc" ]; then
      cat "$rc" >>"$tmp"
    fi
    install_rc "$tmp" "$rc"
  else
    path_block >>"$rc"
  fi
  changed "$rc carries the factory PATH"
}

# Prepend above bash's interactive guard: stock ~/.bashrc returns early for
# non-interactive shells (which Ubuntu still sources over ssh), so an
# appended line down the bottom would never run there.
ensure_bashrc_path() {
  ensure_rc_block "$HOME/.bashrc" prepend
}

# ~/.profile has no interactive guard; appending is enough for login shells.
ensure_profile_path() {
  ensure_rc_block "$HOME/.profile" append
}

# The systemd user manager reads environment.d for every user service,
# including the factory Herdr session. Full explicit PATH: no shell
# expansion happens here, so $HOME is baked in at install time.
ensure_environmentd() {
  local conf="$HOME/.config/environment.d/factory.conf"
  if write_file "$conf" <<EOF
# Factory tools installed into the home directory. Read by the systemd user
# manager; user services inherit neither shell rc files nor ssh environments.
PATH=$HOME/.opencode/bin:$HOME/.bun/bin:$HOME/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
EOF
  then
    changed "$conf written"
  else
    skip "$conf already current"
    return 0
  fi
  if [ "$DRY_RUN" = "1" ]; then
    say "would run: systemctl --user daemon-reload"
    return 0
  fi
  systemctl --user daemon-reload 2>/dev/null || say "warn: daemon-reload for the new environment failed; log out and back in"
}

# zsh reads ~/.zshenv for every invocation, interactive or not, with no
# guard in the stock file; appending is enough on macOS.
ensure_zshenv_path() {
  ensure_rc_block "$HOME/.zshenv" append
}

# login_shell names the operator's login shell (zsh, bash, ...), from $SHELL
# with getent as fallback. The PATH block goes to that shell's rc files,
# never assumed from the OS.
login_shell() {
  local sh="${SHELL:-}"
  if [ -z "$sh" ]; then
    sh="$(getent passwd "${USER:-$(id -un)}" 2>/dev/null | cut -d: -f7 || true)"
  fi
  printf '%s' "${sh##*/}"
}

ensure_shell_path() {
  if [ "$OS" = "Linux" ]; then
    ensure_environmentd || return 1
  fi
  case "$(login_shell)" in
    zsh)
      ensure_zshenv_path || return 1
      ;;
    bash|sh|dash|ksh)
      ensure_bashrc_path || return 1
      ensure_profile_path || return 1
      ;;
    *)
      say "note: login shell '$(login_shell)' is not covered; add $HOME/.opencode/bin, $HOME/.bun/bin and $HOME/.local/bin to its init by hand"
      ;;
  esac
  return 0
}

# --- persistence + resource group -----------------------------------------

ensure_linger() {
  if [ "$OS" != "Linux" ]; then
    return 0
  fi
  if loginctl show-user "$USER" 2>/dev/null | grep -q '^Linger=yes'; then
    skip "linger already enabled for $USER"
    return 0
  fi
  say "enable: linger for $USER (user services survive logout)"
  run_root loginctl enable-linger "$USER" || {
    say "failed: loginctl enable-linger $USER"
    return 1
  }
  changed "linger enabled"
}

ensure_slice() {
  if [ "$OS" != "Linux" ]; then
    return 0
  fi
  local unit="$HOME/.config/systemd/user/factory.slice"
  if write_file "$unit" <<EOF
[Unit]
Description=igniter factory slice (low-priority agents and dispatch)
Before=slices.target

[Slice]
CPUWeight=$FACTORY_CPU_WEIGHT
EOF
  then
    changed "$unit written (CPUWeight=$FACTORY_CPU_WEIGHT)"
    SLICE_CHANGED=1
  else
    skip "$unit already current"
  fi
}

ensure_persist_linux() {
  local herdr_bin unit unit_changed
  unit_changed=0
  herdr_bin="$(command -v herdr || true)"
  if [ -z "$herdr_bin" ]; then
    say "missing: herdr must be installed before the systemd unit is written"
    return 1
  fi
  unit="$HOME/.config/systemd/user/factory.service"
  if write_file "$unit" <<EOF
[Unit]
Description=igniter factory Herdr server (session: $FACTORY_SESSION)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart="$herdr_bin" --session "$FACTORY_SESSION" server
Restart=always
RestartSec=5
Slice=factory.slice

[Install]
WantedBy=default.target
EOF
  then
    changed "$unit written"
    unit_changed=1
  else
    skip "$unit already current"
  fi
  if [ "$DRY_RUN" = "1" ]; then
    say "would run: systemctl --user daemon-reload; systemctl --user enable --now factory.service"
    return 0
  fi
  # daemon-reload picks up either change without touching the running
  # server. A changed unit additionally needs a restart to take effect, and
  # restarting kills the session's panes, so that case never proceeds on its
  # own: it tells the operator to restart by hand. A slice change needs no
  # restart — the reload alone applies it.
  # The slice carries no process state, so its changes reload silently here.
  if [ "$unit_changed" = "1" ] || [ "$SLICE_CHANGED" = "1" ]; then
    if ! systemctl --user daemon-reload; then
      say "warn: daemon-reload failed (no user bus?); rerun from a login shell"
      return 1
    fi
  fi
  if [ "$unit_changed" = "1" ]; then
    if systemctl --user is-active factory.service >/dev/null 2>&1; then
      say "failed: $unit changed; run 'systemctl --user restart factory.service' by hand (it kills the session's panes), then rerun"
      return 1
    fi
  fi
  if systemctl --user is-enabled factory.service >/dev/null 2>&1 && systemctl --user is-active factory.service >/dev/null 2>&1; then
    skip "factory.service already enabled and active"
    return 0
  fi
  if systemctl --user enable --now factory.service; then
    changed "factory.service enabled and started"
  else
    say "warn: could not enable factory.service (no user bus?); rerun from a login shell"
    return 1
  fi
}

ensure_persist_macos() {
  local herdr_bin plist plist_changed
  plist_changed=0
  herdr_bin="$(command -v herdr || true)"
  if [ -z "$herdr_bin" ]; then
    say "missing: herdr must be installed before the LaunchAgent is written"
    return 1
  fi
  plist="$HOME/Library/LaunchAgents/dev.igniter.factory.plist"
  if write_file "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.igniter.factory</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/nice</string>
    <string>-n</string>
    <string>10</string>
    <string>/usr/bin/taskpolicy</string>
    <string>-c</string>
    <string>background</string>
    <string>$herdr_bin</string>
    <string>--session</string>
    <string>$FACTORY_SESSION</string>
    <string>server</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>FACTORY_SESSION</key>
    <string>$FACTORY_SESSION</string>
    <key>PATH</key>
    <string>$HOME/.opencode/bin:$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$HOME/Library/Logs/factory-herdr.log</string>
  <key>StandardErrorPath</key>
  <string>$HOME/Library/Logs/factory-herdr.log</string>
</dict>
</plist>
EOF
  then
    changed "$plist written"
    plist_changed=1
  else
    if launchctl list 2>/dev/null | grep -q 'dev\.igniter\.factory'; then
      skip "$plist already current and loaded"
      return 0
    fi
    say "load: $plist already current but not loaded"
  fi
  if [ "$DRY_RUN" = "1" ]; then
    say "would run: launchctl bootstrap gui/$(id -u) $plist"
    return 0
  fi
  # A changed plist only takes effect on reload, and reloading kills the
  # session's panes; never do it here, tell the operator to do it by hand.
  if [ "$plist_changed" = "1" ]; then
    if launchctl list 2>/dev/null | grep -q 'dev\.igniter\.factory'; then
      say "failed: $plist changed; run 'launchctl bootout gui/$(id -u)/dev.igniter.factory' and 'launchctl bootstrap gui/$(id -u) $plist' by hand (it kills the session's panes), then rerun"
      return 1
    fi
  fi
  launchctl bootout "gui/$(id -u)/dev.igniter.factory" 2>/dev/null || true
  if launchctl bootstrap "gui/$(id -u)" "$plist"; then
    changed "dev.igniter.factory loaded"
  else
    say "warn: could not load dev.igniter.factory; load it by hand"
    return 1
  fi
}

# --- swap (Linux only) -----------------------------------------------------

ensure_swap() {
  if [ "$OS" != "Linux" ]; then
    return 0
  fi
  if [ -n "${FACTORY_NO_SWAP:-}" ]; then
    skip "swap step disabled by FACTORY_NO_SWAP"
    return 0
  fi
  if [ "$(tail -n +2 /proc/swaps 2>/dev/null | wc -l)" -gt 0 ]; then
    skip "swap already active"
    return 0
  fi
  if [ -f /swapfile ]; then
    skip "/swapfile exists but is inactive; run 'sudo swapon /swapfile' by hand"
    return 0
  fi
  say "install: 4 GB /swapfile (FACTORY_NO_SWAP=1 to skip)"
  if [ "$DRY_RUN" = "1" ]; then
    say "would run: sudo fallocate -l 4G /swapfile; chmod 600; mkswap; swapon; fstab entry"
    return 0
  fi
  # From here on a failure must stop before /etc/fstab is touched, and must
  # remove the half-made file so a re-run retries cleanly.
  swap_failed() {
    say "failed: $* (/etc/fstab left untouched)"
    as_root rm -f /swapfile
    return 1
  }
  as_root fallocate -l 4G /swapfile || as_root dd if=/dev/zero of=/swapfile bs=1M count=4096 status=progress || {
    swap_failed "could not allocate /swapfile"
    return 1
  }
  as_root chmod 600 /swapfile || {
    swap_failed "chmod 600 /swapfile"
    return 1
  }
  as_root mkswap /swapfile || {
    swap_failed "mkswap /swapfile"
    return 1
  }
  as_root swapon /swapfile || {
    swap_failed "swapon /swapfile"
    return 1
  }
  if ! grep -qs '^/swapfile ' /etc/fstab; then
    echo '/swapfile none swap sw 0 0' | as_root tee -a /etc/fstab >/dev/null || {
      as_root swapoff /swapfile 2>/dev/null || true
      swap_failed "could not append the /swapfile line to /etc/fstab"
      return 1
    }
  fi
  changed "/swapfile active"
}

# --- main ------------------------------------------------------------------

main() {
  # See ensure_shell_path: home-installed tools must resolve in this shell
  # too, or have-checks later in the same run miss what an earlier step put
  # there. Process environment only; the file writes persist it for others.
  export PATH="$HOME/.opencode/bin:$HOME/.bun/bin:$HOME/.local/bin:$PATH"
  say "provision: factory host ($OS) — dry run: $DRY_RUN"
  case "$OS" in
    Linux)
      if ! have apt-get; then
        say "missing: no apt-get on this Linux host; install tools by hand, then rerun"
        exit 1
      fi
      if have git && have curl; then
        skip "git and curl already present"
      else
        step "git and curl" apt_install git curl
      fi
      step "unzip" ensure_unzip_apt
      step "node" ensure_node_apt
      step "pnpm" ensure_pnpm
      step "bun" ensure_bun
      step "opencode" ensure_opencode
      step "claude" ensure_npm_tool claude "@anthropic-ai/claude-code"
      step "codex" ensure_npm_tool codex "@openai/codex"
      step "agent-browser" ensure_npm_tool agent-browser "agent-browser"
      step "chromium" ensure_chromium_apt
      step "herdr" ensure_herdr_apt
      step "tailscale" ensure_tailscale_apt
      if ! have gh; then
        step "gh" apt_install gh
      else
        skip "gh already present"
      fi
      ;;
    Darwin)
      if ! have brew; then
        say "missing: Homebrew is required on macOS; install it from https://brew.sh by hand, then rerun"
        exit 1
      fi
      if ! have git; then
        step "git" brew_install git
      else
        skip "git already present"
      fi
      step "node" ensure_node_brew
      step "pnpm" ensure_pnpm
      step "bun" ensure_bun
      step "opencode" ensure_opencode
      step "claude" ensure_npm_tool claude "@anthropic-ai/claude-code"
      step "codex" ensure_npm_tool codex "@openai/codex"
      step "agent-browser" ensure_npm_tool agent-browser "agent-browser"
      step "chromium" ensure_chromium_brew
      step "herdr" ensure_herdr_brew
      step "tailscale" ensure_tailscale_brew
      if ! have gh; then
        step "gh" brew_install gh
      else
        skip "gh already present"
      fi
      ;;
    *)
      say "missing: unsupported OS $OS (need Linux with apt, or macOS with brew)"
      exit 1
      ;;
  esac

  if have pnpm; then
    step "pnpm store" share_pnpm_store
  fi
  if have bun && have git; then
    step "igniter checkout" ensure_igniter
  else
    say "missing: bun and git are required for the igniter checkout; rerun once installed"
  fi
  step "env file" ensure_env_file
  step "shell PATH" ensure_shell_path

  if [ "$OS" = "Linux" ]; then
    step "linger" ensure_linger
    step "slice" ensure_slice
    step "persist" ensure_persist_linux
    step "swap" ensure_swap
  else
    step "persist" ensure_persist_macos
  fi

  say ""
  say "logins still needed (never done by this script):"
  say "  - opencode (OpenAI account):  opencode auth login"
  say "  - claude code:                run 'claude' once and finish the browser login"
  say "  - github cli:                 gh auth login"
  if [ -n "$FAILED" ]; then
    say ""
    say "FAILED steps: $FAILED"
    say "fix the errors above and rerun (finished steps are skipped, nothing is re-done)"
    exit 1
  fi
  say "then run scripts/doctor.sh to verify."
}

main "$@"
