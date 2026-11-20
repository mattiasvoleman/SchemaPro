import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTranslator } from "use-intl";
import { describe, expect, it } from "vitest";
import {
  endedKey,
  failedKey,
  type StaffingSearchLeftOutPostReason,
  type StaffingSearchLeftOutYearReason,
  type StaffingSearchStatus,
  type StaffingSearchStop,
  type StaffingSearchView,
} from "@/lib/staffing-search";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";

/**
 * Lärarval F3, the search's words, checked against the catalogues as the reader gets them. The panel's tests echo what is
 * on the screen, so they prove which sentence is said and not what the catalogue holds: the honest limit, the plural of
 * "byte", and that every way a search can end has a sentence in both languages.
 */

const ROOT = join(__dirname, "..");
const swedish = createTranslator({ locale: "sv", messages: sv, namespace: "staffing.search" });
const english = createTranslator({ locale: "en", messages: en, namespace: "staffing.search" });

const flat = (catalogue: Record<string, unknown>, prefix = ""): string[] =>
  Object.entries(catalogue).flatMap(([key, value]) =>
    value !== null && typeof value === "object" ? flat(value as Record<string, unknown>, `${prefix}${key}.`) : [`${prefix}${key}`],
  );

const STATUSES: StaffingSearchStatus[] = ["PENDING", "RUNNING", "CANCELLING", "SUCCEEDED", "CANCELLED", "FAILED"];
const STOPS: (StaffingSearchStop | null)[] = [
  "NOT_TIGHT",
  "LOCAL_OPTIMUM",
  "NOT_ALL_COUNTED",
  "NO_MOVES",
  "CANCELLED",
  "BUDGET",
  "MAX_ROUNDS",
  "MAX_EVALUATIONS",
  "ENGINE_OLDER",
  "ENGINE_BUSY",
  "ENGINE_FAILING",
  null,
];
/** Every reason the gateway counts a post under, and every reason it names a year with: a reason added to the type is a key missing here. */
const POST_REASONS = Object.keys({
  NOT_FREE: true,
  UNSTAFFED: true,
  NO_CHOICE: true,
  NOT_IN_WEEK: true,
  YEAR_LIMIT: true,
  YEAR_NOT_COUNTED: true,
} satisfies Record<StaffingSearchLeftOutPostReason, true>) as StaffingSearchLeftOutPostReason[];
const YEAR_REASONS = Object.keys({ YEAR_LIMIT: true, YEAR_NOT_COUNTED: true } satisfies Record<StaffingSearchLeftOutYearReason, true>) as StaffingSearchLeftOutYearReason[];
const view = (status: StaffingSearchStatus, stopReason: StaffingSearchStop | null, acceptedMoves: number, errorCode: string | null): StaffingSearchView => ({
  id: "r",
  academicYearId: "y",
  status,
  stopReason,
  budgetMs: 1,
  elapsedMs: 1,
  round: 1,
  evaluations: 1,
  acceptedMoves,
  figures: null,
  tally: null,
  errorCode,
  errorParams: null,
  error: null,
  hasProposal: false,
  createdAt: "",
  startedAt: null,
  finishedAt: null,
});

describe("staffing.search", () => {
  it("is the same keys in both languages, and the dialog's two own keys are in both", () => {
    expect(flat(en.staffing.search).sort()).toEqual(flat(sv.staffing.search).sort());
    expect(Object.keys(sv.staffing.proposal)).toEqual(expect.arrayContaining(["searchEntry", "searchNote"]));
    expect(Object.keys(en.staffing.proposal)).toEqual(expect.arrayContaining(["searchEntry", "searchNote"]));
  });

  it("says the honest limit in the words the phase was written for: a lower bound per year and week, no schedule, other years unseen, no unled posts", () => {
    expect(sv.staffing.search.limits).toBe(
      "Siffrorna är motorns nedre gräns för varje årskurs och vecka. De visar att veckan går att lätta, inte att ett schema finns, och lärarnas lektioner i andra årskurser syns inte i dem. Poster som ingen leder är inte med.",
    );
    expect(en.staffing.search.limits).toContain("lower bound");
    expect(en.staffing.search.limits).toContain("not that a timetable exists");
    expect(en.staffing.search.limits).toContain("other years are not visible");
    expect(en.staffing.search.limits).toContain("nobody leads are not included");
  });

  it("never says that a week fits or that a timetable can be laid", () => {
    const texts = (node: unknown): string[] =>
      typeof node === "string" ? [node] : node !== null && typeof node === "object" ? Object.values(node).flatMap(texts) : [];
    for (const text of [...texts(sv.staffing.search), ...texts(en.staffing.search)]) {
      expect(text).not.toMatch(/går ihop|ryms|räcker|will fit|is solved/i);
    }
    expect(sv.staffing.search.ended.NOT_TIGHT).toContain("det finns inget att vinna");
  });

  it("counts moves in the plural, and says nothing found as nothing", () => {
    expect(swedish("moves", { count: 0 })).toBe("Hittills: inget byte som underlättar veckan.");
    expect(swedish("moves", { count: 1 })).toBe("Hittills: 1 byte som underlättar veckan.");
    expect(swedish("moves", { count: 2 })).toBe("Hittills: 2 byten som underlättar veckan.");
    expect(english("moves", { count: 0 })).toBe("So far: no change that eases the week.");
    expect(english("moves", { count: 1 })).toBe("So far: 1 change that eases the week.");
    expect(swedish("rounds", { round: 3, evaluations: 41 })).toBe("Varv 3, 41 värderingar.");
    expect(swedish("rounds", { round: 1, evaluations: 1 })).toBe("Varv 1, 1 värdering.");
  });

  it("says a time in seconds, minutes, or both, and a year's figures with the arrow only where there is one", () => {
    expect(swedish("duration.seconds", { seconds: 45 })).toBe("45 s");
    expect(swedish("duration.minutes", { minutes: 10 })).toBe("10 min");
    expect(swedish("duration.both", { minutes: 1, seconds: 20 })).toBe("1 min 20 s");
    expect(swedish("timeUsed", { used: "1 min 20 s", budget: "10 min" })).toBe("Tid använd: 1 min 20 s av 10 min");
    expect(swedish("yearLineSoFar", { year: 9, before: "100,2", after: "96,4" })).toBe("Åk 9: 100,2 % → 96,4 % hittills");
    expect(swedish("yearLine", { year: 9, before: "100,2", after: "96,4" })).toBe("Åk 9: 100,2 % → 96,4 %");
    expect(swedish("yearLineSame", { year: 8, percent: "91,2" })).toBe("Åk 8: 91,2 %");
    expect(english("yearLineSoFar", { year: 9, before: "100.2", after: "96.4" })).toBe("Year 9: 100.2 % → 96.4 % so far");
  });

  it("has a sentence, in both languages, for every way a search can end and every code it can fail with", () => {
    for (const status of STATUSES) {
      for (const stop of STOPS) {
        for (const moves of [0, 3]) {
          for (const code of [null, "SEARCH_ABANDONED", "SEARCH_INTERRUPTED", "SEARCH_START_REFUSED", "SEARCH_START_NOT_EXACT", "SEARCH_ENGINE_OLDER", "SEARCH_ENGINE_FAILING", "SEARCH_ENGINE_BUSY", "SEARCH_FAILED", "A_CODE_NOBODY_KNOWS"]) {
            const run = view(status, stop, moves, code);
            const key = status === "FAILED" ? `failed.${failedKey(run)}` : `ended.${endedKey(run)}`;
            for (const [language, catalogue] of [
              ["sv", swedish],
              ["en", english],
            ] as const) {
              const has = (catalogue as unknown as { has(key: string): boolean }).has(key);
              expect(has, `${language}: ${key} (${status}, ${stop}, ${moves}, ${code})`).toBe(true);
            }
          }
        }
      }
    }
    for (const status of STATUSES) {
      expect(swedish.has(`status.${status}`)).toBe(true);
      expect(english.has(`status.${status}`)).toBe(true);
    }
  });

  it("says a search that stopped before anything was found in a form that does not promise a proposal, and one that found something with its number of moves", () => {
    expect(swedish("ended.CANCELLED", { count: 1 })).toBe("Sökningen avbröts. Bästa läget den hann hitta har 1 byte.");
    expect(swedish("ended.CANCELLED_NONE", {})).toBe("Sökningen avbröts innan den hann hitta något byte som gör veckan lättare.");
    expect(swedish("ended.BUDGET", { count: 4 })).toContain("med mer tid kan den hitta fler byten");
    expect(english("ended.BUDGET", { count: 4 })).toContain("with more time it could find more changes");
    expect(swedish("failed.SEARCH_ENGINE_OLDER", {})).toContain("Schemamotorn är äldre än API:t");
  });

  it("says a search that the engine kept waiting too long as that, and that the wait is not part of the search's time", () => {
    expect(swedish("failed.SEARCH_ENGINE_BUSY", {})).toBe(
      "Motorn var upptagen för länge (den delas med andra skolor), så sökningen stannade. Väntan räknas inte in i sökningens tid. Försök igen om en stund.",
    );
    expect(english("failed.SEARCH_ENGINE_BUSY", {})).toBe(
      "The engine was busy for too long (it is shared with other schools), so the search stopped. The wait is not counted in the search's time. Try again in a moment.",
    );
    // The run stopped on the engine's side and the wording says so: never "failed" as of the school's own doing.
    expect(sv.staffing.search.failed.SEARCH_ENGINE_BUSY).not.toBe(sv.staffing.search.failed.SEARCH_FAILED);
  });

  it("has a sentence, in the singular and the plural and in both languages, for every reason a post or a year is left out", () => {
    for (const [language, catalogue] of [
      ["sv", swedish],
      ["en", english],
    ] as const) {
      const has = (catalogue as unknown as { has(key: string): boolean }).has;
      expect(has.call(catalogue, "leftOutTitle"), `${language}: leftOutTitle`).toBe(true);
      for (const reason of POST_REASONS) {
        expect(has.call(catalogue, `leftOutPost.${reason}`), `${language}: leftOutPost.${reason}`).toBe(true);
        const one = (catalogue as unknown as (key: string, values: object) => string)(`leftOutPost.${reason}`, { count: 1 });
        const many = (catalogue as unknown as (key: string, values: object) => string)(`leftOutPost.${reason}`, { count: 4 });
        // The count leads each sentence, and the singular and the plural are not the same words.
        expect(one, `${language}: ${reason}`).toMatch(/^1 /);
        expect(many, `${language}: ${reason}`).toMatch(/^4 /);
        expect(many).not.toBe(one.replace(/^1/, "4"));
      }
      for (const reason of YEAR_REASONS) {
        expect(has.call(catalogue, `leftOutYear.${reason}`), `${language}: leftOutYear.${reason}`).toBe(true);
      }
    }
    // Every key the catalogue holds for it is a reason the gateway has (and the other way round).
    expect(Object.keys(sv.staffing.search.leftOutPost).sort()).toEqual([...POST_REASONS].sort());
    expect(Object.keys(en.staffing.search.leftOutPost).sort()).toEqual([...POST_REASONS].sort());
    expect(Object.keys(sv.staffing.search.leftOutYear).sort()).toEqual([...YEAR_REASONS].sort());
    expect(Object.keys(en.staffing.search.leftOutYear).sort()).toEqual([...YEAR_REASONS].sort());
  });

  it("says what was left out in the words the phase was written for, in the plural where there are several", () => {
    expect(swedish("leftOutTitle")).toBe("Det sökningen lämnade orört");
    expect(swedish("leftOutPost.NOT_FREE", { count: 1 })).toBe("1 post är inte släppt åt motorn, eller är fäst, och behåller sin lärare.");
    expect(swedish("leftOutPost.NOT_FREE", { count: 3 })).toBe("3 poster är inte släppta åt motorn, eller är fästa, och behåller sina lärare.");
    expect(swedish("leftOutPost.UNSTAFFED", { count: 2 })).toContain("2 poster saknar lärare och söks inte");
    expect(swedish("leftOutPost.UNSTAFFED", { count: 2 })).toContain("Föreslå bemanning");
    expect(swedish("leftOutPost.NO_CHOICE", { count: 1 })).toContain("behörighet, tjänstgrad eller medlärare");
    expect(swedish("leftOutPost.NOT_IN_WEEK", { count: 5 })).toContain("handplacerade");
    expect(swedish("leftOutPost.YEAR_LIMIT", { count: 1 })).toContain("inte bland de fyra trängsta");
    expect(swedish("leftOutPost.YEAR_NOT_COUNTED", { count: 1 })).toContain("kunde inte räknas till slut");
    expect(swedish("leftOutYear.YEAR_LIMIT", { year: 8 })).toBe("Åk 8 värderades inte: sökningen värderar högst fyra årskurser, de trängsta.");
    expect(swedish("leftOutYear.YEAR_NOT_COUNTED", { year: 9 })).toBe("Åk 9 värderades inte: veckan kunde inte räknas till slut som den är i dag.");
    expect(english("leftOutTitle")).toBe("What the search left alone");
    expect(english("leftOutPost.NOT_FREE", { count: 1 })).toBe("1 entry is not released for the engine, or is pinned, and keeps its teacher.");
    expect(english("leftOutPost.NOT_FREE", { count: 2 })).toBe("2 entries are not released for the engine, or are pinned, and keep their teachers.");
    expect(english("leftOutYear.YEAR_LIMIT", { year: 8 })).toBe("Year 8 was not judged: the search judges at most four years, the tightest.");
  });

  it("has no sentence that nothing says", () => {
    // The panel is the only reader of staffing.search; the dialog reads its own two keys of staffing.proposal.
    const panel = readFileSync(join(ROOT, "components/staffing/staffing-search.tsx"), "utf8");
    const dialog = readFileSync(join(ROOT, "app/[locale]/(app)/admin/staffing/staffing-proposal-dialog.tsx"), "utf8");
    // status.*, refused.*, ended.*, failed.*, proposalProblem.*, duration.* and leftOutPost.* / leftOutYear.* are said through a
    // template or a computed key (the panel's tests and the tests above hold them).
    const unused = flat(sv.staffing.search).filter(
      (key) => !/^(status|refused|ended|failed|proposalProblem|duration|leftOutPost|leftOutYear)\./.test(key) && !panel.includes(`("${key}"`) && !panel.includes(`t("${key}"`),
    );
    expect(unused).toEqual([]);
    expect(dialog).toContain('t("searchEntry")');
    expect(dialog).toContain('t("searchNote")');
  });
});
