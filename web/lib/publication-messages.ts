import { ApiError } from "@/lib/api";
import { engineMessage, type MessageLookup } from "@/lib/engine-message";

/*
 * Publicering's refusals in the reader's language.
 *
 * The gateway answers PUBLISH_*, CANCELLATION_* and PUBLIC_* with a Swedish
 * sentence beside the code and flat params (src/publication). The pages
 * render publishing.errors.<CODE> through lib/engine-message.ts's fallback:
 * a code the web has not translated yet, or a param a sentence needs and the
 * gateway did not send, shows the gateway's own sentence rather than a hole.
 */
export function publicationErrorText(t: MessageLookup, error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    return engineMessage(t, {
      code: error.code ?? null,
      message: error.message,
      params: error.params ?? null,
    });
  }
  return error instanceof Error ? error.message : fallback;
}

/** The refusal's code, when the gateway sent one. */
export function errorCode(error: unknown): string | undefined {
  return error instanceof ApiError ? error.code : undefined;
}

/** The gate codes a PUBLISH_WARNINGS_UNACKNOWLEDGED names (params.warnings, comma-separated). */
export function warningCodes(error: unknown): string[] {
  if (!(error instanceof ApiError) || error.code !== "PUBLISH_WARNINGS_UNACKNOWLEDGED") return [];
  const raw = error.params?.["warnings"];
  return typeof raw === "string" ? raw.split(",").map((code) => code.trim()).filter((code) => /^PUB_[A-Z_]+$/.test(code)) : [];
}
