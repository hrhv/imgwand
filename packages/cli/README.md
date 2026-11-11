# @hrhv/imgwand-cli

The `imgwand` command: a k9s-style terminal UI and scriptable commands to inspect image metadata, preview images in
high quality (kitty, iTerm2, sixel, colored blocks; works in tmux) and remove EXIF/XMP/IPTC/ICC metadata and C2PA
Content Credentials losslessly.

```bash
npm install -g @hrhv/imgwand-cli   # from GitHub Packages; or use the standalone binary
imgwand
imgwand strip photo.jpg -f privacy --in-place
```

See the [project README](../../README.md) for the full guide. The library it is built on is
[`@hrhv/imgwand`](../core/README.md).

## License

MPL-2.0
