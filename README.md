# imgwand

Inspect image metadata in a k9s-style terminal UI and remove it **losslessly**: EXIF (GPS, serial numbers,
thumbnails, MakerNotes), XMP, IPTC, Photoshop resources, ICC profiles, comments, and C2PA Content Credentials
(read, validate, sign, redact, remove). JPEG, PNG and WebP.

```bash
curl -fsSL https://raw.githubusercontent.com/hrhv/imgwand/main/install.sh | sh
imgwand                                   # browse the current folder
imgwand strip photo.jpg -f privacy --in-place
```

Everything is also a library you can import: [`@hrhv/imgwand`](packages/core/README.md).

## Why it's different

- **Lossless.** The compressed picture is never decoded or re-encoded. Only metadata segments/chunks change, and every
  write is verified: the blocks that hold the picture must come out byte-identical, or nothing is written.
- **Surgical.** Remove one field, a group, or a preset. EXIF edits happen in place, so vendor MakerNotes (which hide
  absolute offsets) survive edits that break them in most other tools.
- **C2PA-aware.** Content Credentials are signed over the whole file, so *any* edit invalidates them. imgwand tells
  you, and makes you choose: strip them too, keep the (now invalid) manifest, or re-sign with history.
- **Sees the picture.** High-quality previews in kitty, Ghostty, WezTerm, iTerm2 and sixel terminals, colored blocks
  everywhere else, and it works inside tmux.
- **Safe to point at untrusted files.** Every value is sanitized before it reaches your terminal, decompression is
  bounded, XMP with DOCTYPEs is refused, and nothing touches the network unless you ask.

## Install

### Standalone binary (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/hrhv/imgwand/main/install.sh | sh
```

Picks the build for your machine (Linux glibc or musl/Alpine, x64 or arm64; macOS Intel or Apple Silicon), verifies
it against `SHA256SUMS`, runs it once, installs it to `~/.local/bin` (or `/usr/local/bin` as root) and adds that to
your `PATH`. Variables: `IMGWAND_VERSION=v0.2.0`, `IMGWAND_INSTALL_DIR=/opt/bin`, `IMGWAND_NO_MODIFY_PATH=1`,
`IMGWAND_VERBOSE=1` (or `sh -s -- --verbose`).

The binary needs neither Node.js nor npm. It embeds sharp/libvips and the C2PA SDK and extracts them on first run
to `~/.cache/imgwand/native` (or `$XDG_CACHE_HOME/imgwand`), a directory only you can write to; set
`IMGWAND_NATIVE_DIR` to put it elsewhere (an `imgwand-native` folder is created inside it). `imgwand cache clean`
removes old versions and nothing else. On Alpine, install `libstdc++ libgcc` first.

Uninstall (removes the binary, the `PATH` lines and the native cache; `--dry-run` shows what it would do, `--purge`
also removes your config):

```bash
curl -fsSL https://raw.githubusercontent.com/hrhv/imgwand/main/uninstall.sh | sh
```

### npm (GitHub Packages)

```bash
echo "@hrhv:registry=https://npm.pkg.github.com" >> .npmrc   # plus a token with read:packages
npm install -g @hrhv/imgwand-cli
```

The C2PA SDK downloads its native binary in an install script. npm 11 only runs approved scripts, so approve it:
`npm install-scripts approve @contentauth/c2pa-node` (or add `"allowScripts": {"@contentauth/c2pa-node": true}` to
your `package.json`). Requires Node.js 24 or newer.

## The interactive UI

```bash
imgwand [folder-or-image]
```

| Screen | What you do there |
| ------ | ----------------- |
| **Browser** | Folders and images. `enter` opens, `h`/`⌫` goes up, `p` previews full screen, `d` duplicates the image (asks first, suggesting `photo-copy-imgwand.jpg`; Enter confirms), `.` shows hidden files. |
| **Metadata** | Every field, grouped (C2PA, EXIF, GPS, Thumbnail, XMP, IPTC, Photoshop, ICC, Comments, Other), with a live preview panel on wide terminals. `space` marks, `a` marks a group, `d` stages removal, `P` stages the privacy preset, `D` strips everything, `e` edits a value, `n` adds a field, `u` undoes, `w` writes (with a summary and an optional backup). |
| **Content Credentials** (`c`) | The manifest chain, signer, actions, assertions, ingredients and validation. `s` signs (keeping the history), `r` redacts an assertion, `x` stages removal. |
| **Help** (`?`) | Every keybinding, grouped by screen (navigation, browser, metadata, Content Credentials, preview) plus the `:` commands. Opens from any screen; `?` or `esc` goes back. |

`/` filters, `:` opens the command line (`:rm gps xmp:dc:creator`, `:set exif:IFD0:Artist="Jane"`, `:privacy`,
`:strip-all`, `:w`, `:wq`, `:q`, `:q!`, `:undo`, `:reset`, `:open <path>`, `:c2pa`, `:preview`). Nothing is
written until you press `w`; edits to a signed file ask what to do with its Content Credentials.

## Commands

```bash
imgwand show photo.jpg [--json] [-g gps]           # print every field (or JSON for scripts)
imgwand strip *.jpg -f privacy --in-place --backup  # remove fields; -o file, --in-place or --dry-run
imgwand strip photo.jpg -f all -f '!icc' -o clean.jpg
imgwand set photo.jpg exif:IFD0:Artist="Jane Doe" xmp:dc:title="Sunset" --in-place
imgwand c2pa show signed.jpg [--json] [--trust anchors.pem]
imgwand c2pa sign photo.jpg --cert chain.pem --key key.pem --source-type digitalCapture --in-place
imgwand c2pa redact signed.jpg cawg.training-mining --cert chain.pem --key key.pem -o redacted.jpg
imgwand c2pa remove signed.jpg --in-place
imgwand preview photo.jpg [--graphics kitty|iterm|sixel|blocks|ascii]
imgwand fields                                      # selector reference
imgwand -v                                          # versions, native libraries, terminal graphics
```

Content Credentials are reported on the C2PA specification's ladder of validation states, the same way in
`c2pa show`, `show` and the UI:

| Verdict | Meaning |
| ------- | ------- |
| **Trusted** | Signature verified, and the signer chains to a trust anchor (`--trust anchors.pem`, or `trustAnchors` in the config). |
| **Valid** | Signature verified, but the signer is not on a trust list (shown as a warning). |
| **Well-formed** | The manifest is intact, but its signature or certificate check failed. |
| **Invalid** | Either the image was changed after signing (imgwand says whether the manifest itself is still valid), or the manifest is damaged and cannot be parsed. |

`c2pa show` also prints the whole ladder (`well-formed ✓  valid ✓  trusted ✗  image unchanged ✓`). Failures are listed
with `✗` and warnings with `!`. `--json` includes both the SDK's `validationState` and the specification's
`manifestState`.

When a file has Content Credentials, `strip` and `set` refuse to silently invalidate them: pass `--c2pa remove`
(strip them too) or `--c2pa keep` (keep the invalid manifest), or re-sign afterwards with `imgwand c2pa sign`.

### Selectors

| Selector | Meaning |
| -------- | ------- |
| `exif:GPS:GPSLatitude`, `xmp:dc:creator`, `iptc:Keywords` | one field (ids are shown by `show --json`) |
| `GPSLatitude` | a field by name |
| `exif:GPS:*`, `xmp:dc:*` | a glob over ids |
| `exif` `gps` `thumbnail` `xmp` `iptc` `photoshop` `icc` `c2pa` `comment` `other` | a group |
| `privacy` | location, serial numbers, names, comments, thumbnails and other identifying fields (never C2PA or ICC) |
| `all` | every removable field |
| `!icc`, `!exif:IFD0:Orientation` | exclusions, applied last |

Some things can only go as a whole: an ICC profile, a C2PA manifest store, the EXIF thumbnail. Selecting part of
one selects all of it, and the UI tells you so.

## Images in the terminal

| Terminal | Protocol |
| -------- | -------- |
| kitty, Ghostty, Konsole, Warp | kitty graphics |
| iTerm2, WezTerm | iTerm2 inline images |
| foot, Windows Terminal, mlterm, contour (and any terminal that reports sixel) | sixel |
| everything else | 24-bit colored half blocks (`ascii` without color) |

Detection uses environment variables and asks the terminal (kitty graphics query, DA1, cell size). Override with
`--graphics` or `IMGWAND_GRAPHICS`. **tmux:** imgwand asks tmux which terminal it is attached to; enable
`set -g allow-passthrough on` so images reach it (kitty images then use Unicode placeholders, which move with
panes). Without passthrough you get colored blocks and a hint. In the full-screen preview, `g` cycles protocols.

## Security

imgwand is built to be pointed at files you don't trust:

- Every value read from a file is stripped of escape sequences and control characters (7-bit and 8-bit C1)
  before it reaches the terminal, in the UI, the text output and `--json`.
- Parsers are bounded: decompression is capped per chunk and per file, IFD loops are detected, decoded value
  arrays are capped, sharp refuses pixel bombs, XMP with a DOCTYPE is refused (no entity expansion).
- Reading never touches the network: remote C2PA manifests and OCSP are off unless you pass `--network`.
- Writes are atomic (temp file + fsync + rename), keep the file's mode, and never follow or clobber backups.
- The standalone binary verifies the SHA-256 of every native library it extracts, extracts only into a
  directory owned by you, and re-verifies on every start when it has to fall back to the shared temp directory.

## Configuration

`~/.config/imgwand/config.json` (or `$XDG_CONFIG_HOME/imgwand/config.json`):

```json
{
  "graphics": "auto",
  "backup": true,
  "signer": { "cert": "~/keys/chain.pem", "key": "~/keys/key.pem", "alg": "es256", "tsa": "http://timestamp.example" },
  "trustAnchors": "~/keys/anchors.pem"
}
```

Keys are referenced by path and read only when signing. `IMGWAND_C2PA_CERT` / `IMGWAND_C2PA_KEY` override the signer.

## Development

```bash
mise install          # Node 24 + Bun (see mise.toml)
npm ci
npm test              # 200+ tests: unit, integration (real C2PA SDK, ExifTool cross-checks), property-based fuzzing
npm run coverage
npm run typecheck
npm run build && npm run smoke
npx tsx scripts/build-binaries.ts host && sh scripts/smoke-test.sh dist/bin/imgwand-<platform>
npx tsx scripts/demo-images.ts /tmp/demo && npm run dev -- /tmp/demo
```

Layout: `packages/core` is the library (container codecs in `container/`, one handler per metadata family, C2PA in
`c2pa/`), `packages/cli` is the CLI and TUI (`terminal/` for graphics, `tui/` for the Ink app, `native/` for the
standalone binary's bootstrap). `scripts/` builds binaries, the musl C2PA SDK, demo images and screenshots.

### Local build and install

Build the standalone binary for this machine from your working tree, smoke-test it and put it on your `PATH`:

```bash
npm run install:local
```

This runs [`scripts/install-local.sh`](scripts/install-local.sh): `npm ci` if `node_modules` is missing, builds
`dist/bin/imgwand-<platform>` with Bun, runs the 14 smoke checks against it, then installs it as `imgwand` into
`~/.local/bin` (`/usr/local/bin` as root). The copy is written next to the target and renamed, so a running
`imgwand` is never replaced by a half-written file. It prints the installed version and tells you if the directory
is not on your `PATH` (it never edits shell profiles).

| Option | Effect |
| ------ | ------ |
| `IMGWAND_INSTALL_DIR=/opt/bin` | install somewhere else |
| `--no-smoke` (`npm run install:local -- --no-smoke`) | skip the smoke test |
| `IMGWAND_C2PA_NODE=path/to/index.node` | required on Alpine/musl: a C2PA SDK built with `scripts/build-c2pa-musl.sh` |

Needs Node.js 24+ and Bun (`mise install`).

To remove it and everything it left behind:

```bash
npm run uninstall:local                  # add -- --dry-run to see the list first
```

[`scripts/uninstall-local.sh`](scripts/uninstall-local.sh) runs [`uninstall.sh`](uninstall.sh) and then removes this
repository's build outputs. It removes:

- The `imgwand` binary from `$IMGWAND_INSTALL_DIR`, `~/.local/bin`, `/usr/local/bin` or wherever it is on `PATH`.
  It only removes a file it has checked is really this project's binary. An npm install or another program with the
  same name is reported and left alone.
- The `PATH` lines `install.sh` added to your shell profiles. Nothing else in them changes.
- The native libraries the binary extracted: `~/.cache/imgwand` (or `$XDG_CACHE_HOME/imgwand`),
  `$IMGWAND_NATIVE_DIR/imgwand-native` and the per-user temp fallback.
- Build outputs in the repository:
  - `dist/`: the built binaries.
  - `.native/`: cross-installed sharp, the downloaded and musl-built C2PA SDKs, and generated assets.
  - `.imgwand-tmp/`: scratch files.

| Option | Effect |
| ------ | ------ |
| `--dry-run` | list what would be removed, change nothing |
| `--purge` | also remove your config, `~/.config/imgwand` (the signing keys it points to are never touched) |
| `--keep-build` | leave the repository's build outputs alone |

`node_modules` is kept. The next `npm run install:local` rebuilds everything, but rebuilding the musl C2PA SDK
takes a while.

### Releasing a new version

Both packages and the binaries share one version. Tags are `vX.Y.Z` (`vX.Y.Z-rc.N` for prereleases).

1. **Bump the version** everywhere it is recorded (both `package.json` files, the CLI's dependency on
   `@hrhv/imgwand`, `packages/core/src/version.ts` and `package-lock.json`; a test fails if they disagree):

   ```bash
   npm run version:set -- 0.2.0
   ```

2. **Verify** locally:

   ```bash
   npm run typecheck && npm test && npm run build && npm run smoke && npm run licenses
   npm run install:local      # optional: try the real binary
   ```

3. **If `@contentauth/c2pa-node` changed version**, add its commit to the `case` in
   [`scripts/build-c2pa-musl.sh`](scripts/build-c2pa-musl.sh) (the musl build refuses unpinned versions), and
   update `allowScripts` in `package.json` to the new version.

4. **Commit, tag and push**:

   ```bash
   git commit -am "Release v0.2.0"
   git tag v0.2.0
   git push origin main v0.2.0
   ```

5. **Publish a GitHub release** for the tag. This is what triggers the pipelines:

   ```bash
   gh release create v0.2.0 --generate-notes             # add --prerelease for an -rc version
   ```

   - [`publish.yml`](.github/workflows/publish.yml) checks that the tag matches the package versions, then
     publishes `@hrhv/imgwand` and `@hrhv/imgwand-cli` to GitHub Packages (prereleases under the `next` dist-tag).
   - [`release.yml`](.github/workflows/release.yml) builds the musl C2PA SDK, compiles the six binaries,
     smoke-tests each on its own OS/CPU (and on Alpine), and attaches the gzipped binaries, `SHA256SUMS`,
     `install.sh`, `uninstall.sh`, `LICENSE` and `THIRD_PARTY_NOTICES.md` to the release.

6. **Check the result** once both workflows are green:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/hrhv/imgwand/main/install.sh | IMGWAND_VERSION=v0.2.0 sh
   imgwand --version
   npm view @hrhv/imgwand-cli@0.2.0 --registry https://npm.pkg.github.com
   ```

If a binary build fails after the release is published, fix it on `main` and rebuild the existing release's
assets with **Actions → release → Run workflow** and the tag (`gh workflow run release.yml -f tag=v0.2.0`).
A version already on GitHub Packages cannot be republished: bump to the next patch version instead.

## License

[MPL-2.0](LICENSE). Bundled third-party software is listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
