export type ImgwandErrorCode =
  | "UNSUPPORTED_FORMAT"
  | "CORRUPT_FILE"
  | "UNKNOWN_FIELD"
  | "NOT_REMOVABLE"
  | "NOT_WRITABLE"
  | "INVALID_VALUE"
  | "SEGMENT_TOO_LARGE"
  | "C2PA_ERROR"
  | "VERIFY_FAILED"
  | "IO_ERROR";

/** Expected, user-facing failures. Anything else is a bug. */
export class ImgwandError extends Error {
  constructor(
    readonly code: ImgwandErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ImgwandError";
  }
}

export function isImgwandError(error: unknown): error is ImgwandError {
  return error instanceof ImgwandError;
}
