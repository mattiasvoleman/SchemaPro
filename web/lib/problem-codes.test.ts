import { parse, TYPE, type MessageFormatElement } from "@formatjs/icu-messageformat-parser";
import { createTranslator } from "use-intl";
import { describe, expect, it } from "vitest";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import { apiErrorText, type ProblemLookup } from "@/lib/api-error-text";
import { PROBLEM_CODES } from "@/lib/problem-codes";

/** An ApiError as api.ts builds one, as a shape: api-error-text.ts does not import the class. */
function apiError(status: number, message: string, code?: string, params?: Record<string, unknown>): Error {
  return Object.assign(new Error(message), { name: "ApiError", status, code, params });
}

// The real catalogues, through the real translator.
const swedish = createTranslator({ locale: "sv", messages: sv, namespace: "common" }) as unknown as ProblemLookup;
const english = createTranslator({ locale: "en", messages: en, namespace: "common" }) as unknown as ProblemLookup;
const sentencesOf = (messages: typeof sv): Record<string, string> => messages.common.codes;

/**
 * What each thrower sends beside its code, as the gateway's filter passes it on (flat names, short strings and numbers): read off the
 * throw sites in src/, the ones that send any. A code that is not here sends none. Some of the values are not used by the sentence
 * (the sentence says no more than the thrower knew in every case it stands for), and they are here all the same: an argument the
 * sentence does not take must change nothing.
 */
const SENT: Record<string, Record<string, string | number>> = {
  ACTIVITY_OWNS_BATCH: { activityId: "0d4c0e1e-6a53-4d37-9d06-0a6a1c9d7e11" },
  CLASS_BOOK_RANGE: { max: 92 },
  EXAM_ROOM: { capacity: 30 },
  EXAM_TOO_MANY: { limit: 50 },
  EXTERNAL_BOOKINGS_REGISTERED: { date: "2026-12-04" },
  LESSON_LOG_RANGE: { max: 42 },
  LESSON_LOG_TOO_LONG: { field: "topic", max: 200 },
  STUDENT_GROUP_HAS_ENROLMENT_HISTORY: { year: "2026/27" },
  SUBJECT_QUALIFICATION_IS_INHERITED: { subjectId: "7b1f", inheritorId: "8c2e" },
  SUBJECT_QUALIFICATION_IS_ITSELF: { subjectId: "7b1f" },
  SUBJECT_QUALIFICATION_SOURCE_INHERITS: { subjectId: "7b1f", sourceId: "9d3a" },
  TEMPLATE_DUPLICATE_FIELD: { field: "email" },
  TEMPLATE_DUPLICATE_KEY: { index: 3 },
  TEMPLATE_FIELDS_CONFLICT: { a: "firstName", b: "fullName" },
  TEMPLATE_LABEL_INVALID: { index: 2 },
  TEMPLATE_NAME_INVALID: { max: 80 },
  TEMPLATE_PERSONAL_NUMBER: { index: 1 },
  TEMPLATE_TOO_LARGE: { maxPlacements: 120, maxBytes: 40000 },
  TEMPLATE_UNKNOWN_FIELD: { field: "shoeSize", kind: "STUDENTS" },
  TIMPLAN_CREDIT_GROUP_OF_ANOTHER_YEAR: { groupName: "7A", yearName: "2026/27" },
  TIMPLAN_CREDIT_SCOPE: { fields: "minGradeLevel, maxGradeLevel" },
  USER_LEFT_ON_BEFORE_RETURN: { returned: "2026-08-17" },
  USER_LEFT_ON_BEFORE_START: { added: "2026-01-12" },
};

/** The gateway's own sentence, as `detail` carries it: what must NOT be shown for a code that has one in the catalogue. */
const DETAIL = "Gatewayens egen mening i kastarens språk.";

/**
 * The arguments a sentence names: every argument of its ICU syntax tree, the ones a `select` or a plural chooses on and the ones its
 * branches take. A scan for `{name}` would read the one-word branch of a select ("{Monday}") as an argument, and does not tell an
 * argument from the text a branch says.
 */
const argumentsOf = (sentence: string): string[] => {
  const names = (elements: readonly MessageFormatElement[]): string[] =>
    elements.flatMap((element) => {
      if (element.type === TYPE.literal || element.type === TYPE.pound) return [];
      if (element.type === TYPE.select || element.type === TYPE.plural) {
        return [element.value, ...Object.values(element.options).flatMap((option) => names(option.value))];
      }
      return [element.value];
    });
  return [...new Set(names(parse(sentence)))].sort();
};

/** What a declared name stands for: the name, without the `?` that says the gateway sends it for some cases only. */
const nameOf = (declared: string): string => (declared.endsWith("?") ? declared.slice(0, -1) : declared);
/** The declared names the gateway must send for the sentence to be said at all. */
const requiredOf = (code: string): string[] => PROBLEM_CODES[code]!.filter((declared) => !declared.endsWith("?"));

/** The sentence with its arguments filled by hand, so the expectation does not lean on the formatter under test. */
const filled = (sentence: string, values: Record<string, string | number>): string =>
  sentence.replace(/\{(\w+)\}/g, (_match, name: string) => String(values[name]));

/**
 * The codes whose sentence chooses on one of its params (a `select` on the reason): filled by hand it would be the formatter's job done
 * twice, so each is said in a describe of its own below, branch by branch.
 */
const SELECTING = new Set(["MASTER_LESSON_REFUSED"]);

const CODES = Object.keys(PROBLEM_CODES);

describe("a problem with a code the web has a sentence for", () => {
  it("lists codes", () => {
    expect(CODES.length).toBeGreaterThan(0);
    expect(CODES).toContain("DATABASE_BUSY");
  });

  describe.each([
    ["sv", swedish, sv],
    ["en", english, en],
  ] as const)("in %s", (_name, translator, messages) => {
    it.each(CODES.filter((code) => !SELECTING.has(code)))("%s is said as the catalogue's sentence, not as the gateway's", (code) => {
      const error = apiError(code === "DATABASE_BUSY" ? 503 : 409, DETAIL, code, SENT[code]);
      const expected = filled(sentencesOf(messages)[code]!, SENT[code] ?? {});
      const shown = apiErrorText(error, translator);
      expect(shown).toBe(expected);
      expect(shown).not.toBe(DETAIL);
      // A sentence that was not filled, or the translator's own fallback for a key it has not got.
      expect(shown).not.toMatch(/[{}]|common\.codes|codes\./);
    });
  });

  it("is the same sentence whatever the gateway wrote as detail, and an empty detail makes no difference", () => {
    for (const detail of ["No such limit.", "Salsbytet skulle krocka med en annan lektion i samma sal.", ""]) {
      expect(apiErrorText(apiError(409, detail, "ROOM_CLASH"), swedish)).toBe(
        "Salsbytet skulle krocka med en annan lektion i samma sal. Inget ändrades.",
      );
      expect(apiErrorText(apiError(409, detail, "ROOM_CLASH"), english)).toBe(
        "The room change would clash with another lesson in the same room. Nothing was changed.",
      );
    }
  });

  it("says the busy server in the reader's language, which the gateway's English detail does not", () => {
    const busy = apiError(503, "The server is busy right now, and nothing was done. Try again in a moment.", "DATABASE_BUSY");
    expect(apiErrorText(busy, swedish)).toBe("Servern är upptagen just nu, och inget har gjorts. Försök igen om en stund.");
    expect(apiErrorText(busy, english)).toBe("The server is busy right now, and nothing was done. Try again in a moment.");
  });

  it("says each answer of the body parser, with each of the sentences the filter words its code with, as a general sentence in the reader's language", () => {
    // The filter's five: a body too large and one with too many fields (413), one that is not JSON (400), an encoding and a character set it will not read (415).
    const SENTENCES: ReadonlyArray<readonly [number, string, string, "problemTooLarge" | "problemBadRequest"]> = [
      [413, "REQUEST_BODY_TOO_LARGE", "The request body is too large. Split the import into smaller files and upload them one at a time.", "problemTooLarge"],
      [413, "REQUEST_BODY_TOO_LARGE", "The request body has too many fields.", "problemTooLarge"],
      [400, "REQUEST_BODY_NOT_JSON", "The request body is not valid JSON.", "problemBadRequest"],
      [415, "REQUEST_ENCODING_UNSUPPORTED", "The request body uses an unsupported content encoding.", "problemBadRequest"],
      [415, "REQUEST_ENCODING_UNSUPPORTED", "The request body uses an unsupported character set. Send it as UTF-8.", "problemBadRequest"],
    ];
    for (const [status, code, detail, key] of SENTENCES) {
      expect(apiErrorText(apiError(status, detail, code), swedish)).toBe(sv.common[key]);
      expect(apiErrorText(apiError(status, detail, code), english)).toBe(en.common[key]);
    }
  });

  it("says a sentence that is only the filter's log as the general one, ahead of the table, whatever code it is sent with", () => {
    // GATEWAY_LOG is asked first (lib/api-error-text.ts generalKey) and the table after: a code the table holds does not bring a log's English back.
    const log = "The request body is too large. Split the import into smaller files and upload them one at a time.";
    expect(apiErrorText(apiError(413, log, "DATABASE_BUSY"), swedish)).toBe(sv.common.problemTooLarge);
    expect(apiErrorText(apiError(413, log, "DATABASE_BUSY"), english)).toBe(en.common.problemTooLarge);
  });

  it("fills the sentence from the params the gateway sent", () => {
    const tooLong = apiError(400, "topic: högst 200 tecken.", "LESSON_LOG_TOO_LONG", { field: "topic", max: 200 });
    expect(apiErrorText(tooLong, swedish)).toBe("Texten är för lång: högst 200 tecken.");
    expect(apiErrorText(tooLong, english)).toBe("The text is too long: at most 200 characters.");
    const clash = apiError(400, "x", "TEMPLATE_FIELDS_CONFLICT", { a: "firstName", b: "fullName" });
    expect(apiErrorText(clash, swedish)).toBe("Fälten firstName och fullName läser samma celler och kan inte placeras tillsammans.");
  });

  it("falls back to the gateway's sentence when an argument the sentence takes did not arrive, never to the translator's fallback", () => {
    const withArguments = CODES.filter((code) => requiredOf(code).length > 0);
    expect(withArguments.length).toBeGreaterThan(0);
    for (const code of withArguments) {
      for (const sent of [undefined, {}, { unrelated: 1 }, ...requiredOf(code).map((name) => ({ ...SENT[code], [name]: undefined }))]) {
        const error = apiError(400, DETAIL, code, sent);
        expect(apiErrorText(error, swedish)).toBe(DETAIL);
        expect(apiErrorText(error, english)).toBe(DETAIL);
      }
    }
  });

  it("takes only a string or a finite number for an argument", () => {
    for (const value of [null, true, ["7A"], { name: "7A" }, Number.NaN, Number.POSITIVE_INFINITY]) {
      const error = apiError(400, DETAIL, "TIMPLAN_CREDIT_GROUP_OF_ANOTHER_YEAR", { groupName: value, yearName: "2026/27" });
      expect(apiErrorText(error, swedish)).toBe(DETAIL);
    }
    const ok = apiError(400, DETAIL, "TIMPLAN_CREDIT_GROUP_OF_ANOTHER_YEAR", { groupName: 7, yearName: "2026/27" });
    expect(apiErrorText(ok, swedish)).toBe("Gruppen 7 hör till ett annat läsår än 2026/27.");
  });

  it("asks the translator for keys only, never for `has`, with values only for a sentence that takes any", () => {
    const asked: Array<[string, unknown]> = [];
    const echo: ProblemLookup = (key, values) => {
      asked.push([key, values]);
      return `common.${key}`;
    };
    expect(apiErrorText(apiError(503, DETAIL, "DATABASE_BUSY"), echo)).toBe("common.codes.DATABASE_BUSY");
    expect(apiErrorText(apiError(400, DETAIL, "LESSON_LOG_TOO_LONG", { field: "topic", max: 200 }), echo)).toBe("common.codes.LESSON_LOG_TOO_LONG");
    expect(asked).toEqual([
      ["codes.DATABASE_BUSY", undefined],
      ["codes.LESSON_LOG_TOO_LONG", { max: 200 }],
    ]);
  });
});

/**
 * MASTER_LESSON_REFUSED (src/calendar/lesson-refusal.ts): one sentence that chooses on the reason, so each reason is said here with what
 * the gateway sends for it (src/calendar/lesson-judge.ts), in both languages, through the real translator.
 */
describe("MASTER_LESSON_REFUSED, said reason by reason", () => {
  const other = { otherKind: "LESSON", className: "8B", subjectName: "Kemi", day: 1, start: "13:10", end: "14:10" };
  const CASES: ReadonlyArray<readonly [string, Record<string, string | number>, string, string]> = [
    ["TEACHER", other, "Läraren har redan Kemi med 8B, måndag 13:10–14:10.", "The teacher already has Kemi with 8B, Monday 13:10–14:10."],
    ["ROOM", { ...other, day: 2 }, "Salen är redan upptagen av Kemi med 8B, tisdag 13:10–14:10.", "The room is already taken by Kemi with 8B, Tuesday 13:10–14:10."],
    ["GROUP", { ...other, day: 5 }, "Klassen har redan Kemi med 8B, fredag 13:10–14:10.", "The class already has Kemi with 8B, Friday 13:10–14:10."],
    [
      "PUPILS",
      { ...other, day: 3 },
      "Elever i klassen är också med i en annan grupp som har Kemi med 8B, onsdag 13:10–14:10.",
      "Pupils of the class are also in another group that has Kemi with 8B, Wednesday 13:10–14:10.",
    ],
    ["GROUP", { ...other, pupilTime: 1, note: "Klassen är upptagen med ombyte eller dusch." }, "Klassen är upptagen med ombyte eller dusch kring Kemi med 8B, måndag 13:10–14:10.", "The class is busy changing or showering around Kemi with 8B, Monday 13:10–14:10."],
    ["AVAILABILITY", { resource: "TEACHER" }, "Läraren är markerad som inte tillgänglig då.", "The teacher is marked as unavailable then."],
    ["AVAILABILITY", { resource: "ROOM" }, "Salen är markerad som inte tillgänglig då.", "The room is marked as unavailable then."],
    ["AVAILABILITY", { resource: "GROUP" }, "Klassen är markerad som inte tillgänglig då.", "The class is marked as unavailable then."],
    ["SCHOOL_DAY", {}, "Lektionen ligger utanför skoldagen: måndag till fredag.", "The lesson is outside the school day: Monday to Friday."],
    ["FRAME", {}, "Tiden ligger utanför ramtiden för klassens stadium.", "The time is outside the frame time of the class's stage."],
    ["LUNCH", {}, "Tiden ligger på klassens lunch.", "The time is on the class's lunch."],
    ["GRADE_RULE", {}, "Tiden är stängd för klassens årskurs.", "The time is closed to the class's year."],
    ["OTHER_SCHOOL", { schools: "Norra skolan, Södra skolan" }, "Tiden är upptagen av Norra skolan, Södra skolan.", "The time is held by Norra skolan, Södra skolan."],
  ];

  it.each(CASES)("%s %j", (reason, params, inSwedish, inEnglish) => {
    const error = apiError(409, DETAIL, "MASTER_LESSON_REFUSED", { reason, reasons: reason, ...params });
    expect(apiErrorText(error, swedish)).toBe(inSwedish);
    expect(apiErrorText(error, english)).toBe(inEnglish);
  });

  it("is said with no value for a name only another reason sends, and the whole sentence falls back to `detail` without the reason", () => {
    // FRAME sends no class, no subject and no clock: the names are passed empty, and the branch that is chosen never reads them.
    for (const reason of ["SCHOOL_DAY", "FRAME", "LUNCH", "GRADE_RULE"]) {
      const said = apiErrorText(apiError(409, DETAIL, "MASTER_LESSON_REFUSED", { reason }), swedish);
      expect(said).not.toBe(DETAIL);
      expect(said).not.toMatch(/[{}]|common\.codes|codes\./);
    }
    expect(apiErrorText(apiError(409, DETAIL, "MASTER_LESSON_REFUSED", {}), swedish)).toBe(DETAIL);
    expect(apiErrorText(apiError(409, DETAIL, "MASTER_LESSON_REFUSED", { reason: ["TEACHER"] }), english)).toBe(DETAIL);
  });

  it("falls to the gateway's own sentence for a reason it has no words for, and for a clash that names no other lesson", () => {
    // A newer gateway's reason is not "the class already has ...", and a clash with no lesson is not "... with , day  –".
    expect(apiErrorText(apiError(409, DETAIL, "MASTER_LESSON_REFUSED", { reason: "SOMETHING_NEW", ...other }), swedish)).toBe(DETAIL);
    expect(apiErrorText(apiError(409, DETAIL, "MASTER_LESSON_REFUSED", { reason: "TEACHER" }), swedish)).toBe(DETAIL);
    expect(apiErrorText(apiError(409, DETAIL, "MASTER_LESSON_REFUSED", { reason: "PUPILS", reasons: "PUPILS" }), english)).toBe(DETAIL);
    expect(apiErrorText(apiError(409, DETAIL, "MASTER_LESSON_REFUSED", { reason: "OTHER_SCHOOL" }), swedish)).toBe(DETAIL);
    // The rules that name no lesson are said without one.
    expect(apiErrorText(apiError(409, DETAIL, "MASTER_LESSON_REFUSED", { reason: "FRAME" }), swedish)).toBe("Tiden ligger utanför ramtiden för klassens stadium.");
  });

  it("names a day of the week the sentence has no word for as a day number, in both languages", () => {
    const error = apiError(409, DETAIL, "MASTER_LESSON_REFUSED", { reason: "TEACHER", ...other, day: 9 });
    expect(apiErrorText(error, swedish)).toBe("Läraren har redan Kemi med 8B, dag 9 13:10–14:10.");
    expect(apiErrorText(error, english)).toBe("The teacher already has Kemi with 8B, day 9 13:10–14:10.");
  });

  it("is said for a Saturday and a Sunday, which a school with a weekend lesson has", () => {
    expect(apiErrorText(apiError(409, DETAIL, "MASTER_LESSON_REFUSED", { reason: "ROOM", ...other, day: 6 }), swedish)).toContain("lördag");
    expect(apiErrorText(apiError(409, DETAIL, "MASTER_LESSON_REFUSED", { reason: "ROOM", ...other, day: 7 }), english)).toContain("Sunday");
  });
});

describe("a problem whose code the web has no sentence for", () => {
  it("still shows the gateway's sentence", () => {
    expect(apiErrorText(apiError(409, "Rummet är dubbelbokat.", "ROOM_DOUBLE_BOOKED_TOMORROW"), swedish)).toBe("Rummet är dubbelbokat.");
    expect(apiErrorText(apiError(404, "No such thing.", "NOTHING_LIKE_IT", { name: "x" }), english)).toBe("No such thing.");
    // A 404 or a 5xx with a code is the thrower's too, as before.
    expect(apiErrorText(apiError(503, "Tjänsten är nere.", "SOME_OTHER_OUTAGE"), swedish)).toBe("Tjänsten är nere.");
  });

  it("is not fooled by a code that names a property every object has", () => {
    for (const code of ["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf"]) {
      expect(apiErrorText(apiError(400, DETAIL, code), swedish)).toBe(DETAIL);
    }
  });

  it("is still said as a status for a refusal with no code at all", () => {
    expect(apiErrorText(apiError(503, "Service Unavailable"), swedish)).toBe("Något gick fel hos oss. Försök igen om en stund.");
    expect(apiErrorText(apiError(404, "The requested resource does not exist."), english)).toBe(
      "What you tried to reach no longer exists. Reload the page and try again.",
    );
  });
});

describe("the list and the catalogues", () => {
  it("has the same codes as common.codes in Swedish and in English, no more and no fewer", () => {
    expect(Object.keys(sentencesOf(sv)).sort()).toEqual([...CODES].sort());
    expect(Object.keys(sentencesOf(en)).sort()).toEqual([...CODES].sort());
  });

  it("holds names of codes, in the gateway's own shape (a code is a name, not a sentence)", () => {
    for (const code of CODES) expect(code).toMatch(/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/);
  });

  it.each(CODES)("%s: the arguments the list declares are the ones both sentences take", (code) => {
    const declared = PROBLEM_CODES[code]!.map(nameOf).sort();
    expect(argumentsOf(sentencesOf(sv)[code]!)).toEqual(declared);
    expect(argumentsOf(sentencesOf(en)[code]!)).toEqual(declared);
  });

  it.each(CODES)("%s: is a whole sentence in each language, written for the reader and not for a log", (code) => {
    const swedishSentence = sentencesOf(sv)[code]!;
    const englishSentence = sentencesOf(en)[code]!;
    for (const sentence of [swedishSentence, englishSentence]) {
      expect(sentence).toMatch(/^[A-ZÅÄÖ{0-9]/);
      expect(sentence).toMatch(/[.!?]$/);
      // The gateway's convention for naming the field ("name: ...", "gradeFrom, gradeTo: ...") is for a client, not for a reader.
      expect(sentence).not.toMatch(/^[a-zA-Z]+(?:, [a-zA-Z]+)*: /);
    }
    // Written in its own language: the English one has no Swedish letters, and is not the Swedish one.
    expect(englishSentence).not.toMatch(/[åäöÅÄÖ]/);
    expect(englishSentence).not.toBe(swedishSentence);
  });
});
