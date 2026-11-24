import { createTranslator } from "use-intl";
import { describe, expect, it } from "vitest";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import { NETWORK_FAILURE, apiErrorText, fieldProblem, ownWords, type ProblemLookup } from "@/lib/api-error-text";

/** An ApiError as api.ts builds one, as a shape: this module does not import the class. */
function apiError(status: number, message: string, code?: string, problems?: string[], method?: string): Error {
  return Object.assign(new Error(message), { name: "ApiError", status, code, problems, method });
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

    it("says class-validator's own English in the reader's language, with the property it names, and ends each sentence", () => {
      // What the gateway sends for CreateRoomDto with no name, a capacity of 20000 and a roomTypeId that is no UUID.
      const error = refused(["name should not be empty", "capacity must not be greater than 10000", "roomTypeId must be a UUID"]);
      expect(apiErrorText(error, swedish)).toBe(
        "Uppgifterna kunde inte sparas. Fältet ”name” får inte vara tomt. Fältet ”capacity” får inte vara större än 10000. Fältet ”roomTypeId” måste vara ett giltigt id.",
      );
      expect(apiErrorText(error, english)).toBe(
        "The details could not be saved. The field “name” must not be empty. The field “capacity” must not be greater than 10000. The field “roomTypeId” must be a valid id.",
      );
      // A wording it does not know is shown as the gateway wrote it, with a stop so that it does not run into the next; one that already ends
      // in a mark keeps it, and a count follows a sentence of its own.
      expect(apiErrorText(refused(["Nivån är för hög.", "x", "y", "z"]), swedish)).toBe(
        "Uppgifterna kunde inte sparas. Nivån är för hög. x. y. Dessutom 1 fel till.",
      );
    });

    it("says a refused read as a read, since the gateway checks a query's parameters with a DTO too", () => {
      const read = apiError(400, "One or more fields failed validation.", undefined, ["from must be YYYY-MM-DD."], "GET");
      expect(apiErrorText(read, swedish)).toBe("Det gick inte att hämta uppgifterna. Fältet ”from” måste vara ett datum, ÅÅÅÅ-MM-DD.");
      expect(apiErrorText(read, english)).toBe("The data could not be fetched. The field “from” must be a date, YYYY-MM-DD.");
      const written = apiError(400, "One or more fields failed validation.", undefined, ["from must be YYYY-MM-DD."], "PUT");
      expect(apiErrorText(written, swedish)).toContain("Uppgifterna kunde inte sparas.");
      // A request that was not given a method (a failure made before api.ts knew it) is a write, as it was.
      expect(apiErrorText(refused(["a."]), swedish)).toContain("Uppgifterna kunde inte sparas.");
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
      [401, "Invalid authentication token.", "Din inloggning har gått ut. Logga in igen.", "Your session has expired. Sign in again."],
      [
        401,
        "No active user profile is linked to this account.",
        "Ditt konto är inte kopplat till någon person i en skola. Kontakta skolans administratör.",
        "Your account is not linked to a person at a school. Contact the school's administrator.",
      ],
      [403, "Forbidden resource", "Du har inte behörighet att göra det här.", "You are not allowed to do this."],
      [403, "Forbidden", "Du har inte behörighet att göra det här.", "You are not allowed to do this."],
      [400, "Bad Request", "Förfrågan kunde inte behandlas. Ladda om sidan och försök igen.", "The request could not be processed. Reload the page and try again."],
      [403, "You do not have permission to perform this action.", "Du har inte behörighet att göra det här.", "You are not allowed to do this."],
      [
        409,
        "A resource with the same unique identifier already exists.",
        "Det finns redan något med samma uppgifter, eller så har någon annan ändrat det. Ladda om sidan och försök igen.",
        "Something with the same details already exists, or someone else has changed it. Reload the page and try again.",
      ],
      [
        413,
        "The request body is too large. Split the import into smaller files and upload them one at a time.",
        "Det som skickades är för stort. Dela upp det i mindre delar och försök igen.",
        "What was sent is too large. Split it into smaller parts and try again.",
      ],
      [415, "The request body uses an unsupported content encoding.", "Förfrågan kunde inte behandlas. Ladda om sidan och försök igen.", "The request could not be processed. Reload the page and try again."],
      [400, "The request body is not valid JSON.", "Förfrågan kunde inte behandlas. Ladda om sidan och försök igen.", "The request could not be processed. Reload the page and try again."],
      [400, "The request could not be processed.", "Förfrågan kunde inte behandlas. Ladda om sidan och försök igen.", "The request could not be processed. Reload the page and try again."],
      [
        400,
        "The request references a resource that does not exist.",
        "Det du försökte nå finns inte längre. Ladda om sidan och försök igen.",
        "What you tried to reach no longer exists. Reload the page and try again.",
      ],
      [503, "Database is unreachable.", "Något gick fel hos oss. Försök igen om en stund.", "Something went wrong on our side. Try again in a moment."],
      [503, "Invitations are not configured for this deployment.", "Något gick fel hos oss. Försök igen om en stund.", "Something went wrong on our side. Try again in a moment."],
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
      expect(apiErrorText(apiError(403, "Bara lektionens lärare får göra det här."), swedish)).toBe("Bara lektionens lärare får göra det här.");
      expect(apiErrorText(apiError(409, "Rummet är dubbelbokat."), swedish)).toBe("Rummet är dubbelbokat.");
    });

    it("a 404, a 429 or a 5xx whose thrower wrote the reader's sentence in Swedish, which a general sentence would only hide", () => {
      // Läraren utan tjänst: "Det du försökte nå finns inte längre. Ladda om sidan" is the wrong advice for it.
      const noEmployment = "Läraren har ingen tjänst det läsåret. Lägg in tjänsten först; en period ändrar en tjänst från ett datum.";
      expect(apiErrorText(apiError(404, noEmployment), swedish)).toBe(noEmployment);
      expect(apiErrorText(apiError(404, "Personen står inte i vikariepoolen."), swedish)).toBe("Personen står inte i vikariepoolen.");
      expect(apiErrorText(apiError(404, "Provet finns inte."), swedish)).toBe("Provet finns inte.");
      expect(apiErrorText(apiError(503, "Mejlet kunde inte skickas. Försök igen."), swedish)).toBe("Mejlet kunde inte skickas. Försök igen.");
      expect(apiErrorText(apiError(429, "Du har provat för många gånger."), swedish)).toBe("Du har provat för många gånger.");
      expect(apiErrorText(apiError(500, "Något oväntat hände i sparandet."), swedish)).toBe("Något oväntat hände i sparandet.");
    });

    it("a coded refusal, even one that carries validation sentences", () => {
      expect(apiErrorText(apiError(400, "Läsåret finns inte.", "ACADEMIC_YEAR_NOT_FOUND", ["name should not be empty"]), swedish)).toBe("Läsåret finns inte.");
    });

    it("an English sentence of a 429 that is not Nest's own is a log's, like the 404's", () => {
      expect(apiErrorText(apiError(429, "Rate limit exceeded for this client."), swedish)).toBe(
        "För många förfrågningar på kort tid. Vänta en stund och försök igen.",
      );
    });

    it("the sentence of a 400, 403 or 409 that is neither the filter's nor a guard's, in whatever language the service wrote it", () => {
      expect(apiErrorText(apiError(409, "That room is already booked for this time."), swedish)).toBe("That room is already booked for this time.");
      expect(apiErrorText(apiError(400, "Bookings must be in the future."), swedish)).toBe("Bookings must be in the future.");
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
    expect(apiErrorText(apiError(400, "x", undefined, ["a"]), echo)).toBe('common.problemValidation{"problems":"a.","kind":"write"}');
    expect(asked).toEqual(["problemNotFound", "problemNetwork", "problemValidation"]);
  });
});

describe("ownWords", () => {
  it("is the gateway's own sentence for a thrower's words, and nothing for a log's, a lost connection or a validation list", () => {
    expect(ownWords(apiError(404, "Provet finns inte."))).toBe("Provet finns inte.");
    expect(ownWords(apiError(409, "Rummet är dubbelbokat."))).toBe("Rummet är dubbelbokat.");
    expect(ownWords(apiError(409, "Läraren är upptagen.", "TEACHER_BUSY"))).toBe("Läraren är upptagen.");
    expect(ownWords(apiError(500, "An unexpected error occurred. Please try again later."))).toBe("");
    expect(ownWords(apiError(404, "Academic year not found."))).toBe("");
    expect(ownWords(apiError(0, "Failed to fetch", NETWORK_FAILURE))).toBe("");
    expect(ownWords(apiError(400, "One or more fields failed validation.", undefined, ["name should not be empty"]))).toBe("");
    expect(ownWords(new Error("Namnet kan inte vara tomt."))).toBe("Namnet kan inte vara tomt.");
    expect(ownWords("boom")).toBe("");
  });
});

describe("fieldProblem", () => {
  const refused = apiError(
    400,
    "One or more fields failed validation.",
    undefined,
    ["name should not be empty", "capacity must not be greater than 10000", "minutesPerWeek: minst 1 minut per vecka.", "Nivån kan vara högst 1500 timmar."],
  );

  it("is the sentence for the property, without the frame that names it, in the reader's language", () => {
    expect(fieldProblem(refused, "name", swedish)).toBe("Får inte vara tomt.");
    expect(fieldProblem(refused, "name", english)).toBe("Must not be empty.");
    expect(fieldProblem(refused, "capacity", swedish)).toBe("Får inte vara större än 10000.");
  });

  it("takes a sentence the gateway's DTO worded as `property: sentence` for its property, and shows what follows the property", () => {
    expect(fieldProblem(refused, "minutesPerWeek", swedish)).toBe("Minst 1 minut per vecka.");
  });

  it("does not draw a sentence about every value of a list at the list's own field", () => {
    expect(fieldProblem(apiError(400, "x", undefined, ["each value in userIds must be a UUID"]), "userIds", swedish)).toBeUndefined();
  });

  it("is undefined for a property no sentence names, a sentence that names none, and a failure that is no validation", () => {
    expect(fieldProblem(refused, "roomTypeId", swedish)).toBeUndefined();
    expect(fieldProblem(apiError(400, "x", undefined, ["Nivån kan vara högst 1500 timmar."]), "level", swedish)).toBeUndefined();
    expect(fieldProblem(apiError(409, "Rummet är dubbelbokat."), "name", swedish)).toBeUndefined();
    expect(fieldProblem(undefined, "name", swedish)).toBeUndefined();
  });
});
