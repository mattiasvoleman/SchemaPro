import { ApiError } from "@/lib/api";
import type { MessageLookup } from "@/lib/engine-message";
import { coverErrorText } from "@/lib/cover-view";

/*
 * Vikariefrågan's refusals in words. Every code the gateway answers a request
 * with has a Swedish and an English sentence under coverRequests.errors; the
 * reader gives them with `chainLookup(coverRequests.errors, coverErrors)`, so
 * the board's own codes (COVER_NOT_AFFECTED, PUBLISH_IN_PROGRESS) are said as
 * they are everywhere else.
 */

/**
 * The two refusals where the gateway's own sentence is the answer: a yes, or a
 * chosen colleague, that a hard rule of cover refuses. Its Swedish names the
 * rule and the time ("… eftersom du undervisar på en annan lektion då"), which
 * a code and a flat param cannot render, so it is shown as it came.
 */
export const VERBATIM_CODES: ReadonlySet<string> = new Set(["COVER_REQUEST_RULE", "COVER_REQUEST_RECIPIENT_RULE"]);

export function requestErrorText(t: MessageLookup, error: unknown, fallback: string): string {
  if (error instanceof ApiError && error.code && VERBATIM_CODES.has(error.code) && error.message.trim() !== "") {
    return error.message;
  }
  return coverErrorText(t, error, fallback);
}
