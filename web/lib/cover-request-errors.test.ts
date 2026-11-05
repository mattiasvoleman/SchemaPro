import { describe, expect, it } from "vitest";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import { ApiError } from "@/lib/api";
import type { MessageLookup } from "@/lib/engine-message";
import { requestErrorText } from "@/lib/cover-request-errors";
import { chainLookup } from "@/lib/cover-view";

/**
 * Every code Vikariefrågan's gateway answers with has a sentence in both
 * languages (src/cover/cover-errors.ts, cover-requests.service.ts and
 * cover-request-rules.ts), except the two where the gateway's own Swedish is
 * the answer; a code with no sentence would show the gateway's English-less
 * fallback only by luck.
 */
const CODES = [
  "COVER_REQUEST_LESSON_CANCELLED",
  "COVER_REQUEST_LESSON_COVERED",
  "COVER_REQUEST_LESSON_STARTED",
  "COVER_REQUEST_EXISTS",
  "COVER_REQUEST_RECIPIENT_RULE",
  "COVER_REQUEST_RECIPIENT_INVALID",
  "COVER_REQUEST_ENDED",
  "COVER_REQUEST_TAKEN",
  "COVER_REQUEST_GONE",
  "COVER_REQUEST_ANSWERED",
  "COVER_REQUEST_NOT_FOUND",
  "COVER_REQUEST_SENDER_GONE",
  "COVER_REQUEST_RULE",
  "COVER_PASS_NOT_FOUND",
];

const lookupOf = (messages: Record<string, unknown>, path: string): MessageLookup => {
  const node = path.split(".").reduce<Record<string, unknown>>((current, key) => current[key] as Record<string, unknown>, messages);
  const t = ((key: string) => String(node[key])) as MessageLookup;
  t.has = (key: string) => typeof node[key] === "string";
  return t;
};

describe("requestErrorText", () => {
  it.each(["sv", "en"] as const)("says every code of the contract in %s", (language) => {
    const messages = (language === "sv" ? sv : en) as unknown as Record<string, unknown>;
    const t = chainLookup(lookupOf(messages, "coverRequests.errors"), lookupOf(messages, "coverErrors"));
    for (const code of CODES) {
      expect([code, t.has(code)]).toEqual([code, true]);
      expect(requestErrorText(t, new ApiError(409, "English log text", code), "x").length).toBeGreaterThan(10);
    }
    // The board's own codes are said as they are everywhere else.
    expect(t.has("COVER_NOT_AFFECTED")).toBe(true);
    expect(t.has("PUBLISH_IN_PROGRESS")).toBe(true);
  });

  it("answers a code in Swedish with the sentence the page owns", () => {
    const t = chainLookup(lookupOf(sv as unknown as Record<string, unknown>, "coverRequests.errors"), lookupOf(sv as unknown as Record<string, unknown>, "coverErrors"));
    expect(requestErrorText(t, new ApiError(409, "x", "COVER_REQUEST_TAKEN"), "fel")).toBe(
      "Uppdraget är redan tillsatt: en kollega hann tacka ja före dig.",
    );
    expect(requestErrorText(t, new ApiError(409, "x", "COVER_REQUEST_EXISTS"), "fel")).toBe(
      "Det finns redan en öppen förfrågan för lektionen. Dra tillbaka den först.",
    );
  });

  it("shows the gateway's own Swedish for a yes or a colleague that a hard rule refused: it names the rule and the time", () => {
    const t = chainLookup(lookupOf(sv as unknown as Record<string, unknown>, "coverRequests.errors"), lookupOf(sv as unknown as Record<string, unknown>, "coverErrors"));
    const message = "Du kan inte ta uppdraget (tis 14 okt 08:00) eftersom du skulle överskrida dagens tak för undervisning.";
    expect(requestErrorText(t, new ApiError(409, message, "COVER_REQUEST_RULE", { lessonId: "l-1", rules: "DAILY_CAP" }), "fel")).toBe(message);
    const recipient = "Förfrågan om tis 14 okt 08:00 kan inte gå till Bo Ek, som undervisar på en annan lektion då.";
    expect(requestErrorText(t, new ApiError(409, recipient, "COVER_REQUEST_RECIPIENT_RULE"), "fel")).toBe(recipient);
  });

  it("falls back to the sentence it was handed, and to the page's own words for a non-answer", () => {
    const t = lookupOf(sv as unknown as Record<string, unknown>, "coverRequests.errors");
    expect(requestErrorText(t, new ApiError(500, "Servern svarade inte.", "FROM_A_NEWER_GATEWAY"), "fel")).toBe("Servern svarade inte.");
    expect(requestErrorText(t, "boom", "Något gick fel")).toBe("Något gick fel");
  });
});
