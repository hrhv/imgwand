/**
 * @hrhv/imgwand: read, edit and losslessly remove image metadata (EXIF, XMP, IPTC, ICC, comments) and read,
 * verify, sign, redact and strip C2PA manifests. JPEG, PNG and WebP.
 */

export {
  editMetadata,
  inspect,
  readMetadata,
  removeC2pa,
  removeMetadata,
  setMetadata,
  stripAll,
  HANDLERS,
  type BlockSummary,
  type EditOptions,
  type EditOutcome,
  type MetadataReport,
  type ReadOptions,
  type StripOptions,
} from "./document.js";
export { ImageDocument } from "./image-document.js";
export type { FieldGroup, MetadataField, Removal } from "./fields.js";
export { GROUPS, PRESETS, resolveSelectors, suggest, type Resolution } from "./selectors.js";
export {
  C2PA_ALGORITHMS,
  DIGITAL_SOURCE_TYPES,
  assessC2pa,
  c2paFields,
  c2paVerdict,
  readC2pa,
  redactC2pa,
  resolveRedactions,
  signC2pa,
  type C2paManifestState,
  type C2paManifestSummary,
  type C2paReadOptions,
  type C2paReport,
  type C2paSignOptions,
  type C2paSigner,
  type C2paSigningAlgorithm,
  type C2paStatus,
  type C2paVerdict,
  type DigitalSourceType,
} from "./c2pa/c2pa.js";
export { C2PA_STORE_ID } from "./c2pa/handler.js";
export { detectFormat, parseContainer, samePicture, type Block, type BlockKind, type Container, type ImageFormat } from "./container/index.js";
export { imageInfo, renderPaletted, renderPng, renderRaster, samePixels, type ImageInfo, type PalettedRaster, type Raster, type RenderOptions } from "./image.js";
export { MAX_FILE_SIZE, readImageFile, writeFileAtomic, type WriteOptions, type WriteResult } from "./fileio.js";
export { ImgwandError, isImgwandError, type ImgwandErrorCode } from "./errors.js";
export { parseTiff, readValue, type ExifValue, type Rational, type Tiff, type TiffEntry, type TiffIfd } from "./exif/tiff.js";
export { formatExifValue, dmsToDecimal } from "./exif/format.js";
export { parseIcc, type IccSummary } from "./icc/handler.js";
export { XMP_NAMESPACES } from "./xmp/handler.js";
export { formatBytes } from "./util/bytes.js";
export { VERSION, runtimeVersions, type RuntimeVersions } from "./version.js";
