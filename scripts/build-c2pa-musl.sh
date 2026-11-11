#!/bin/sh
# Builds the C2PA SDK's Node addon (@contentauth/c2pa-node) for musl libc (Alpine), which the SDK does not ship
# prebuilt. Run it inside an Alpine container with Rust:
#
#   docker run --rm -v "$PWD:/w" -w /w rust:alpine sh scripts/build-c2pa-musl.sh 0.10.1 .native/c2pa-musl/index.node
#
# TrustMark (invisible watermarking) is left out: it depends on ONNX Runtime, which has no musl build, and imgwand
# does not use it. Everything else is the SDK's own source at the release tag, built with static OpenSSL.
set -eu

version=${1:?usage: $0 <c2pa-node version> <output .node path>}
output=${2:?usage: $0 <c2pa-node version> <output .node path>}
case $output in /*) ;; *) output="$PWD/$output" ;; esac

apk add --no-cache git musl-dev perl make cmake g++ pkgconf openssl-dev openssl-libs-static >/dev/null

# The exact source commit of each SDK release we build, so a moved tag cannot change what goes into a binary.
case $version in
  0.10.1) commit=78ffc4a00b18bddd9081dd6b2ae2f6a62ed3f2af ;;
  *) echo "No pinned commit for c2pa-node $version; add it to scripts/build-c2pa-musl.sh" >&2; exit 1 ;;
esac

src=$(mktemp -d)
trap 'rm -rf "$src"' EXIT
trap 'rm -rf "$src"; exit 130' INT TERM
git clone -q -c advice.detachedHead=false --depth 1 --branch "@contentauth/c2pa-node@$version" https://github.com/contentauth/c2pa-js "$src"
actual=$(git -C "$src" rev-parse HEAD)
if [ "$actual" != "$commit" ]; then
  echo "Tag @contentauth/c2pa-node@$version points to $actual, expected $commit; refusing to build" >&2
  exit 1
fi

# Fetch every crate at the version the SDK's Cargo.lock pins, before patching. The build below runs --offline, so
# removing TrustMark can only drop entries from the lock file; nothing can be re-resolved to a different version.
(cd "$src" && cargo fetch --locked)

cd "$src/packages/c2pa-node"
sed -i "/^trustmark = /d" Cargo.toml
sed -i "/pub mod neon_trustmark;/d" src/lib.rs
sed -i "/\/\/ Trustmark/,/trustmarkDecode/d" src/lib.rs
# Remove the Watermark error variant together with its #[error(transparent)] attribute.
sed -i '/#\[error(transparent)\]/{N;/trustmark::Error/d;}' src/error.rs
# The patch must leave no reference behind; fail loudly if the SDK's layout changed.
if grep -n "trustmark" Cargo.toml src/lib.rs src/error.rs; then
  echo "TrustMark references remain; update scripts/build-c2pa-musl.sh for c2pa-node $version" >&2
  exit 1
fi

cd "$src"
RUSTFLAGS="-C target-feature=-crt-static" OPENSSL_STATIC=1 cargo build --release --offline -p c2pa-node
lib=$(find "$src" -name libc2pa_node.so -path "*release*" | head -1)
mkdir -p "$(dirname "$output")"
cp "$lib" "$output"
echo "built $output ($(wc -c <"$output") bytes)"
