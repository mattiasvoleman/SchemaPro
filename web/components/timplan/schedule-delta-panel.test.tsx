import { render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { AcademicYear, MasterLesson, StudentGroup, Subject, TeachingRequirement } from "@/lib/types";
import { ScheduleDeltaPanel } from "./schedule-delta-panel";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}(${Object.entries(values).map(([k, v]) => `${k}=${String(v)}`).join("|")})` : key,
}));
vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, children, className }: { href: string; children: ReactNode; className?: string }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));
const breaks = vi.hoisted(() => ({ data: [] as unknown[] | undefined }));
vi.mock("@/lib/queries", () => ({ useSchoolBreaks: () => ({ data: breaks.data }) }));

const YEAR = {
  id: "y1",
  name: "2026/2027",
  startDate: "2026-08-17",
  endDate: "2027-06-11",
  isActive: true,
  predecessorId: null,
} as AcademicYear;

const group = (id: string, name: string, gradeLevel = 7): StudentGroup =>
  ({ id, name, kind: "CLASS", gradeLevel, academicYearId: "y1" }) as StudentGroup;
const GROUPS = [group("g7a", "7A"), group("g7b", "7B")];
const SUBJECTS = [
  { id: "ma", name: "Matematik", nationalCode: "MA", countsTowardTimplan: true },
  { id: "sv", name: "Svenska", nationalCode: "SV_SVA", countsTowardTimplan: true },
  { id: "me", name: "Mentorstid", nationalCode: null, countsTowardTimplan: false },
] as Subject[];

const post = (id: string, studentGroupId: string, subjectId: string, lessonsPerWeek: number): TeachingRequirement =>
  ({
    id,
    academicYearId: "y1",
    studentGroupId,
    subjectId,
    lessonsPerWeek,
    minutesPerLesson: 60,
    lessonLengths: [],
    recurrence: "ALL_WEEKS",
    startDate: null,
    endDate: null,
  }) as unknown as TeachingRequirement;
const POSTS = [post("r1", "g7a", "ma", 3), post("r2", "g7a", "sv", 2), post("r3", "g7b", "ma", 3)];

const lesson = (id: string, studentGroupId: string, subjectId: string, dayOfWeek: number, overrides: Partial<MasterLesson> = {}): MasterLesson => ({
  id,
  academicYearId: "y1",
  subjectId,
  studentGroupId,
  teacherId: "t1",
  coTeacherId: null,
  roomId: null,
  dayOfWeek,
  startTime: "08:00:00",
  endTime: "09:00:00",
  isLocked: false,
  isParked: false,
  recurrence: "ALL_WEEKS",
  startDate: null,
  endDate: null,
  extraGroupIds: [],
  studentIds: [],
  ...overrides,
});
const LESSONS = [
  lesson("a1", "g7a", "ma", 1),
  lesson("a2", "g7a", "ma", 3),
  lesson("a3", "g7a", "ma", 5),
  lesson("a4", "g7a", "sv", 2),
  lesson("a5", "g7a", "sv", 4),
  lesson("a6", "g7a", "me", 4),
  lesson("b1", "g7b", "ma", 1),
  lesson("b2", "g7b", "ma", 3),
];

const panel = (lessons: MasterLesson[] | undefined, groupFilters: string[] = []) => (
  <ScheduleDeltaPanel
    id="lesson-time"
    year={YEAR}
    lessons={lessons}
    requirements={POSTS}
    groups={GROUPS}
    subjects={SUBJECTS}
    groupFilters={groupFilters}
  />
);

const region = () => screen.getByRole("region", { name: "region" });
const live = () => region().querySelector("[aria-live]")!;

describe("ScheduleDeltaPanel", () => {
  it("lists only the lines that deviate when several groups are in view, and counts every line", () => {
    render(panel(LESSONS));
    expect(region()).toHaveTextContent("summary(matching=2|total=3)");
    expect(screen.getByText("line(subject=Matematik|scheduled=120|planned=180)")).toBeInTheDocument();
    // 7A's three lessons match their post: not listed, and mentorstid counts nowhere.
    expect(screen.queryByText(/scheduled=180\|planned=180/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Mentorstid/)).not.toBeInTheDocument();
    expect(within(region()).getByText("7B")).toBeInTheDocument();
    expect(within(region()).queryByText("7A")).not.toBeInTheDocument();
  });

  it("lists every line of the one group in view, matching or not, and links to its Täckning", () => {
    render(panel(LESSONS, ["g7a"]));
    expect(screen.getByText("line(subject=Matematik|scheduled=180|planned=180)")).toBeInTheDocument();
    expect(screen.getByText("line(subject=Svenska|scheduled=120|planned=120)")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "openCoverage" })).toHaveAttribute(
      "href",
      "/admin/timplan/tackning?year=y1&layer=scheduled&group=g7a",
    );
  });

  it("shows a shortened lesson in the render it lands in, and says only that line changed", () => {
    const { rerender } = render(panel(LESSONS, ["g7a"]));
    expect(live()).toHaveTextContent("");
    const shorter = LESSONS.map((l) => (l.id === "a2" ? { ...l, endTime: "08:55:00" } : l));
    rerender(panel(shorter, ["g7a"]));
    expect(screen.getByText("line(subject=Matematik|scheduled=175|planned=180)")).toBeInTheDocument();
    expect(live()).toHaveTextContent("announce(group=7A|subject=Matematik|scheduled=175|planned=180)");
    expect(live()).not.toHaveTextContent("Svenska");
  });

  it("changes nothing, and announces nothing, for a pure move to another day and time", () => {
    const { rerender } = render(panel(LESSONS, ["g7a"]));
    const moved = LESSONS.map((l) =>
      l.id === "a1" ? { ...l, dayOfWeek: 2, startTime: "13:00:00", endTime: "14:00:00" } : l,
    );
    rerender(panel(moved, ["g7a"]));
    expect(screen.getByText("line(subject=Matematik|scheduled=180|planned=180)")).toBeInTheDocument();
    expect(live()).toHaveTextContent("");
  });

  it("takes a parked lesson out of the scheduled minutes and names it as parked", () => {
    const { rerender } = render(panel(LESSONS, ["g7a"]));
    rerender(panel(LESSONS.map((l) => (l.id === "a3" ? { ...l, isParked: true } : l)), ["g7a"]));
    expect(screen.getByText("line(subject=Matematik|scheduled=120|planned=180)")).toBeInTheDocument();
    expect(region()).toHaveTextContent("parked(minutes=60)");
    expect(live()).toHaveTextContent("announce(group=7A|subject=Matematik|scheduled=120|planned=180)");
  });

  it("says a subject with a post and no lessons is unscheduled, and one with lessons and no post unplanned", () => {
    const lessons = [...LESSONS.filter((l) => l.subjectId !== "sv"), lesson("x1", "g7b", "sv", 2)];
    render(panel(lessons, ["g7a", "g7b"]));
    expect(screen.getByText("unscheduled(subject=Svenska|planned=120)")).toBeInTheDocument();
    expect(screen.getByText("unplanned(subject=Svenska|scheduled=60)")).toBeInTheDocument();
  });

  it("waits for the lov before it shows a figure", () => {
    breaks.data = undefined;
    try {
      render(panel(LESSONS));
      expect(region()).toHaveTextContent("loading");
      expect(screen.queryByText(/summary/)).not.toBeInTheDocument();
    } finally {
      breaks.data = [];
    }
  });

  it("waits for the board's lessons too, and announces nothing when they arrive after the lov", () => {
    // A reload with the panel open: the lov answer is one request, the
    // lessons are paged. Until they land there is nothing to compare — not a
    // year of empty lines that the arrival then "changes".
    const { rerender } = render(panel(undefined, ["g7a"]));
    expect(region()).toHaveTextContent("loading");
    expect(screen.queryByText(/unscheduled/)).not.toBeInTheDocument();
    rerender(panel(LESSONS, ["g7a"]));
    expect(screen.getByText("line(subject=Matematik|scheduled=180|planned=180)")).toBeInTheDocument();
    expect(live()).toHaveTextContent("");
  });

  it("announces only lines of the groups in view", () => {
    const { rerender } = render(panel(LESSONS, ["g7a"]));
    rerender(panel(LESSONS.filter((l) => l.id !== "b2"), ["g7a"]));
    expect(live()).toHaveTextContent("");
  });

  it("counts a parked lesson combined across two groups once in the summary", () => {
    const combined = [...LESSONS, lesson("p1", "g7a", "ma", 2, { isParked: true, extraGroupIds: ["g7b"] })];
    render(panel(combined));
    // On 7A's line and on 7B's: 60 each, but one lesson of 60.
    expect(within(region()).getByText(/summary\(matching=2\|total=3\)/)).toHaveTextContent("parked(minutes=60)");
    expect(within(region()).getByText(/summary/)).not.toHaveTextContent("parked(minutes=120)");
  });
});
