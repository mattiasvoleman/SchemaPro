/**
 * RFC 7807 "Problem Details for HTTP APIs".
 * https://www.rfc-editor.org/rfc/rfc7807
 *
 * This is the ONLY error shape the API returns to clients. It deliberately
 * omits stack traces and any internal detail that could leak PII or
 * implementation specifics.
 */
export interface ProblemDetails {
  /** A URI reference that identifies the problem type. */
  type: string;
  /** A short, human-readable summary of the problem type. */
  title: string;
  /** The HTTP status code. */
  status: number;
  /** A human-readable explanation specific to this occurrence. */
  detail: string;
  /** A URI reference that identifies the specific occurrence (the request path). */
  instance: string;
  /** Correlation id so logs can be matched to a response without exposing internals. */
  traceId: string;
  /** Optional field-level validation errors (safe, client-supplied field names only). */
  errors?: Record<string, string[]>;
}
