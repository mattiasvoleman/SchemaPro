import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import fixture from "../../../src/common/__fixtures__/timplan-scheduled-cases.json";
import {
  asTeacher,
  DELIVERED_DRILL_7A,
  DELIVERED_IDS,
  DELIVERED_OVERVIEW,
  DELIVERED_UNPUBLISHED,
} from "@/lib/__fixtures__/timplan-delivered";
import type { DeliveredCoverageResponse } from "@/lib/timplan-delivered";
import type { ScheduledCoverage, ScheduledCoverageInput } from "@/lib/timplan-scheduled";
import type { ScheduledCoverageResponse } from "@/lib/timplan-scheduled-queries";
import { CoverageDeliveredTab } from "./coverage-delivered-tab";
import { CoverageScheduledTab } from "./coverage-scheduled-tab";

/**
 * Täckning's two P3 tabs over gateway documents: layer 2 from the gateway's
 * own fixture (src/common/__fixtures__/timplan-scheduled-cases.json), layer 3
 * from the spec's worked example (lib/__fixtures__/timplan-delivered.ts).
 * The figures are the gateway's and are not recomputed; what is under test is
 * what the tabs say, to whom, and what they ask for.
 */

interface FixtureCase {
  name: string;
  input: ScheduledCoverageInput;
  coverage: ScheduledCoverage;
}
const { cases } = fixture as unknown as { cases: FixtureCase[] };
const scheduledCase = (prefix: string): { input: ScheduledCoverageInput; response: ScheduledCoverageResponse } => {
  const found = cases.find((entry) => entry.name.startsWith(prefix))!;
  return {
    input: found.input,
    response: {
      ...found.coverage,
      academicYearId: "y-1",
      layer: "scheduled",
      verdicts: found.coverage.verdicts.map((verdict) => ({ ...verdict, message: verdict.code })),
    },
  };
};
const TWO_GROUPS = "a lesson reaching a pupil through two groups";
const TEACHER = "the same year read by a teacher";
const DRILLED = "the same year drilled into 7A";
const NO_MASTER = "posts and no grundschema at all";

const state = vi.hoisted(() => ({
  scheduled: {} as Record<string, unknown>,
  delivered: {} as Record<string, unknown>,
  asked: [] as string[],
}));

vi.mock("@/lib/timplan-scheduled-queries", () => ({
  useScheduledCoverage: (yearId: string | null, groupId: string | null = null) => {
    state.asked.push(`scheduled:${yearId}:${groupId ?? ""}`);
    return { data: yearId === null ? undefined : state.scheduled[groupId ?? ""], isLoading: false, isError: false };
  },
}));
vi.mock("@/lib/timplan-delivered-queries", () => ({
  useDeliveredCoverage: (yearId: string | null, groupId: string | null = null) => {
    state.asked.push(`delivered:${yearId}:${groupId ?? ""}`);
    return { data: yearId === null ? undefined : state.delivered[groupId ?? ""], isLoading: false, isError: false };
  },
}));
vi.mock("@/lib/queries", () => ({
  useMasterLessons: () => ({
    data: [
      { id: "00000000-0000-4000-8000-000000000168", dayOfWeek: 1, startTime: "08:00:00", endTime: "09:00:00", recurrence: "ALL_WEEKS", isParked: false },
      { id: "00000000-0000-4000-8000-000000000169", dayOfWeek: 3, startTime: "10:00:00", endTime: "11:00:00", recurrence: "ODD_WEEKS", isParked: false },
    ],
  }),
}));
vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) =>
    values ? `${namespace}.${key}(${Object.values(values).join("|")})` : `${namespace}.${key}`,
}));

const groupNames = new Map<string, string>([
  ["00000000-0000-4000-8000-000000000157", "7A"],
  ["00000000-0000-4000-8000-000000000158", "Ma7-fördjupning"],
  ["00000000-0000-4000-8000-000000000159", "Spanska 7"],
  [DELIVERED_IDS.class7A, "7A"],
  [DELIVERED_IDS.fordjupning, "Ma7-fördjupning"],
]);
const pupilNames = new Map<string, string>([
  ["00000000-0000-4000-8000-000000000160", "Bea Berg"],
  ["00000000-0000-4000-8000-000000000164", "Eli Ek"],
  [DELIVERED_IDS.bea, "Bea Berg"],
  [DELIVERED_IDS.ali, "Ali Al"],
]);

const props = (subjects: { id: string; name: string }[], linkedGroup: string | null = null) => ({
  year: { id: "y-1", name: "2026/27" },
  linkedGroup,
  groupName: (id: string) => groupNames.get(id) ?? id,
  subjects,
  pupilName: (id: string) => pupilNames.get(id) ?? "okänd",
  gradeName: (grade: number | null) => `åk ${grade}`,
});

beforeEach(() => {
  state.asked = [];
  state.scheduled = {};
  state.delivered = {};
});

describe("CoverageScheduledTab", () => {
  const subjects = scheduledCase(TWO_GROUPS).input.subjects.map(({ id, name }) => ({ id, name }));

  it("shows classes and then teaching groups as schemalagt / planerat, a short språkgrupp in words", () => {
    state.scheduled[""] = scheduledCase(TWO_GROUPS).response;
    render(<CoverageScheduledTab {...props(subjects)} />);
    const row7A = screen.getByRole("row", { name: /^7A/ });
    expect(within(row7A).getByText("180 / 180")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "timplanCoverage.teachingGroups" })).toBeInTheDocument();
    const spanish = screen.getByRole("row", { name: /Spanska 7/ });
    expect(within(spanish).getByText("timplanCoverage.scheduled.cellLine(Spanska|60|120)")).toBeInTheDocument();
    expect(within(spanish).getByText("−60")).toBeInTheDocument();
    // Five pupils, three below in at least one subject.
    expect(screen.getByRole("status")).toHaveTextContent("timplanCoverage.scheduled.pupilsSummary(5|");
  });

  it("opens a group: its lessons resolved to weekday and time, the pupils' spread, Bea listed by source", async () => {
    state.scheduled[""] = scheduledCase(TWO_GROUPS).response;
    state.scheduled["00000000-0000-4000-8000-000000000157"] = scheduledCase(DRILLED).response;
    const user = userEvent.setup();
    render(<CoverageScheduledTab {...props(subjects)} />);
    await user.click(screen.getByRole("button", { name: /^7A/ }));
    const section = screen.getByRole("region", { name: "7A" });
    const maths = within(section).getByRole("row", { name: /Matematik/ });
    expect(maths).toHaveTextContent("timplanCoverage.scheduled.lessonWhen(days.1|08:00|09:00)");
    expect(maths).toHaveTextContent(
      "timplanCoverage.scheduled.lessonWhen(days.3|10:00|11:00) (timplanCoverage.scheduled.oddWeeks)",
    );
    expect(maths).toHaveTextContent("timplanCoverage.stats(−60|0|0)");
    expect(state.asked).toContain("scheduled:y-1:00000000-0000-4000-8000-000000000157");
    // Bea and Eli get one lesson through two groups once: listed. Classmates are counted only.
    expect(within(section).getByText("Bea Berg")).toBeInTheDocument();
    expect(within(section).getByText("Eli Ek")).toBeInTheDocument();
    expect(within(section).getAllByText("timplanCoverage.scheduled.pupilLine(Matematik|180|240)")).toHaveLength(2);
    expect(within(section).queryByText("okänd")).not.toBeInTheDocument();

    await user.click(within(section).getByRole("button", { name: "timplanCoverage.showAllPupils" }));
    expect(within(section).getAllByText(/^okänd$|Bea Berg|Eli Ek/).length).toBe(5);
  });

  it("shows a teacher no pupil column and asks for no pupil drill-down", async () => {
    state.scheduled[""] = scheduledCase(TEACHER).response;
    const user = userEvent.setup();
    render(<CoverageScheduledTab {...props(subjects, "00000000-0000-4000-8000-000000000157")} />);
    const section = screen.getByRole("region", { name: "7A" });
    expect(within(section).queryByText("timplanCoverage.scheduled.linePupils")).not.toBeInTheDocument();
    expect(within(section).queryByRole("button", { name: "timplanCoverage.showAllPupils" })).not.toBeInTheDocument();
    expect(state.asked.filter((entry) => entry.startsWith("scheduled:y-1:") && entry.endsWith("0157"))).toEqual([]);
    expect(screen.getByRole("status")).toHaveTextContent("timplanCoverage.pupilsTotal(5)");
    await user.click(screen.getByRole("button", { name: /^7A/ }));
    expect(screen.queryByRole("region", { name: "7A" })).not.toBeInTheDocument();
  });

  it("scrolls the linked group's drill-down into view, as the planned tab does", () => {
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    try {
      state.scheduled[""] = scheduledCase(TWO_GROUPS).response;
      state.scheduled["00000000-0000-4000-8000-000000000157"] = scheduledCase(DRILLED).response;
      render(<CoverageScheduledTab {...props(subjects, "00000000-0000-4000-8000-000000000157")} />);
      expect(scrolled).toHaveBeenCalledWith({ block: "start" });
      expect(scrolled.mock.contexts[0]).toHaveAttribute("id", "tackning-scheduled-group");
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it("says the year has no grundschema rather than showing a matrix of nothing", () => {
    state.scheduled[""] = scheduledCase(NO_MASTER).response;
    render(<CoverageScheduledTab {...props(subjects)} />);
    expect(screen.getByText("timplanCoverage.scheduled.noLessons")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});

describe("CoverageDeliveredTab", () => {
  const subjects = [
    { id: DELIVERED_IDS.idh, name: "Idrott och hälsa" },
    { id: DELIVERED_IDS.ma, name: "Matematik" },
  ];

  it("states when it was counted, by today's rosters, and what counts — on every read", () => {
    state.delivered[""] = DELIVERED_OVERVIEW;
    render(<CoverageDeliveredTab {...props(subjects)} />);
    expect(screen.getByText(/timplanCoverage\.delivered\.asOf\(2026-10-08\|/)).toHaveTextContent(
      "timplanCoverage.delivered.publishedThrough(2026-08-17|2026-10-23)",
    );
    expect(screen.getByText("timplanCoverage.delivered.rosterNote")).toBeInTheDocument();
    expect(screen.getByText("timplanCoverage.delivered.definition")).toBeInTheDocument();
  });

  it("shows genomfört / publicerat in hours with the projection pill, and Utan ämne last", () => {
    state.delivered[""] = DELIVERED_OVERVIEW;
    render(<CoverageDeliveredTab {...props(subjects)} />);
    const headers = screen.getAllByRole("columnheader").map((cell) => cell.textContent);
    expect(headers.slice(1, 4)).toEqual(["Idrott och hälsa", "Matematik", "timplanCoverage.noSubject"]);
    const row = screen.getByRole("row", { name: /^7A/ });
    expect(within(row).getByText("19,0 h / 22,0 h")).toBeInTheDocument();
    expect(within(row).getByText("timplanCoverage.delivered.projection.short(4,2 h)")).toBeInTheDocument();
    expect(within(row).getByText("timplanCoverage.delivered.projection.onTrack")).toBeInTheDocument();
    expect(within(row).getByText("180,3 h / 182,0 h")).toBeInTheDocument();
    // The year's notices in the reader's language, from the figures.
    // Drift in its two directions, never netted.
    expect(screen.getByText("timplanCoverage.delivered.notice.drift(60|0|1)")).toBeInTheDocument();
    expect(screen.getByText("timplanCoverage.delivered.notice.creditOverlaps(Temadag|2026-10-02|120|180)")).toBeInTheDocument();
  });

  it("drills into a group with its own request: lost time by cause, the projection's parts, Bea listed", async () => {
    state.delivered[""] = DELIVERED_OVERVIEW;
    state.delivered[DELIVERED_IDS.class7A] = DELIVERED_DRILL_7A;
    const user = userEvent.setup();
    render(<CoverageDeliveredTab {...props(subjects)} />);
    await user.click(screen.getByRole("button", { name: /^7A/ }));
    expect(state.asked).toContain(`delivered:y-1:${DELIVERED_IDS.class7A}`);
    const section = screen.getByRole("region", { name: "7A" });
    const maths = within(section).getByRole("article", { name: "Matematik" });
    expect(maths).toHaveTextContent(
      "timplanCoverage.delivered.causeLine(timplanCoverage.delivered.cause.cancelledTeacherUnavailable|1,0 h)",
    );
    expect(maths).toHaveTextContent("timplanCoverage.delivered.cause.teacherless|1,0 h");
    expect(within(maths).getByText("timplanCoverage.delivered.projection.masterAhead").nextSibling).toHaveTextContent(
      "80,0 h",
    );
    expect(within(maths).getByText("timplanCoverage.delivered.projection.scheduleGap").nextSibling).toHaveTextContent(
      "−0,2 h",
    );
    expect(maths).toHaveTextContent("timplanCoverage.delivered.statsDelta(−40,6 h|−4,2 h|−4,2 h|2|2)");
    const sport = within(section).getByRole("article", { name: "Idrott och hälsa" });
    expect(sport).toHaveTextContent("timplanCoverage.delivered.creditLine(2026-09-25|Friluftsdag|300)");
    expect(sport).toHaveTextContent("timplanCoverage.delivered.lostNone");

    // Bea has a finding of her own; Ali is short only with his class.
    expect(within(section).getByText("Bea Berg")).toBeInTheDocument();
    expect(within(section).queryByText("Ali Al")).not.toBeInTheDocument();
    expect(within(section).getByText(/timplanCoverage\.delivered\.sharedWith\(Ma7-fördjupning\)/)).toBeInTheDocument();
    await user.click(within(section).getByRole("button", { name: "timplanCoverage.showAllPupils" }));
    expect(within(section).getByText("Ali Al")).toBeInTheDocument();
  });

  it("gives a teacher the group's breakdowns and no pupil", async () => {
    state.delivered[""] = asTeacher(DELIVERED_OVERVIEW);
    state.delivered[DELIVERED_IDS.class7A] = asTeacher(DELIVERED_DRILL_7A);
    render(<CoverageDeliveredTab {...props(subjects, DELIVERED_IDS.class7A)} />);
    const section = screen.getByRole("region", { name: "7A" });
    expect(within(section).getByRole("article", { name: "Matematik" })).toHaveTextContent(
      "timplanCoverage.delivered.projection.masterAhead",
    );
    expect(within(section).queryByText("Bea Berg")).not.toBeInTheDocument();
    expect(within(section).queryByText(/statsDelta/)).not.toBeInTheDocument();
    expect(within(section).queryByRole("button", { name: "timplanCoverage.showAllPupils" })).not.toBeInTheDocument();
  });

  it("says a past year is counted by its class history, unless the history has nothing for it", () => {
    state.delivered[""] = DELIVERED_OVERVIEW;
    const { unmount } = render(<CoverageDeliveredTab {...props(subjects)} historyRosters />);
    expect(screen.getByText("timplanCoverage.delivered.rosterNoteHistory")).toBeInTheDocument();
    expect(screen.queryByText("timplanCoverage.delivered.rosterNote")).not.toBeInTheDocument();
    unmount();
    state.delivered[""] = {
      ...DELIVERED_OVERVIEW,
      verdicts: [
        ...DELIVERED_OVERVIEW.verdicts,
        { code: "TIMPLAN_DELIVERED_PAST_YEAR_ROSTERS", severity: "notice", params: { yearEnd: "2026-06-12" }, message: "" },
      ],
    } as DeliveredCoverageResponse;
    render(<CoverageDeliveredTab {...props(subjects)} historyRosters />);
    expect(screen.getByText("timplanCoverage.delivered.rosterNote")).toBeInTheDocument();
  });

  it("says nothing is published, with the roster note still there, and draws no table", () => {
    state.delivered[""] = DELIVERED_UNPUBLISHED;
    render(<CoverageDeliveredTab {...props(subjects)} />);
    expect(screen.getByText("timplanCoverage.delivered.notPublishedTitle")).toBeInTheDocument();
    expect(screen.getByText("timplanCoverage.delivered.rosterNote")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("names the other groups' lines nowhere in a drill-down response it does not hold", () => {
    // The drill-down answers for its group alone (R20); the overview stays the table.
    const drill: DeliveredCoverageResponse = DELIVERED_DRILL_7A;
    expect(drill.groups.map((g) => g.studentGroupId)).toEqual([DELIVERED_IDS.class7A]);
    state.delivered[""] = DELIVERED_OVERVIEW;
    state.delivered[DELIVERED_IDS.class7A] = drill;
    render(<CoverageDeliveredTab {...props(subjects, DELIVERED_IDS.class7A)} />);
    expect(screen.getByRole("row", { name: /Ma7-fördjupning/ })).toBeInTheDocument();
  });

  it("judges the row's projection against the planned year less the days nothing records, as its cells are", () => {
    const late: DeliveredCoverageResponse = {
      ...DELIVERED_OVERVIEW,
      groups: DELIVERED_OVERVIEW.groups.map((group) =>
        group.studentGroupId === DELIVERED_IDS.class7A
          ? { ...group, totals: { ...group.totals, unrecorded: 1224 } }
          : group,
      ),
    };
    state.delivered[""] = late;
    render(<CoverageDeliveredTab {...props(subjects)} />);
    const row = screen.getByRole("row", { name: /^7A/ });
    // 10 920 − 1 224 = 9 696 minutes: 161,6 h, not the whole year's 182,0 h.
    expect(within(row).getByText("180,3 h / 161,6 h")).toBeInTheDocument();
  });

  it("names a gap two publishes left, in the reader's language", () => {
    state.delivered[""] = {
      ...DELIVERED_OVERVIEW,
      verdicts: [
        ...DELIVERED_OVERVIEW.verdicts,
        {
          code: "TIMPLAN_PUBLISHED_GAP",
          severity: "notice",
          params: { from: "2027-01-11", through: "2027-01-15", days: 5, unrecordedMinutes: 180 },
          message: "gap",
        },
      ],
    } as DeliveredCoverageResponse;
    render(<CoverageDeliveredTab {...props(subjects)} />);
    expect(
      screen.getByText("timplanCoverage.delivered.notice.publishedGap(2027-01-11|2027-01-15|5|3,0 h)"),
    ).toBeInTheDocument();
  });

  it("scrolls the linked group's drill-down into view once, as the planned tab does", () => {
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    try {
      state.delivered[""] = DELIVERED_OVERVIEW;
      state.delivered[DELIVERED_IDS.class7A] = DELIVERED_DRILL_7A;
      render(<CoverageDeliveredTab {...props(subjects, DELIVERED_IDS.class7A)} />);
      expect(scrolled).toHaveBeenCalledWith({ block: "start" });
      expect(scrolled.mock.contexts[0]).toHaveAttribute("id", "tackning-delivered-group");
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it("lists a pupil's own finding only under a group with a line in its subject, and only that line", async () => {
    // Bea's finding is in Matematik. Ma7-fördjupning's drill-down has a
    // Matematik line: she is listed there with it. An Idrott-only group's
    // drill-down does not list her at all.
    const idhOnly = {
      ...DELIVERED_DRILL_7A,
      groups: DELIVERED_DRILL_7A.groups.map((group) => ({
        ...group,
        lines: group.lines.filter((line) => line.key === `subject:${DELIVERED_IDS.idh}`),
      })),
    };
    const overview = {
      ...DELIVERED_OVERVIEW,
      groups: DELIVERED_OVERVIEW.groups.map((group) =>
        group.studentGroupId === DELIVERED_IDS.class7A
          ? { ...group, lines: group.lines.filter((line) => line.key === `subject:${DELIVERED_IDS.idh}`) }
          : group,
      ),
    };
    state.delivered[""] = overview;
    state.delivered[DELIVERED_IDS.class7A] = idhOnly;
    render(<CoverageDeliveredTab {...props(subjects, DELIVERED_IDS.class7A)} />);
    const section = screen.getByRole("region", { name: "7A" });
    expect(within(section).queryByText("Bea Berg")).not.toBeInTheDocument();
  });
});
