import { createTranslator } from "use-intl";
import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import type { ProblemLookup } from "@/lib/api-error-text";
import { classifyProposalError, classifyStartError } from "@/lib/staffing-search";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";

/**
 * A busy database is a 503 DATABASE_BUSY on a read, and the web has a sentence of its own for the code (lib/problem-codes.ts, common.codes). The
 * proposal's read has no kind for a 503, so the failure reaches the notice as "any other failure", and the thrower's words for it are English.
 * Given the translator for `common`, the classifier says the catalogue's sentence in the reader's language, as apiErrorText does everywhere else.
 */
const BUSY = "The server is busy right now, and nothing was done. Try again in a moment.";
const swedish = createTranslator({ locale: "sv", messages: sv, namespace: "common" }) as unknown as ProblemLookup;
const english = createTranslator({ locale: "en", messages: en, namespace: "common" }) as unknown as ProblemLookup;

describe("a busy server on the proposal's read", () => {
  it("is said in the reader's language, from the catalogue's sentence for its code", () => {
    const busy = new ApiError(503, BUSY, "DATABASE_BUSY");
    expect(classifyProposalError(busy, swedish)).toEqual({ kind: "OTHER", message: "Servern är upptagen just nu, och inget har gjorts. Försök igen om en stund." });
    expect(classifyProposalError(busy, english)).toEqual({ kind: "OTHER", message: BUSY });
  });

  it("is the engine's unavailable kind for a start, as before: the start has a kind for a 503", () => {
    expect(classifyStartError(new ApiError(503, BUSY, "DATABASE_BUSY"), swedish)).toEqual({ kind: "UNAVAILABLE" });
  });
});
