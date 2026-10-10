import { ApiError } from "@/lib/api";
import type { MessageLookup } from "@/lib/engine-message";

/**
 * A refusal from the gateway: the catalogue's sentence for its code, with
 * the code's params, else the gateway's own sentence.
 * `t` is useTranslations("integrations.errors").
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

/** A timestamp as the reader's locale writes it, date and time. */
export function formatWhen(locale: string, iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(date);
}
