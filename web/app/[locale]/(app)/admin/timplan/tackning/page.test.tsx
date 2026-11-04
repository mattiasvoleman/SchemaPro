import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  coverageCase,
  EMPTY_PLAN,
  LANGUAGES,
  NATIONAL_ENTRIES,
  NATIONAL_NO_OWN_ENTRY,
  TWO_ALTERNATIVES,
  UNATTACHED_AND_DRAFT,
} from "@/lib/__fixtures__/timplan-tackning";
import type { TimplanCoverageResponse } from "@/lib/timplan-tackning";
import TimplanCoveragePage from "./page";

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};
globalThis.ResizeObserver ??= class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
};

/**
 * The coverage page over the gateway's own documents (the layer-1 fixture,
 * through lib/__fixtures__/timplan-tackning.ts): what a class row says, that
 * the drill-down names the pupils from the roster and never prints an id, the
 * year notices, the deep link from the Timplansposter pill, and the year
 * picker. The figures themselves are the gateway's and are not recomputed.
 */

const id = (n: number) => `00000000-0000-4000-8000-000000000${n}`;

const state = vi.hoisted(() => ({
  case: null as unknown as { input: { groups: unknown[]; subjects: unknown[] }; response: TimplanCoverageResponse },
  asked: [] as (string | null)[],
  tabFails: false,
  panelFails: false,
}));

vi.mock("@/lib/queries", () => ({
  useAcademicYears: () => ({
    data: [
      { id: "y-0", name: "2025/26", startDate: "2025-08-18", endDate: "2026-06-12", isActive: false },
      { id: "y-1", name: "2026/27", startDate: "2026-08-17", endDate: "2027-06-11", isActive: true },
    ],
    isLoading: false,
    isError: false,
  }),
  useGroups: () => ({
    data: (state.case.input.groups as { id: string; name: string; kind: string; gradeLevel: number | null }[]).map(
      (group) => ({ ...group, academicYearId: "y-1" }),
    ),
    isLoading: false,
    isError: false,
  }),
  useSubjects: () => ({ data: state.case.input.subjects, isLoading: false, isError: false }),
  usePeople: () => ({
    data: [
      { id: id(906), firstName: "Bo", lastName: "Andersson", role: "STUDENT" },
      { id: id(909), firstName: "Ada", lastName: "Öberg", role: "STUDENT" },
    ],
  }),
}));
vi.mock("@/lib/timplan-queries", () => ({
  useLocalTimplans: () => ({ data: [{ id: id(201), name: "Grundskolan 2024", status: "DECIDED" }] }),
}));
vi.mock("@/lib/timplan-tackning-queries", () => ({
  useTimplanCoverage: (yearId: string | null) => {
    state.asked.push(yearId);
    return {
      data: yearId === null ? undefined : { ...state.case.response, academicYearId: yearId },
      isLoading: false,
      isError: false,
    };
  },
}));
// The P3 tabs are their own files with their own tests
// (components/timplan/coverage-tabs.test.tsx); here only what the page hands them.
vi.mock("@/components/timplan/coverage-scheduled-tab", () => ({
  CoverageScheduledTab: (props: { year: { id: string }; linkedGroup: string | null }) => (
    <p>scheduled-tab {props.year.id} {props.linkedGroup ?? "none"}</p>
  ),
}));
vi.mock("@/components/timplan/coverage-delivered-tab", () => ({
  CoverageDeliveredTab: (props: { year: { id: string }; linkedGroup: string | null; historyRosters?: boolean }) => {
    // Stands in for a chunk that did not arrive: what the boundary catches.
    if (state.tabFails) throw new Error("Loading chunk failed");
    return (
      <p>delivered-tab {props.year.id} {props.linkedGroup ?? "none"} {props.historyRosters ? "history" : "today"}</p>
    );
  },
}));
// The P4 tab likewise (components/timplan/coverage-stage-tab.test.tsx).
vi.mock("@/components/timplan/coverage-stage-tab", () => ({
  CoverageStageTab: (props: { year: { id: string }; linkedGroup: string | null }) => (
    <p>stage-tab {props.year.id} {props.linkedGroup ?? "none"}</p>
  ),
}));
// "Visa alla elever" is its own file with its own test
// (components/timplan/coverage-planned-pupils.test.tsx); here only what the
// page hands it and what it does when the chunk does not arrive.
vi.mock("@/components/timplan/coverage-planned-pupils", () => ({
  PlannedClassPupils: (props: { yearId: string; classId: string; classLines: unknown[]; groups: unknown[]; people: unknown[] }) => {
    if (state.panelFails) throw new Error("Loading chunk failed");
    return (
      <p>
        planned-pupils {props.yearId} {props.classId} lines:{props.classLines.length} groups:{props.groups.length} people:{props.people.length}
      </p>
    );
  },
}));
vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}(${Object.values(values).join("|")})` : key,
}));

beforeEach(() => {
  state.case = coverageCase(LANGUAGES) as typeof state.case;
  state.asked = [];
});
afterEach(() => {
  window.history.replaceState(null, "", "/");
});

describe("TimplanCoveragePage", () => {
  it("shows each class's cells as planerat / mål, the språkval carried by its groups said in words", () => {
    render(<TimplanCoveragePage />);
    const row = screen.getByRole("row", { name: /8A/ });
    expect(within(row).getByText("180 / 180")).toBeInTheDocument();
    // M2 is planned in språkval groups: neutral, 'i grupp', and the sentence says why.
    expect(within(row).getAllByText("tagPupils").length).toBeGreaterThan(0);
    expect(within(row).getAllByText(/^cell\.pupils\(Spanska/).length).toBe(1);
    // Five of six lines reach every pupil: the M2 line has one pupil short.
    // Review reproduction (P2 review, lens webb): the sentence sat in an
    // aria-label on a role-less <span>, which screen readers do not read;
    // it is text now, and the visible "5/6" is hidden from them.
    expect(within(row).getByText("coverageLabel(5|6)")).toHaveClass("sr-only");
    expect(within(row).getByText("5/6")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("pupilsBelow(5|1)")).toBeInTheDocument();
  });

  it("tags the parts of a national subject and says in the drill-down that they count together", async () => {
    // Slöjd, Textilslöjd and Trä- och metallslöjd are one line per class in åk 5;
    // 5A plans textil alone and meets the 60 the three entries make.
    state.case = coverageCase(NATIONAL_ENTRIES) as typeof state.case;
    const user = userEvent.setup();
    render(<TimplanCoveragePage />);
    const row = screen.getByRole("row", { name: /5A/ });
    expect(within(row).getByText("60 / 20")).toBeInTheDocument();
    // Met with the cell's own 0 of 20: said in a word, not as a deficit it is not.
    expect(within(row).getAllByText("tagParts")).toHaveLength(3);
    // 5C is short on the line: the cells show the line's difference instead.
    expect(within(screen.getByRole("row", { name: /5C/ })).queryByText("tagParts")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /5A/ }));
    const section = screen.getByRole("region", { name: "5A" });
    const line = within(section).getByRole("row", { name: /Textilslöjd/ });
    expect(within(line).getByText("partsTogether")).toBeInTheDocument();
    // An alternative's "together" is not said of parts: they add up, not stand in for one another.
    expect(within(line).queryByText("together")).not.toBeInTheDocument();
  });

  it("reads a part the plan has no entry for by its line, not as '50 of 0 minutes'", () => {
    // 7A keeps trä- och metallslöjd 2 × 25 and the plan's 65 is on Slöjd: the
    // cell shows "50 / —", and what a screen reader gets is the line's 50 of 65.
    state.case = coverageCase(NATIONAL_NO_OWN_ENTRY) as typeof state.case;
    render(<TimplanCoveragePage />);
    const row = screen.getByRole("row", { name: /7A/ });
    expect(within(row).getByText("50 / —")).toBeInTheDocument();
    expect(within(row).getByText(/^cell\.pupils\(Trä- och metallslöjd\|50\|65\|15\|/)).toBeInTheDocument();
    expect(within(row).queryByText(/^cell\.pupils\(Trä- och metallslöjd\|50\|0\|/)).not.toBeInTheDocument();
  });

  it("says a class attached to a plan with no time for its årskurs has none, rather than 0/0", () => {
    state.case = coverageCase(EMPTY_PLAN) as typeof state.case;
    render(<TimplanCoveragePage />);
    expect(screen.getByText("emptyPlan(Högstadiet 2024|grade(3))")).toBeInTheDocument();
    const row = screen.getByRole("row", { name: /3A/ });
    expect(within(row).getByText("emptyPlanShort")).toBeInTheDocument();
    expect(within(row).queryByText("0/0")).not.toBeInTheDocument();
    // Åk 11 has nothing to attach: no notice asks for it.
    expect(screen.queryByText(/^unattached/)).not.toBeInTheDocument();
  });

  it("says a pupil on two språkval rosters gets time in several alternatives", async () => {
    state.case = coverageCase(TWO_ALTERNATIVES) as typeof state.case;
    const user = userEvent.setup();
    render(<TimplanCoveragePage />);
    await user.click(screen.getByRole("button", { name: /8B/ }));
    const section = screen.getByRole("region", { name: "8B" });
    expect(within(section).getByText("pupilAlternatives(Spanska / Tyska)")).toBeInTheDocument();
    expect(within(section).queryByText(/^pupilDouble/)).not.toBeInTheDocument();
  });

  it("opens a class's drill-down: per line min / median / max, and its own pupils by name", async () => {
    const user = userEvent.setup();
    render(<TimplanCoveragePage />);
    expect(screen.getByText("chooseClass")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /8A/ }));
    const section = screen.getByRole("region", { name: "8A" });
    expect(within(section).getByRole("row", { name: /Matematik/ })).toHaveTextContent("stats(180|180|240)");
    expect(within(section).getByRole("row", { name: /Spanska \/ Tyska/ })).toHaveTextContent("below(1|5)");
    expect(within(section).getByRole("row", { name: /Spanska \/ Tyska/ })).toHaveTextContent("Spanska 8");

    // Three pupils have a finding of their own; one is not in the roster.
    expect(within(section).getByText("pupilsTitle(3)")).toBeInTheDocument();
    expect(within(section).getByText("Bo Andersson")).toBeInTheDocument();
    expect(within(section).getByText("Ada Öberg")).toBeInTheDocument();
    expect(within(section).getByText("unknownPupil")).toBeInTheDocument();
    expect(section).not.toHaveTextContent(id(908));
    expect(within(section).getByText("pupilDouble(Matematik)")).toBeInTheDocument();
    expect(within(section).getByText(/^pupilUnder\(Spanska \/ Tyska\|0\|90\|90\)/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /8A/ }));
    expect(screen.queryByRole("region", { name: "8A" })).not.toBeInTheDocument();
  });

  it("keeps the pupils with a finding of their own as the list, and offers every pupil of the class on request", async () => {
    const user = userEvent.setup();
    render(<TimplanCoveragePage />);
    await user.click(screen.getByRole("button", { name: /8A/ }));
    const section = screen.getByRole("region", { name: "8A" });
    const toggle = within(section).getByRole("button", { name: "showAllPupils" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(within(section).getByText("pupilsTitle(3)")).toBeInTheDocument();
    expect(within(section).queryByText(/^planned-pupils/)).not.toBeInTheDocument();

    await user.click(toggle);
    // The panel gets the year and the class, the class's lines, the school's groups and the roster.
    expect(await within(section).findByText(`planned-pupils y-1 ${id(303)} lines:6 groups:6 people:2`)).toBeInTheDocument();
    expect(within(section).getByText("plannedPupils.title(5)")).toBeInTheDocument();
    expect(within(section).queryByText("pupilsTitle(3)")).not.toBeInTheDocument();
    expect(within(section).queryByText("Bo Andersson")).not.toBeInTheDocument();
    const back = within(section).getByRole("button", { name: "showOwnPupils" });
    expect(back).toHaveAttribute("aria-pressed", "true");

    await user.click(back);
    expect(within(section).getByText("pupilsTitle(3)")).toBeInTheDocument();
    expect(within(section).queryByText(/^planned-pupils/)).not.toBeInTheDocument();
  });

  it("starts the next class on its own pupils with a finding, whatever the last one showed", async () => {
    state.case = coverageCase(NATIONAL_ENTRIES) as typeof state.case;
    const user = userEvent.setup();
    render(<TimplanCoveragePage />);
    await user.click(screen.getByRole("button", { name: /5A/ }));
    await user.click(within(screen.getByRole("region", { name: "5A" })).getByRole("button", { name: "showAllPupils" }));
    expect(await screen.findByText(/^planned-pupils y-1/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /5B/ }));
    const section = screen.getByRole("region", { name: "5B" });
    expect(within(section).getByRole("button", { name: "showAllPupils" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByText(/^planned-pupils/)).not.toBeInTheDocument();
  });

  it("says the pupils' panel could not load when its chunk fails, keeps the class, and fetches afresh on retry", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    state.panelFails = true;
    try {
      const user = userEvent.setup();
      render(<TimplanCoveragePage />);
      await user.click(screen.getByRole("button", { name: /8A/ }));
      const section = screen.getByRole("region", { name: "8A" });
      await user.click(within(section).getByRole("button", { name: "showAllPupils" }));
      expect(await within(section).findByText("plannedPupils.loadFailed")).toBeInTheDocument();
      // The class table is still there, and the way back to the default list.
      expect(within(section).getByRole("row", { name: /Matematik/ })).toBeInTheDocument();
      state.panelFails = false;
      await user.click(within(section).getByRole("button", { name: "plannedPupils.retry" }));
      expect(await within(section).findByText(/^planned-pupils y-1/)).toBeInTheDocument();
      expect(within(section).queryByText("plannedPupils.loadFailed")).not.toBeInTheDocument();
    } finally {
      state.panelFails = false;
      quiet.mockRestore();
    }
  });

  it("keeps the tables' sr-only sentences inside their scroll boxes, so a phone scrolls the matrix and not the page", async () => {
    // An sr-only sentence is position: absolute. With no positioned ancestor
    // inside the scroll box (TableScroll) it is laid out against the page, and the
    // columns past a 390 px screen widened /admin/timplan/tackning to 624 px.
    const user = userEvent.setup();
    render(<TimplanCoveragePage />);
    await user.click(screen.getByRole("button", { name: /8A/ }));
    const tables = screen.getAllByRole("table");
    expect(tables.length).toBeGreaterThan(1);
    for (const table of tables) expect(table.closest(".overflow-auto, .overflow-x-auto")).toHaveClass("relative");
  });

  it("opens the year and class the Timplansposter pill links to", () => {
    window.history.replaceState(null, "", `/admin/timplan/tackning?year=y-0&group=${id(303)}`);
    render(<TimplanCoveragePage />);
    expect(state.asked).toContain("y-0");
    expect(screen.getByRole("region", { name: "8A" })).toBeInTheDocument();
  });

  it("states the årskurser without a plan and the draft a grade follows", () => {
    state.case = coverageCase(UNATTACHED_AND_DRAFT) as typeof state.case;
    render(<TimplanCoveragePage />);
    expect(screen.getByText("unattached(grade(6))")).toBeInTheDocument();
    expect(screen.getByText("draft(Grundskolan 2027 (utkast)|grade(9))")).toBeInTheDocument();
    const sixA = screen.getByRole("row", { name: /6A/ });
    expect(within(sixA).getByText("noPlan")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /9A/ })).toHaveTextContent("draftShort");
  });

  it("says there is no target to compare with when the year follows no plan in any årskurs", () => {
    // Seen 2026-10-07: "80 elever i läsårets klasser; ingen är under mål" for
    // a year attached to no plan — true, and read as all is well.
    const response = state.case.response;
    state.case = {
      ...state.case,
      response: {
        ...response,
        groups: response.groups.map((group) => ({
          ...group,
          localTimplanId: null,
          planStatus: null,
          linesWithTarget: 0,
          linesCovered: 0,
        })),
        pupilsBelowTarget: 0,
      },
    };
    render(<TimplanCoveragePage />);
    expect(screen.getByText("pupilsNoTarget(5)")).toBeInTheDocument();
    expect(screen.queryByText(/^pupilsBelow/)).not.toBeInTheDocument();
  });

  it("asks for the year chosen in the picker", async () => {
    const user = userEvent.setup();
    render(<TimplanCoveragePage />);
    expect(state.asked.at(-1)).toBe("y-1");
    await user.click(screen.getByRole("combobox", { name: "yearLabel" }));
    await user.click(await screen.findByRole("option", { name: "2025/26" }));
    expect(state.asked.at(-1)).toBe("y-0");
  });

  it("shows no pupil columns or list for a group-level document", async () => {
    const user = userEvent.setup();
    state.case = {
      ...state.case,
      response: { ...state.case.response, pupilLevel: false, pupils: null, pupilsBelowTarget: null },
    };
    render(<TimplanCoveragePage />);
    expect(screen.getByText("pupilsTotal(5)")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /8A/ }));
    expect(screen.queryByText("linePupils")).not.toBeInTheDocument();
    expect(screen.queryByText(/^pupilsTitle/)).not.toBeInTheDocument();
    // A teacher's document has no pupil to show: no way to ask for every one.
    expect(screen.queryByRole("button", { name: "showAllPupils" })).not.toBeInTheDocument();
  });

  it("puts the four layers in a tablist above every empty state, so a year without classes still reaches them", async () => {
    state.case = {
      ...state.case,
      response: { ...state.case.response, groups: [], cells: [], pupils: [] },
    };
    const user = userEvent.setup();
    render(<TimplanCoveragePage />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["layerPlanned", "layerScheduled", "layerDelivered", "layerStage"]);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    // The planned layer's own empty state, inside its panel, under the tabs.
    expect(within(screen.getByRole("tabpanel")).getByText("noClassesTitle")).toBeInTheDocument();
    await user.click(tabs[2]!);
    expect(screen.getAllByRole("tab")[2]).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByText("delivered-tab y-1 none today")).toBeInTheDocument();
    expect(screen.queryByText("noClassesTitle")).not.toBeInTheDocument();
    await user.click(screen.getAllByRole("tab")[3]!);
    expect(await screen.findByText("stage-tab y-1 none")).toBeInTheDocument();
  });

  it("moves between tabs with the arrow keys, Home and End, focus following", async () => {
    const user = userEvent.setup();
    render(<TimplanCoveragePage />);
    screen.getAllByRole("tab")[0]!.focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getAllByRole("tab")[1]).toHaveFocus();
    expect(screen.getAllByRole("tab")[1]).toHaveAttribute("aria-selected", "true");
    expect(screen.getAllByRole("tab")[0]).toHaveAttribute("tabindex", "-1");
    expect(await screen.findByText("scheduled-tab y-1 none")).toBeInTheDocument();
    await user.keyboard("{End}");
    expect(screen.getAllByRole("tab")[3]).toHaveFocus();
    expect(await screen.findByText("stage-tab y-1 none")).toBeInTheDocument();
    await user.keyboard("{ArrowRight}");
    expect(screen.getAllByRole("tab")[0]).toHaveFocus();
    await user.keyboard("{ArrowLeft}{Home}");
    expect(screen.getAllByRole("tab")[0]).toHaveAttribute("aria-selected", "true");
  });

  it("opens the tab, year and group the Lektionstid panel links to, and asks layer 1 for nothing", async () => {
    window.history.replaceState(null, "", `/admin/timplan/tackning?year=y-0&layer=scheduled&group=${id(303)}`);
    render(<TimplanCoveragePage />);
    expect(await screen.findByText(`scheduled-tab y-0 ${id(303)}`)).toBeInTheDocument();
    expect(screen.getAllByRole("tab")[1]).toHaveAttribute("aria-selected", "true");
    expect(state.asked.filter((yearId) => yearId !== null)).toEqual([]);
  });

  it("says a tab whose chunk failed in its panel, keeps the page, and fetches afresh when a tab is chosen again", async () => {
    window.history.replaceState(null, "", "/admin/timplan/tackning?layer=delivered");
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    state.tabFails = true;
    try {
      const user = userEvent.setup();
      render(<TimplanCoveragePage />);
      expect(await screen.findByText("loadFailed")).toBeInTheDocument();
      // The page is still there: its tablist, and the other tabs reachable.
      expect(screen.getAllByRole("tab")).toHaveLength(4);
      state.tabFails = false;
      await user.click(screen.getAllByRole("tab")[2]!);
      expect(await screen.findByText(/^delivered-tab y-1/)).toBeInTheDocument();
    } finally {
      state.tabFails = false;
      quiet.mockRestore();
    }
  });

  it("tells the delivered tab a past year is read from the class history, and the active one by today's rosters", async () => {
    window.history.replaceState(null, "", "/admin/timplan/tackning?year=y-0&layer=delivered");
    render(<TimplanCoveragePage />);
    expect(await screen.findByText("delivered-tab y-0 none history")).toBeInTheDocument();
  });

  it("opens the Stadium tab from a deep link", async () => {
    window.history.replaceState(null, "", `/admin/timplan/tackning?layer=stage&group=${id(303)}`);
    render(<TimplanCoveragePage />);
    expect(await screen.findByText(`stage-tab y-1 ${id(303)}`)).toBeInTheDocument();
    expect(screen.getAllByRole("tab")[3]).toHaveAttribute("aria-selected", "true");
  });

  it("ignores a layer it does not know and shows the planned one", () => {
    window.history.replaceState(null, "", "/admin/timplan/tackning?layer=bogus");
    render(<TimplanCoveragePage />);
    expect(screen.getAllByRole("tab")[0]).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("row", { name: /8A/ })).toBeInTheDocument();
  });
});
