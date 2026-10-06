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
  /**
   * A machine-readable name for the problem, when the thrower gave one — an
   * RFC 7807 extension member. It is what a client branches on where `detail`
   * is only for reading: a stale room proposal (ROOM_PROPOSAL_STALE) means
   * "compute again", a clash means "show this". A token, never free text.
   */
  code?: string;
  /**
   * The values the code's sentence substitutes, when the thrower gave them —
   * a flat object of short scalars (STAFF_TEACHER_NOT_QUALIFIED: role,
   * subject, grades). Present only beside `code`; see HttpExceptionFilter.
   */
  params?: Record<string, string | number>;
}
