import { decodeText, formatBytes, latin1 } from "../util/bytes.js";
import { tagDef, type IfdName } from "./tags.js";
import type { ExifValue, Rational } from "./tiff.js";

/** Turns decoded EXIF values into the text people expect to read ("1/200 s", "f/2.8", "37° 46' 30.12\""). */

function ratio([n, d]: Rational): number {
  return d === 0 ? Number.NaN : n / d;
}

function trimNumber(n: number, digits = 4): string {
  if (!Number.isFinite(n)) return "undefined";
  return Number(n.toFixed(digits)).toString();
}

function isPrintable(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return true;
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  for (let i = 0; i < end; i++) {
    const c = bytes[i]!;
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) return false;
    if (c === 0x7f) return false;
  }
  return true;
}

function decodeUtf16(bytes: Uint8Array, littleEndian: boolean): string {
  let s = "";
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const c = littleEndian ? bytes[i]! | (bytes[i + 1]! << 8) : (bytes[i]! << 8) | bytes[i + 1]!;
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

/** UserComment / GPSProcessingMethod: an 8-byte character-code prefix followed by the text. */
function decodeCharsetText(bytes: Uint8Array, littleEndian: boolean): string {
  const code = latin1(bytes, 0, 8).replace(/\0+$/, "");
  const body = bytes.subarray(8);
  let text: string;
  if (code === "UNICODE") text = decodeUtf16(body, littleEndian);
  else if (code === "ASCII" || code === "") text = decodeText(body);
  else text = decodeText(body);
  return text.replace(/\0+$/, "").trim();
}

function dms(values: readonly Rational[]): string {
  const [d, m, s] = values.map(ratio);
  const parts = [`${trimNumber(d ?? 0, 6)}°`];
  if (m !== undefined) parts.push(`${trimNumber(m, 4)}'`);
  if (s !== undefined) parts.push(`${trimNumber(s, 2)}"`);
  return parts.join(" ");
}

/** Decimal degrees from an EXIF degrees/minutes/seconds triple. */
export function dmsToDecimal(values: readonly Rational[]): number {
  const [d = 0, m = 0, s = 0] = values.map(ratio);
  return d + m / 60 + s / 3600;
}

export function formatExifValue(ifd: IfdName, tag: number, value: ExifValue | undefined, littleEndian: boolean, count?: number): string {
  if (value === undefined) return "(invalid: points outside the EXIF data)";
  const def = tagDef(ifd, tag);
  const name = def?.name ?? "";

  if (value instanceof Uint8Array) {
    if (name.startsWith("XP")) return decodeUtf16(value, true);
    if (name === "UserComment" || name === "GPSProcessingMethod" || name === "GPSAreaInformation") return decodeCharsetText(value, littleEndian);
    if (name === "MakerNote") return `(${formatBytes(value.length)} of vendor data)`;
    if (name === "GPSVersionID") return [...value].join(".");
    if (name === "ComponentsConfiguration") return [...value].map((c) => ["-", "Y", "Cb", "Cr", "R", "G", "B"][c] ?? "?").join(", ");
    if (def?.values && value.length === 1) return def.values[value[0]!] ?? String(value[0]);
    if (value.length <= 64 && isPrintable(value)) return latin1(value).replace(/\0+$/, "");
    return `(${formatBytes(value.length)} binary data)`;
  }

  if (typeof value === "string") return value;

  if (Array.isArray(value) && value.length > 0 && Array.isArray(value[0])) {
    const rationals = value as readonly Rational[];
    switch (name) {
      case "ExposureTime": {
        const t = ratio(rationals[0]!);
        return t > 0 && t < 1 ? `1/${Math.round(1 / t)} s` : `${trimNumber(t)} s`;
      }
      case "FNumber":
      case "ApertureValue":
      case "MaxApertureValue":
        return name === "FNumber" ? `f/${trimNumber(ratio(rationals[0]!), 1)}` : `${trimNumber(ratio(rationals[0]!), 2)} APEX`;
      case "FocalLength":
        return `${trimNumber(ratio(rationals[0]!), 1)} mm`;
      case "GPSLatitude":
      case "GPSLongitude":
      case "GPSDestLatitude":
      case "GPSDestLongitude":
        return `${dms(rationals)} (${trimNumber(dmsToDecimal(rationals), 6)})`;
      case "GPSAltitude":
        return `${trimNumber(ratio(rationals[0]!), 2)} m`;
      case "GPSTimeStamp":
        return rationals.map((r) => String(Math.floor(ratio(r))).padStart(2, "0")).join(":");
      case "LensInfo": {
        const [a, b, c, d] = rationals.map(ratio);
        return `${trimNumber(a ?? 0, 1)}-${trimNumber(b ?? 0, 1)} mm f/${trimNumber(c ?? 0, 1)}-${trimNumber(d ?? 0, 1)}`;
      }
      case "ExposureCompensation":
        return `${trimNumber(ratio(rationals[0]!), 2)} EV`;
      default:
        return rationals.map((r) => (r[1] === 1 ? String(r[0]) : trimNumber(ratio(r)))).join(", ");
    }
  }

  if (typeof value === "number") {
    if (def?.values) return def.values[value] ?? String(value);
    return String(value);
  }

  const numbers = value as readonly number[];
  const total = Math.max(count ?? numbers.length, numbers.length);
  const shown = numbers.slice(0, 16).join(", ");
  return total > 16 ? `${shown}, … (${total} values)` : shown;
}
