import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  coverageCase,
  EMPTY_PLAN,
  LANGUAGES,
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
  CoverageDeliveredTab: (props: { year: { id: string }; linkedGroup: string | null }) => (
    <p>delivered-tab {props.year.id} {props.linkedGroup ?? "none"}</p>
  ),
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
  });

  it("puts the three layers in a tablist above every empty state, so a year without classes still reaches them", async () => {
    state.case = {
      ...state.case,
      response: { ...state.case.response, groups: [], cells: [], pupils: [] },
    };
    const user = userEvent.setup();
    render(<TimplanCoveragePage />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["layerPlanned", "layerScheduled", "layerDelivered"]);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    // The planned layer's own empty state, inside its panel, under the tabs.
    expect(within(screen.getByRole("tabpanel")).getByText("noClassesTitle")).toBeInTheDocument();
    await user.click(tabs[2]!);
    expect(screen.getAllByRole("tab")[2]).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByText("delivered-tab y-1 none")).toBeInTheDocument();
    expect(screen.queryByText("noClassesTitle")).not.toBeInTheDocument();
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
    expect(screen.getAllByRole("tab")[2]).toHaveFocus();
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

  it("ignores a layer it does not know and shows the planned one", () => {
    window.history.replaceState(null, "", "/admin/timplan/tackning?layer=bogus");
    render(<TimplanCoveragePage />);
    expect(screen.getAllByRole("tab")[0]).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("row", { name: /8A/ })).toBeInTheDocument();
  });
});
