import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import sv from "@/messages/sv.json";
import type { PlannedLine } from "@/lib/timplan-planned";
import type { PlannedClassPupil, PlannedClassPupilsResponse, PlannedPupilFigure } from "@/lib/timplan-tackning";
import { PlannedClassPupils, type PlannedClassPupilsProps } from "./coverage-planned-pupils";

globalThis.ResizeObserver ??= class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
};

/**
 * "Visa alla elever" over the gateway's per-class answer, in the Swedish
 * messages: what the panel says for a class where nobody has a finding of their
 * own (the pupils the overview only counts), where each line's minutes come
 * from, and what it does while loading, when it fails and when nothing matches.
 * The figures are the gateway's (src/common/timplan-planned.drill.spec.ts).
 */

const CLASS_ID = "c-8a";
const HALF_ID = "g-8a1";
const SPANSKA = "g-spanska";
const SVA = "g-sva";
const MA = "s-ma";
const SPA = "s-spa";
const TYS = "s-tys";
const SLOJD = "s-slojd";
const TEXTIL = "s-textil";

const state = vi.hoisted(() => ({
  query: {} as { data?: unknown; isError?: boolean; isLoading?: boolean },
  asked: [] as string[],
  refetched: 0,
}));

vi.mock("@/lib/timplan-planned-pupils-queries", () => ({
  usePlannedClassPupils: (yearId: string | null, groupId: string | null) => {
    state.asked.push(`${yearId}:${groupId}`);
    return {
      data: state.query.data,
      isError: state.query.isError ?? false,
      isLoading: state.query.isLoading ?? false,
      refetch: () => {
        state.refetched += 1;
      },
    };
  },
}));

const figure = (
  key: string,
  subjectIds: string[],
  target: number | null,
  planned: number,
  sources: PlannedPupilFigure["sources"],
  extra: Partial<PlannedPupilFigure> = {},
): PlannedPupilFigure => ({
  key,
  alternativeCode: null,
  subjectIds,
  targetMinutesPerWeek: target,
  plannedMinutesPerWeek: planned,
  deltaMinutesPerWeek: target === null ? null : planned - target,
  status: target === null ? "NO_TARGET" : planned < target ? "UNDER" : "MET",
  sources,
  doublePlannedSubjectIds: [],
  alternativeSubjectIds: [],
  ...extra,
});
const pupil = (pupilId: string, lines: PlannedPupilFigure[]): PlannedClassPupil => ({
  pupilId,
  homeGroupId: CLASS_ID,
  gradeLevel: 8,
  lines,
});

/** Matematik is short in the class (120 of 180) for all three; Ada has Spanska from a group and Textilslöjd from her half. */
const ADA = pupil("p-ada", [
  figure(`subject:${MA}`, [MA], 180, 120, [{ studentGroupId: CLASS_ID, subjectId: MA, minutesPerWeek: 120 }]),
  figure(`alt:M2`, [SPA, TYS], 90, 90, [{ studentGroupId: SPANSKA, subjectId: SPA, minutesPerWeek: 90 }], {
    alternativeCode: "M2",
  }),
  figure(
    "national:SL",
    [SLOJD, TEXTIL],
    120,
    120,
    [
      { studentGroupId: CLASS_ID, subjectId: SLOJD, minutesPerWeek: 60 },
      { studentGroupId: HALF_ID, subjectId: TEXTIL, minutesPerWeek: 60 },
    ],
    { nationalCode: "SL" },
  ),
]);
const BO = pupil("p-bo", [
  figure(`subject:${MA}`, [MA], 180, 120, [{ studentGroupId: CLASS_ID, subjectId: MA, minutesPerWeek: 120 }]),
  figure(`alt:M2`, [SPA, TYS], 90, 0, [], { alternativeCode: "M2" }),
]);
const CIA = pupil("p-cia", [figure(`subject:${MA}`, [MA], 180, 180, [{ studentGroupId: CLASS_ID, subjectId: MA, minutesPerWeek: 180 }])]);
const NOBODY = pupil("p-ingen", []);

const answer = (pupils: PlannedClassPupil[], patch: Partial<PlannedClassPupilsResponse> = {}): PlannedClassPupilsResponse => ({
  academicYearId: "y-1",
  layer: "planned",
  studentGroupId: CLASS_ID,
  gradeLevel: 8,
  pupils,
  ...patch,
});

const classLine = (key: string, status: PlannedLine["status"]) => ({ key, status }) as PlannedLine;
const NAMES: Record<string, string> = { "p-ada": "Ada Öberg", "p-bo": "Bo Andersson", "p-cia": "Cia Berg", "p-ingen": "Dan Dal" };
const SUBJECTS: Record<string, string> = {
  [MA]: "Matematik",
  [SPA]: "Spanska",
  [TYS]: "Tyska",
  [SLOJD]: "Slöjd",
  [TEXTIL]: "Textilslöjd",
};
const GROUPS: Record<string, string> = { [CLASS_ID]: "8A", [HALF_ID]: "8A:1", [SPANSKA]: "Spanska 8", [SVA]: "SvA8" };

const props = (patch: Partial<PlannedClassPupilsProps> = {}): PlannedClassPupilsProps => ({
  yearId: "y-1",
  classId: CLASS_ID,
  classLines: [classLine(`subject:${MA}`, "UNDER"), classLine("alt:M2", "PUPILS"), classLine("national:SL", "MET")],
  people: [
    { id: "p-ada", firstName: "Ada", lastName: "Öberg" },
    { id: "p-bo", firstName: "Bo", lastName: "Andersson" },
    { id: "p-cia", firstName: "Cia", lastName: "Berg" },
    { id: "p-ingen", firstName: "Dan", lastName: "Dal" },
  ],
  pupilName: (id) => NAMES[id] ?? "okänd elev",
  groupName: (id) => GROUPS[id] ?? id,
  groups: [
    { id: CLASS_ID, kind: "CLASS" },
    { id: HALF_ID, kind: "TEACHING_GROUP", halfOfId: CLASS_ID },
    { id: SPANSKA, kind: "TEACHING_GROUP" },
    { id: SVA, kind: "TEACHING_GROUP", replacesSubjectId: "s-sv" },
  ],
  subjectNames: (ids) => ids.map((id) => SUBJECTS[id] ?? id).join(" / "),
  ...patch,
});

const show = (patch: Partial<PlannedClassPupilsProps> = {}) =>
  render(
    <NextIntlClientProvider locale="sv" messages={sv} timeZone="Europe/Stockholm">
      <PlannedClassPupils {...props(patch)} />
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  state.query = { data: answer([ADA, BO, CIA, NOBODY]) };
  state.asked = [];
  state.refetched = 0;
});

describe("PlannedClassPupils", () => {
  it("asks for the opened class of the chosen year, and nothing else", () => {
    show();
    expect(state.asked).toEqual(["y-1:c-8a"]);
  });

  it("lists every pupil by name, surname first in Swedish order, including those short only because the class is", () => {
    show();
    const cards = screen.getAllByRole("listitem").filter((item) => item.querySelector("table, p.font-medium"));
    const names = cards.map((card) => card.querySelector("p.font-medium")?.textContent);
    // Andersson, Berg, Dal, Öberg
    expect(names).toEqual(["Bo Andersson", "Cia Berg", "Dan Dal", "Ada Öberg"]);
  });

  it("marks the lines under target by count, by a minus sign and by words for a screen reader", () => {
    show();
    const bo = screen.getByRole("table", { name: "Planerad tid för Bo Andersson, ämne för ämne" });
    const matte = within(bo).getByRole("row", { name: /Matematik/ });
    expect(within(matte).getAllByRole("cell").map((cell) => cell.textContent)).toEqual([
      "180",
      "120",
      "−60" + "60 min/v under målet",
    ]);
    expect(within(matte).getByText("−60")).toHaveAttribute("aria-hidden", "true");
    expect(within(matte).getByText("60 min/v under målet")).toHaveClass("sr-only");
    expect(screen.getAllByText("2 ämnen under mål")).toHaveLength(1);
    expect(screen.getAllByText("1 ämne under mål")).toHaveLength(1);
    expect(screen.getByText("Inget ämne under mål")).toBeInTheDocument();
  });

  it("says where a line's minutes come from: the class, a half, a teaching group, a replacing group — and names the subject when the line has several", () => {
    show();
    const ada = screen.getByRole("table", { name: "Planerad tid för Ada Öberg, ämne för ämne" });
    // One subject: no subject name in the source, the kind of group in brackets.
    expect(within(ada).getByText("8A (klass) 120 min")).toBeInTheDocument();
    // An alternative: Spanska 8 gives the Spanska, said with its subject.
    expect(within(ada).getByText("Spanska: Spanska 8 (undervisningsgrupp) 90 min")).toBeInTheDocument();
    expect(within(ada).getByText("(tillsammans)")).toBeInTheDocument();
    // The parts of a national subject: the class's Slöjd and the half's Textilslöjd.
    expect(within(ada).getByText("Slöjd: 8A (klass) 60 min")).toBeInTheDocument();
    expect(within(ada).getByText("Textilslöjd: 8A:1 (halvklass) 60 min")).toBeInTheDocument();
    expect(within(ada).getByText("(delar räknas ihop)")).toBeInTheDocument();
    // Every line says it, once: three lines, three "Kommer från".
    expect(within(ada).getAllByText("Kommer från")).toHaveLength(3);
  });

  it("keeps the sources on a row of their own under the line, across the table, so a phone needs no fifth column", () => {
    show();
    const ada = screen.getByRole("table", { name: "Planerad tid för Ada Öberg, ämne för ämne" });
    expect(within(ada).getAllByRole("columnheader")).toHaveLength(4);
    const source = within(ada).getByText("8A (klass) 120 min");
    expect(source.closest("td")).toHaveAttribute("colspan", "4");
  });

  it("names a replacing group, and a group the page does not hold without a kind", () => {
    state.query = {
      data: answer([
        pupil("p-bo", [
          figure(`subject:${MA}`, [MA], 100, 100, [
            { studentGroupId: SVA, subjectId: MA, minutesPerWeek: 60 },
            { studentGroupId: "g-gone", subjectId: MA, minutesPerWeek: 40 },
          ]),
        ]),
      ]),
    };
    show();
    expect(screen.getByText("SvA8 (ersättande grupp) 60 min")).toBeInTheDocument();
    expect(screen.getByText("g-gone 40 min")).toBeInTheDocument();
  });

  it("says plainly when no post reaches the pupil, and tells a short class from a short group", () => {
    show();
    const bo = screen.getByRole("table", { name: "Planerad tid för Bo Andersson, ämne för ämne" });
    expect(within(bo).getByText("Ingen post når eleven")).toBeInTheDocument();
    expect(within(within(bo).getByRole("row", { name: /Spanska \/ Tyska/ })).getByText("−90")).toBeInTheDocument();
    // Matematik is short in the class and said so; the Spanska line is carried by groups (PUPILS) and not.
    expect(within(bo).getAllByText("Klassens egen rad ligger också under mål.")).toHaveLength(1);
  });

  it("reads a line with no target as a line to read, not to judge", () => {
    state.query = {
      data: answer([pupil("p-bo", [figure(`subject:${MA}`, [MA], null, 80, [{ studentGroupId: CLASS_ID, subjectId: MA, minutesPerWeek: 80 }])])]),
    };
    show();
    const row = screen.getByRole("row", { name: /Matematik/ });
    expect(within(row).getByText("inget mål")).toHaveClass("sr-only");
    expect(within(row).getByText("—", { selector: "[aria-hidden]" })).toBeInTheDocument();
    expect(screen.queryByText(/^\d+ ämnen? under mål$/)).not.toBeInTheDocument();
    expect(screen.getByText("Inget ämne under mål")).toBeInTheDocument();
  });

  it("says a pupil with neither targets nor posts has none, and shows no empty table for them", () => {
    show();
    expect(screen.getByText("Eleven har varken mål eller poster i läsåret.")).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: /Dan Dal/ })).not.toBeInTheDocument();
  });

  it("carries a double planning and an alternative to check, as the overview's list does", () => {
    state.query = {
      data: answer([
        pupil("p-bo", [
          figure(`subject:${MA}`, [MA], 180, 240, [], { doublePlannedSubjectIds: [MA] }),
          figure("alt:M2", [SPA, TYS], 90, 90, [], { alternativeCode: "M2", alternativeSubjectIds: [SPA, TYS] }),
        ]),
      ]),
    };
    show();
    expect(screen.getByText("Får Matematik från flera grupper — kontrollera att det är avsett.")).toBeInTheDocument();
    expect(screen.getByText(/^Får tid i flera alternativ \(Spanska \/ Tyska\)/)).toBeInTheDocument();
  });

  it("filters by name, says how many it shows, and says when nobody matches", async () => {
    const user = userEvent.setup();
    show();
    const box = screen.getByRole("searchbox", { name: "Sök elev i klassen" });
    await user.type(box, "berg");
    // Part of a name is enough: Cia Berg, and Ada Öberg, who has the same four letters in hers.
    expect(screen.getByRole("status")).toHaveTextContent("Visar 2 av 4 elever");
    expect(screen.getByText("Cia Berg")).toBeInTheDocument();
    expect(screen.getByText("Ada Öberg")).toBeInTheDocument();
    expect(screen.queryByText("Bo Andersson")).not.toBeInTheDocument();
    await user.clear(box);
    await user.type(box, "zzz");
    expect(screen.getByText("Ingen elev i klassen matchar sökningen.")).toBeInTheDocument();
    await user.clear(box);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByText("Bo Andersson")).toBeInTheDocument();
  });

  it("names no pupil the roster does not hold by an id", () => {
    state.query = { data: answer([pupil("p-ghost", [figure(`subject:${MA}`, [MA], 180, 180, [])])]) };
    const { container } = show();
    expect(screen.getByText("okänd elev")).toBeInTheDocument();
    expect(container).not.toHaveTextContent("p-ghost");
  });

  it("says a class with no pupils has none, with no search box", () => {
    state.query = { data: answer([]) };
    show();
    expect(screen.getByText("Klassen har inga elever i läsåret.")).toBeInTheDocument();
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
  });

  it("holds a busy skeleton while it loads, and also for an answer that is another class's", () => {
    state.query = { data: undefined, isLoading: true };
    const { container, rerender } = show();
    expect(container.querySelector("[aria-busy='true']")).not.toBeNull();
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();

    state.query = { data: answer([BO], { studentGroupId: "c-9b" }) };
    rerender(
      <NextIntlClientProvider locale="sv" messages={sv} timeZone="Europe/Stockholm">
        <PlannedClassPupils {...props()} />
      </NextIntlClientProvider>,
    );
    expect(container.querySelector("[aria-busy='true']")).not.toBeNull();
    expect(screen.queryByText("Bo Andersson")).not.toBeInTheDocument();
  });

  it("says it could not load, leaves the table above alone, and tries again on request", async () => {
    state.query = { data: undefined, isError: true };
    const user = userEvent.setup();
    show();
    expect(screen.getByRole("alert")).toHaveTextContent("Klassens elever kunde inte hämtas");
    expect(screen.getByRole("alert")).toHaveTextContent("Tabellen ovan påverkas inte.");
    await user.click(screen.getByRole("button", { name: "Försök igen" }));
    expect(state.refetched).toBe(1);
  });

  it("keeps the pupils it has when a later read fails", () => {
    state.query = { data: answer([BO]), isError: true };
    show();
    expect(screen.getByText("Bo Andersson")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps its tables' hidden sentences inside their scroll boxes", () => {
    show();
    for (const table of screen.getAllByRole("table")) {
      expect(table.closest(".overflow-auto")).toHaveClass("relative");
    }
  });
});
