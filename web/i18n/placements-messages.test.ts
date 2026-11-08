import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";

/**
 * Förlagda poster as the reader hears and sees it.
 *
 * The component tests echo keys, so they prove which sentence a row gets and
 * with which values, never what the sentence says. The sentences are chosen by
 * code (a verdict's reason is a key, the day an ICU select), which is where a
 * missing branch reads as a hole or as "dag 3" in a Swedish sentence. Rendered
 * here with the real catalogues, in both languages.
 */

const REASONS = [
  "TEACHER",
  "ROOM",
  "GROUP",
  "PUPILS",
  "AVAILABILITY",
  "FRAME",
  "LUNCH",
  "GRADE_RULE",
  "OTHER_SCHOOL",
  "SCHOOL_DAY",
  "OVER_DEMAND",
] as const;
const FIT_REASONS = ["LENGTH", "COUNT", "WEEKS", "PAIRS", "BLOCK", "SHARES", "POST"] as const;

const svT = createTranslator({ locale: "sv", messages: sv, namespace: "requirements.placements" });
const enT = createTranslator({ locale: "en", messages: en, namespace: "requirements.placements" });
const svEngine = createTranslator({ locale: "sv", messages: sv, namespace: "engineMessages" });
const enEngine = createTranslator({ locale: "en", messages: en, namespace: "engineMessages" });

/** What the gateway sends with a clash (placement-judge.ts); a reason with no clash sends less. */
const CLASH = { otherKind: "LESSON", className: "7B", subjectName: "Matematik", day: 2, start: "10:00", end: "11:00" };
const PARAMS: Record<(typeof REASONS)[number], Record<string, string | number>> = {
  TEACHER: CLASH,
  ROOM: { ...CLASH, otherKind: "PLACEMENT" },
  GROUP: CLASH,
  PUPILS: CLASH,
  AVAILABILITY: { resource: "ROOM" },
  FRAME: {},
  LUNCH: {},
  GRADE_RULE: {},
  OTHER_SCHOOL: { schools: "Östra skolan" },
  SCHOOL_DAY: {},
  OVER_DEMAND: {},
};

describe("a placed lesson's line", () => {
  const line = { day: "tis", start: "10:00", end: "11:00", room: "Simhallen" };

  it("says the day, the time, the room and the weeks when they are not every week", () => {
    expect(svT("row", { ...line, weeks: "ODD_WEEKS" })).toBe("tis 10:00–11:00, Simhallen, udda veckor");
    expect(svT("row", { ...line, weeks: "EVEN_WEEKS" })).toBe("tis 10:00–11:00, Simhallen, jämna veckor");
    expect(enT("row", { ...line, day: "tue", weeks: "ODD_WEEKS" })).toBe("tue 10:00–11:00, Simhallen, odd weeks");
  });

  it("says nothing of the weeks for a lesson that runs every week", () => {
    expect(svT("row", { ...line, weeks: "ALL_WEEKS" })).toBe("tis 10:00–11:00, Simhallen");
    expect(enT("row", { ...line, day: "tue", weeks: "ALL_WEEKS" })).toBe("tue 10:00–11:00, Simhallen");
  });

  it("is what the cell says of the mark", () => {
    expect(svT("badgeNote", { rows: "tis 10:00–11:00, Simhallen" })).toBe("Förlagd: tis 10:00–11:00, Simhallen");
    expect(enT("badgeNote", { rows: "tue 10:00–11:00, Simhallen" })).toBe("Placed: tue 10:00–11:00, Simhallen");
  });
});

describe("why a row cannot stand", () => {
  it.each(REASONS)("%s has a sentence in both languages, with every value filled in", (reason) => {
    for (const t of [svT, enT]) {
      const sentence = t(`verdict.${reason}`, PARAMS[reason]);
      expect(sentence.trim()).not.toBe("");
      expect(sentence).not.toMatch(/[{}]/);
      expect(sentence).not.toMatch(/undefined|NaN/);
    }
  });

  it("names the other lesson as a class and a subject, and what kind of lesson it is", () => {
    expect(svT("verdict.TEACHER", CLASH)).toBe("Läraren har redan en lektion som Generera behåller: Matematik med 7B, tisdag 10:00–11:00.");
    expect(svT("verdict.ROOM", { ...CLASH, otherKind: "PLACEMENT" })).toBe(
      "Salen är redan upptagen av en annan förlagd lektion: Matematik med 7B, tisdag 10:00–11:00.",
    );
    expect(enT("verdict.GROUP", CLASH)).toBe(
      "The class or group already has a lesson Generera keeps: Matematik with 7B, Tuesday 10:00–11:00.",
    );
  });

  it("says which resource is unavailable", () => {
    expect(svT("verdict.AVAILABILITY", { resource: "TEACHER" })).toBe("Läraren är markerad som inte tillgänglig då.");
    expect(svT("verdict.AVAILABILITY", { resource: "ROOM" })).toBe("Salen är markerad som inte tillgänglig då.");
    expect(svT("verdict.AVAILABILITY", { resource: "GROUP" })).toBe("Klassen är markerad som inte tillgänglig då.");
    expect(enT("verdict.AVAILABILITY", { resource: "ROOM" })).toBe("The room is marked as unavailable then.");
  });

  it("names the schools that hold the time", () => {
    expect(svT("verdict.OTHER_SCHOOL", { schools: "Östra skolan" })).toBe("Tiden är upptagen av Östra skolan.");
  });

  it("names no person: the teacher in the way is 'läraren' whatever the gateway sends with the clash", () => {
    // The clash carries the other lesson's class and subject and nothing of its teacher; even a
    // stray name in the values reaches no sentence, because no sentence has a place for one.
    const sentence = svT("verdict.TEACHER", { ...CLASH, teacherName: "Anna Ek", firstName: "Anna" });
    expect(sentence).not.toContain("Anna");
    expect(sentence).toContain("Läraren");
  });

  it("has a general sentence for a reason a newer gateway sends", () => {
    expect(svT("verdict.UNKNOWN")).toBe("Lektionen kan inte ligga där.");
    expect(enT("verdict.UNKNOWN")).toBe("The lesson cannot stand there.");
  });

  it("is a sentence for every reason the engine's own refusal carries too", () => {
    // PLACEMENT_CANNOT_STAND is selected on the same eleven codes.
    const engineReasons = Object.keys(sv.requirements.placements.verdict).filter((code) => code !== "UNKNOWN");
    expect(engineReasons.sort()).toEqual([...REASONS].sort());
  });
});

describe("why the rows do not fit the post", () => {
  it.each(FIT_REASONS)("%s has a sentence in both languages", (reason) => {
    expect(svT(`problem.${reason}`).trim()).not.toBe("");
    expect(enT(`problem.${reason}`).trim()).not.toBe("");
  });

  it("has a general sentence for a rule a newer gateway sends", () => {
    expect(svT("problem.UNKNOWN")).toBe("Förläggningarna passar inte posten.");
  });

  it("says a block cannot hold a post with lessons placed, and the proposals' pre-check says the same of a placed lesson", () => {
    expect(svT("blockRefused")).toMatch(/förlagda lektioner.*ligga i ett block/);
    expect(enT("blockRefused")).toMatch(/placed lessons.*cannot be in a block/);
    expect(sv.scheduleCandidates.refusal.PLACEMENTS_REFUSED_SUMMARY).toMatch(/förlagd lektion/);
    expect(en.scheduleCandidates.refusal.PLACEMENTS_REFUSED_SUMMARY).toMatch(/placed lesson/);
  });

  it("is the reason a refused change of the post gives", () => {
    expect(svT("editRefused", { reason: svT("problem.COUNT") })).toBe(
      "Posten sparades inte: den har förlagda lektioner som ändringen inte passar. Fler lektioner av en längd är förlagda än posten har. Ta bort en förläggning.",
    );
  });
});

describe("the dialog's counts", () => {
  it("says one lesson in the singular", () => {
    expect(svT("addFull", { count: 1 })).toBe("Posten har 1 lektion i veckan, och alla är förlagda.");
    expect(svT("addFull", { count: 3 })).toBe("Posten har 3 lektioner i veckan, och alla är förlagda.");
    expect(enT("addFull", { count: 1 })).toBe("The entry has 1 lesson a week, and all of them are placed.");
  });

  it("says how many placed lessons no longer hold", () => {
    expect(svT("staleTitle", { count: 1 })).toBe("En förläggning håller inte längre");
    expect(svT("staleTitle", { count: 2 })).toBe("2 förläggningar håller inte längre");
    expect(svT("staleBody", { count: 1 })).toContain("Rätta den här");
    expect(svT("staleBody", { count: 2 })).toContain("Rätta dem här");
  });

  it("states the two things a school must know before it saves", () => {
    // That it applies at the next Generate, and that a placed lesson never gives way.
    expect(svT("nextGenerate")).toMatch(/nästa Generera/);
    expect(svT("neverGivesWay")).toMatch(/aldrig vika/);
    expect(svT("neverGivesWay")).toMatch(/Bästa möjliga schema/);
    expect(enT("nextGenerate")).toMatch(/next Generate/);
    expect(enT("neverGivesWay")).toMatch(/never gives way/);
  });
});

describe("the English calls a timplanspost a curriculum entry", () => {
  it("in the dialog and its marks, as the navigation does", () => {
    const text = JSON.stringify(en.requirements.placements);
    expect(text).not.toMatch(/requirement/i);
    expect(text).toMatch(/entry/);
  });
});

describe("the engine's refusals about placed lessons", () => {
  const where = { requirement: "7A Slöjd", day: 2, start: "10:00", end: "11:00", room: "Slöjdsalen" };

  it("says each reason a placed lesson cannot stand, in Swedish", () => {
    expect(svEngine("PLACEMENT_CANNOT_STAND", { ...where, reason: "TEACHER", other: "7B Matematik" })).toBe(
      "7A Slöjd, förlagd tisdag 10:00–11:00 i Slöjdsalen: läraren har redan 7B Matematik då.",
    );
    expect(svEngine("PLACEMENT_CANNOT_STAND", { ...where, reason: "AVAILABILITY", resource: "ROOM" })).toBe(
      "7A Slöjd, förlagd tisdag 10:00–11:00 i Slöjdsalen: salen är reserverad då.",
    );
    expect(svEngine("PLACEMENT_CANNOT_STAND", { ...where, reason: "OTHER_SCHOOL", schools: "Östra skolan" })).toBe(
      "7A Slöjd, förlagd tisdag 10:00–11:00 i Slöjdsalen: tiden är upptagen av Östra skolan.",
    );
  });

  it.each([...REASONS, "SOMETHING_NEW"])("renders %s in both languages without a hole", (reason) => {
    const values = { ...where, reason, other: "7B Matematik", schools: "Östra skolan", resource: "TEACHER" };
    for (const engine of [svEngine, enEngine]) {
      const sentence = engine("PLACEMENT_CANNOT_STAND", values);
      expect(sentence).not.toMatch(/[{}]/);
      expect(sentence.endsWith(".")).toBe(true);
    }
  });

  it("counts the placed lessons the pre-check refused", () => {
    expect(svEngine("PLACEMENTS_REFUSED_SUMMARY", { count: 1 })).toMatch(/^1 förlagd lektion på timplanen kan inte längre ligga där den är förlagd/);
    expect(svEngine("PLACEMENTS_REFUSED_SUMMARY", { count: 3 })).toMatch(/^3 förlagda lektioner på timplanen kan inte längre ligga där de är förlagda/);
  });

  it("says in the singular and the plural which placements the week cannot be laid around", () => {
    expect(svEngine("PLACEMENTS_PROBE_SUMMARY", { count: 1, seconds: 12 })).toContain("Med den förlagda lektionen släppta hittades ett schema på 12 s, så det är den förläggningen, nedan");
    expect(svEngine("PLACEMENTS_PROBE_SUMMARY", { count: 4, seconds: 12 })).toContain("Med de 4 förlagda lektionerna släppta hittades ett schema på 12 s, så det är de förläggningarna, nedan");
  });

  it("lists a placed lesson in the way, and says what the probe found with them released", () => {
    expect(svEngine("PLACED_LESSON_IN_THE_WAY", where)).toBe("7A Slöjd, förlagd tisdag 10:00–11:00 i Slöjdsalen.");
    expect(svEngine("PROBE_SOLVED_WITH_PLACEMENTS_RELEASED", { seconds: 7 })).toContain("hittades ett schema på 7 s");
  });

  it("has the category the conflicts are listed under", () => {
    expect(sv.conflictCategories.PLACEMENT).toBe("Förlagda poster");
    expect(en.conflictCategories.PLACEMENT).toBe("Placed lessons");
  });
});
