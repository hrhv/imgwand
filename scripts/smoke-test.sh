#!/bin/sh
# End-to-end smoke test for a built imgwand: the npm bundle or a standalone binary.
# Uses only local files (no network) and POSIX sh, so it also runs in Alpine/BusyBox.
#
#   sh scripts/smoke-test.sh node packages/cli/dist/index.js
#   sh scripts/smoke-test.sh ./dist/bin/imgwand-linux-x64
set -eu

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <command...>   e.g. $0 ./dist/bin/imgwand-linux-x64" >&2
  exit 2
fi

here=$(cd "$(dirname "$0")" && pwd)
fixtures="$here/smoke"
certs="$here/../packages/core/test/fixtures/certs"

# Make relative file arguments absolute before we cd elsewhere.
for arg do
  shift
  if [ -f "$arg" ]; then arg=$(cd "$(dirname "$arg")" && pwd)/$(basename "$arg"); fi
  set -- "$@" "$arg"
done

work=$(mktemp -d 2>/dev/null || mktemp -d -t imgwand-smoke)
trap 'rm -rf "$work"' EXIT INT TERM
# A fresh HOME: standalone binaries extract their native libraries on first run.
export HOME="$work/home" XDG_CACHE_HOME="" XDG_CONFIG_HOME="" NO_COLOR=1
mkdir -p "$HOME"

passed=0
pass() { passed=$((passed + 1)); echo "  ok - $1"; }
fail() { echo "  FAIL - $1" >&2; [ -f "$work/out" ] && sed 's/^/    | /' "$work/out" >&2; exit 1; }
iw() { "$@" >"$work/out" 2>&1; }

echo "Smoke testing: $*"
cd "$work"
cp "$fixtures/sample.jpg" "$fixtures/sample.png" "$fixtures/signed.jpg" .

# 1. Version, diagnostics, help.
iw "$@" --version || fail "--version exits 0"
grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+' "$work/out" || fail "--version prints a version"
pass "--version ($(cat "$work/out"))"

iw "$@" -v || fail "-v exits 0"
grep -q '^imgwand [0-9]' "$work/out" || fail "-v starts with the version"
grep -Eq 'sharp +✓ [0-9]' "$work/out" || fail "-v finds sharp/libvips"
grep -Eq 'c2pa-node +✓ [0-9]' "$work/out" || fail "-v finds the C2PA SDK"
pass "-v loads sharp and the C2PA SDK"

iw "$@" --help || fail "--help exits 0"
grep -q 'Usage: imgwand' "$work/out" || fail "--help prints usage"
pass "--help"

# 2. Reading.
iw "$@" show sample.jpg || fail "show exits 0"
grep -q 'GPSLatitude' "$work/out" || fail "show lists GPS"
grep -q 'Fujifilm' "$work/out" || fail "show lists the camera"
iw "$@" show sample.png --json || fail "show --json exits 0"
grep -q '"format": "png"' "$work/out" || fail "show --json describes the PNG"
pass "show (text and JSON)"

# 3. Lossless strip to a new file; the original is untouched.
cp sample.jpg original.jpg
iw "$@" strip sample.jpg -f privacy -o clean.jpg || fail "strip -o exits 0"
cmp -s sample.jpg original.jpg || fail "strip -o leaves the input alone"
iw "$@" show clean.jpg || fail "show clean.jpg"
grep -q 'GPSLatitude' "$work/out" && fail "privacy strip removes GPS"
grep -q 'Fujifilm' "$work/out" || fail "privacy strip keeps the camera make"
pass "strip -f privacy -o"

iw "$@" strip sample.jpg -f gps || true
grep -q 'Choose where to write' "$work/out" || fail "strip without a target explains the options"
pass "strip insists on -o, --in-place or --dry-run"

# 4. Setting values in place with a backup.
iw "$@" set sample.png 'exif:IFD0:Artist=Smoke Test' 'xmp:dc:title=Smoke' --in-place --backup || fail "set exits 0"
[ -f sample.png.bak ] || fail "set --backup keeps a backup"
iw "$@" show sample.png || fail "show sample.png"
grep -q 'Smoke Test' "$work/out" || fail "set wrote the EXIF value"
pass "set --in-place --backup"

# 5. C2PA: show, protect, sign, redact, remove.
iw "$@" c2pa show signed.jpg || fail "c2pa show exits 0"
grep -q 'Validation  Valid' "$work/out" || fail "c2pa show validates the manifest"
pass "c2pa show"

if iw "$@" strip signed.jpg -f gps -o x.jpg; then fail "editing a signed file needs a --c2pa decision"; fi
grep -q -- '--c2pa remove' "$work/out" || fail "the refusal explains --c2pa"
iw "$@" strip signed.jpg -f gps --c2pa remove -o unsigned.jpg || fail "strip --c2pa remove"
pass "C2PA is protected unless told what to do"

iw "$@" c2pa sign unsigned.jpg --cert "$certs/es256.pub" --key "$certs/es256.pem" --source-type digitalCapture -o resigned.jpg || fail "c2pa sign"
iw "$@" c2pa show resigned.jpg || fail "c2pa show resigned.jpg"
grep -q 'Validation  Valid' "$work/out" || fail "the new signature validates"
pass "c2pa sign"

iw "$@" c2pa redact signed.jpg cawg.training-mining --cert "$certs/es256.pub" --key "$certs/es256.pem" -o redacted.jpg || fail "c2pa redact"
grep -q 'Redacted' "$work/out" || fail "c2pa redact records the redaction"
iw "$@" c2pa remove redacted.jpg --in-place || fail "c2pa remove"
iw "$@" c2pa show redacted.jpg || fail "c2pa show after remove"
grep -q 'No C2PA manifest store' "$work/out" || fail "c2pa remove removed the store"
pass "c2pa redact and remove"

# 6. Terminal preview.
iw "$@" --graphics blocks preview sample.jpg -W 24 -H 8 || fail "preview exits 0"
grep -q '▀' "$work/out" || fail "preview draws blocks"
pass "preview"

# 7. Clean errors (no stack traces) for bad input.
if iw "$@" show missing.jpg; then fail "a missing file fails"; fi
grep -q 'no such file' "$work/out" || fail "a missing file is explained"
grep -q '    at ' "$work/out" && fail "no stack trace for expected errors"
printf 'not an image' > notes.jpg
if iw "$@" show notes.jpg; then fail "a non-image fails"; fi
grep -q 'Unrecognized file format' "$work/out" || fail "a non-image is explained"
pass "clean errors"

iw "$@" cache clean || fail "cache clean exits 0"
pass "cache clean"

echo "All $passed smoke checks passed."
