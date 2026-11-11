/** EXIF/TIFF tag names and value vocabularies (TIFF 6.0, EXIF 2.32, GPS 2.3, Microsoft XP tags). */

export type IfdName = "IFD0" | "ExifIFD" | "GPS" | "Interop" | "IFD1";

export const TYPE_BYTE = 1;
export const TYPE_ASCII = 2;
export const TYPE_SHORT = 3;
export const TYPE_LONG = 4;
export const TYPE_RATIONAL = 5;
export const TYPE_SBYTE = 6;
export const TYPE_UNDEFINED = 7;
export const TYPE_SSHORT = 8;
export const TYPE_SLONG = 9;
export const TYPE_SRATIONAL = 10;
export const TYPE_FLOAT = 11;
export const TYPE_DOUBLE = 12;
export const TYPE_IFD = 13;

export const TYPE_SIZES: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4 };

export const TAG_EXIF_IFD = 0x8769;
export const TAG_GPS_IFD = 0x8825;
export const TAG_INTEROP_IFD = 0xa005;
export const TAG_THUMBNAIL_OFFSET = 0x0201;
export const TAG_THUMBNAIL_LENGTH = 0x0202;
export const TAG_ORIENTATION = 0x0112;
export const TAG_MAKERNOTE = 0x927c;

/** Sub-IFD pointer tags and the IFD each one points to. */
export const POINTERS: Readonly<Record<number, IfdName>> = {
  [TAG_EXIF_IFD]: "ExifIFD",
  [TAG_GPS_IFD]: "GPS",
  [TAG_INTEROP_IFD]: "Interop",
};

export interface TagDef {
  readonly name: string;
  /** Type used when the tag is created. */
  readonly type: number;
  /** Fixed value count, when the spec defines one. */
  readonly count?: number;
  /** Personal or identifying information (location, serial numbers, names, free text). */
  readonly sensitive?: boolean;
  readonly values?: Readonly<Record<number, string>>;
}

const ORIENTATION = { 1: "Horizontal (normal)", 2: "Mirror horizontal", 3: "Rotate 180", 4: "Mirror vertical", 5: "Mirror horizontal and rotate 270 CW", 6: "Rotate 90 CW", 7: "Mirror horizontal and rotate 90 CW", 8: "Rotate 270 CW" };
const RESOLUTION_UNIT = { 1: "None", 2: "inches", 3: "cm" };
const COMPRESSION = { 1: "Uncompressed", 6: "JPEG (old-style)", 7: "JPEG", 8: "Adobe Deflate", 32773: "PackBits" };
const EXPOSURE_PROGRAM = { 0: "Not defined", 1: "Manual", 2: "Program AE", 3: "Aperture-priority AE", 4: "Shutter speed priority AE", 5: "Creative (slow speed)", 6: "Action (high speed)", 7: "Portrait", 8: "Landscape" };
const METERING_MODE = { 0: "Unknown", 1: "Average", 2: "Center-weighted average", 3: "Spot", 4: "Multi-spot", 5: "Multi-segment", 6: "Partial", 255: "Other" };
const LIGHT_SOURCE = { 0: "Unknown", 1: "Daylight", 2: "Fluorescent", 3: "Tungsten (incandescent)", 4: "Flash", 9: "Fine weather", 10: "Cloudy", 11: "Shade", 12: "Daylight fluorescent", 13: "Day white fluorescent", 14: "Cool white fluorescent", 15: "White fluorescent", 17: "Standard light A", 18: "Standard light B", 19: "Standard light C", 20: "D55", 21: "D65", 22: "D75", 23: "D50", 24: "ISO studio tungsten", 255: "Other" };
const FLASH = { 0x0: "No Flash", 0x1: "Fired", 0x5: "Fired, Return not detected", 0x7: "Fired, Return detected", 0x8: "On, Did not fire", 0x9: "On, Fired", 0xd: "On, Return not detected", 0xf: "On, Return detected", 0x10: "Off, Did not fire", 0x14: "Off, Did not fire, Return not detected", 0x18: "Auto, Did not fire", 0x19: "Auto, Fired", 0x1d: "Auto, Fired, Return not detected", 0x1f: "Auto, Fired, Return detected", 0x20: "No flash function", 0x30: "Off, No flash function", 0x41: "Fired, Red-eye reduction", 0x45: "Fired, Red-eye reduction, Return not detected", 0x47: "Fired, Red-eye reduction, Return detected", 0x49: "On, Red-eye reduction", 0x4d: "On, Red-eye reduction, Return not detected", 0x4f: "On, Red-eye reduction, Return detected", 0x50: "Off, Red-eye reduction", 0x58: "Auto, Did not fire, Red-eye reduction", 0x59: "Auto, Fired, Red-eye reduction", 0x5d: "Auto, Fired, Red-eye reduction, Return not detected", 0x5f: "Auto, Fired, Red-eye reduction, Return detected" };
const COLOR_SPACE = { 1: "sRGB", 2: "Adobe RGB", 0xfffd: "Wide Gamut RGB", 0xfffe: "ICC Profile", 0xffff: "Uncalibrated" };
const SENSING_METHOD = { 1: "Not defined", 2: "One-chip color area", 3: "Two-chip color area", 4: "Three-chip color area", 5: "Color sequential area", 7: "Trilinear", 8: "Color sequential linear" };
const SCENE_CAPTURE = { 0: "Standard", 1: "Landscape", 2: "Portrait", 3: "Night", 4: "Other" };
const WHITE_BALANCE = { 0: "Auto", 1: "Manual" };
const EXPOSURE_MODE = { 0: "Auto", 1: "Manual", 2: "Auto bracket" };
const LOW_HIGH = { 0: "Normal", 1: "Low", 2: "High" };
const SOFT_HARD = { 0: "Normal", 1: "Soft", 2: "Hard" };
const GAIN_CONTROL = { 0: "None", 1: "Low gain up", 2: "High gain up", 3: "Low gain down", 4: "High gain down" };
const SUBJECT_DISTANCE_RANGE = { 0: "Unknown", 1: "Macro", 2: "Close", 3: "Distant" };
const CUSTOM_RENDERED = { 0: "Normal", 1: "Custom" };
const YCBCR_POSITIONING = { 1: "Centered", 2: "Co-sited" };
const PHOTOMETRIC = { 0: "WhiteIsZero", 1: "BlackIsZero", 2: "RGB", 3: "RGB Palette", 5: "CMYK", 6: "YCbCr", 8: "CIELab" };
const GPS_ALTITUDE_REF = { 0: "Above sea level", 1: "Below sea level" };

const IMAGE_TAGS: Record<number, TagDef> = {
  0x00fe: { name: "SubfileType", type: TYPE_LONG },
  0x0100: { name: "ImageWidth", type: TYPE_LONG },
  0x0101: { name: "ImageHeight", type: TYPE_LONG },
  0x0102: { name: "BitsPerSample", type: TYPE_SHORT },
  0x0103: { name: "Compression", type: TYPE_SHORT, values: COMPRESSION },
  0x0106: { name: "PhotometricInterpretation", type: TYPE_SHORT, values: PHOTOMETRIC },
  0x010d: { name: "DocumentName", type: TYPE_ASCII, sensitive: true },
  0x010e: { name: "ImageDescription", type: TYPE_ASCII, sensitive: true },
  0x010f: { name: "Make", type: TYPE_ASCII },
  0x0110: { name: "Model", type: TYPE_ASCII },
  0x0111: { name: "StripOffsets", type: TYPE_LONG },
  0x0112: { name: "Orientation", type: TYPE_SHORT, count: 1, values: ORIENTATION },
  0x0115: { name: "SamplesPerPixel", type: TYPE_SHORT },
  0x0116: { name: "RowsPerStrip", type: TYPE_LONG },
  0x0117: { name: "StripByteCounts", type: TYPE_LONG },
  0x011a: { name: "XResolution", type: TYPE_RATIONAL, count: 1 },
  0x011b: { name: "YResolution", type: TYPE_RATIONAL, count: 1 },
  0x011c: { name: "PlanarConfiguration", type: TYPE_SHORT },
  0x0128: { name: "ResolutionUnit", type: TYPE_SHORT, count: 1, values: RESOLUTION_UNIT },
  0x012d: { name: "TransferFunction", type: TYPE_SHORT },
  0x0131: { name: "Software", type: TYPE_ASCII },
  0x0132: { name: "ModifyDate", type: TYPE_ASCII, count: 20 },
  0x013b: { name: "Artist", type: TYPE_ASCII, sensitive: true },
  0x013c: { name: "HostComputer", type: TYPE_ASCII, sensitive: true },
  0x013e: { name: "WhitePoint", type: TYPE_RATIONAL },
  0x013f: { name: "PrimaryChromaticities", type: TYPE_RATIONAL },
  0x0201: { name: "ThumbnailOffset", type: TYPE_LONG },
  0x0202: { name: "ThumbnailLength", type: TYPE_LONG },
  0x0211: { name: "YCbCrCoefficients", type: TYPE_RATIONAL },
  0x0212: { name: "YCbCrSubSampling", type: TYPE_SHORT },
  0x0213: { name: "YCbCrPositioning", type: TYPE_SHORT, values: YCBCR_POSITIONING },
  0x0214: { name: "ReferenceBlackWhite", type: TYPE_RATIONAL },
  0x02bc: { name: "ApplicationNotes", type: TYPE_BYTE },
  0x4746: { name: "Rating", type: TYPE_SHORT },
  0x4749: { name: "RatingPercent", type: TYPE_SHORT },
  0x8298: { name: "Copyright", type: TYPE_ASCII },
  0x8769: { name: "ExifOffset", type: TYPE_LONG },
  0x8825: { name: "GPSInfo", type: TYPE_LONG, sensitive: true },
  0x9c9b: { name: "XPTitle", type: TYPE_BYTE, sensitive: true },
  0x9c9c: { name: "XPComment", type: TYPE_BYTE, sensitive: true },
  0x9c9d: { name: "XPAuthor", type: TYPE_BYTE, sensitive: true },
  0x9c9e: { name: "XPKeywords", type: TYPE_BYTE, sensitive: true },
  0x9c9f: { name: "XPSubject", type: TYPE_BYTE, sensitive: true },
  0xa480: { name: "GDALMetadata", type: TYPE_ASCII },
  0xc4a5: { name: "PrintIM", type: TYPE_UNDEFINED },
  0xea1c: { name: "Padding", type: TYPE_UNDEFINED },
};

const EXIF_TAGS: Record<number, TagDef> = {
  0x829a: { name: "ExposureTime", type: TYPE_RATIONAL, count: 1 },
  0x829d: { name: "FNumber", type: TYPE_RATIONAL, count: 1 },
  0x8822: { name: "ExposureProgram", type: TYPE_SHORT, values: EXPOSURE_PROGRAM },
  0x8824: { name: "SpectralSensitivity", type: TYPE_ASCII },
  0x8827: { name: "ISO", type: TYPE_SHORT },
  0x8828: { name: "OECF", type: TYPE_UNDEFINED },
  0x8830: { name: "SensitivityType", type: TYPE_SHORT },
  0x8831: { name: "StandardOutputSensitivity", type: TYPE_LONG },
  0x8832: { name: "RecommendedExposureIndex", type: TYPE_LONG },
  0x9000: { name: "ExifVersion", type: TYPE_UNDEFINED, count: 4 },
  0x9003: { name: "DateTimeOriginal", type: TYPE_ASCII, count: 20 },
  0x9004: { name: "CreateDate", type: TYPE_ASCII, count: 20 },
  0x9010: { name: "OffsetTime", type: TYPE_ASCII },
  0x9011: { name: "OffsetTimeOriginal", type: TYPE_ASCII },
  0x9012: { name: "OffsetTimeDigitized", type: TYPE_ASCII },
  0x9101: { name: "ComponentsConfiguration", type: TYPE_UNDEFINED, count: 4 },
  0x9102: { name: "CompressedBitsPerPixel", type: TYPE_RATIONAL },
  0x9201: { name: "ShutterSpeedValue", type: TYPE_SRATIONAL },
  0x9202: { name: "ApertureValue", type: TYPE_RATIONAL },
  0x9203: { name: "BrightnessValue", type: TYPE_SRATIONAL },
  0x9204: { name: "ExposureCompensation", type: TYPE_SRATIONAL },
  0x9205: { name: "MaxApertureValue", type: TYPE_RATIONAL },
  0x9206: { name: "SubjectDistance", type: TYPE_RATIONAL },
  0x9207: { name: "MeteringMode", type: TYPE_SHORT, values: METERING_MODE },
  0x9208: { name: "LightSource", type: TYPE_SHORT, values: LIGHT_SOURCE },
  0x9209: { name: "Flash", type: TYPE_SHORT, values: FLASH },
  0x920a: { name: "FocalLength", type: TYPE_RATIONAL },
  0x9214: { name: "SubjectArea", type: TYPE_SHORT },
  0x927c: { name: "MakerNote", type: TYPE_UNDEFINED, sensitive: true },
  0x9286: { name: "UserComment", type: TYPE_UNDEFINED, sensitive: true },
  0x9290: { name: "SubSecTime", type: TYPE_ASCII },
  0x9291: { name: "SubSecTimeOriginal", type: TYPE_ASCII },
  0x9292: { name: "SubSecTimeDigitized", type: TYPE_ASCII },
  0x9400: { name: "AmbientTemperature", type: TYPE_SRATIONAL },
  0x9401: { name: "Humidity", type: TYPE_RATIONAL },
  0x9402: { name: "Pressure", type: TYPE_RATIONAL },
  0x9403: { name: "WaterDepth", type: TYPE_SRATIONAL },
  0x9404: { name: "Acceleration", type: TYPE_RATIONAL },
  0x9405: { name: "CameraElevationAngle", type: TYPE_SRATIONAL },
  0xa000: { name: "FlashpixVersion", type: TYPE_UNDEFINED, count: 4 },
  0xa001: { name: "ColorSpace", type: TYPE_SHORT, values: COLOR_SPACE },
  0xa002: { name: "ExifImageWidth", type: TYPE_LONG },
  0xa003: { name: "ExifImageHeight", type: TYPE_LONG },
  0xa004: { name: "RelatedSoundFile", type: TYPE_ASCII },
  0xa005: { name: "InteropOffset", type: TYPE_LONG },
  0xa20b: { name: "FlashEnergy", type: TYPE_RATIONAL },
  0xa20e: { name: "FocalPlaneXResolution", type: TYPE_RATIONAL },
  0xa20f: { name: "FocalPlaneYResolution", type: TYPE_RATIONAL },
  0xa210: { name: "FocalPlaneResolutionUnit", type: TYPE_SHORT, values: RESOLUTION_UNIT },
  0xa214: { name: "SubjectLocation", type: TYPE_SHORT },
  0xa215: { name: "ExposureIndex", type: TYPE_RATIONAL },
  0xa217: { name: "SensingMethod", type: TYPE_SHORT, values: SENSING_METHOD },
  0xa300: { name: "FileSource", type: TYPE_UNDEFINED, values: { 1: "Film scanner", 2: "Reflection print scanner", 3: "Digital camera" } },
  0xa301: { name: "SceneType", type: TYPE_UNDEFINED, values: { 1: "Directly photographed" } },
  0xa302: { name: "CFAPattern", type: TYPE_UNDEFINED },
  0xa401: { name: "CustomRendered", type: TYPE_SHORT, values: CUSTOM_RENDERED },
  0xa402: { name: "ExposureMode", type: TYPE_SHORT, values: EXPOSURE_MODE },
  0xa403: { name: "WhiteBalance", type: TYPE_SHORT, values: WHITE_BALANCE },
  0xa404: { name: "DigitalZoomRatio", type: TYPE_RATIONAL },
  0xa405: { name: "FocalLengthIn35mmFormat", type: TYPE_SHORT },
  0xa406: { name: "SceneCaptureType", type: TYPE_SHORT, values: SCENE_CAPTURE },
  0xa407: { name: "GainControl", type: TYPE_SHORT, values: GAIN_CONTROL },
  0xa408: { name: "Contrast", type: TYPE_SHORT, values: SOFT_HARD },
  0xa409: { name: "Saturation", type: TYPE_SHORT, values: LOW_HIGH },
  0xa40a: { name: "Sharpness", type: TYPE_SHORT, values: SOFT_HARD },
  0xa40b: { name: "DeviceSettingDescription", type: TYPE_UNDEFINED },
  0xa40c: { name: "SubjectDistanceRange", type: TYPE_SHORT, values: SUBJECT_DISTANCE_RANGE },
  0xa420: { name: "ImageUniqueID", type: TYPE_ASCII, sensitive: true },
  0xa430: { name: "OwnerName", type: TYPE_ASCII, sensitive: true },
  0xa431: { name: "SerialNumber", type: TYPE_ASCII, sensitive: true },
  0xa432: { name: "LensInfo", type: TYPE_RATIONAL, count: 4 },
  0xa433: { name: "LensMake", type: TYPE_ASCII },
  0xa434: { name: "LensModel", type: TYPE_ASCII },
  0xa435: { name: "LensSerialNumber", type: TYPE_ASCII, sensitive: true },
  0xa460: { name: "CompositeImage", type: TYPE_SHORT },
  0xa500: { name: "Gamma", type: TYPE_RATIONAL },
  0xea1c: { name: "Padding", type: TYPE_UNDEFINED },
};

const GPS_TAGS: Record<number, TagDef> = {
  0x0000: { name: "GPSVersionID", type: TYPE_BYTE, count: 4 },
  0x0001: { name: "GPSLatitudeRef", type: TYPE_ASCII, count: 2 },
  0x0002: { name: "GPSLatitude", type: TYPE_RATIONAL, count: 3 },
  0x0003: { name: "GPSLongitudeRef", type: TYPE_ASCII, count: 2 },
  0x0004: { name: "GPSLongitude", type: TYPE_RATIONAL, count: 3 },
  0x0005: { name: "GPSAltitudeRef", type: TYPE_BYTE, count: 1, values: GPS_ALTITUDE_REF },
  0x0006: { name: "GPSAltitude", type: TYPE_RATIONAL, count: 1 },
  0x0007: { name: "GPSTimeStamp", type: TYPE_RATIONAL, count: 3 },
  0x0008: { name: "GPSSatellites", type: TYPE_ASCII },
  0x0009: { name: "GPSStatus", type: TYPE_ASCII, count: 2 },
  0x000a: { name: "GPSMeasureMode", type: TYPE_ASCII, count: 2 },
  0x000b: { name: "GPSDOP", type: TYPE_RATIONAL },
  0x000c: { name: "GPSSpeedRef", type: TYPE_ASCII, count: 2 },
  0x000d: { name: "GPSSpeed", type: TYPE_RATIONAL },
  0x000e: { name: "GPSTrackRef", type: TYPE_ASCII, count: 2 },
  0x000f: { name: "GPSTrack", type: TYPE_RATIONAL },
  0x0010: { name: "GPSImgDirectionRef", type: TYPE_ASCII, count: 2 },
  0x0011: { name: "GPSImgDirection", type: TYPE_RATIONAL },
  0x0012: { name: "GPSMapDatum", type: TYPE_ASCII },
  0x0013: { name: "GPSDestLatitudeRef", type: TYPE_ASCII, count: 2 },
  0x0014: { name: "GPSDestLatitude", type: TYPE_RATIONAL, count: 3 },
  0x0015: { name: "GPSDestLongitudeRef", type: TYPE_ASCII, count: 2 },
  0x0016: { name: "GPSDestLongitude", type: TYPE_RATIONAL, count: 3 },
  0x0017: { name: "GPSDestBearingRef", type: TYPE_ASCII, count: 2 },
  0x0018: { name: "GPSDestBearing", type: TYPE_RATIONAL },
  0x0019: { name: "GPSDestDistanceRef", type: TYPE_ASCII, count: 2 },
  0x001a: { name: "GPSDestDistance", type: TYPE_RATIONAL },
  0x001b: { name: "GPSProcessingMethod", type: TYPE_UNDEFINED },
  0x001c: { name: "GPSAreaInformation", type: TYPE_UNDEFINED },
  0x001d: { name: "GPSDateStamp", type: TYPE_ASCII, count: 11 },
  0x001e: { name: "GPSDifferential", type: TYPE_SHORT },
  0x001f: { name: "GPSHPositioningError", type: TYPE_RATIONAL },
};

const INTEROP_TAGS: Record<number, TagDef> = {
  0x0001: { name: "InteropIndex", type: TYPE_ASCII },
  0x0002: { name: "InteropVersion", type: TYPE_UNDEFINED, count: 4 },
  0x1000: { name: "RelatedImageFileFormat", type: TYPE_ASCII },
  0x1001: { name: "RelatedImageWidth", type: TYPE_LONG },
  0x1002: { name: "RelatedImageHeight", type: TYPE_LONG },
};

const TABLES: Record<IfdName, Record<number, TagDef>> = {
  IFD0: IMAGE_TAGS,
  IFD1: IMAGE_TAGS,
  ExifIFD: EXIF_TAGS,
  GPS: GPS_TAGS,
  Interop: INTEROP_TAGS,
};

export function tagDef(ifd: IfdName, tag: number): TagDef | undefined {
  // Some writers put EXIF tags in IFD0 and vice versa; fall back to the other table for naming.
  return TABLES[ifd][tag] ?? (ifd === "IFD0" || ifd === "IFD1" ? EXIF_TAGS[tag] : ifd === "ExifIFD" ? IMAGE_TAGS[tag] : undefined);
}

export function tagName(ifd: IfdName, tag: number): string {
  return tagDef(ifd, tag)?.name ?? `0x${tag.toString(16).padStart(4, "0")}`;
}

/** Looks a tag up by name (case-insensitive) or by hex id ("0x010f"). */
export function tagByName(ifd: IfdName, name: string): number | undefined {
  if (/^0x[0-9a-f]{1,4}$/i.test(name)) return Number.parseInt(name.slice(2), 16);
  const lower = name.toLowerCase();
  const find = (table: Record<number, TagDef>) => {
    for (const [tag, def] of Object.entries(table)) if (def.name.toLowerCase() === lower) return Number(tag);
    return undefined;
  };
  // Mirror tagDef's fallback, so every name tagName() produces resolves back to its tag.
  const fallback = ifd === "IFD0" || ifd === "IFD1" ? EXIF_TAGS : ifd === "ExifIFD" ? IMAGE_TAGS : undefined;
  return find(TABLES[ifd]) ?? (fallback ? find(fallback) : undefined);
}

/** Which IFD a tag normally lives in, used when creating EXIF data from scratch. */
export function defaultIfdFor(name: string): IfdName | undefined {
  for (const ifd of ["IFD0", "ExifIFD", "GPS", "Interop"] as const) if (tagByName(ifd, name) !== undefined && !name.startsWith("0x")) return ifd;
  return undefined;
}
