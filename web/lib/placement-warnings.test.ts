import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";
import type { TimetableLesson } from "@/components/schedule/timetable-grid";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import type { MessageLookup } from "./engine-message";
import type { BoardHold } from "./placement-board";
import {
  heldBands,
  itemsOfWarnings,
  markCards,
  sentenceOfWarning,
  sentencesOf,
  warningKeyOf,
  warningsByRow,
  warningsOfRows,
} from "./placement-warnings";
import type { PlacementWarning, PlacementWarningCode } from "./requirement-placements";

/**
 * Varningar medan man lägger, the pure part: the sentence for each code and each of its values (with the real catalogues, both languages),
 * a warning said once per post however many rows it is on, the mark on a card, and the other schools' bands. The page's own wiring is
 * page.warnings.test.tsx's.
 */

const lookup = (locale: "sv" | "en"): MessageLookup =>
  createTranslator({ locale, messages: locale === "sv" ? sv : en, namespace: "placementWeek.warnings" } as never) as unknown as MessageLookup;

const warning = (code: PlacementWarningCode, params: PlacementWarning["params"], over: Partial<PlacementWarning> = {}): PlacementWarning => ({
  code,
  refuses: false,
  ...(params ? { params } : {}),
  rowId: "row-1",
  requirementId: "post-1",
  ...over,
});

const DAY = warning("TEACHER_DAY_TOO_LONG", { day: 2, minutes: 470, cap: 420 });
const DAYS = warning("TEACHER_WEEK_TOO_MANY_DAYS", { days: 5, max: 4 });
const DAYS_HIDDEN = warning("TEACHER_WEEK_TOO_MANY_DAYS_HIDDEN", undefined);
const STRETCH = warning("TEACHER_STRETCH_TOO_LONG", { day: 3, minutes: 240, max: 180, breakMinutes: 20 });
const STRETCH_HIDDEN = warning("TEACHER_STRETCH_TOO_LONG_HIDDEN", undefined);
const LUNCH = warning("CLASS_HAS_NO_LUNCH", { day: 4, windowStart: "10:30", windowEnd: "13:00", minutes: 30 }, { refuses: true });
const ROOM = warning("NO_ROOM_FREE", { day: 5, start: "10:00", end: "11:00", roomType: "Gymnastiksal" }, { refuses: true });

describe("the sentence for a warning", () => {
  it.each([
    [DAY, "Läraren undervisar 470 min på tisdag, över taket på 420 min."],
    [DAYS, "Läraren undervisar 5 dagar i veckan, över gränsen på 4."],
    [DAYS_HIDDEN, "Läraren går över sin gräns för antal undervisningsdagar."],
    [STRETCH, "Läraren undervisar 240 min i följd på onsdag, över gränsen på 180 min (rast 20 min)."],
    [STRETCH_HIDDEN, "Läraren går över sin gräns för undervisning i följd."],
    [LUNCH, "Klassen får ingen lunch på torsdag: lektionerna lämnar inte 30 min ledigt mellan 10:30 och 13:00."],
    [ROOM, "Ingen sal av typen Gymnastiksal är ledig fredag 10:00–11:00."],
  ])("says each code with each of its values, in Swedish (%#)", (given, sentence) => {
    expect(sentenceOfWarning(lookup("sv"), given)).toBe(sentence);
  });

  it.each([
    [DAY, "The teacher teaches 470 min on Tuesday, over the cap of 420 min."],
    [DAYS, "The teacher teaches 5 days a week, over the limit of 4."],
    [DAYS_HIDDEN, "The teacher goes over their limit for teaching days."],
    [STRETCH, "The teacher teaches 240 min in a row on Wednesday, over the limit of 180 min (break 20 min)."],
    [STRETCH_HIDDEN, "The teacher goes over their limit for teaching in a row."],
    [LUNCH, "The class gets no lunch on Thursday: the lessons leave no 30 min free between 10:30 and 13:00."],
    [ROOM, "No room of type Gymnastiksal is free on Friday 10:00–11:00."],
  ])("and in English (%#)", (given, sentence) => {
    expect(sentenceOfWarning(lookup("en"), given)).toBe(sentence);
  });

  it("names every weekday of the school week, and says an odd number as a number rather than as nothing", () => {
    const days = [1, 2, 3, 4, 5, 6].map((day) => sentenceOfWarning(lookup("sv"), warning("TEACHER_DAY_TOO_LONG", { day, minutes: 1, cap: 1 })));
    expect(days.map((text) => /på (.+?), över/.exec(text)![1])).toEqual(["måndag", "tisdag", "onsdag", "torsdag", "fredag", "dag 6"]);
  });

  it("reads a code this build has no sentence for as the general one", () => {
    expect(sentenceOfWarning(lookup("sv"), { code: "SOMETHING_NEW" as PlacementWarningCode, params: { day: 1 } })).toBe(
      "Veckan har en varning om lektionen som den här versionen inte kan beskriva.",
    );
    expect(sentenceOfWarning(lookup("en"), { code: "SOMETHING_NEW" as PlacementWarningCode })).toBe(
      "The week has a warning about the lesson that this version cannot describe.",
    );
  });

  it("reads a sentence that cannot be written (a translator that throws on a hole, as the other sentences of the app are written for) as the general one", () => {
    const strict = Object.assign(
      (key: string, values?: Record<string, string | number>) => {
        if (key === "TEACHER_DAY_TOO_LONG" && values?.["cap"] === undefined) throw new Error("no cap");
        return key === "UNKNOWN" ? "general" : `${key}`;
      },
      { has: (key: string) => key !== "SOMETHING_NEW" },
    ) as MessageLookup;
    expect(sentenceOfWarning(strict, { code: "TEACHER_DAY_TOO_LONG", params: { day: 2, minutes: 470 } })).toBe("general");
    expect(sentenceOfWarning(strict, { code: "TEACHER_DAY_TOO_LONG", params: { day: 2, minutes: 470, cap: 420 } })).toBe("TEACHER_DAY_TOO_LONG");
  });

  it("asks the catalogue for the day by the day's own name and for the sentence by the code, nothing else (an echoing translator)", () => {
    const asked: Array<[string, unknown]> = [];
    const echo = Object.assign(
      (key: string, values?: Record<string, string | number>) => {
        asked.push([key, values]);
        return `${key}(${Object.values(values ?? {}).join("|")})`;
      },
      { has: () => true },
    ) as MessageLookup;
    expect(sentenceOfWarning(echo, DAY)).toBe("TEACHER_DAY_TOO_LONG(day(2)|470|420)");
    expect(asked).toEqual([
      ["day", { day: 2 }],
      ["TEACHER_DAY_TOO_LONG", { day: "day(2)", minutes: 470, cap: 420 }],
    ]);
  });
});

describe("one sentence, once", () => {
  const same = (rowId: string, over: Partial<PlacementWarning> = {}) => ({ ...DAY, rowId, ...over });

  it("says a warning on several rows once: the key is what it says and not where it is", () => {
    const items = itemsOfWarnings([same("a"), same("b"), same("c")], (given) => sentenceOfWarning(lookup("sv"), given));
    expect(items).toHaveLength(1);
    expect(items[0]!.text).toContain("470 min på tisdag");
    expect(warningKeyOf(same("a"))).toBe(warningKeyOf(same("b")));
    // The order the params come in is not what a warning says.
    expect(warningKeyOf({ code: "TEACHER_DAY_TOO_LONG", params: { cap: 420, day: 2, minutes: 470 } })).toBe(warningKeyOf(DAY));
  });

  it("says two warnings that differ in a value, or in the code, as two", () => {
    const other = same("b", { params: { day: 2, minutes: 480, cap: 420 } });
    const items = itemsOfWarnings([DAY, other, LUNCH], (given) => sentenceOfWarning(lookup("sv"), given));
    expect(items.map((item) => item.text)).toEqual([
      "Läraren undervisar 470 min på tisdag, över taket på 420 min.",
      "Läraren undervisar 480 min på tisdag, över taket på 420 min.",
      "Klassen får ingen lunch på torsdag: lektionerna lämnar inte 30 min ledigt mellan 10:30 och 13:00.",
    ]);
  });

  it("keeps the stronger when one row refuses and another does not, whichever comes first", () => {
    const say = (given: PlacementWarning) => sentenceOfWarning(lookup("sv"), given);
    expect(itemsOfWarnings([same("a", { refuses: false }), same("b", { refuses: true })], say)[0]!.refuses).toBe(true);
    expect(itemsOfWarnings([same("a", { refuses: true }), same("b", { refuses: false })], say)[0]!.refuses).toBe(true);
    expect(itemsOfWarnings([same("a"), same("b")], say)[0]!.refuses).toBe(false);
  });

  it("says nothing for a week that has none, and for a gateway that sends none", () => {
    expect(itemsOfWarnings([], () => "x")).toEqual([]);
    expect(itemsOfWarnings(undefined, () => "x")).toEqual([]);
    expect(warningsByRow(undefined).size).toBe(0);
  });

  it("finds the warnings of the rows asked for, in their order, and none for a row without", () => {
    const byRow = warningsByRow([warning("TEACHER_DAY_TOO_LONG", { day: 2, minutes: 1, cap: 1 }, { rowId: "a" }), LUNCH, { ...ROOM, rowId: "b" }]);
    expect(warningsOfRows(byRow, ["b", "a"]).map((found) => found.code)).toEqual(["NO_ROOM_FREE", "TEACHER_DAY_TOO_LONG"]);
    expect(warningsOfRows(byRow, ["row-1"]).map((found) => found.code)).toEqual(["CLASS_HAS_NO_LUNCH"]);
    expect(warningsOfRows(byRow, ["gone"])).toEqual([]);
  });

  it("says what a refusal means after the sentence that refuses and after no other", () => {
    expect(
      sentencesOf(
        [
          { key: "a", text: "Ett.", refuses: false },
          { key: "b", text: "Två.", refuses: true },
        ],
        "Vägrar.",
      ),
    ).toBe("Ett. Två. Vägrar.");
  });
});

describe("the mark on a card", () => {
  const card = (id: string): TimetableLesson => ({ id, dayOfWeek: 2, startMinutes: 600, endMinutes: 660, title: "Matematik", color: "#2563eb" });
  const text = { badge: "Varning", badgeRefuses: "Vägrar", label: (items: readonly { text: string }[]) => items.map((item) => item.text).join("+") };

  it("marks the card that has a warning, spelled out for the reader who cannot see the mark, and leaves the others as they were", () => {
    const cards = [card("a"), card("b")];
    const marked = markCards(cards, new Map([["a", [{ key: "k", text: "Sagt.", refuses: false }]]]), text);
    expect(marked[0]).toMatchObject({ id: "a", share: "Varning", shareLabel: "Sagt." });
    expect(marked[1]).toBe(cards[1]);
  });

  it("has the stronger word on a card where any warning refuses", () => {
    const marked = markCards(
      [card("a")],
      new Map([["a", [{ key: "k", text: "Ett.", refuses: false }, { key: "l", text: "Två.", refuses: true }]]]),
      text,
    );
    expect(marked[0]).toMatchObject({ share: "Vägrar", shareLabel: "Ett.+Två." });
  });

  it("hands back the very cards when nothing is warned, and does not mark a card whose list is empty", () => {
    const cards = [card("a")];
    expect(markCards(cards, new Map(), text)).toBe(cards);
    expect(markCards(cards, new Map([["a", []]]), text)[0]).toBe(cards[0]);
    expect(markCards(cards, new Map([["other", [{ key: "k", text: "x", refuses: false }]]]), text)[0]).toBe(cards[0]);
  });
});

describe("the other schools' bands", () => {
  const hold = (over: Partial<BoardHold> = {}): BoardHold => ({
    kind: "TEACHER_BUSY",
    resourceKind: "TEACHER",
    resourceId: "anna",
    dayOfWeek: 3,
    startTime: "13:00",
    endTime: "14:30",
    schools: ["Östra skolan"],
    ...over,
  });
  const label = (schools: readonly string[], kind?: BoardHold["kind"]) =>
    `${kind === "ROOM_LENT" ? "Utlånad till" : kind === "ROOM_BORROWED" ? "Lånad från" : "Bokad på"} ${schools.join(" och ")}`;
  const none = { teachers: [] as string[], rooms: [] as string[] };

  it("draws a band for a hold on a teacher who is picked, with the schools' names", () => {
    expect(heldBands([hold()], { ...none, teachers: ["anna"] }, label)).toEqual([
      { id: "hold:3|780|870", dayOfWeek: 3, startMinutes: 780, endMinutes: 870, label: "Bokad på Östra skolan" },
    ]);
  });

  it("makes two holds at one time one band that names every school, in name order", () => {
    // A teacher the Östra skolan holds and a room the Norra skolan holds, the same weekday and hour, and both picked: one band, both names.
    const teacher = hold({ schools: ["Östra skolan"] });
    const room = hold({ kind: "ROOM_BORROWED", resourceKind: "ROOM", resourceId: "r-gym", schools: ["Norra skolan"] });
    // Two kinds at one time: the sentence that is true of both, which is the generic one.
    expect(heldBands([teacher, room], { teachers: ["anna"], rooms: ["r-gym"] }, label)).toEqual([
      { id: "hold:3|780|870", dayOfWeek: 3, startMinutes: 780, endMinutes: 870, label: "Bokad på Norra skolan och Östra skolan" },
    ]);
  });

  it("says a lent room and a borrowed one as what they are, and not as booked (review of #339, LÅG-3)", () => {
    // ROOM_BORROWED is every hour OUTSIDE the loan's times, so a band "booked at the owner" over most of the week would be wrong; the id stays as it was.
    const lent = hold({ kind: "ROOM_LENT", resourceKind: "ROOM", resourceId: "r-gym", schools: ["Norra skolan"] });
    const borrowed = hold({ kind: "ROOM_BORROWED", resourceKind: "ROOM", resourceId: "r-sal", startTime: "08:00", endTime: "13:00", schools: ["Roller skola"] });
    const bands = heldBands([lent, borrowed], { ...none, rooms: ["r-gym", "r-sal"] }, label);
    expect(bands.map((band) => [band.id, band.label])).toEqual([
      ["hold:3|780|870", "Utlånad till Norra skolan"],
      ["hold:3|480|780", "Lånad från Roller skola"],
    ]);
    // A band says the kind its holds have in common: the same kind from two schools is still that kind.
    expect(heldBands([lent, { ...lent, schools: ["Södra skolan"] }], { ...none, rooms: ["r-gym"] }, label).map((band) => band.label)).toEqual(["Utlånad till Norra skolan och Södra skolan"]);
  });

  it("draws a band for a hold on a room that is picked, and for no other", () => {
    const room = hold({ kind: "ROOM_LENT", resourceKind: "ROOM", resourceId: "r-gym", startTime: "09:00", endTime: "10:00", schools: ["Norra skolan"] });
    expect(heldBands([room], { ...none, rooms: ["r-gym"] }, label).map((band) => band.label)).toEqual(["Utlånad till Norra skolan"]);
    // A teacher filter does not pick a room and a room filter does not pick a teacher, even by the same id.
    expect(heldBands([room], { ...none, teachers: ["r-gym"] }, label)).toEqual([]);
    expect(heldBands([hold()], { ...none, rooms: ["anna"] }, label)).toEqual([]);
  });

  it("draws nothing when no filter points at the resource, and nothing for a gateway that sends no holds", () => {
    expect(heldBands([hold()], none, label)).toEqual([]);
    expect(heldBands([hold()], { ...none, teachers: ["bo"] }, label)).toEqual([]);
    expect(heldBands(undefined, { ...none, teachers: ["anna"] }, label)).toEqual([]);
  });

  it("puts two holds at one time in one band that names every school, in name order", () => {
    const bands = heldBands(
      [hold({ schools: ["Södra skolan"] }), hold({ resourceId: "bo", schools: ["Östra skolan", "Södra skolan"] }), hold({ startTime: "08:00", endTime: "09:00" })],
      { ...none, teachers: ["anna", "bo"] },
      label,
    );
    expect(bands.map((band) => band.label)).toEqual(["Bokad på Södra skolan och Östra skolan", "Bokad på Östra skolan"]);
  });

  it("keeps the band inside the förläggning's day, so that the grid is not stretched by an hour no lesson can be laid in", () => {
    const early = hold({ startTime: "06:30", endTime: "08:30" });
    const late = hold({ startTime: "17:30", endTime: "19:00", dayOfWeek: 4 });
    const outside = hold({ startTime: "05:00", endTime: "07:45", dayOfWeek: 5 });
    const afterwards = hold({ startTime: "18:00", endTime: "19:00", dayOfWeek: 1 });
    const bands = heldBands([early, late, outside, afterwards], { ...none, teachers: ["anna"] }, label);
    expect(bands.map(({ dayOfWeek, startMinutes, endMinutes }) => [dayOfWeek, startMinutes, endMinutes])).toEqual([
      [3, 480, 510],
      [4, 1050, 1080],
    ]);
  });
});
