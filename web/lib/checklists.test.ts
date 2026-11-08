import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import {
  ASK_MAX,
  CHECKLIST_CODES,
  CHECKLIST_DATE_IN_THE_FUTURE,
  CHECKLIST_DATE_INVALID,
  CHECKLIST_INSTRUCTOR_IS_NOT_STAFF,
  CHECKLIST_NOT_FOUND,
  CHECKLIST_NOT_STAFF,
  CHECKLIST_NOT_YOUR_PUPIL,
  CHECKLIST_REASON_NEEDED,
  CHECKLIST_TEMPLATE_EXISTS,
  CHECKLIST_TEMPLATE_RETIRED,
  CHECKLIST_UNKNOWN_PUPIL,
  CHECKLIST_UNKNOWN_SUBJECT,
  CONSENT_ASK_ALREADY_ANSWERED,
  CONSENT_ASK_NEEDS_ALL,
  CONSENT_KINDS,
  CONSENT_LIST_CLOSED,
  CONSENT_LIST_EXISTS,
  CONSENT_NOBODY_TO_ASK,
  CONSENT_NOT_A_CLASS,
  CONSENT_NOT_YOUR_CLASS,
  CONSENT_STATES,
  DESCRIPTION_MAX,
  ENTRY_NOTE_MAX,
  GIVEN_BY_MAX,
  LIST_BODY_MAX,
  PROOF_NOTE_MAX,
  REASON_MAX,
  REFUSALS,
  TICK_MAX,
  TITLE_MAX,
  activeTemplates,
  askBody,
  classesForNewList,
  classesOfGroups,
  countOf,
  earlierProofs,
  emptyEntryForm,
  emptyListForm,
  emptyTemplateForm,
  entryBody,
  entryProblems,
  formOfTemplate,
  groupLabel,
  instructorOf,
  isFuture,
  latestProof,
  listBody,
  listProblems,
  missingIds,
  namesOfIds,
  refusalOf,
  setChosen,
  sharesOf,
  stillOnRoster,
  stillWritable,
  templateCreateBody,
  templateLabel,
  templatePatch,
  templateProblems,
  tickBody,
  tickProblems,
  tickableIds,
  unansweredIds,
  voidProblem,
  writableIds,
  type TickForm,
} from "./checklists";
import { ACK_DISABLED, ACK_TOO_MANY_RECIPIENTS, ACK_TOO_MANY_REQUESTS } from "./ack";
import {
  CONSENT_ROWS,
  GROUPS,
  INSTRUCTORS,
  ROWS,
  TEMPLATES,
  ask,
  card,
  consentRow,
  counts,
  detail,
  entry,
  group,
  listItem,
  proof,
  roster,
  row,
  template,
} from "./__fixtures__/checklists";

/**
 * The web's copy of the gateway's vocabulary, bounds, codes and shapes. The
 * gateway's files (src/checklists/checklists.ts, checklists-views.ts,
 * consent-state.ts and the DTOs) are read as text, because the web cannot import
 * them, and the two must say the same: a bound that differs is a form that
 * accepts what the gateway refuses, or one that refuses what it would take; a code
 * that differs is a refusal said as a raw message; a shape that differs is a
 * screen that reads a field that is not there.
 */
const GATEWAY_DIR = join(__dirname, "..", "..", "src", "checklists");
const GATEWAY = readFileSync(join(GATEWAY_DIR, "checklists.ts"), "utf8");
const VIEWS = readFileSync(join(GATEWAY_DIR, "checklists-views.ts"), "utf8");
const STATE = readFileSync(join(GATEWAY_DIR, "consent-state.ts"), "utf8");
const DTO = readFileSync(join(GATEWAY_DIR, "dto", "checklists.dto.ts"), "utf8");

const numberOf = (name: string): number => Number(new RegExp(`export const ${name} = (\\d+)`).exec(GATEWAY)?.[1]);
const codeOf = (name: string): string | undefined => new RegExp(`export const ${name} = '([A-Z_]+)'`).exec(GATEWAY)?.[1];
const unionOf = (source: string, name: string): string[] =>
  [...(new RegExp(`export type ${name} =([^;]*);`).exec(source)?.[1] ?? "").matchAll(/'([A-Z_]+)'/g)].map((match) => match[1]!);
const fieldsOf = (name: string): string[] => {
  const body = new RegExp(`export interface ${name}(?:<\\w+>)? \\{\\n([\\s\\S]*?)\\n\\}`).exec(VIEWS)?.[1] ?? "";
  return [...body.matchAll(/^ {2}(\w+):/gm)].map((match) => match[1]!).sort();
};
const keys = (value: object): string[] => Object.keys(value).sort();

describe("the bounds and the codes are the gateway's", () => {
  it("says the same bounds", () => {
    expect(TITLE_MAX).toBe(numberOf("TITLE_MAX"));
    expect(DESCRIPTION_MAX).toBe(numberOf("DESCRIPTION_MAX"));
    expect(PROOF_NOTE_MAX).toBe(numberOf("PROOF_NOTE_MAX"));
    expect(ENTRY_NOTE_MAX).toBe(numberOf("ENTRY_NOTE_MAX"));
    expect(GIVEN_BY_MAX).toBe(numberOf("GIVEN_BY_MAX"));
    expect(REASON_MAX).toBe(numberOf("REASON_MAX"));
    expect(LIST_BODY_MAX).toBe(numberOf("LIST_BODY_MAX"));
    expect(TICK_MAX).toBe(numberOf("TICK_MAX"));
    expect(ASK_MAX).toBe(numberOf("ASK_MAX"));
  });

  it("names the codes the gateway answers with", () => {
    expect(CHECKLIST_NOT_FOUND).toBe(codeOf("CHECKLIST_NOT_FOUND"));
    expect(CHECKLIST_NOT_STAFF).toBe(codeOf("CHECKLIST_NOT_STAFF"));
    expect(CHECKLIST_NOT_YOUR_PUPIL).toBe(codeOf("CHECKLIST_NOT_YOUR_PUPIL"));
    expect(CHECKLIST_UNKNOWN_PUPIL).toBe(codeOf("CHECKLIST_UNKNOWN_PUPIL"));
    expect(CHECKLIST_TEMPLATE_RETIRED).toBe(codeOf("CHECKLIST_TEMPLATE_RETIRED"));
    expect(CHECKLIST_TEMPLATE_EXISTS).toBe(codeOf("CHECKLIST_TEMPLATE_EXISTS"));
    expect(CHECKLIST_UNKNOWN_SUBJECT).toBe(codeOf("CHECKLIST_UNKNOWN_SUBJECT"));
    expect(CHECKLIST_DATE_IN_THE_FUTURE).toBe(codeOf("CHECKLIST_DATE_IN_THE_FUTURE"));
    expect(CHECKLIST_DATE_INVALID).toBe(codeOf("CHECKLIST_DATE_INVALID"));
    expect(CONSENT_ASK_NEEDS_ALL).toBe(codeOf("CONSENT_ASK_NEEDS_ALL"));
    expect(CONSENT_ASK_ALREADY_ANSWERED).toBe(codeOf("CONSENT_ASK_ALREADY_ANSWERED"));
    expect(CHECKLIST_INSTRUCTOR_IS_NOT_STAFF).toBe(codeOf("CHECKLIST_INSTRUCTOR_IS_NOT_STAFF"));
    expect(CHECKLIST_REASON_NEEDED).toBe(codeOf("CHECKLIST_REASON_NEEDED"));
    expect(CONSENT_LIST_CLOSED).toBe(codeOf("CONSENT_LIST_CLOSED"));
    expect(CONSENT_LIST_EXISTS).toBe(codeOf("CONSENT_LIST_EXISTS"));
    expect(CONSENT_NOT_A_CLASS).toBe(codeOf("CONSENT_NOT_A_CLASS"));
    expect(CONSENT_NOT_YOUR_CLASS).toBe(codeOf("CONSENT_NOT_YOUR_CLASS"));
    expect(CONSENT_NOBODY_TO_ASK).toBe(codeOf("CONSENT_NOBODY_TO_ASK"));
  });

  it("knows every code the gateway exports, and no other", () => {
    const exported = [...GATEWAY.matchAll(/export const ((?:CHECKLIST|CONSENT)_[A-Z_]+) = '([A-Z_]+)'/g)].map((match) => match[2]!);
    // CONSENT_KVITTENS_OFF is Kvittens's own ACK_DISABLED, which REFUSALS holds with the other Kvittens codes.
    expect([...CHECKLIST_CODES].sort()).toEqual(exported.filter((code) => code !== ACK_DISABLED).sort());
    expect(codeOf("CONSENT_KVITTENS_OFF")).toBe(ACK_DISABLED);
  });

  it("has a sentence for every refusal, in both languages, and one for the throttler", () => {
    expect(REFUSALS).toEqual(expect.arrayContaining([ACK_DISABLED, ACK_TOO_MANY_REQUESTS, ACK_TOO_MANY_RECIPIENTS]));
    for (const messages of [sv, en]) {
      const refusal = messages.checklists.refusal as Record<string, string>;
      for (const code of REFUSALS) expect(refusal[code], code).toEqual(expect.any(String));
      expect(refusal["THROTTLED"]).toEqual(expect.any(String));
      expect(Object.keys(refusal).sort()).toEqual([...REFUSALS, "THROTTLED"].sort());
    }
  });

  it("has a word for every state and every kind of answer, in both languages", () => {
    expect([...CONSENT_STATES]).toEqual(unionOf(STATE, "ConsentKind").concat(["ASKED", "MISSING"]));
    expect([...CONSENT_KINDS]).toEqual(unionOf(STATE, "ConsentKind"));
    const kinds = /CONSENT_ENTRY_KINDS = \[([^\]]*)\]/.exec(DTO)?.[1] ?? "";
    expect([...CONSENT_KINDS]).toEqual([...kinds.matchAll(/'([A-Z_]+)'/g)].map((match) => match[1]));
    for (const messages of [sv, en]) {
      const c = messages.checklists;
      expect(Object.keys(c.state).sort()).toEqual([...CONSENT_STATES].sort());
      for (const part of [c.entry.title, c.entry.description, c.entry.dateLabel, c.entry.dateHint, c.entry.submit, c.detail.written]) {
        expect(Object.keys(part).sort()).toEqual([...CONSENT_KINDS].sort());
      }
    }
  });

  it("answers the shapes the gateway has, field by field", () => {
    expect(fieldsOf("TemplateView")).toEqual(keys(template()));
    expect(fieldsOf("GroupChoice")).toEqual(keys(group()));
    expect(fieldsOf("Instructor")).toEqual(keys(INSTRUCTORS[0]!));
    expect(fieldsOf("ProofView")).toEqual(keys(proof()));
    expect(fieldsOf("ProofRow")).toEqual(keys(row("p", "P")));
    expect(fieldsOf("ProofRoster")).toEqual(keys(roster()));
    expect(fieldsOf("ProofsWritten")).toEqual(["already", "written"]);
    expect(fieldsOf("ProofVoided")).toEqual(["voidedAt"]);
    expect(fieldsOf("ConsentEntryView")).toEqual(keys(entry()));
    expect(fieldsOf("ConsentAskView")).toEqual(keys(ask()));
    expect(fieldsOf("ConsentRow")).toEqual(keys(consentRow("p", "P")));
    expect(fieldsOf("ConsentListItem")).toEqual(keys(listItem()));
    expect(fieldsOf("ConsentDetail")).toEqual(keys(detail()));
    expect(fieldsOf("ConsentWritten")).toEqual(["written"]);
    expect(fieldsOf("ConsentAsked")).toEqual(["guardians", "pupils", "requestId", "withoutGuardian"]);
    expect(fieldsOf("ConsentClosed")).toEqual(["closedAt"]);
    expect(fieldsOf("ChecklistSettings")).toEqual(["kvittens"]);
    // The card's inner shapes are written inline, so every name in its body is compared with every key the fixture holds.
    const cardBody = /export interface PupilCard \{\n([\s\S]*?)\n\}/.exec(VIEWS)?.[1] ?? "";
    const declared = [...new Set([...cardBody.matchAll(/\b(\w+):/g)].map((match) => match[1]!))].sort();
    const held = [...new Set([...keys(card()), ...keys(card().student), ...keys(card().proofs[1]!).filter((key) => !keys(proof()).includes(key)), ...keys(card().consents[0]!)])].sort();
    expect(declared).toEqual(held);
    expect(keys(counts())).toEqual(["asked", "declined", "granted", "missing", "pupils", "withdrawn"]);
    const countsBody = /export interface ConsentCounts \{\n([\s\S]*?)\n\}/.exec(STATE)?.[1] ?? "";
    expect([...countsBody.matchAll(/^ {2}(\w+):/gm)].map((match) => match[1]).sort()).toEqual(keys(counts()));
  });
});

describe("the sentence for a problem in a form", () => {
  it("has one for every problem each form can find, in both languages", () => {
    // The problems the helpers can answer with (the unions in checklists.ts), spelled out so that a new one fails here until it has words.
    const problems: Record<string, string[]> = {
      tick: ["pupils", "pupilsMany", "date", "dateFuture", "noteLong"],
      entry: ["pupils", "pupilsMany", "date", "dateFuture", "givenByLong", "noteLong"],
      templates: ["title", "titleLong", "descriptionLong"],
      void: ["reason", "reasonLong"],
      newList: ["class", "title", "titleLong", "body", "bodyLong"],
    };
    for (const messages of [sv, en]) {
      for (const [form, expected] of Object.entries(problems)) {
        const found = (messages.checklists as unknown as Record<string, { problem: Record<string, string> }>)[form]!.problem;
        expect(Object.keys(found).sort(), form).toEqual([...expected].sort());
      }
    }
    // And the helpers do answer with them.
    const form = { studentIds: [], instructedOn: "", instructorId: "", note: "n".repeat(PROOF_NOTE_MAX + 1) };
    expect(tickProblems(form, "2026-10-05")).toEqual(["pupils", "date", "noteLong"]);
    expect(voidProblem("")).toBe("reason");
  });
});

describe("the sentence for a refusal", () => {
  it("is ours for a code we know, the throttler's for a 429 without one, and nothing for the rest", () => {
    expect(refusalOf({ status: 409, code: "CONSENT_LIST_CLOSED" })).toBe("CONSENT_LIST_CLOSED");
    expect(refusalOf({ status: 409, code: "ACK_DISABLED" })).toBe("ACK_DISABLED");
    expect(refusalOf({ status: 429, code: "ACK_TOO_MANY_REQUESTS" })).toBe("ACK_TOO_MANY_REQUESTS");
    expect(refusalOf({ status: 429 })).toBe("THROTTLED");
    expect(refusalOf({ status: 429, code: "SOMETHING_ELSE" })).toBe("THROTTLED");
    expect(refusalOf({ status: 500, code: "SOMETHING_ELSE" })).toBeNull();
    expect(refusalOf(new Error("boom"))).toBeNull();
    expect(refusalOf(null)).toBeNull();
    expect(refusalOf(undefined)).toBeNull();
  });
});

describe("templates", () => {
  it("is spelled Ämne – Moment in a select, and by the moment alone without a subject", () => {
    expect(templateLabel(template())).toBe("Slöjd – Maskinerna");
    expect(templateLabel(template({ subjectName: null, subjectId: null }))).toBe("Maskinerna");
  });

  it("offers the active ones to tick in", () => {
    expect(activeTemplates(TEMPLATES).map((one) => one.title)).toEqual(["Maskinerna", "Laborationssäkerhet", "Brandövning"]);
  });

  it("says what stops a template from being saved, counting after the trim as the gateway does", () => {
    expect(templateProblems(emptyTemplateForm())).toEqual(["title"]);
    expect(templateProblems({ title: "  ", description: "", subjectId: "" })).toEqual(["title"]);
    expect(templateProblems({ title: "a".repeat(TITLE_MAX), description: "", subjectId: "" })).toEqual([]);
    expect(templateProblems({ title: "a".repeat(TITLE_MAX + 1), description: "b".repeat(DESCRIPTION_MAX + 1), subjectId: "" })).toEqual([
      "titleLong",
      "descriptionLong",
    ]);
    expect(templateProblems({ title: ` ${"a".repeat(TITLE_MAX)} `, description: ` ${"b".repeat(DESCRIPTION_MAX)} `, subjectId: "" })).toEqual([]);
  });

  it("makes a template of the trimmed text and leaves out what is blank", () => {
    expect(templateCreateBody({ title: " Maskinerna ", description: "  ", subjectId: "" })).toEqual({ title: "Maskinerna" });
    expect(templateCreateBody({ title: "Maskinerna", description: " Sågen ", subjectId: "s-slojd" })).toEqual({
      title: "Maskinerna",
      description: "Sågen",
      subjectId: "s-slojd",
    });
  });

  it("changes only what changed, takes away with null, and sends nothing when nothing changed", () => {
    const one = template({ description: "Sågen", subjectId: "s-slojd" });
    expect(formOfTemplate(one)).toEqual({ title: "Maskinerna", description: "Sågen", subjectId: "s-slojd" });
    expect(formOfTemplate(template())).toEqual({ title: "Maskinerna", description: "", subjectId: "s-slojd" });
    expect(templatePatch(one, formOfTemplate(one))).toBeNull();
    expect(templatePatch(one, { ...formOfTemplate(one), title: " Svarven " })).toEqual({ title: "Svarven" });
    expect(templatePatch(one, { ...formOfTemplate(one), description: "" })).toEqual({ description: null });
    expect(templatePatch(one, { ...formOfTemplate(one), subjectId: "" })).toEqual({ subjectId: null });
    expect(templatePatch(template(), { title: "Maskinerna", description: "Ny", subjectId: "s-no" })).toEqual({ description: "Ny", subjectId: "s-no" });
  });
});

describe("groups", () => {
  it("is spelled with what the reader teaches in it", () => {
    expect(groupLabel(group())).toBe("7A");
    expect(groupLabel(group({ subjects: ["Slöjd", "Fysik"] }))).toBe("7A · Slöjd, Fysik");
  });

  it("offers the classes to filter lists by, and to make a list for only the ones the gateway says the reader may", () => {
    expect(classesOfGroups(GROUPS).map((one) => one.name)).toEqual(["7A", "8B"]);
    expect(classesForNewList(GROUPS).map((one) => one.name)).toEqual(["7A", "8B"]);
    // A class the reader only teaches, a teaching group, and a läsare's every class are not to make a list for.
    const groups = [group({ id: "a", name: "9C", canMakeList: false }), group({ id: "b", name: "Slöjd 7", kind: "TEACHING_GROUP", canMakeList: true }), group({ id: "c", name: "7A" })];
    expect(classesForNewList(groups).map((one) => one.name)).toEqual(["7A"]);
    expect(classesForNewList(groups.map((one) => ({ ...one, canMakeList: false })))).toEqual([]);
  });
});

describe("a roster", () => {
  it("reads the latest instruction, how many came before it, and who gave it", () => {
    expect(latestProof(ROWS[0]!)?.id).toBe("pr-1");
    expect(earlierProofs(ROWS[0]!)).toBe(1);
    expect(earlierProofs(ROWS[1]!)).toBe(0);
    expect(latestProof(ROWS[1]!)).toBeNull();
    expect(instructorOf(proof())).toBe("Anna Svensson");
    // The instructor the writer left out is the writer.
    expect(instructorOf(proof({ instructorName: null, recordedByName: "Bo Ek" }))).toBe("Bo Ek");
    expect(instructorOf(proof({ instructorName: null, recordedByName: null }))).toBeNull();
  });

  it("offers the pupils the reader may tick, and those still missing a tick", () => {
    expect(tickableIds(ROWS)).toEqual(["p-ada", "p-bo", "p-dan"]);
    expect(missingIds(ROWS)).toEqual(["p-bo"]);
    expect(missingIds([row("p-x", "X", { canTick: false })])).toEqual([]);
  });

  it("keeps the choice of a pupil still on the roster, and drops one a read again took off it", () => {
    expect(stillOnRoster(["p-ada", "p-gone", "p-cia"], ROWS)).toEqual(["p-ada"]);
  });

  it("chooses and unchooses, each pupil once", () => {
    expect(setChosen(["a"], ["b", "a"], true)).toEqual(["a", "b"]);
    expect(setChosen(["a", "b"], ["a"], false)).toEqual(["b"]);
  });
});

describe("the tick", () => {
  const form = (over: Partial<TickForm> = {}): TickForm => ({ studentIds: ["p-ada"], instructedOn: "2026-10-05", instructorId: "", note: "", ...over });

  it("is stopped by no pupil, too many, a day that is not one or has not come, and a long note", () => {
    expect(tickProblems(form(), "2026-10-05")).toEqual([]);
    expect(tickProblems(form({ studentIds: [] }), "2026-10-05")).toEqual(["pupils"]);
    expect(tickProblems(form({ studentIds: Array.from({ length: TICK_MAX + 1 }, (_, index) => `p${index}`) }), "2026-10-05")).toEqual(["pupilsMany"]);
    expect(tickProblems(form({ studentIds: Array.from({ length: TICK_MAX }, (_, index) => `p${index}`) }), "2026-10-05")).toEqual([]);
    expect(tickProblems(form({ instructedOn: "" }), "2026-10-05")).toEqual(["date"]);
    expect(tickProblems(form({ instructedOn: "5 okt" }), "2026-10-05")).toEqual(["date"]);
    expect(tickProblems(form({ instructedOn: "2026-10-06" }), "2026-10-05")).toEqual(["dateFuture"]);
    expect(tickProblems(form({ note: "n".repeat(PROOF_NOTE_MAX + 1) }), "2026-10-05")).toEqual(["noteLong"]);
    expect(tickProblems(form({ note: ` ${"n".repeat(PROOF_NOTE_MAX)} ` }), "2026-10-05")).toEqual([]);
  });

  it("is a day not after today", () => {
    expect(isFuture("2026-10-06", "2026-10-05")).toBe(true);
    expect(isFuture("2026-10-05", "2026-10-05")).toBe(false);
    expect(isFuture("2025-12-31", "2026-01-01")).toBe(false);
  });

  it("leaves out today (the school's clock decides it) and nobody as the instructor (the writer is), and sends each pupil once", () => {
    expect(tickBody("t-1", form({ studentIds: ["p-ada", "p-bo", "p-ada"] }), "2026-10-05")).toEqual({ templateId: "t-1", studentIds: ["p-ada", "p-bo"] });
    expect(tickBody("t-1", form({ instructedOn: "2026-10-03", instructorId: "u-bo", note: " Svarven " }), "2026-10-05")).toEqual({
      templateId: "t-1",
      studentIds: ["p-ada"],
      instructedOn: "2026-10-03",
      instructorId: "u-bo",
      note: "Svarven",
    });
  });

  it("asks for a reason to void, at most as long as the gateway takes", () => {
    expect(voidProblem("")).toBe("reason");
    expect(voidProblem("   ")).toBe("reason");
    expect(voidProblem("Fel elev")).toBeNull();
    expect(voidProblem("r".repeat(REASON_MAX))).toBeNull();
    expect(voidProblem("r".repeat(REASON_MAX + 1))).toBe("reasonLong");
  });
});

describe("a consent list", () => {
  it("is stopped by no class, no title, no text, or either too long", () => {
    expect(listProblems(emptyListForm())).toEqual(["class", "title", "body"]);
    expect(listProblems({ classId: "g-7a", title: "Foto", body: "Vi får fotografera." })).toEqual([]);
    expect(listProblems({ classId: "g-7a", title: "t".repeat(TITLE_MAX + 1), body: "b".repeat(LIST_BODY_MAX + 1) })).toEqual(["titleLong", "bodyLong"]);
    expect(listProblems({ classId: "g-7a", title: "t".repeat(TITLE_MAX), body: "b".repeat(LIST_BODY_MAX) })).toEqual([]);
  });

  it("is made of the trimmed text", () => {
    expect(listBody({ classId: "g-7a", title: " Foto ", body: " Vi får fotografera. " })).toEqual({ classId: "g-7a", title: "Foto", body: "Vi får fotografera." });
  });

  it("is told in numbers, and in shares for the bar: only the states that have a pupil", () => {
    expect(countOf(counts(), "GRANTED")).toBe(2);
    expect(countOf(counts(), "ASKED")).toBe(1);
    expect(countOf(counts(), "MISSING")).toBe(2);
    expect(sharesOf(counts({ pupils: 4, granted: 1, declined: 0, withdrawn: 1, asked: 0, missing: 2 }))).toEqual([
      { state: "GRANTED", count: 1, percent: 25 },
      { state: "WITHDRAWN", count: 1, percent: 25 },
      { state: "MISSING", count: 2, percent: 50 },
    ]);
    expect(sharesOf(counts({ pupils: 0, granted: 0, declined: 0, withdrawn: 0, asked: 0, missing: 0 }))).toEqual([]);
  });
});

describe("an answer", () => {
  it("starts on today with the kind the button chose", () => {
    expect(emptyEntryForm("WITHDRAWN", "2026-10-05")).toEqual({ kind: "WITHDRAWN", givenOn: "2026-10-05", givenBy: "", note: "" });
  });

  it("is stopped by no pupil, too many, a bad or future day, and long text", () => {
    const form = emptyEntryForm("GRANTED", "2026-10-05");
    expect(entryProblems(form, ["p-ada"], "2026-10-05")).toEqual([]);
    expect(entryProblems(form, [], "2026-10-05")).toEqual(["pupils"]);
    expect(entryProblems(form, Array.from({ length: TICK_MAX + 1 }, (_, index) => `p${index}`), "2026-10-05")).toEqual(["pupilsMany"]);
    expect(entryProblems({ ...form, givenOn: "" }, ["p-ada"], "2026-10-05")).toEqual(["date"]);
    expect(entryProblems({ ...form, givenOn: "2026-10-06" }, ["p-ada"], "2026-10-05")).toEqual(["dateFuture"]);
    expect(entryProblems({ ...form, givenBy: "g".repeat(GIVEN_BY_MAX + 1), note: "n".repeat(ENTRY_NOTE_MAX + 1) }, ["p-ada"], "2026-10-05")).toEqual([
      "givenByLong",
      "noteLong",
    ]);
  });

  it("is written with the trimmed text, today left to the school's clock and each pupil once", () => {
    const form = { ...emptyEntryForm("DECLINED", "2026-10-05"), givenBy: " Adas mamma ", note: "  " };
    expect(entryBody(form, ["p-ada", "p-ada", "p-bo"], "2026-10-05")).toEqual({ studentIds: ["p-ada", "p-bo"], kind: "DECLINED", givenBy: "Adas mamma" });
    expect(entryBody({ ...form, givenOn: "2026-10-01", note: " På blanketten " }, ["p-ada"], "2026-10-05")).toEqual({
      studentIds: ["p-ada"],
      kind: "DECLINED",
      givenOn: "2026-10-01",
      givenBy: "Adas mamma",
      note: "På blanketten",
    });
  });
});

describe("the pupils of a list", () => {
  it("are the ones the reader may write for, and the ones with no answer to ask", () => {
    const rows = [
      consentRow("a", "A"),
      consentRow("b", "B", { canWrite: false }),
      consentRow("c", "C", { state: "GRANTED" }),
      consentRow("d", "D", { inClass: false }),
      consentRow("e", "E", { state: "ASKED" }),
    ];
    expect(writableIds(rows)).toEqual(["a", "c", "d", "e"]);
    // A pupil who has left the class is not asked: their guardians are asked about the class they are in.
    expect(unansweredIds(rows)).toEqual(["a"]);
    expect(stillWritable(["a", "b", "z"], rows)).toEqual(["a"]);
    expect(unansweredIds(CONSENT_ROWS)).toEqual(["p-gun"]);
  });

  it("asks the chosen pupils, or every one with no answer when none is chosen", () => {
    expect(askBody(["a", "b", "a"])).toEqual({ studentIds: ["a", "b"] });
    expect(askBody([])).toEqual({});
  });

  it("names the pupils the gateway left out, in the list's order", () => {
    expect(namesOfIds(CONSENT_ROWS, ["p-dan", "p-ada", "p-unknown"])).toEqual(["Ada Berg", "Dan Dal"]);
  });
});
