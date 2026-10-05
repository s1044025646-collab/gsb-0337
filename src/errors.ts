export type ErrorCode =
  | "INVALID_REQUEST"
  | "REGION_EMPTY"
  | "REGION_CODE_DUPLICATE"
  | "POPULATION_NOT_POSITIVE_INTEGER"
  | "POPULATION_TOO_MANY_DIGITS"
  | "TOO_MANY_REGIONS"
  | "SEATS_NOT_INTEGER"
  | "SEATS_BELOW_REGION_COUNT"
  | "SEATS_ABOVE_LIMIT"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RULES_MISMATCH"
  | "REPLAY_MISMATCH"
  | "INTERNAL";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.details = details;
  }
}

export function errorStatusCode(code: ErrorCode): number {
  switch (code) {
    case "NOT_FOUND":
      return 404;
    case "CONFLICT":
    case "REPLAY_MISMATCH":
      return 409;
    case "INTERNAL":
      return 500;
    default:
      return 400;
  }
}
