import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTranslator } from "use-intl";
import { describe, expect, it } from "vitest";
import {
  endedKey,
  failedKey,
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
  "NO_MOVES",
  "CANCELLED",
  "BUDGET",
  "MAX_ROUNDS",
  "MAX_EVALUATIONS",
  "ENGINE_OLDER",
  "ENGINE_FAILING",
  null,
];
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
          for (const code of [null, "SEARCH_ABANDONED", "SEARCH_INTERRUPTED", "SEARCH_START_REFUSED", "SEARCH_START_NOT_EXACT", "SEARCH_ENGINE_OLDER", "SEARCH_ENGINE_FAILING", "SEARCH_FAILED", "A_CODE_NOBODY_KNOWS"]) {
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

  it("has no sentence that nothing says", () => {
    // The panel is the only reader of staffing.search; the dialog reads its own two keys of staffing.proposal.
    const panel = readFileSync(join(ROOT, "components/staffing/staffing-search.tsx"), "utf8");
    const dialog = readFileSync(join(ROOT, "app/[locale]/(app)/admin/staffing/staffing-proposal-dialog.tsx"), "utf8");
    // status.*, refused.*, ended.*, failed.*, proposalProblem.* and duration.* are said through a template or a computed key
    // (the panel's tests and the test above hold them).
    const unused = flat(sv.staffing.search).filter(
      (key) => !/^(status|refused|ended|failed|proposalProblem|duration)\./.test(key) && !panel.includes(`("${key}"`) && !panel.includes(`t("${key}"`),
    );
    expect(unused).toEqual([]);
    expect(dialog).toContain('t("searchEntry")');
    expect(dialog).toContain('t("searchNote")');
  });
});
