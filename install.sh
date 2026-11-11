#!/bin/sh
# imgwand installer: downloads the right prebuilt binary for this machine, verifies its checksum,
# installs it, and puts it on your PATH.
#
#   curl -fsSL https://raw.githubusercontent.com/hrhv/imgwand/main/install.sh | sh
#   wget -qO- https://raw.githubusercontent.com/hrhv/imgwand/main/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/hrhv/imgwand/main/install.sh | sh -s -- --verbose
#
# Supports Linux (glibc and musl, x64 and arm64) and macOS (Intel and Apple Silicon).
# Everything happens inside main(), called on the last line, so a partially downloaded script never runs.

set -eu

REPO="hrhv/imgwand"
BIN_NAME="imgwand"
INSTALL_URL="https://raw.githubusercontent.com/$REPO/main/install.sh"

usage() {
  cat <<'EOF'
Usage: install.sh [-v|--verbose]

Options:
  -v, --verbose   log every step, URL, command and timing (for debugging installs)
  -h, --help      show this help

Environment variables:
  IMGWAND_VERSION=v0.2.0        install a specific release, with or without the "v" (default: the latest
                                   release, or the newest pre-release while there is no stable release yet)
  IMGWAND_INSTALL_DIR=/opt/bin  install somewhere else (default: /usr/local/bin as root, else ~/.local/bin)
  IMGWAND_NO_MODIFY_PATH=1      never edit shell profiles
  IMGWAND_VERBOSE=1             same as --verbose
  IMGWAND_DOWNLOAD_URL=...      base URL that holds the release assets (mirrors, testing)
EOF
}

if [ -t 2 ] && [ -z "${NO_COLOR:-}" ]; then
  BOLD=$(printf '\033[1m') DIM=$(printf '\033[2m') GREEN=$(printf '\033[32m') YELLOW=$(printf '\033[33m')
  RED=$(printf '\033[31m') RESET=$(printf '\033[0m')
else
  BOLD="" DIM="" GREEN="" YELLOW="" RED="" RESET=""
fi

VERBOSE=${IMGWAND_VERBOSE:-}
START=$(date +%s)

info() { printf '%s→%s %s\n' "$BOLD" "$RESET" "$*" >&2; }
success() { printf '%s✓%s %s\n' "$GREEN" "$RESET" "$*" >&2; }
warn() { printf '%s!%s %s\n' "$YELLOW" "$RESET" "$*" >&2; }
# Verbose-only detail, prefixed with seconds since the installer started so slow steps stand out.
debug() {
  [ -n "$VERBOSE" ] || return 0
  printf '%s  [%3ss] %s%s\n' "$DIM" "$(($(date +%s) - START))" "$*" "$RESET" >&2
}
die() {
  printf '%s✗ %s%s\n' "$RED" "$*" "$RESET" >&2
  if [ -z "$VERBOSE" ]; then
    printf '  For details, re-run with --verbose: curl -fsSL %s | sh -s -- --verbose\n' "$INSTALL_URL" >&2
  fi
  exit 1
}

has() { command -v "$1" >/dev/null 2>&1; }

detect_platform() {
  os=$(uname -s)
  cpu=$(uname -m)
  debug "uname: $(uname -a)"

  case "$cpu" in
    x86_64 | amd64) cpu=x64 ;;
    aarch64 | arm64) cpu=arm64 ;;
    *) die "Unsupported CPU architecture: $cpu (supported: x86_64, arm64)." ;;
  esac

  case "$os" in
    Darwin)
      # An x64 shell under Rosetta on Apple Silicon should still get the native arm64 build.
      translated=$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)
      debug "macOS $(sw_vers -productVersion 2>/dev/null || echo '?'), running under Rosetta: $([ "$translated" = 1 ] && echo yes || echo no)"
      if [ "$cpu" = x64 ] && [ "$translated" = 1 ]; then cpu=arm64; fi
      platform="darwin-$cpu"
      ;;
    Linux)
      libc=""
      for loader in /lib/ld-musl-*.so.1; do
        if [ -e "$loader" ]; then libc="-musl" && debug "musl loader found: $loader"; fi
      done
      if [ -z "$libc" ] && (ldd --version 2>&1 | grep -qi musl); then libc="-musl" && debug "ldd reports musl"; fi
      [ -n "$libc" ] || debug "libc: glibc ($(ldd --version 2>&1 | head -n 1))"
      platform="linux-$cpu$libc"
      ;;
    *) die "Unsupported operating system: $os (supported: Linux, macOS). Install with npm from GitHub Packages instead: npm install -g @hrhv/imgwand-cli" ;;
  esac
}

# The musl builds link libstdc++ and libgcc dynamically; Alpine doesn't ship them by default.
ensure_musl_runtime() {
  missing=""
  for lib in libstdc++.so.6 libgcc_s.so.1; do
    found=""
    for dir in /lib /usr/lib /usr/local/lib; do
      if [ -e "$dir/$lib" ]; then found="$dir/$lib"; fi
    done
    if [ -n "$found" ]; then debug "found $found"; else missing="$missing $lib"; fi
  done
  [ -z "$missing" ] && return 0

  if has apk && [ "$(id -u)" = 0 ]; then
    info "Installing runtime libraries the musl build needs: libstdc++ libgcc"
    apk add --no-cache libstdc++ libgcc >/dev/null || die "apk add libstdc++ libgcc failed."
  elif has apk; then
    die "imgwand needs libstdc++ and libgcc on Alpine. Run: sudo apk add libstdc++ libgcc  (then re-run this installer)"
  else
    die "imgwand needs these shared libraries, which are missing:$missing. Install your distro's libstdc++ and libgcc packages."
  fi
}

pick_downloader() {
  if has curl; then
    downloader=curl
    debug "downloader: $(command -v curl) ($(curl --version | head -n 1))"
  elif has wget; then
    if wget --help 2>&1 | grep -qi busybox; then downloader=busybox-wget; else downloader=wget; fi
    debug "downloader: $(command -v wget) ($downloader)"
  else
    die "Neither curl nor wget is installed."
  fi
}

# Runs a download command; its stderr goes to the terminal when showing progress, else to a log for --verbose.
run_downloader() {
  if [ -n "$show_progress" ]; then "$@"; else "$@" 2>"$tmp/fetch-error"; fi
}

# fetch <url> <file> [progress]
# Small files and probes are silent; "progress" shows a progress bar when stderr is a terminal.
# Every transfer has timeouts and gives up if it stalls (under 1 KB/s for 30 s), so it can't hang forever.
fetch() {
  url=$1 file=$2 mode=${3:-quiet}
  show_progress=""
  if [ "$mode" = progress ] && [ -t 2 ]; then show_progress=1; fi
  debug "GET $url"
  started=$(date +%s)
  : >"$tmp/fetch-error"

  case "$downloader" in
    curl)
      # HTTPS only (file: for local test releases), including redirects.
      set -- --proto =https,file --proto-redir =https --fail --location --connect-timeout 20 --retry 2 --retry-delay 1 --speed-limit 1024 --speed-time 30
      if [ -n "$show_progress" ]; then set -- "$@" --progress-bar; else set -- "$@" --silent --show-error; fi
      if [ "$mode" != progress ]; then set -- "$@" --max-time 60; fi
      if stats=$(run_downloader curl "$@" --write-out '%{http_code} %{size_download} %{time_total}' --output "$file" "$url"); then
        status=0
      else
        status=$?
      fi
      # shellcheck disable=SC2086 # split "code bytes seconds"
      set -- $stats
      debug "  → HTTP ${1:-?}, ${2:-0} bytes in ${3:-?}s (curl exit $status)"
      ;;
    wget | busybox-wget)
      set -- -T 30 -O "$file"
      if [ "$downloader" = wget ]; then set -- "$@" -t 3; fi
      if [ -n "$show_progress" ] && [ "$downloader" = wget ] && wget --help 2>&1 | grep -q -- --show-progress; then
        set -- "$@" -q --show-progress
      elif [ -z "$show_progress" ]; then
        set -- "$@" -q
      fi
      if run_downloader wget "$@" "$url"; then status=0; else status=$?; fi
      debug "  → wget exit $status after $(($(date +%s) - started))s"
      ;;
  esac

  if [ "$status" != 0 ] && [ -n "$VERBOSE" ] && [ -s "$tmp/fetch-error" ]; then
    while IFS= read -r line; do debug "  $line"; done <"$tmp/fetch-error"
  fi
  return "$status"
}

sha256_of() {
  if has sha256sum; then
    sha256sum "$1" | cut -d' ' -f1
  elif has shasum; then
    shasum -a 256 "$1" | cut -d' ' -f1
  elif has openssl; then
    openssl dgst -sha256 "$1" | sed 's/^.*= *//'
  else
    return 1
  fi
}

# Tag of the newest release including pre-releases (GitHub's releases/latest skips pre-releases).
newest_release_tag() {
  fetch "https://api.github.com/repos/$REPO/releases?per_page=1" "$tmp/releases.json" || return 1
  sed -n 's/^ *"tag_name": *"\([^"]*\)".*/\1/p' "$tmp/releases.json" | head -n 1
}

# Finds the release to install by fetching its small SHA256SUMS file (never the binary itself), so the
# binary is downloaded exactly once. Sets base_url and release_label, and leaves SHA256SUMS in $tmp.
resolve_release() {
  if [ -n "${IMGWAND_DOWNLOAD_URL:-}" ]; then
    base_url="${IMGWAND_DOWNLOAD_URL%/}"
    release_label="from $base_url"
    fetch "$base_url/SHA256SUMS" "$tmp/SHA256SUMS" && return 0
    die "Could not download $base_url/SHA256SUMS."
  fi

  releases="https://github.com/$REPO/releases"
  version=${IMGWAND_VERSION:-latest}
  if [ "$version" != latest ]; then
    info "Looking up release $version"
    # Accept the tag with or without its leading "v": try it as given, then the other form.
    case "$version" in v*) other=${version#v} ;; *) other="v$version" ;; esac
    for tag in "$version" "$other"; do
      base_url="$releases/download/$tag"
      release_label="release $tag"
      fetch "$base_url/SHA256SUMS" "$tmp/SHA256SUMS" && return 0
    done
    die "Release $version was not found. See the available releases: $releases"
  fi

  info "Looking up the latest release"
  base_url="$releases/latest/download"
  release_label="latest release"
  fetch "$base_url/SHA256SUMS" "$tmp/SHA256SUMS" && return 0

  # No stable release yet (or it has no assets): fall back to the newest pre-release.
  debug "no stable release; asking the GitHub API for the newest pre-release"
  tag=$(newest_release_tag) || tag=""
  if [ -n "$tag" ]; then
    base_url="$releases/download/$tag"
    release_label="pre-release $tag"
    if fetch "$base_url/SHA256SUMS" "$tmp/SHA256SUMS"; then
      info "No stable release yet; using pre-release $tag"
      return 0
    fi
  fi
  die "Could not find a release to install. See the available releases: $releases"
}

default_install_dir() {
  if [ -n "${IMGWAND_INSTALL_DIR:-}" ]; then
    echo "$IMGWAND_INSTALL_DIR"
  elif [ "$(id -u)" = 0 ]; then
    echo /usr/local/bin
  else
    echo "$HOME/.local/bin"
  fi
}

# Adds $1 to PATH in the user's shell profile, once. Prints the file it changed (if any).
add_to_path() {
  dir=$1
  case "$dir" in "$HOME"/*) path_expr="\$HOME/${dir#"$HOME"/}" ;; *) path_expr=$dir ;; esac
  marker="# Added by the imgwand installer"

  case "$(basename "${SHELL:-sh}")" in
    zsh) profile="${ZDOTDIR:-$HOME}/.zshrc" line="export PATH=\"$path_expr:\$PATH\"" ;;
    bash)
      # macOS Terminal opens login shells, which read .bash_profile rather than .bashrc.
      if [ "$(uname -s)" = Darwin ]; then profile="$HOME/.bash_profile"; else profile="$HOME/.bashrc"; fi
      line="export PATH=\"$path_expr:\$PATH\""
      ;;
    fish)
      profile="${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/imgwand.fish"
      line="fish_add_path \"$dir\""
      ;;
    *) profile="$HOME/.profile" line="export PATH=\"$path_expr:\$PATH\"" ;;
  esac
  debug "shell ${SHELL:-unknown} → profile $profile"

  if [ -f "$profile" ] && grep -qF "$marker" "$profile"; then return 0; fi
  mkdir -p "$(dirname "$profile")"
  printf '\n%s\n%s\n' "$marker" "$line" >>"$profile"
  debug "appended to $profile: $line"
  echo "$profile"
}

main() {
  for arg in "$@"; do
    case "$arg" in
      -v | --verbose) VERBOSE=1 ;;
      -h | --help)
        usage
        return 0
        ;;
      *)
        printf 'Unknown option: %s\n\n' "$arg" >&2
        usage >&2
        exit 2
        ;;
    esac
  done
  debug "installer for $REPO, options: version=${IMGWAND_VERSION:-latest} install_dir=${IMGWAND_INSTALL_DIR:-default} no_modify_path=${IMGWAND_NO_MODIFY_PATH:-no}"

  detect_platform
  asset="$BIN_NAME-$platform.gz"
  install_dir=$(default_install_dir)
  debug "platform $platform → asset $asset, install dir $install_dir"

  info "Installing $BIN_NAME for $platform"
  case "$platform" in *-musl) ensure_musl_runtime ;; esac

  tmp=$(mktemp -d 2>/dev/null || mktemp -d -t imgwand)
  trap 'rm -rf "$tmp"' EXIT
  trap 'rm -rf "$tmp"; exit 130' INT TERM
  debug "working directory $tmp"
  pick_downloader

  resolve_release
  expected=$(grep " \*\{0,1\}$asset\$" "$tmp/SHA256SUMS" | cut -d' ' -f1)
  [ -n "$expected" ] || die "The $release_label has no build for $platform ($asset is not in its SHA256SUMS)."
  debug "expected sha256 $expected"

  info "Downloading $asset ($release_label)"
  fetch "$base_url/$asset" "$tmp/$asset" progress ||
    die "Could not download $base_url/$asset. Check your connection, then try again."

  if actual=$(sha256_of "$tmp/$asset"); then
    debug "actual sha256   $actual"
    [ "$actual" = "$expected" ] || die "Checksum mismatch for $asset (expected $expected, got $actual). Not installing."
    success "Checksum verified"
  else
    die "No sha256sum, shasum or openssl found, so the download cannot be verified. Install one of them and re-run."
  fi

  gunzip -c "$tmp/$asset" >"$tmp/$BIN_NAME" || die "Could not decompress $asset."
  chmod +x "$tmp/$BIN_NAME"
  debug "unpacked $(wc -c <"$tmp/$BIN_NAME" | tr -d ' ') bytes"

  # Run it before installing: catches a wrong libc/CPU build instead of leaving a broken binary behind.
  # On macOS the first launch of a new program also includes a one-time security check.
  info "Checking that it runs on this machine"
  check_started=$(date +%s)
  if ! version=$("$tmp/$BIN_NAME" --version 2>"$tmp/run-error"); then
    die "The downloaded binary does not run on this machine ($platform): $(head -n 1 "$tmp/run-error")"
  fi
  debug "$BIN_NAME --version → $version (took $(($(date +%s) - check_started))s)"

  if ! mkdir -p "$install_dir" 2>/dev/null || [ ! -w "$install_dir" ]; then
    die "Cannot write to $install_dir. Re-run with sudo, or set IMGWAND_INSTALL_DIR to a directory you own."
  fi
  # Copy then rename, so a running imgwand is never replaced with a half-written file.
  cp "$tmp/$BIN_NAME" "$install_dir/.$BIN_NAME.new"
  mv -f "$install_dir/.$BIN_NAME.new" "$install_dir/$BIN_NAME"
  debug "copied to $install_dir/$BIN_NAME"
  if [ "$(uname -s)" = Darwin ] && has xattr; then xattr -d com.apple.quarantine "$install_dir/$BIN_NAME" 2>/dev/null || true; fi

  success "Installed $BIN_NAME $version to $install_dir/$BIN_NAME"

  case ":$PATH:" in
    *":$install_dir:"*)
      debug "$install_dir is already on PATH"
      found=$(command -v "$BIN_NAME" || true)
      if [ -n "$found" ] && [ "$found" != "$install_dir/$BIN_NAME" ]; then
        warn "Another $BIN_NAME at $found comes first on your PATH and will be used instead."
      fi
      ;;
    *)
      if [ -n "${IMGWAND_NO_MODIFY_PATH:-}" ]; then
        warn "$install_dir is not on your PATH. Add it to use $BIN_NAME."
      elif profile=$(add_to_path "$install_dir") && [ -n "$profile" ]; then
        success "Added $install_dir to PATH in $profile"
        info "Open a new terminal, or run: export PATH=\"$install_dir:\$PATH\""
      else
        info "$install_dir is already on PATH in your shell profile. Open a new terminal to use it."
      fi
      ;;
  esac

  debug "done in $(($(date +%s) - START))s"

  printf '\n  %s%s%s                     browse images in the current directory (interactive)\n' "$BOLD" "$BIN_NAME" "$RESET" >&2
  printf '  %s%s strip photo.jpg -f privacy --in-place%s   remove location, names and serial numbers\n' "$BOLD" "$BIN_NAME" "$RESET" >&2
  printf '  %s%s --help%s               all options\n' "$BOLD" "$BIN_NAME" "$RESET" >&2
  printf '  %s%s -v%s                   version, platform and dependency details (include it in bug reports)\n' "$BOLD" "$BIN_NAME" "$RESET" >&2
  printf '\n  To uninstall: curl -fsSL https://raw.githubusercontent.com/%s/main/uninstall.sh | sh\n\n' "$REPO" >&2
}

main "$@"
