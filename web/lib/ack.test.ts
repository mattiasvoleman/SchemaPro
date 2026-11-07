import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import {
  ACK_CUSTODY_ENDED,
  ACK_DISABLED,
  ACK_NOT_FOUND,
  ACK_NOT_STAFF,
  ACK_NOT_YOUR_PUPIL,
  ACK_NO_GUARDIANS,
  ACK_REMINDER_STATES,
  ACK_RULES,
  ACK_TOO_MANY_RECIPIENTS,
  ACK_TOO_MANY_REQUESTS,
  ACK_UNKNOWN_PUPIL,
  BODY_MAX,
  CREATE_REFUSALS,
  PUPILS_MAX,
  REMIND_DAYS_MAX,
  REMIND_DAYS_MIN,
  REMIND_DAY_OPTIONS,
  TITLE_MAX,
  bodyOfForm,
  classesOf,
  emptyAckForm,
  formProblems,
  guardiansOf,
  isDone,
  itemsOf,
  matchesPupil,
  metIn,
  namesOf,
  pupilStanding,
  pupilsNotMet,
  reminderOf,
  setChosen,
  shownPupils,
  waitingFor,
  withConfirmed,
  withConfirmedPages,
  withoutGuardianOf,
  type AckPupilChoice,
} from "./ack";
import { detail, listItem, mineItem, page } from "./__fixtures__/ack";

/**
 * The web's copy of the gateway's vocabulary, bounds and codes. The gateway's
 * file (src/ack/ack.ts, root of the DTOs) is read as text, because the web
 * cannot import it, and the two must say the same: a bound that differs is a
 * form that accepts what the gateway refuses, or one that refuses what it would
 * take; a code that differs is a refusal said as a raw message.
 */
const GATEWAY = readFileSync(join(__dirname, "..", "..", "src", "ack", "ack.ts"), "utf8");
const VIEWS = readFileSync(join(__dirname, "..", "..", "src", "ack", "ack-views.ts"), "utf8");
const SCHEMA = readFileSync(join(__dirname, "..", "..", "prisma", "schema.prisma"), "utf8");

const numberOf = (name: string): number => Number(new RegExp(`export const ${name} = (\\d+)`).exec(GATEWAY)?.[1]);
const codeOf = (name: string): string | undefined => new RegExp(`export const ${name} = '([A-Z_]+)'`).exec(GATEWAY)?.[1];
const rulesOf = (): string[] => {
  const line = /export const ACK_RULES[^=]*= \[([^\]]*)\]/.exec(GATEWAY)?.[1] ?? "";
  return [...line.matchAll(/'([A-Z_]+)'/g)].map((match) => match[1]!);
};

describe("the vocabulary, the bounds and the codes are the gateway's", () => {
  it("says the same rules and bounds", () => {
    expect([...ACK_RULES]).toEqual(rulesOf());
    expect(TITLE_MAX).toBe(numberOf("TITLE_MAX"));
    expect(BODY_MAX).toBe(numberOf("BODY_MAX"));
    expect(PUPILS_MAX).toBe(numberOf("PUPILS_MAX"));
    expect(REMIND_DAYS_MIN).toBe(numberOf("REMIND_DAYS_MIN"));
    expect(REMIND_DAYS_MAX).toBe(numberOf("REMIND_DAYS_MAX"));
  });

  it("offers every day the gateway takes for the reminder, once, in order", () => {
    expect(REMIND_DAY_OPTIONS[0]).toBe(REMIND_DAYS_MIN);
    expect(REMIND_DAY_OPTIONS[REMIND_DAY_OPTIONS.length - 1]).toBe(REMIND_DAYS_MAX);
    expect(REMIND_DAY_OPTIONS).toHaveLength(REMIND_DAYS_MAX - REMIND_DAYS_MIN + 1);
  });

  it("names the codes the gateway answers with", () => {
    expect(ACK_DISABLED).toBe(codeOf("ACK_DISABLED"));
    expect(ACK_NOT_FOUND).toBe(codeOf("ACK_NOT_FOUND"));
    expect(ACK_CUSTODY_ENDED).toBe(codeOf("ACK_CUSTODY_ENDED"));
    expect(ACK_UNKNOWN_PUPIL).toBe(codeOf("ACK_UNKNOWN_PUPIL"));
    expect(ACK_NOT_YOUR_PUPIL).toBe(codeOf("ACK_NOT_YOUR_PUPIL"));
    expect(ACK_NO_GUARDIANS).toBe(codeOf("ACK_NO_GUARDIANS"));
    expect(ACK_TOO_MANY_REQUESTS).toBe(codeOf("ACK_TOO_MANY_REQUESTS"));
    expect(ACK_TOO_MANY_RECIPIENTS).toBe(codeOf("ACK_TOO_MANY_RECIPIENTS"));
    expect(ACK_NOT_STAFF).toBe(codeOf("ACK_NOT_STAFF"));
  });

  it("says every refusal of a request that the form has a sentence for, in both languages", () => {
    expect(CREATE_REFUSALS).toContain(ACK_TOO_MANY_REQUESTS);
    expect(CREATE_REFUSALS).toContain(ACK_TOO_MANY_RECIPIENTS);
    for (const messages of [sv, en]) {
      const refusal = messages.acknowledgements.refusal as Record<string, string>;
      for (const code of CREATE_REFUSALS) expect(refusal[code], code).toEqual(expect.any(String));
    }
  });

  it("knows the states of a reminder as the gateway has them: none, scheduled, and the database's outcomes", () => {
    const outcomes = [...(/enum AckReminderOutcome \{([^}]*)\}/.exec(SCHEMA)?.[1] ?? "").matchAll(/^\s*([A-Z_]+)\s*$/gm)].map((match) => match[1]!);
    expect(outcomes.length).toBeGreaterThan(0);
    expect([...ACK_REMINDER_STATES]).toEqual(["NONE", "SCHEDULED", ...outcomes]);
  });

  it("has a word for every state of a reminder, in the list and in the request, in both languages", () => {
    for (const messages of [sv, en]) {
      const { list, detail: reading } = messages.acknowledgements;
      expect(Object.keys(list.reminder).sort()).toEqual([...ACK_REMINDER_STATES].sort());
      expect(Object.keys(reading.reminderState).sort()).toEqual([...ACK_REMINDER_STATES].sort());
    }
  });

  it("answers the staff's shapes as the gateway has them: a page, the reminder as a state, and the right to stop it", () => {
    const fieldsOf = (name: string): string[] => {
      const body = new RegExp(`export interface ${name}(?:<\\w+>)? \\{\\n([\\s\\S]*?)\\n\\}`).exec(VIEWS)?.[1] ?? "";
      return [...body.matchAll(/^ {2}(\w+):/gm)].map((match) => match[1]!).sort();
    };
    expect(fieldsOf("AckPage")).toEqual(Object.keys(page([])).sort());
    expect(fieldsOf("AckListItem")).toEqual(Object.keys(listItem()).sort());
    expect(fieldsOf("AckDetail")).toEqual(Object.keys(detail()).sort());
    expect(fieldsOf("AckMine")).toEqual(Object.keys(mineItem()).sort());
    expect(fieldsOf("AckReminderStopped")).toEqual(["reminder"]);
  });

  it("reads the guardian's shape as the gateway has it: no field about another guardian", () => {
    const mine = /export interface AckMine \{\n([\s\S]*?)\n\}/.exec(VIEWS)?.[1] ?? "";
    expect([...mine.matchAll(/^ {2}(\w+):/gm)].map((match) => match[1])).toEqual([
      "id",
      "title",
      "body",
      "rule",
      "authorName",
      "createdAt",
      "children",
      "ackedAt",
    ]);
  });
});

const pupil = (id: string, name: string, className: string | null, guardians: number): AckPupilChoice => ({ id, name, className, guardians });
const PUPILS = [
  pupil("p1", "Ada Berg", "7A", 2),
  pupil("p2", "Bo Ek", "7A", 1),
  pupil("p3", "Cia Lund", "7B", 0),
  pupil("p4", "Åke Öst", "10A", 2),
  pupil("p5", "Dan Dal", null, 1),
];

describe("the form", () => {
  const form = (over: Partial<ReturnType<typeof emptyAckForm>>) => ({ ...emptyAckForm(), title: "Utflykten", body: "På torsdag", studentIds: ["p1"], ...over });

  it("starts with one guardian enough, and nothing written or chosen", () => {
    expect(emptyAckForm()).toEqual({ title: "", body: "", rule: "ANY", studentIds: [] });
  });

  it("stops a form with no title, no text or no pupil, in the order the fields come", () => {
    expect(formProblems(emptyAckForm(), PUPILS)).toEqual(["title", "body", "pupils"]);
    expect(formProblems(form({}), PUPILS)).toEqual([]);
  });

  it("counts the title and the text as the gateway does, after trimming", () => {
    expect(formProblems(form({ title: "   ", body: "\n" }), PUPILS)).toEqual(["title", "body"]);
    expect(formProblems(form({ title: ` ${"x".repeat(TITLE_MAX)} `, body: `${"y".repeat(BODY_MAX)}\n` }), PUPILS)).toEqual([]);
    expect(formProblems(form({ title: "x".repeat(TITLE_MAX + 1), body: "y".repeat(BODY_MAX + 1) }), PUPILS)).toEqual(["titleLong", "bodyLong"]);
  });

  it("stops more pupils than a request takes, and pupils none of whom has a guardian to ask", () => {
    const many = Array.from({ length: PUPILS_MAX + 1 }, (_, index) => `x${index}`);
    expect(formProblems(form({ studentIds: many }), PUPILS)).toEqual(["pupilsMany"]);
    expect(formProblems(form({ studentIds: ["p3"] }), PUPILS)).toEqual(["nobody"]);
    // One pupil with a guardian is enough; the other is left out, and the form says so (withoutGuardianOf).
    expect(formProblems(form({ studentIds: ["p3", "p2"] }), PUPILS)).toEqual([]);
  });

  it("sends the title and the text trimmed, the rule, and each pupil once", () => {
    expect(bodyOfForm(form({ title: "  Utflykten ", body: " På torsdag\n", rule: "ALL", studentIds: ["p1", "p2", "p1"] }))).toEqual({
      title: "Utflykten",
      body: "På torsdag",
      rule: "ALL",
      studentIds: ["p1", "p2"],
    });
  });

  it("counts the guardians who would be asked, and names the chosen pupils nobody can be asked about", () => {
    expect(guardiansOf(PUPILS, ["p1", "p2", "p3"])).toBe(3);
    expect(guardiansOf(PUPILS, [])).toBe(0);
    // An id the list does not have (a pupil who left) counts for nothing.
    expect(guardiansOf(PUPILS, ["p1", "gone"])).toBe(2);
    expect(withoutGuardianOf(PUPILS, ["p1", "p3"]).map((one) => one.name)).toEqual(["Cia Lund"]);
    expect(namesOf(PUPILS, ["p4", "p1"])).toEqual(["Ada Berg", "Åke Öst"]);
  });
});

describe("choosing pupils", () => {
  it("finds a pupil by any part of the name or the class, in any case", () => {
    expect(matchesPupil(PUPILS[0]!, "berg")).toBe(true);
    expect(matchesPupil(PUPILS[0]!, "  ADA ")).toBe(true);
    expect(matchesPupil(PUPILS[0]!, "7a")).toBe(true);
    expect(matchesPupil(PUPILS[0]!, "7b")).toBe(false);
    expect(matchesPupil(PUPILS[3]!, "åke")).toBe(true);
    expect(matchesPupil(PUPILS[4]!, "7a")).toBe(false);
    expect(matchesPupil(PUPILS[4]!, "")).toBe(true);
  });

  it("lists the classes once, 7A before 7B before 10A, and not the pupils with none", () => {
    expect(classesOf(PUPILS)).toEqual(["7A", "7B", "10A"]);
    expect(classesOf([])).toEqual([]);
  });

  it("shows the pupils of a class that answer a search; no class is every class", () => {
    expect(shownPupils(PUPILS, "", "").map((one) => one.id)).toEqual(["p1", "p2", "p3", "p4", "p5"]);
    expect(shownPupils(PUPILS, "", "7A").map((one) => one.id)).toEqual(["p1", "p2"]);
    expect(shownPupils(PUPILS, "bo", "7A").map((one) => one.id)).toEqual(["p2"]);
    expect(shownPupils(PUPILS, "bo", "7B")).toEqual([]);
  });

  it("chooses and clears many at once, keeping the rest and the order they were chosen in", () => {
    expect(setChosen(["p9"], ["p1", "p2"], true)).toEqual(["p9", "p1", "p2"]);
    expect(setChosen(["p1", "p9"], ["p1", "p2"], true)).toEqual(["p1", "p9", "p2"]);
    expect(setChosen(["p1", "p2", "p9"], ["p1", "p2"], false)).toEqual(["p9"]);
    expect(setChosen([], ["p1"], false)).toEqual([]);
  });
});

describe("reading a request", () => {
  const guardian = (state: "CONFIRMED" | "WAITING" | "ENDED") => ({ id: state, name: state, state, ackedAt: null, remindedAt: null });
  const row = (met: boolean, ...states: Array<"CONFIRMED" | "WAITING" | "ENDED">) => ({
    id: `${met}-${states.join()}`,
    name: "n",
    className: null,
    met,
    guardians: states.map(guardian),
  });

  it("counts the pupils who are done", () => {
    expect(metIn({ pupils: [row(true, "CONFIRMED"), row(false, "WAITING"), row(true, "CONFIRMED", "WAITING")] })).toBe(2);
    expect(metIn({ pupils: [] })).toBe(0);
  });

  it("tells a pupil who is waiting from one nobody can confirm for any more", () => {
    expect(pupilStanding(row(true, "CONFIRMED"))).toBe("MET");
    expect(pupilStanding(row(false, "WAITING", "ENDED"))).toBe("WAITING");
    expect(pupilStanding(row(false, "ENDED"))).toBe("NOBODY");
    expect(pupilStanding(row(false))).toBe("NOBODY");
  });

  it("keeps the pupils still to hear from", () => {
    const rows = [row(true, "CONFIRMED"), row(false, "WAITING")];
    expect(pupilsNotMet(rows)).toEqual([rows[1]]);
  });

  it("says what became of the reminder as the gateway does, for every state", () => {
    for (const reminder of ACK_REMINDER_STATES) {
      expect(reminderOf({ reminder, remindAt: reminder === "NONE" ? null : "2026-11-08T08:00:00.000Z" })).toBe(reminder);
    }
  });

  it("does not work out what the gateway has not said: a reminder that went is not 'due' for lack of waiting guardians", () => {
    // The state is the gateway's whatever the counts and the moments say.
    expect(reminderOf({ reminder: "SENT", remindAt: null })).toBe("SENT");
    expect(reminderOf({ reminder: "STOPPED", remindAt: "2026-11-08T08:00:00.000Z" })).toBe("STOPPED");
  });

  it("reads a scheduled reminder with no time to show as none, so that nothing says 'Går' with no date", () => {
    expect(reminderOf({ reminder: "SCHEDULED", remindAt: null })).toBe("NONE");
    expect(reminderOf({ reminder: "SCHEDULED", remindAt: "2026-11-08T08:00:00.000Z" })).toBe("SCHEDULED");
  });

  it("calls a request done when every pupil the reader sees is, and not when the reader sees none", () => {
    expect(isDone({ pupils: 3, met: 3 })).toBe(true);
    expect(isDone({ pupils: 3, met: 2 })).toBe(false);
    expect(isDone({ pupils: 0, met: 0 })).toBe(false);
  });
});

describe("the pages of a list", () => {
  it("puts the pages loaded together in the order they came, and nothing for no data yet", () => {
    expect(itemsOf({ pages: [page(["a", "b"], "b"), page(["c"])] })).toEqual(["a", "b", "c"]);
    expect(itemsOf({ pages: [] })).toEqual([]);
    expect(itemsOf(undefined)).toEqual([]);
  });
});

describe("the guardian's list", () => {
  const mine = [
    { id: "a", ackedAt: null },
    { id: "b", ackedAt: "2026-11-05T10:00:00.000Z" },
    { id: "c", ackedAt: null },
  ];

  it("counts the messages that still wait", () => {
    expect(waitingFor(mine)).toBe(2);
    expect(waitingFor([])).toBe(0);
  });

  it("writes a confirmation into the page that has the request, whichever it is, and leaves the other pages as they were", () => {
    const first = page([mineItem({ id: "a" }), mineItem({ id: "b" })], "b");
    const second = page([mineItem({ id: "c" })]);
    const data = { pages: [first, second], pageParams: [undefined, "b"] };

    const after = withConfirmedPages(data, "c", "2026-11-06T09:00:00.000Z");

    expect(after.pages[1]!.items[0]!.ackedAt).toBe("2026-11-06T09:00:00.000Z");
    expect(after.pages[0]).toBe(first);
    expect(after.pageParams).toEqual([undefined, "b"]);
    expect(second.items[0]!.ackedAt).toBeNull();
    // A request on no page loaded changes nothing, and the next page's cursor is kept.
    const none = withConfirmedPages(data, "gone", "2026-11-06T09:00:00.000Z");
    expect(none.pages.map((one) => one.items.map((item) => item.ackedAt))).toEqual([[null, null], [null]]);
    expect(none.pages[0]!.next).toBe("b");
  });

  it("writes the gateway's time of a confirmation into one request, and keeps an earlier one", () => {
    const after = withConfirmed(mine, "a", "2026-11-06T09:00:00.000Z");
    expect(after.map((one) => one.ackedAt)).toEqual(["2026-11-06T09:00:00.000Z", "2026-11-05T10:00:00.000Z", null]);
    expect(withConfirmed(mine, "b", "2026-11-06T09:00:00.000Z")[1]!.ackedAt).toBe("2026-11-05T10:00:00.000Z");
    // The list it was given is not changed.
    expect(mine[0]!.ackedAt).toBeNull();
  });
});
