#!/bin/sh
# Builds the standalone imgwand binary for this machine from the working tree, smoke-tests it, and installs it as
# `imgwand` into a bin directory. Use it to try local changes as a real binary, or to install without a release.
#
#   sh scripts/install-local.sh                 # build, smoke test, install to ~/.local/bin (/usr/local/bin as root)
#   sh scripts/install-local.sh --no-smoke      # skip the smoke test
#   IMGWAND_INSTALL_DIR=/opt/bin sh scripts/install-local.sh
#   IMGWAND_C2PA_NODE=path/to/index.node sh scripts/install-local.sh   # Alpine/musl: a C2PA SDK built with
#                                                                      # scripts/build-c2pa-musl.sh
#
# Needs Node.js (24+), npm and Bun (see mise.toml). Does not edit shell profiles: if the directory is not on PATH it
# tells you what to add.
set -eu

smoke=1
for arg do
  case $arg in
    --no-smoke) smoke="" ;;
    -h | --help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg (see --help)" >&2; exit 2 ;;
  esac
done

die() { echo "error: $*" >&2; exit 1; }
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"

command -v node >/dev/null 2>&1 || die "Node.js is required (24 or newer; see mise.toml)"
command -v bun >/dev/null 2>&1 || die "Bun is required to compile the binary (https://bun.sh, or: mise install)"

# The platform name build-binaries.ts uses for this machine.
case $(uname -s) in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) die "unsupported OS: $(uname -s) (supported: macOS, Linux)" ;;
esac
case $(uname -m) in
  x86_64 | amd64) cpu=x64 ;;
  arm64 | aarch64) cpu=arm64 ;;
  *) die "unsupported CPU: $(uname -m)" ;;
esac
platform="$os-$cpu"
if [ "$os" = linux ] && { [ -e /lib/ld-musl-x86_64.so.1 ] || [ -e /lib/ld-musl-aarch64.so.1 ]; }; then
  platform="$platform-musl"
  [ -n "${IMGWAND_C2PA_NODE:-}" ] || die "musl needs a C2PA SDK build: run scripts/build-c2pa-musl.sh and set IMGWAND_C2PA_NODE to its index.node"
fi

if [ ! -d node_modules ]; then
  echo "→ installing dependencies"
  npm ci
fi

echo "→ building imgwand for $platform"
if [ -n "${IMGWAND_C2PA_NODE:-}" ]; then
  npx tsx scripts/build-binaries.ts "$platform" --c2pa-node "$IMGWAND_C2PA_NODE"
else
  npx tsx scripts/build-binaries.ts "$platform"
fi
binary="$root/dist/bin/imgwand-$platform"
[ -x "$binary" ] || die "the build did not produce $binary"

if [ -n "$smoke" ]; then
  echo "→ smoke testing"
  sh "$root/scripts/smoke-test.sh" "$binary"
fi

if [ -n "${IMGWAND_INSTALL_DIR:-}" ]; then
  install_dir=$IMGWAND_INSTALL_DIR
elif [ "$(id -u)" = 0 ]; then
  install_dir=/usr/local/bin
else
  install_dir="$HOME/.local/bin"
fi
mkdir -p "$install_dir" || die "cannot create $install_dir"
[ -w "$install_dir" ] || die "cannot write to $install_dir; set IMGWAND_INSTALL_DIR to a directory you own"

# Copy next to the target, then rename: a running imgwand is never replaced by a half-written file. Same name as
# install.sh uses, so uninstall.sh also cleans up after an interrupted install.
tmp="$install_dir/.imgwand.new"
trap 'rm -f "$tmp"' EXIT
trap 'rm -f "$tmp"; exit 130' INT TERM
cp "$binary" "$tmp"
chmod 755 "$tmp"
mv -f "$tmp" "$install_dir/imgwand"

version=$("$install_dir/imgwand" --version)
echo "✓ installed imgwand $version to $install_dir/imgwand"
case ":$PATH:" in
  *":$install_dir:"*) ;;
  *) echo "  $install_dir is not on your PATH; add it with: export PATH=\"$install_dir:\$PATH\"" ;;
esac
