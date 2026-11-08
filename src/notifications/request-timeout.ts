/**
 * Whether an error is AbortSignal.timeout firing: a TimeoutError, to fetch's caller and to a body being read alike.
 * Read by name, not with `instanceof Error`: the error is a DOMException made by the runtime, which under Jest is of
 * another realm than the code under test and is then not an `Error` to it.
 */
export function isTimeoutError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'TimeoutError';
}
