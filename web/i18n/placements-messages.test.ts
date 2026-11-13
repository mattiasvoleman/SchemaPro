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
const FIT_REASONS = [
  "LENGTH",
  "COUNT",
  "WEEKS",
  "PAIRS",
  "BLOCK",
  "POST",
  // Delade lektioner: the rules per teacher.
  "NO_TEACHER",
  "TEACHER",
  "TEACHER_LENGTH",
  "TEACHER_PAIRS",
  "TEACHER_COUNT",
  // A change of the post refused for a placement nobody teaches (its teacher removed): only removal helps.
  "UNSTAFFED",
] as const;

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

  it("says a placement nobody teaches can only be removed, and never to choose another teacher (review of #298, LÅG-6)", () => {
    expect(svT("problem.UNSTAFFED")).toMatch(/Ta bort förläggningen först/);
    expect(svT("problem.UNSTAFFED")).not.toMatch(/välj/i);
    expect(enT("problem.UNSTAFFED")).toMatch(/Remove the placed lesson first/);
    expect(enT("problem.UNSTAFFED")).not.toMatch(/choose/i);
  });

  it("names the placement without saying a post was not saved, for a batch that applied nothing", () => {
    const params = { day: 4, start: "13:00", end: "14:00", weeks: "EVEN_WEEKS", reason: svT("problem.NO_TEACHER") };
    expect(svT("placementFirst", params)).toBe(`Förläggningen torsdag 13:00–14:00 (jämna veckor) måste ändras eller tas bort först. ${svT("problem.NO_TEACHER")}`);
    expect(enT("placementFirst", { ...params, reason: "x" })).toBe("The placed lesson on Thursday 13:00–14:00 (even weeks) has to be changed or removed first. x");
    expect(svT("placementFirst", params)).not.toMatch(/sparades inte/);
  });

  it("is the reason a refused change of the post gives", () => {
    expect(svT("editRefused", { reason: svT("problem.COUNT") })).toBe(
      "Posten sparades inte: den har förlagda lektioner som ändringen inte passar. Fler lektioner av en längd är förlagda än posten har. Ta bort en förläggning.",
    );
  });

  it("no longer has the sentence that a post sharing its lessons cannot be placed", () => {
    expect(Object.keys(sv.requirements.placements.problem).sort()).toEqual([...FIT_REASONS, "UNKNOWN"].sort());
    expect(Object.keys(en.requirements.placements.problem).sort()).toEqual([...FIT_REASONS, "UNKNOWN"].sort());
  });

  it("says what to do about a lesson that has no teacher, and about each per-teacher rule", () => {
    expect(svT("problem.NO_TEACHER")).toMatch(/kan inte förläggas.*välj en lärare/);
    expect(enT("problem.NO_TEACHER")).toMatch(/cannot be placed.*choose a teacher/);
    expect(svT("problem.TEACHER")).toMatch(/ingen lektion på posten/);
    expect(svT("problem.TEACHER_LENGTH")).toMatch(/ingen lektion av den längden/);
    expect(svT("problem.TEACHER_PAIRS")).toMatch(/samma lärare för båda halvorna/);
    expect(svT("problem.TEACHER_COUNT")).toMatch(/Fler av en lärares lektioner/);
    expect(enT("problem.TEACHER_LENGTH")).toMatch(/no lesson of that length/);
    expect(enT("problem.TEACHER_PAIRS")).toMatch(/same teacher for both halves/);
  });
});

describe("a change of a post's teacher that its placed lessons do not follow", () => {
  const where = { day: 2, start: "10:00", end: "11:00", weeks: "ODD_WEEKS" };

  it("names the placement by its weekday and time, with the weeks when they are not every week, and then says why", () => {
    expect(svT("changeFirst", { ...where, reason: svT("problem.TEACHER") })).toBe(
      "Posten sparades inte. Förläggningen tisdag 10:00–11:00 (udda veckor) måste ändras eller tas bort först. Förläggningens lärare har ingen lektion på posten. Välj en av postens lärare för förläggningen, eller ta bort den.",
    );
    expect(enT("changeFirst", { ...where, weeks: "EVEN_WEEKS", reason: enT("problem.TEACHER_COUNT") })).toBe(
      "The entry was not saved. The placed lesson on Tuesday 10:00–11:00 (even weeks) has to be changed or removed first. More of a teacher's lessons of one length are placed than the teacher's part has. Remove a placement, or choose another teacher for it.",
    );
  });

  it("says nothing of the weeks for a lesson that runs every week, and every weekday in both languages", () => {
    expect(svT("changeFirst", { ...where, weeks: "ALL_WEEKS", day: 5, reason: "x" })).toBe(
      "Posten sparades inte. Förläggningen fredag 10:00–11:00 måste ändras eller tas bort först. x",
    );
    const weekdays = {
      sv: ["måndag", "tisdag", "onsdag", "torsdag", "fredag"],
      en: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
    };
    [1, 2, 3, 4, 5].forEach((day, index) => {
      expect(svT("changeFirst", { ...where, day, reason: "x" })).toContain(`Förläggningen ${weekdays.sv[index]} 10:00`);
      expect(enT("changeFirst", { ...where, day, reason: "x" })).toContain(`lesson on ${weekdays.en[index]} 10:00`);
    });
  });
});

describe("the dialog's words for a post that shares its lessons", () => {
  it("counts each teacher's placed lessons against their part, in a line", () => {
    const counts = [svT("teacherCount", { name: "Anna Ek", placed: 1, of: 2 }), svT("teacherCount", { name: "Bo Alm", placed: 1, of: 1 })].join(", ");
    expect(svT("perTeacher", { counts })).toBe("Förlagda lektioner per lärare: Anna Ek 1 av 2, Bo Alm 1 av 1.");
    expect(enT("teacherCount", { name: "Anna Ek", placed: 1, of: 2 })).toBe("Anna Ek 1 of 2");
  });

  it("says that a lesson without a teacher needs one before it can be placed, in the singular and the plural", () => {
    expect(svT("noTeacher", { count: 1 })).toMatch(/^1 lektion utan lärare behöver en lärare innan den kan förläggas/);
    expect(svT("noTeacher", { count: 2 })).toMatch(/^2 lektioner utan lärare behöver en lärare innan de kan förläggas/);
    expect(enT("noTeacher", { count: 1 })).toMatch(/^1 lesson without a teacher needs a teacher before it can be placed/);
    expect(enT("noTeacher", { count: 3 })).toMatch(/^3 lessons without a teacher need a teacher before they can be placed/);
  });

  it("labels the teacher field and asks for one", () => {
    expect(svT("teacher")).toBe("Lärare");
    expect(svT("teacherPlaceholder")).toBe("Välj lärare");
    expect(svT("problemTeacher")).toBe("Välj en lärare.");
    expect(enT("teacherPlaceholder")).toBe("Choose a teacher");
    expect(enT("problemTeacher")).toBe("Choose a teacher.");
  });

  it("says that a pair is one teacher's, and that all the lessons with a teacher are placed", () => {
    expect(svT("pairsHintShared")).toMatch(/samma lärare/);
    expect(enT("pairsHintShared")).toMatch(/same teacher/);
    expect(svT("addFullShared")).toBe("Alla lektioner som har en lärare är förlagda.");
    expect(enT("addFullShared")).toBe("All the lessons that have a teacher are placed.");
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

describe("the figures of a post in the week of förläggningar", () => {
  // A post with one lesson a week is the usual one: "1 lektioner" and "1 fasta" read as a slip (review of #315, LÅG-4).
  const svWeek = createTranslator({ locale: "sv", messages: sv, namespace: "placementWeek" });
  const enWeek = createTranslator({ locale: "en", messages: en, namespace: "placementWeek" });

  it("says one lesson and one fixed lesson in the singular, and several in the plural, in Swedish", () => {
    expect(svWeek("postFigures", { placed: 0, count: 1, locked: 0, left: 1 })).toBe(
      "0 av 1 lektion förlagd, 0 fasta i grundschemat, 1 kvar för Generera.",
    );
    expect(svWeek("postFigures", { placed: 0, count: 1, locked: 1, left: 0 })).toBe(
      "0 av 1 lektion förlagd, 1 fast i grundschemat, 0 kvar för Generera.",
    );
    expect(svWeek("postFigures", { placed: 1, count: 3, locked: 1, left: 1 })).toBe(
      "1 av 3 lektioner förlagda, 1 fast i grundschemat, 1 kvar för Generera.",
    );
  });

  it("says one lesson in the singular, and several in the plural, in English", () => {
    expect(enWeek("postFigures", { placed: 0, count: 1, locked: 0, left: 1 })).toBe(
      "0 of 1 lesson placed, 0 fixed in the master timetable, 1 left for Generate.",
    );
    expect(enWeek("postFigures", { placed: 1, count: 3, locked: 1, left: 1 })).toBe(
      "1 of 3 lessons placed, 1 fixed in the master timetable, 1 left for Generate.",
    );
  });
});
