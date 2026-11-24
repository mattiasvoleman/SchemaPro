import { createTranslator } from "use-intl";
import { describe, expect, it } from "vitest";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import { fieldSentence, readValidation, validationSentence, type ValidationLookup } from "@/lib/validation-problems";

const swedish = createTranslator({ locale: "sv", messages: sv, namespace: "common" }) as unknown as ValidationLookup;
const english = createTranslator({ locale: "en", messages: en, namespace: "common" }) as unknown as ValidationLookup;

/**
 * Each wording class-validator gives a decorator the gateway uses (src DTOs: IsString, IsNotEmpty, IsUUID, IsInt, Min, Max, MaxLength,
 * MinLength, IsBoolean, IsArray, ArrayMaxSize, ArrayMinSize, IsEnum and IsIn, the whitelist, ValidateNested, IsEmail, IsISO8601,
 * IsDateString, IsDefined, IsNumber, IsObject) and the wordings the gateway's own DTOs repeat, with what each says in both languages.
 */
const CASES: ReadonlyArray<readonly [string, string, string, string]> = [
  ["name should not be empty", "name", "Fältet ”name” får inte vara tomt.", "The field “name” must not be empty."],
  ["name must be a string", "name", "Fältet ”name” måste vara en text.", "The field “name” must be text."],
  ["roomTypeId must be a UUID", "roomTypeId", "Fältet ”roomTypeId” måste vara ett giltigt id.", "The field “roomTypeId” must be a valid id."],
  ["academicYearId must be a valid UUIDv4.", "academicYearId", "Fältet ”academicYearId” måste vara ett giltigt id.", "The field “academicYearId” must be a valid id."],
  ["capacity must be an integer number", "capacity", "Fältet ”capacity” måste vara ett heltal.", "The field “capacity” must be a whole number."],
  ["weight must be a number conforming to the specified constraints", "weight", "Fältet ”weight” måste vara ett tal.", "The field “weight” must be a number."],
  ["capacity must not be less than 1", "capacity", "Fältet ”capacity” får inte vara mindre än 1.", "The field “capacity” must not be less than 1."],
  ["capacity must not be greater than 10000", "capacity", "Fältet ”capacity” får inte vara större än 10000.", "The field “capacity” must not be greater than 10000."],
  ["factor must not be less than -0.5", "factor", "Fältet ”factor” får inte vara mindre än -0.5.", "The field “factor” must not be less than -0.5."],
  ["note must be shorter than or equal to 500 characters", "note", "Fältet ”note” får vara högst 500 tecken långt.", "The field “note” must be at most 500 characters."],
  ["name must be longer than or equal to 2 characters", "name", "Fältet ”name” måste vara minst 2 tecken långt.", "The field “name” must be at least 2 characters."],
  ["active must be a boolean value", "active", "Fältet ”active” måste vara ja eller nej.", "The field “active” must be yes or no."],
  ["userIds must be an array", "userIds", "Fältet ”userIds” måste vara en lista.", "The field “userIds” must be a list."],
  ["userIds must contain no more than 500 elements", "userIds", "Fältet ”userIds” får innehålla högst 500 poster.", "The field “userIds” may hold at most 500 items."],
  ["userIds must contain at least 1 elements", "userIds", "Fältet ”userIds” måste innehålla minst 1 poster.", "The field “userIds” must hold at least 1 items."],
  ["kind must be one of the following values: A, B, C", "kind", "Fältet ”kind” måste vara ett av: A, B, C.", "The field “kind” must be one of: A, B, C."],
  ["status must be one of: PRESENT, ABSENT.", "status", "Fältet ”status” måste vara ett av: PRESENT, ABSENT.", "The field “status” must be one of: PRESENT, ABSENT."],
  ["property foo should not exist", "foo", "Fältet ”foo” ska inte finnas med.", "The field “foo” should not be sent."],
  ["nested property items must be either object or array", "items", "Fältet ”items” måste vara ett objekt eller en lista.", "The field “items” must be an object or a list."],
  ["policy must be an object", "policy", "Fältet ”policy” måste vara ett objekt.", "The field “policy” must be an object."],
  ["email must be an email", "email", "Fältet ”email” måste vara en e-postadress.", "The field “email” must be an email address."],
  ["recordedAt must be a valid ISO 8601 date string", "recordedAt", "Fältet ”recordedAt” måste vara ett giltigt datum (ISO 8601).", "The field “recordedAt” must be a valid ISO 8601 date."],
  ["startDate must be YYYY-MM-DD.", "startDate", "Fältet ”startDate” måste vara ett datum, ÅÅÅÅ-MM-DD.", "The field “startDate” must be a date, YYYY-MM-DD."],
  ["date must be a real date in YYYY-MM-DD form.", "date", "Fältet ”date” måste vara ett datum, ÅÅÅÅ-MM-DD.", "The field “date” must be a date, YYYY-MM-DD."],
  ["startTime must be HH:MM.", "startTime", "Fältet ”startTime” måste vara ett klockslag, TT:MM.", "The field “startTime” must be a time, HH:MM."],
  ["toId should not be null or undefined", "toId", "Fältet ”toId” saknas.", "The field “toId” is missing."],
  ["items.0.name should not be empty", "items.0.name", "Fältet ”items.0.name” får inte vara tomt.", "The field “items.0.name” must not be empty."],
];

describe("readValidation and validationSentence", () => {
  it.each(CASES)("%s", (raw, field, svText, enText) => {
    const problem = readValidation(raw);
    expect(problem.field).toBe(field);
    expect(problem.phrase).not.toBeNull();
    expect(validationSentence(problem, swedish)).toBe(svText);
    expect(validationSentence(problem, english)).toBe(enText);
  });

  it("says `each value in` of a list's values", () => {
    const problem = readValidation("each value in userIds must be a UUID");
    expect(problem).toMatchObject({ field: "userIds", each: true });
    expect(validationSentence(problem, swedish)).toBe("Varje värde i fältet ”userIds” måste vara ett giltigt id.");
    expect(validationSentence(problem, english)).toBe("Every value in the field “userIds” must be a valid id.");
  });

  it("reads the property of the gateway's own `property: sentence` and shows the sentence as it came", () => {
    const problem = readValidation("minutesPerWeek: minst 1 minut per vecka.");
    expect(problem).toMatchObject({ field: "minutesPerWeek", each: false, phrase: null });
    expect(validationSentence(problem, swedish)).toBe("minutesPerWeek: minst 1 minut per vecka.");
    expect(validationSentence(problem, english)).toBe("minutesPerWeek: minst 1 minut per vecka.");
  });

  it("shows a sentence of a wording it does not know, or that names no property, as the gateway wrote it", () => {
    for (const raw of ["Nivån kan vara högst 1500 timmar.", "x must be a latitude string or number", "Bookings must be in the future."]) {
      const problem = readValidation(raw);
      expect(problem.phrase).toBeNull();
      expect(validationSentence(problem, swedish)).toBe(raw);
    }
    expect(readValidation("Nivån kan vara högst 1500 timmar.").field).toBeNull();
    expect(readValidation("x must be a latitude string or number").field).toBeNull();
  });

  it("needs no key it does not name: every key a case reads is in both catalogues", () => {
    for (const [raw] of CASES) {
      const problem = readValidation(raw);
      for (const lookup of [swedish, english]) {
        const said = validationSentence(problem, lookup);
        expect(said).not.toMatch(/^common\.|validation\./);
      }
    }
  });
});

describe("fieldSentence", () => {
  it("drops the frame that names the field, for the control that holds it", () => {
    expect(fieldSentence(readValidation("name should not be empty"), swedish)).toBe("Får inte vara tomt.");
    expect(fieldSentence(readValidation("name should not be empty"), english)).toBe("Must not be empty.");
    expect(fieldSentence(readValidation("capacity must not be greater than 10000"), swedish)).toBe("Får inte vara större än 10000.");
  });

  it("drops the property of `property: sentence` and capitalises what is left", () => {
    expect(fieldSentence(readValidation("minutesPerWeek: minst 1 minut per vecka."), swedish)).toBe("Minst 1 minut per vecka.");
  });

  it("gives a sentence that names no property as it came", () => {
    expect(fieldSentence(readValidation("Nivån kan vara högst 1500 timmar."), swedish)).toBe("Nivån kan vara högst 1500 timmar.");
  });
});
