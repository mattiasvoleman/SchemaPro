/**
 * A failure talking to the SS12000 source, as a code and nothing else.
 *
 * Codes only, on purpose: the far side's body, a header, a URL's query or a
 * token never become a message here, so nothing a provider says (an IST
 * token endpoint that echoes the client secret in its error, say) can reach a
 * response, a run row or a log line. The code is what the run row's
 * statusCode / errors and the source's lastTestOutcome store, and what the
 * web translates.
 */
export class Ss12000SourceError extends Error {
  constructor(
    readonly code: string,
    /** For HTTP_<status> codes: the status, so a caller can tell 400 from 404. */
    readonly status?: number,
  ) {
    super(code);
    this.name = 'Ss12000SourceError';
  }
}

/** The code of anything thrown while talking to the source; never its message. */
export function sourceErrorCode(error: unknown): string {
  return error instanceof Ss12000SourceError ? error.code : 'SS12000_UNEXPECTED';
}

/**
 * The SQLSTATE a database error carries through @prisma/adapter-pg (the
 * driver's cause, else the rendered message), as the adapter probe reads it.
 * SS403 / SS404 / SS409 are this module's guards and functions; 55P03 is a
 * lock_timeout; 23505 a unique violation.
 */
export function sqlStateOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const meta = (error as { meta?: { driverAdapterError?: { cause?: { originalCode?: unknown } } } }).meta;
  const original = meta?.driverAdapterError?.cause?.originalCode;
  if (typeof original === 'string') return original;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' ? /Code: `([0-9A-Z]{5})`/.exec(message)?.[1] : undefined;
}
