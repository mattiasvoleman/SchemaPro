import { createTranslator } from "use-intl";
import { describe, expect, it } from "vitest";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import { NETWORK_FAILURE, apiErrorText, type ProblemLookup } from "@/lib/api-error-text";

/** An ApiError as api.ts builds one, as a shape: this module does not import the class. */
function apiError(status: number, message: string, code?: string, problems?: string[]): Error {
  return Object.assign(new Error(message), { name: "ApiError", status, code, problems });
}

// The real catalogues, through the real translator: a key missing from one of them, or an argument the sentence does not take,
// is a sentence the reader never gets.
const swedish = createTranslator({ locale: "sv", messages: sv, namespace: "common" }) as unknown as ProblemLookup;
const english = createTranslator({ locale: "en", messages: en, namespace: "common" }) as unknown as ProblemLookup;

describe("apiErrorText", () => {
  describe("a request that got no answer", () => {
    const failed = apiError(0, "Failed to fetch", NETWORK_FAILURE);

    it("is said in the reader's language, not as the browser's 'Failed to fetch'", () => {
      expect(apiErrorText(failed, swedish)).toBe("Servern gick inte att nå. Kontrollera anslutningen och försök igen.");
      expect(apiErrorText(failed, english)).toBe("The server could not be reached. Check your connection and try again.");
    });
  });

  describe("a 400 from the gateway's validation", () => {
    const refused = (problems: string[]) => apiError(400, "One or more fields failed validation.", undefined, problems);

    it("shows the sentences that name the field, not the constant detail", () => {
      const error = refused(["Nivån kan vara högst 1500 timmar."]);
      expect(apiErrorText(error, swedish)).toBe("Uppgifterna kunde inte sparas. Nivån kan vara högst 1500 timmar.");
      expect(apiErrorText(error, english)).toBe("The details could not be saved. Nivån kan vara högst 1500 timmar.");
      expect(apiErrorText(error, swedish)).not.toContain("One or more fields");
    });

    it("shows the first three and counts the rest", () => {
      const error = refused(["a.", "b.", "c.", "d.", "e."]);
      expect(apiErrorText(error, swedish)).toBe("Uppgifterna kunde inte sparas. a. b. c. Dessutom 2 fel till.");
      expect(apiErrorText(error, english)).toBe("The details could not be saved. a. b. c. And 2 more problems.");
      expect(apiErrorText(refused(["a.", "b.", "c.", "d."]), english)).toBe("The details could not be saved. a. b. c. And 1 more problem.");
      // Three is not more than three.
      expect(apiErrorText(refused(["a.", "b.", "c."]), english)).toBe("The details could not be saved. a. b. c.");
    });

    it("ends the sentences class-validator words itself, which have no full stop, so that they do not run into one another", () => {
      // What the gateway sends for CreateRoomDto with no name, a capacity of 20000 and a roomTypeId that is no UUID.
      const error = refused(["name should not be empty", "capacity must not be greater than 10000", "roomTypeId must be a UUID"]);
      expect(apiErrorText(error, swedish)).toBe(
        "Uppgifterna kunde inte sparas. name should not be empty. capacity must not be greater than 10000. roomTypeId must be a UUID.",
      );
      expect(apiErrorText(error, english)).toBe(
        "The details could not be saved. name should not be empty. capacity must not be greater than 10000. roomTypeId must be a UUID.",
      );
      // One that already ends in a mark keeps it, and a count follows a sentence of its own.
      expect(apiErrorText(refused(["Nivån är för hög.", "x", "y", "z"]), swedish)).toBe(
        "Uppgifterna kunde inte sparas. Nivån är för hög. x. y. Dessutom 1 fel till.",
      );
    });

    it("falls back to the detail for a 400 that sent no sentences", () => {
      expect(apiErrorText(apiError(400, "Bedömningen säger ingenting."), swedish)).toBe("Bedömningen säger ingenting.");
      expect(apiErrorText(refused([]), swedish)).toBe("One or more fields failed validation.");
    });
  });

  describe("a refusal with no code, whose sentence is a log's", () => {
    it.each([
      [404, "The requested resource does not exist.", "Det du försökte nå finns inte längre. Ladda om sidan och försök igen.", "What you tried to reach no longer exists. Reload the page and try again."],
      [404, "Cannot PUT /api/v1/scope-assessments/0000", "Det du försökte nå finns inte längre. Ladda om sidan och försök igen.", "What you tried to reach no longer exists. Reload the page and try again."],
      [404, "Academic year not found.", "Det du försökte nå finns inte längre. Ladda om sidan och försök igen.", "What you tried to reach no longer exists. Reload the page and try again."],
      [429, "ThrottlerException: Too Many Requests", "För många förfrågningar på kort tid. Vänta en stund och försök igen.", "Too many requests in a short time. Wait a moment and try again."],
      [500, "An unexpected error occurred. Please try again later.", "Något gick fel hos oss. Försök igen om en stund.", "Something went wrong on our side. Try again in a moment."],
      [502, "HTTP 502", "Något gick fel hos oss. Försök igen om en stund.", "Something went wrong on our side. Try again in a moment."],
      [503, "Service Unavailable", "Något gick fel hos oss. Försök igen om en stund.", "Something went wrong on our side. Try again in a moment."],
      [401, "Not authenticated.", "Din inloggning har gått ut. Logga in igen.", "Your session has expired. Sign in again."],
    ])("says a %i in both languages instead of %j", (status, detail, svText, enText) => {
      expect(apiErrorText(apiError(status, detail), swedish)).toBe(svText);
      expect(apiErrorText(apiError(status, detail), english)).toBe(enText);
    });
  });

  describe("what it leaves as it is", () => {
    it("a refusal the gateway named, whose thrower worded it", () => {
      // 404 and 429 too: a code means a sentence written for the reader, or one a page words itself from the code.
      expect(apiErrorText(apiError(404, "Läsåret finns inte.", "ACADEMIC_YEAR_NOT_FOUND"), swedish)).toBe("Läsåret finns inte.");
      expect(apiErrorText(apiError(429, "För många försök.", "LOGIN_THROTTLED"), swedish)).toBe("För många försök.");
      expect(apiErrorText(apiError(403, "Schemaläggare fattar inte det här beslutet.", "DECISION_NOT_YOURS"), swedish)).toBe(
        "Schemaläggare fattar inte det här beslutet.",
      );
    });

    it("a 400, 403 or 409 with no code and no sentences, which the gateway's service worded", () => {
      expect(apiErrorText(apiError(400, "Bedömningen säger ingenting."), swedish)).toBe("Bedömningen säger ingenting.");
      expect(apiErrorText(apiError(403, "Forbidden resource"), swedish)).toBe("Forbidden resource");
      expect(apiErrorText(apiError(409, "Rummet är dubbelbokat."), swedish)).toBe("Rummet är dubbelbokat.");
    });

    it("an error that is not the gateway's, and a thrown value that is not an error", () => {
      expect(apiErrorText(new Error("Namnet kan inte vara tomt."), swedish)).toBe("Namnet kan inte vara tomt.");
      expect(apiErrorText("boom", swedish)).toBe("Något gick fel");
      expect(apiErrorText(undefined, english)).toBe("Something went wrong");
    });
  });

  it("asks the translator for keys only, never for `has`, so the page tests' echo stub is enough", () => {
    const asked: string[] = [];
    const echo: ProblemLookup = (key, values) => {
      asked.push(key);
      return `common.${key}${values ? JSON.stringify(values) : ""}`;
    };
    expect(apiErrorText(apiError(404, "x"), echo)).toBe("common.problemNotFound");
    expect(apiErrorText(apiError(0, "x", NETWORK_FAILURE), echo)).toBe("common.problemNetwork");
    expect(apiErrorText(apiError(400, "x", undefined, ["a"]), echo)).toBe('common.problemValidation{"problems":"a."}');
    expect(asked).toEqual(["problemNotFound", "problemNetwork", "problemValidation"]);
  });
});
