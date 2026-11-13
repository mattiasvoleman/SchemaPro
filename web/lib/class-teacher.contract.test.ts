import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import {
  AREA_NOT_YOURS,
  CHANGE_KINDS,
  CODES,
  CONFLICT_KINDS,
  FRAME_REASONS,
  LESSON_IS_PLACED,
  OUTCOMES,
  PART_MIN,
  NOTE_MAX,
  SPANS_MAX,
  WEEKDAYS,
} from "./class-teacher";

/**
 * The web's copy of the gateway's vocabulary. The gateway's file
 * (src/class-teacher/class-teacher.types.ts) is read as text, because the web
 * cannot import it, and the two must say the same: a refusal reason the web does
 * not know is said as "the lesson cannot be changed", a code that differs is a
 * 409 told as something else, a bound that differs is a form that accepts what
 * the gateway refuses.
 */
const TYPES = readFileSync(join(__dirname, "..", "..", "src", "class-teacher", "class-teacher.types.ts"), "utf8");
const DTO = readFileSync(join(__dirname, "..", "..", "src", "class-teacher", "dto", "class-teacher.dto.ts"), "utf8");
const GUARD = readFileSync(join(__dirname, "..", "..", "src", "auth", "roles.guard.ts"), "utf8");
const MASTER_LESSONS = readFileSync(join(__dirname, "..", "..", "src", "calendar", "master-lessons.service.ts"), "utf8");

const listOf = (name: string): string[] => {
  const body = new RegExp(`export const ${name} = \\[([^\\]]*)\\]`).exec(TYPES)?.[1] ?? "";
  return [...body.matchAll(/'([A-Z_]+)'/g)].map((match) => match[1]!);
};

const unionOf = (field: string): string[] => {
  const line = new RegExp(`${field}: ((?:'[A-Z_]+'(?: \\| )?)+)`).exec(TYPES)?.[1] ?? "";
  return [...line.matchAll(/'([A-Z_]+)'/g)].map((match) => match[1]!);
};

const block = (name: string): string => new RegExp(`export const ${name}[^=]*= \\{([\\s\\S]*?)\\n\\}`).exec(TYPES)?.[1] ?? "";

describe("the vocabulary is the gateway's", () => {
  it("says the same refusal reasons, in the same order", () => {
    expect([...FRAME_REASONS]).toEqual(listOf("FRAME_REASONS"));
    expect(FRAME_REASONS.length).toBeGreaterThan(20);
  });

  it("says the same kinds of change", () => {
    expect([...CHANGE_KINDS]).toEqual(listOf("CHANGE_KINDS"));
  });

  it("says the same codes", () => {
    const gateway = Object.fromEntries([...block("CODES").matchAll(/(\w+): '([A-Z_]+)'/g)].map((match) => [match[1], match[2]]));
    // The web keeps the two codes of a bad request that the gateway spells in its services, apart from CODES.
    const web = Object.fromEntries(Object.entries(CODES).filter(([name]) => name !== "INVALID"));
    expect(web).toEqual(gateway);
    expect(CODES.INVALID).toBe("CLASS_TEACHER_INVALID");
    expect(GUARD).toContain(`export const AREA_NOT_YOURS = '${AREA_NOT_YOURS}'`);
  });

  it("says the same clashes and the same outcomes of a publication", () => {
    expect([...CONFLICT_KINDS]).toEqual(unionOf("kind"));
    expect([...OUTCOMES]).toEqual(unionOf("outcome"));
  });

  it("holds the same bounds", () => {
    expect(DTO).toContain("@MaxLength(200)");
    expect(NOTE_MAX).toBe(200);
    expect(DTO).toContain("@ArrayMaxSize(40)");
    expect(SPANS_MAX).toBe(40);
    // Lessons are laid Monday (1) to Friday (5): the DTO's @Min(1) @Max(5) on a weekday.
    expect(DTO).toMatch(/@Min\(1\)\s+@Max\(5\)\s+targetDayOfWeek/);
    expect([...WEEKDAYS]).toEqual([1, 2, 3, 4, 5]);
    // A part of a split is at least 15 minutes (the sentence of SPLIT_MINUTES).
    expect(TYPES).toContain("minst 15 minuter");
    expect(PART_MIN).toBe(15);
  });
});

describe("every reason has a sentence in both languages", () => {
  const gatewaySentences = Object.fromEntries([...block("FRAME_MESSAGES").matchAll(/(\w+): '([^']*)'/g)].map((match) => [match[1], match[2]]));
  const sentenceOf = (messages: typeof sv, reason: string): unknown => (messages.classTeacher.reason as Record<string, unknown>)[reason];

  it("has one for each reason and one for a reason the web does not know yet", () => {
    for (const reason of [...FRAME_REASONS, LESSON_IS_PLACED, "UNKNOWN"]) {
      expect(typeof sentenceOf(sv, reason), `sv ${reason}`).toBe("string");
      expect(typeof sentenceOf(en, reason), `en ${reason}`).toBe("string");
    }
    expect(Object.keys(sv.classTeacher.reason).sort()).toEqual([...FRAME_REASONS, LESSON_IS_PLACED, "UNKNOWN"].sort());
    expect(Object.keys(en.classTeacher.reason).sort()).toEqual(Object.keys(sv.classTeacher.reason).sort());
  });

  // The gateway keeps this reason out of FRAME_REASONS (the list above is mirrored one for one) and says it in its own file.
  it("says the reason the gateway adds to the frame's by its code and its Swedish sentence", () => {
    expect(TYPES).toContain(`export const LESSON_IS_PLACED_REASON = '${LESSON_IS_PLACED}'`);
    expect(MASTER_LESSONS).toContain(`export const LESSON_IS_PLACED = '${LESSON_IS_PLACED}'`);
    const sentence = /export const LESSON_IS_PLACED_MESSAGE =\s*'([^']*)'/.exec(TYPES)?.[1];
    expect(sentence).toBeTruthy();
    expect(sentenceOf(sv, LESSON_IS_PLACED)).toBe(sentence);
    expect(sentenceOf(en, LESSON_IS_PLACED)).not.toBe(sentence);
  });

  it("says the Swedish ones as the gateway says them to a client without the web's strings", () => {
    for (const reason of FRAME_REASONS) expect(sentenceOf(sv, reason), reason).toBe(gatewaySentences[reason]);
  });

  it("says the English ones differently from the Swedish", () => {
    for (const reason of FRAME_REASONS) expect(sentenceOf(en, reason), reason).not.toBe(sentenceOf(sv, reason));
  });
});

describe("the other words that are keyed by the gateway's vocabulary", () => {
  it("has a sentence for each kind of change, clash, outcome and state of a lesson", () => {
    for (const messages of [sv, en]) {
      const t = messages.classTeacher;
      for (const kind of CHANGE_KINDS) {
        expect(t.summary[kind], kind).toBeTruthy();
        expect(t.form.title[kind], kind).toBeTruthy();
        expect(t.form.intro[kind], kind).toBeTruthy();
        expect(t.panel.action[kind], kind).toBeTruthy();
      }
      for (const kind of CONFLICT_KINDS) expect(t.conflict.kind[kind], kind).toBeTruthy();
      for (const outcome of OUTCOMES) expect(t.outcome[outcome], outcome).toBeTruthy();
      for (const state of ["editable", "locked", "draft", "cancelled"] as const) expect(t.state[state], state).toBeTruthy();
    }
  });
});
