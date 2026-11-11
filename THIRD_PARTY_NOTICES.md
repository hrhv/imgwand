# Third-party software

imgwand itself is licensed under the Mozilla Public License 2.0 (see [LICENSE](LICENSE)).

The npm packages install their dependencies from the registry under those dependencies' own licenses. The
standalone binaries additionally **bundle** the following software; each binary embeds the native libraries for its
platform.

| Component | License | Notes |
| --------- | ------- | ----- |
| [Bun](https://bun.sh) runtime | MIT (with LGPL-2.1 JavaScriptCore/WebKit components) | the executable's runtime |
| [sharp](https://sharp.pixelplumbing.com) | Apache-2.0 | image decoding and resizing |
| [libvips](https://www.libvips.org) and its dependencies (`@img/sharp-libvips-*`) | LGPL-3.0-or-later (libvips); see the package for the full list | shipped as a separate shared library, extracted to the native cache at run time |
| [C2PA Node.js SDK](https://github.com/contentauth/c2pa-js) (`@contentauth/c2pa-node`) and [c2pa-rs](https://github.com/contentauth/c2pa-rs) | MIT OR Apache-2.0 | the musl builds are compiled from the SDK's source without the TrustMark module |
| [@xmldom/xmldom](https://github.com/xmldom/xmldom) | MIT | XMP parsing |
| [Ink](https://github.com/vadimdemedes/ink), [React](https://react.dev) | MIT | terminal UI |
| [commander](https://github.com/tj/commander.js) | MIT | command-line parsing |

`npm run licenses` checks every runtime dependency against the licenses compatible with distributing imgwand
under MPL-2.0. To get the source of the LGPL-licensed libvips that a binary contains, see
https://github.com/lovell/sharp-libvips (the version is printed by `imgwand -v`).
