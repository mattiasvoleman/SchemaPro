import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import fixture from "../../../src/common/__fixtures__/timplan-stage-cases.json";
import type { StageCoverage, StageInput, ClassStageSummary } from "@/lib/timplan-stage";
import type { CohortNoticeRow } from "@/lib/timplan-cohorts";
import type { StagePublicationSummary, TimplanStageResponse } from "@/lib/timplan-stage-view";
import { CoverageStageTab } from "./coverage-stage-tab";

/**
 * Täckning's Stadium tab over the gateway's own figures: cases 22 and 23 of
 * src/common/__fixtures__/timplan-stage-cases.json, one class (6A) whose
 * pupils sit on both sides of the one-hour line and of the 995 ‰ line. The
 * figures are the gateway's; what is under test is what the tab says, which
 * pupils it lists, what it asks for and what it publishes.
 */

interface FixtureCase {
  name: string;
  input: StageInput;
  coverage: StageCoverage;
  classes: ClassStageSummary[];
}
interface CohortCase {
  notice: CohortNoticeRow[];
}
const { cases, cohortCases } = fixture as unknown as { cases: FixtureCase[]; cohortCases: CohortCase[] };
const byName = (prefix: string) => cases.find((entry) => entry.name.startsWith(prefix))!;

const CLASS_6A = "00000000-0000-4000-8000-0000000c06a0";
const pupil = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** Cases 22 and 23 as one school: the overview, and the drill-down into 6A. */
function responses(): { overview: TimplanStageResponse; drill: TimplanStageResponse } {
  const pupils = [...byName("22.").coverage.pupils, ...byName("23.").coverage.pupils];
  const counts = new Map<string, { code: never; severity: never; pupils: Set<string> }>();
  for (const entry of pupils) {
    for (const verdict of entry.verdicts) {
      const key = `${verdict.code}:${verdict.severity}`;
      const found = counts.get(key) ?? { code: verdict.code as never, severity: verdict.severity as never, pupils: new Set() };
      found.pupils.add(entry.pupilId);
      counts.set(key, found);
    }
  }
  const base: TimplanStageResponse = {
    academicYearId: "y-1",
    asOfDate: "2026-10-10",
    isActiveYear: true,
    classes: [],
    pupils: null,
    verdictCounts: [...counts.values()].map((entry) => ({ code: entry.code, severity: entry.severity, pupils: entry.pupils.size })),
    cohorts: cohortCases[0]!.notice,
    publication: null,
  };
  // The overview as the gateway sent it for case 22 alone — read a moment
  // before the drill-down, which holds case 23's two pupils too: the panel
  // must paint 6A from the pupils it holds, not from this row.
  const classes = byName("22.").classes;
  return {
    overview: { ...base, classes },
    drill: {
      ...base,
      classes,
      pupils: pupils.map((entry) => ({
        ...entry,
        verdicts: entry.verdicts.map((verdict) => ({ ...verdict, message: `sv:${verdict.code}` })),
      })),
    },
  };
}

const state = vi.hoisted(() => ({
  stages: {} as Record<string, unknown>,
  asked: [] as string[],
  published: 0,
  withdrawn: 0,
}));

vi.mock("@/lib/timplan-stage-queries", () => ({
  useTimplanStages: (yearId: string | null, groupId: string | null = null) => {
    state.asked.push(`stage:${yearId}:${groupId ?? ""}`);
    return { data: yearId === null ? undefined : state.stages[groupId ?? ""], isLoading: false, isError: false };
  },
  useTimplanStatementActions: () => ({
    publish: {
      isPending: false,
      mutate: (_: unknown, options: { onSuccess?: (result: { pupils: number }) => void }) => {
        state.published += 1;
        options.onSuccess?.({ pupils: 5 });
      },
    },
    withdraw: {
      isPending: false,
      mutate: (_: unknown, options: { onSuccess?: () => void }) => {
        state.withdrawn += 1;
        options.onSuccess?.();
      },
    },
  }),
}));
vi.mock("@/lib/queries", () => ({
  useNationalTimplans: () => ({
    data: {
      versions: [],
      subjects: [
        { code: "MA", name: "Matematik", parentCode: null, isGroup: false },
        { code: "HKK", name: "Hem- och konsumentkunskap", parentCode: null, isGroup: false },
      ],
    },
  }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) =>
    values ? `${namespace}.${key}(${Object.values(values).join("|")})` : `${namespace}.${key}`,
}));

const names = new Map([
  [pupil(221), "Ada Alm"],
  [pupil(222), "Bo Berg"],
  [pupil(223), "Cy Ceder"],
  [pupil(231), "Dan Dal"],
  [pupil(232), "Eva Ek"],
]);
const props = (linkedGroup: string | null = null) => ({
  year: { id: "y-1", name: "2026/27" },
  linkedGroup,
  groupName: (id: string) => (id === CLASS_6A ? "6A" : id),
  subjects: [],
  pupilName: (id: string) => names.get(id) ?? "okänd",
  gradeName: (grade: number | null) => `åk ${grade}`,
});

beforeEach(() => {
  state.stages = {};
  state.asked = [];
  state.published = 0;
  state.withdrawn = 0;
});

describe("CoverageStageTab", () => {
  it("leads with what the figures are and what to expect, then one table per stage, and names no pupil", () => {
    state.stages[""] = responses().overview;
    render(<CoverageStageTab {...props()} />);
    expect(screen.getByText(/timplanCoverage\.stage\.asOf\(.*\|2026\/27\)/)).toBeInTheDocument();
    expect(screen.getByText("timplanCoverage.stage.definition")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("timplanCoverage.stage.expectation");
    const mellan = screen.getByRole("region", { name: "timplanCoverage.stage.stageTitle(MELLAN)" });
    const row = within(mellan).getByRole("row", { name: /^6A/ });
    // 409 h median against 410 h; two of the three pupils are a finding.
    expect(within(row).getByText("409 h / 410 h")).toBeInTheDocument();
    expect(within(row).getByText("timplanCoverage.stage.belowShort(2)")).toBeInTheDocument();
    expect(within(row).getByText("SFS 2023:945 B1")).toBeInTheDocument();
    // HKK's merged cell is its own table, not a column of mellanstadiet's.
    expect(screen.getByRole("region", { name: "timplanCoverage.stage.stageTitle(LAG_MELLAN)" })).toBeInTheDocument();
    expect(screen.queryByText("Bo Berg")).not.toBeInTheDocument();
    expect(state.asked).toEqual(["stage:y-1:"]);
  });

  it("sets only compared pupils' figures beside the national hours, and says 'ej jämförd' when no pupil is", () => {
    // Case 14: 6A's mellanstadium, one pupil complete (413 h projected
    // matematik), one not. Case 5: 7A's högstadium, nobody complete.
    const complete = byName("14.").coverage.pupils.find((entry) => entry.stages.some((stage) => stage.stage === "MELLAN" && stage.complete))!;
    const ma = complete.stages.find((stage) => stage.stage === "MELLAN")!.cells.find((cell) => cell.code === "MA")!;
    state.stages[""] = { ...responses().overview, classes: [...byName("14.").classes, ...byName("5.").classes] };
    render(<CoverageStageTab {...props()} />);
    const mellan = screen.getByRole("region", { name: "timplanCoverage.stage.stageTitle(MELLAN)" });
    const row6a = within(mellan).getByRole("row", { name: /^6A/ });
    expect(within(row6a).getByText(`${String(ma.projectedHours).replace(".", ",")} h / 410 h`)).toBeInTheDocument();
    const hog = screen.getByRole("region", { name: "timplanCoverage.stage.stageTitle(HOG)" });
    expect(within(hog).queryByText(/\/ 400 h/)).not.toBeInTheDocument();
    expect(within(hog).getAllByText("timplanCoverage.stage.notCompared").length).toBeGreaterThan(0);
  });

  it("counts pupils per finding, the within-cap notices apart from the warnings", () => {
    state.stages[""] = responses().overview;
    render(<CoverageStageTab {...props()} />);
    const counts = screen.getByRole("region", { name: "timplanCoverage.stage.countsLabel" });
    expect(counts).toHaveTextContent(
      "timplanCoverage.stage.countLine(timplanCoverage.stage.label.TIMPLAN_PUPIL_STAGE_BELOW_NATIONAL|no|2)",
    );
    expect(counts).toHaveTextContent(
      "timplanCoverage.stage.countLine(timplanCoverage.stage.label.TIMPLAN_PUPIL_STAGE_PARTLY_UNRECORDED|no|1)",
    );
  });

  it("drills into a class with its own request, paints it from its pupils, and lists those with a warning", async () => {
    const { overview, drill } = responses();
    state.stages[""] = overview;
    state.stages[CLASS_6A] = drill;
    const user = userEvent.setup();
    render(<CoverageStageTab {...props()} />);
    await user.click(within(screen.getByRole("region", { name: /stageTitle\(MELLAN\)/ })).getByRole("button", { name: /^6A/ }));
    expect(state.asked).toContain(`stage:y-1:${CLASS_6A}`);
    const section = screen.getByRole("region", { name: "6A" });
    // The class row from its own pupils: five pupils in mellanstadiet, two
    // below on both planned and projection, one not compared (994 ‰).
    const maths = within(section).getAllByRole("row", { name: /^Matematik/ })[0]!;
    expect(maths).toHaveTextContent("410 h");
    expect(maths).toHaveTextContent("2 / 2");
    expect(within(section).getByText(/recordedPupils\(4\|5\)/)).toBeInTheDocument();
    // Bo and Cy have warnings; Ada is 59 minutes short — arithmetic, not a finding.
    expect(within(section).getByText("Bo Berg")).toBeInTheDocument();
    expect(within(section).getByText("Cy Ceder")).toBeInTheDocument();
    expect(within(section).queryByText("Ada Alm")).not.toBeInTheDocument();
    // Cy's shortfall in the reader's language, rounded up, against the reference data.
    expect(
      within(section).getAllByText(
        "timplanCoverage.stage.verdict.below(Matematik|timplanCoverage.stage.stageName(MELLAN)|409 h|1,1 h|410 h|SFS 2023:945 B1|no|20)",
      ),
    ).toHaveLength(1);
    await user.click(within(section).getByRole("button", { name: "timplanCoverage.showAllPupils" }));
    expect(within(section).getByText("Ada Alm")).toBeInTheDocument();
    // Eva's mellanstadium is 994 ‰ recorded: the notice names the grade.
    const eva = within(section).getByText("Eva Ek").closest("li")!;
    expect(eva).toHaveTextContent("timplanCoverage.stage.verdict.partPartly(5)");
    expect(eva).toHaveTextContent("timplanCoverage.stage.status.UNRECORDED");
  });

  it("publishes the families' card for the active year, and withdraws it", async () => {
    const { overview } = responses();
    state.stages[""] = overview;
    const user = userEvent.setup();
    const { rerender } = render(<CoverageStageTab {...props()} />);
    expect(screen.getByText("timplanCoverage.stage.publicationNone")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "timplanCoverage.stage.withdraw" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "timplanCoverage.stage.publish" }));
    expect(state.published).toBe(1);

    // Published at 00:30 Swedish time on 10 October: the instant is 9 October
    // in UTC, the school's day is the 10th — and the panel says the 10th.
    const publication: StagePublicationSummary = {
      academicYearId: "y-1",
      publishedAt: "2026-10-09T22:30:00.000Z",
      publishedByUserId: "admin",
      asOfDate: "2026-10-10",
      pupils: 5,
    };
    state.stages[""] = { ...overview, publication };
    rerender(<CoverageStageTab {...props()} />);
    expect(screen.getByText("timplanCoverage.stage.publicationCurrent(10 oktober 2026|5|10 oktober 2026)")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "timplanCoverage.stage.republish" }));
    await user.click(screen.getByRole("button", { name: "timplanCoverage.stage.withdraw" }));
    expect(state.published).toBe(2);
    expect(state.withdrawn).toBe(1);
  });

  it("answers a year that is not the active one with no figures, and offers no publish for it", () => {
    state.stages[""] = {
      ...responses().overview,
      isActiveYear: false,
      classes: [],
      verdictCounts: [],
      cohorts: [],
      publication: { academicYearId: "y-0", publishedAt: "2026-06-01T08:00:00.000Z", publishedByUserId: null, asOfDate: "2026-06-01", pupils: 3 },
    };
    render(<CoverageStageTab {...props()} />);
    expect(screen.getByText("timplanCoverage.stage.notActiveTitle")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /stage\.publish|stage\.republish/ })).not.toBeInTheDocument();
    // A statement for another year shows no card; the admin may still withdraw it.
    expect(screen.getByText(/timplanCoverage\.stage\.publicationOtherYear/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "timplanCoverage.stage.withdraw" })).toBeInTheDocument();
  });

  it("shows Timplaner per årskull from the gateway's rows, the reformed cohort among them", () => {
    state.stages[""] = responses().overview;
    render(<CoverageStageTab {...props()} />);
    expect(screen.getByText("timplanCohorts.title")).toBeInTheDocument();
    expect(screen.getByText("timplanCohorts.cohort(REFORMED_2028|2028)")).toBeInTheDocument();
    expect(screen.getByText("timplanCohorts.sources")).toBeInTheDocument();
  });
});
