#!/bin/sh
# imgwand uninstaller: removes what install.sh set up.
#
#   curl -fsSL https://raw.githubusercontent.com/hrhv/imgwand/main/uninstall.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/hrhv/imgwand/main/uninstall.sh | sh -s -- --dry-run
#
# Everything happens inside main(), called on the last line, so a partially downloaded script never runs.

set -eu

BIN_NAME="imgwand"
MARKER="# Added by the imgwand installer"

usage() {
  cat <<'EOF'
Usage: uninstall.sh [--dry-run] [--purge]

Removes:
  - the imgwand binary from $IMGWAND_INSTALL_DIR, ~/.local/bin, /usr/local/bin,
    or wherever it is on your PATH
  - the PATH lines install.sh added to your shell profiles
  - the native libraries the binary extracted to ~/.cache/imgwand (or $XDG_CACHE_HOME/imgwand,
    $IMGWAND_NATIVE_DIR/imgwand-native, or the per-user temp fallback)
  - with --purge: your config (~/.config/imgwand, or $XDG_CONFIG_HOME/imgwand)

Leaves alone (and tells you about): npm installs of @hrhv/imgwand, other programs
that happen to be called imgwand, the install directory itself, your config unless
--purge is given, and the signing keys your config points to (never touched).

Options:
  -n, --dry-run   show what would be removed without changing anything
      --purge     also remove the config directory
  -h, --help      show this help
EOF
}

if [ -t 2 ] && [ -z "${NO_COLOR:-}" ]; then
  BOLD=$(printf '\033[1m') GREEN=$(printf '\033[32m') YELLOW=$(printf '\033[33m') RED=$(printf '\033[31m') RESET=$(printf '\033[0m')
else
  BOLD="" GREEN="" YELLOW="" RED="" RESET=""
fi

info() { printf '%s→%s %s\n' "$BOLD" "$RESET" "$*" >&2; }
success() { printf '%s✓%s %s\n' "$GREEN" "$RESET" "$*" >&2; }
warn() { printf '%s!%s %s\n' "$YELLOW" "$RESET" "$*" >&2; }
error() { printf '%s✗%s %s\n' "$RED" "$RESET" "$*" >&2; }

DRY_RUN=""
PURGE=""
FAILED=""
CHANGED=""
SEEN=""

# Deletes a file or directory, or only reports it with --dry-run.
remove() {
  target=$1
  what=$2
  if [ -n "$DRY_RUN" ]; then
    info "Would remove $what"
  elif rm -rf "$target" 2>/dev/null && [ ! -e "$target" ] && [ ! -L "$target" ]; then
    success "Removed $what"
    CHANGED=1
  else
    error "Could not remove $what."
    FAILED=1
  fi
}

# Is this file the imgwand built from this project (not an npm shim or another tool with the same name)?
is_our_binary() {
  [ -f "$1" ] || return 1
  if "$1" --help 2>/dev/null | grep -q 'lossless: the compressed picture is never re-encoded'; then return 0; fi
  # Can't run it (e.g. a musl build missing its libraries): look for a string only this project contains
  # (the environment variable that points sharp at the extracted addon). -a: treat the binary as text.
  LC_ALL=C grep -a -q 'IMGWAND_SHARP_NODE' "$1" 2>/dev/null
}

is_npm_install() {
  [ -L "$1" ] || return 1
  case "$(readlink "$1")" in *node_modules*) return 0 ;; esac
  return 1
}

check_binary() {
  path=$1
  case "$path" in /*) ;; *) return 0 ;; esac
  # Each path once, even if it is both an install location and the one on PATH.
  case "
$SEEN
" in *"
$path
"*) return 0 ;; esac
  SEEN="$SEEN
$path"

  # Leftover from an interrupted install (install.sh copies to .imgwand.new, then renames).
  partial="$(dirname "$path")/.$BIN_NAME.new"
  if [ -f "$partial" ]; then remove "$partial" "unfinished install $partial"; fi

  [ -e "$path" ] || [ -L "$path" ] || return 0
  FOUND=1

  if is_npm_install "$path"; then
    warn "$path was installed with npm. Remove it with: npm uninstall -g @hrhv/imgwand-cli"
  elif ! is_our_binary "$path"; then
    warn "$path is not this project's imgwand; leaving it alone."
  elif [ -z "$DRY_RUN" ] && [ ! -w "$(dirname "$path")" ]; then
    error "No permission to remove $path. Run: sudo rm \"$path\""
    FAILED=1
  else
    remove "$path" "$path"
  fi
}

# Prints the profile without install.sh's block: the marker, the PATH line right after it, and the blank line
# install.sh put before the marker. The marker is only removed together with a PATH line that looks like ours.
strip_block() {
  awk -v marker="$MARKER" '
    { lines[NR] = $0 }
    END {
      out = 0
      for (i = 1; i <= NR; i++) {
        if (lines[i] == marker && i < NR && lines[i + 1] ~ /^(export PATH=|fish_add_path )/) {
          if (out > 0 && kept[out] == "") out--
          i++
          continue
        }
        kept[++out] = lines[i]
      }
      for (j = 1; j <= out; j++) print kept[j]
    }
  ' "$1"
}

clean_profile() {
  profile=$1
  [ -f "$profile" ] || return 0
  grep -qF "$MARKER" "$profile" || return 0
  case "
$SEEN
" in *"
$profile
"*) return 0 ;; esac
  SEEN="$SEEN
$profile"

  if [ -n "$DRY_RUN" ]; then
    info "Would remove the imgwand PATH line from $profile"
    return 0
  fi
  if [ ! -w "$profile" ]; then
    error "No permission to edit $profile. Remove the lines after \"$MARKER\" yourself."
    FAILED=1
    return 0
  fi

  stripped=$(mktemp 2>/dev/null || mktemp -t imgwand-profile)
  strip_block "$profile" >"$stripped"
  if [ -s "$stripped" ]; then
    # Write in place (not mv) so the file keeps its permissions and owner, and a symlink stays a symlink.
    cat "$stripped" >"$profile"
    success "Removed the imgwand PATH line from $profile"
  else
    # The installer created this file and nothing else was ever added to it.
    rm -f "$profile"
    success "Removed $profile (it only contained the imgwand PATH line)"
  fi
  rm -f "$stripped"
  CHANGED=1
}

main() {
  for arg in "$@"; do
    case "$arg" in
      -n | --dry-run) DRY_RUN=1 ;;
      --purge) PURGE=1 ;;
      -h | --help)
        usage
        return 0
        ;;
      *)
        error "Unknown option: $arg"
        usage >&2
        exit 2
        ;;
    esac
  done
  [ -n "$DRY_RUN" ] && info "Dry run: nothing will be changed."

  # 1. Binaries: every location install.sh uses, then whatever (still) answers to imgwand on PATH.
  FOUND=""
  if [ -n "${IMGWAND_INSTALL_DIR:-}" ]; then check_binary "$IMGWAND_INSTALL_DIR/$BIN_NAME"; fi
  check_binary "$HOME/.local/bin/$BIN_NAME"
  check_binary "/usr/local/bin/$BIN_NAME"
  check_binary "$(command -v "$BIN_NAME" 2>/dev/null || true)"
  [ -n "$FOUND" ] || info "No imgwand binary found in the install locations or on PATH."

  # 2. Shell profiles (the same files install.sh may have edited).
  for profile in "${ZDOTDIR:-$HOME}/.zshrc" "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile"; do
    clean_profile "$profile"
  done
  fish_conf="${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/imgwand.fish"
  if [ -f "$fish_conf" ] && grep -qF "$MARKER" "$fish_conf"; then remove "$fish_conf" "$fish_conf"; fi

  # 3. Native libraries the standalone binary extracted on first run (and the per-user temp fallback).
  cache_dir="${XDG_CACHE_HOME:-$HOME/.cache}/imgwand"
  if [ -d "$cache_dir" ]; then remove "$cache_dir" "native library cache $cache_dir"; fi
  # IMGWAND_NATIVE_DIR names a parent; the binary only ever creates imgwand-native inside it.
  if [ -n "${IMGWAND_NATIVE_DIR:-}" ] && [ -d "$IMGWAND_NATIVE_DIR/imgwand-native" ]; then
    remove "$IMGWAND_NATIVE_DIR/imgwand-native" "native library cache $IMGWAND_NATIVE_DIR/imgwand-native"
  fi
  tmp_root=${TMPDIR:-/tmp}
  tmp_cache="${tmp_root%/}/imgwand-$(id -u)"
  if [ -d "$tmp_cache" ] && [ -n "$(find "$tmp_cache" -prune -user "$(id -u)" 2>/dev/null)" ]; then
    remove "$tmp_cache" "native library cache $tmp_cache"
  fi

  # 4. Config, only when asked: it is yours (signer paths, preferences), not something the installer created.
  config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/imgwand"
  if [ -n "$PURGE" ]; then
    if [ -L "$config_dir" ]; then
      warn "$config_dir is a symlink (managed elsewhere?); leaving it alone."
    elif [ -d "$config_dir" ]; then
      remove "$config_dir" "config $config_dir"
    fi
  elif [ -d "$config_dir" ]; then
    info "Kept your config in $config_dir (remove it with --purge)."
  fi

  echo >&2
  if [ -n "$FAILED" ]; then
    error "imgwand was only partly removed; see the messages above."
    exit 1
  elif [ -n "$DRY_RUN" ]; then
    info "Dry run complete. Run without --dry-run to remove the items above."
  elif [ -n "$CHANGED" ]; then
    success "imgwand has been uninstalled. Open a new terminal to refresh your PATH."
  else
    info "Nothing to remove: imgwand is not installed on this machine by install.sh."
  fi
}

main "$@"
