import { ApiError } from "@/lib/api";
import type { MessageLookup } from "@/lib/engine-message";

/*
 * The sync's codes in the reader's language.
 *
 * The gateway speaks in codes on purpose (src/integration/ss12000-sync/
 * errors.ts): nothing an IST or Edlevo server says ever reaches a response,
 * a run row or a log, so a token endpoint that echoes the client secret in
 * its error cannot put it on this screen. A code is all there is to show, and
 * this turns it into a sentence. Three shapes are not in the catalogue as
 * themselves and are mapped here:
 *
 *   - SS12000_HTTP_<status>, a provider's status, read with the status;
 *   - SS12000_APPLY_<SQLSTATE>, a row the database refused while applying,
 *     read as the apply failing (nothing was saved);
 *   - a code the web has not translated yet, read with the code itself,
 *     never as a blank.
 *
 * `t` is useTranslations("integrations.codes").
 */
export function codeText(t: MessageLookup, code: string | null | undefined): string {
  if (!code) return "";
  const http = /^SS12000_HTTP_(\d{3})$/.exec(code);
  if (http) return t("SS12000_HTTP", { status: http[1]! });
  if (/^SS12000_APPLY_[0-9A-Z]{5}$/.test(code)) return t("SS12000_APPLY_FAILED");
  if (/^[A-Z][A-Z0-9_]*$/.test(code) && t.has(code)) {
    try {
      return t(code);
    } catch {
      // A sentence that wants a value the row cannot give: say the code.
    }
  }
  return t("unknown", { code });
}

/**
 * A refusal from the gateway: the catalogue's sentence for its code, with
 * the code's params (SS12000_SOURCE_RELINK_REQUIRED {linked},
 * SS12000_MASS_DEACTIVATION {deactivations, limit}), else the gateway's own
 * sentence. `t` is useTranslations("integrations.errors").
 */
export function errorText(t: MessageLookup, error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.code && t.has(error.code)) {
      try {
        return t(error.code, error.params ?? {});
      } catch {
        return error.message;
      }
    }
    return error.message || fallback;
  }
  return error instanceof Error && error.message ? error.message : fallback;
}

/** The refusal's code, when the gateway sent one. */
export function errorCodeOf(error: unknown): string | undefined {
  return error instanceof ApiError ? error.code : undefined;
}

/** A timestamp as the reader's locale writes it, date and time. */
export function formatWhen(locale: string, iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(date);
}
