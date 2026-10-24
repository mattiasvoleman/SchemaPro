import { cleanup, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import StudentSchedulePage from "./page";

/**
 * The pupil's own week.
 *
 * There was no test file here at all, which is how two comments claiming "RLS
 * scopes this to the pupil's group" stood over a policy that matched the whole
 * school. The one seam that decides whether a pupil sees their OWN meal was
 * untested at every level — the policy had no assertion in
 * scripts/test/rls-policies.sql either, and now has both.
 */

const state = vi.hoisted(() => ({
  lessons: [] as unknown[],
  lessonsFailed: false,
  lunches: [] as unknown[],
  rasts: [] as unknown[],
  groupId: "g-41" as string | null,
  role: "STUDENT",
}));

vi.mock("@/lib/queries", () => ({
  useCalendarLessons: () =>
    state.lessonsFailed
      ? { data: undefined, isLoading: false, isError: true }
      : { data: state.lessons, isLoading: false, isError: false },
  useCalendarLunches: () => ({ data: state.lunches }),
  useCalendarRasts: () => ({ data: state.rasts }),
  useGroups: () => ({ data: GROUPS }),
  useRooms: () => ({ data: [] }),
  useSubjects: () => ({ data: SUBJECTS }),
}));

vi.mock("@/components/profile-context", () => ({
  useProfile: () => ({
    profile: {
      id: "p-1",
      authId: "a-1",
      schoolId: "s-1",
      role: state.role,
      firstName: "Alva",
      lastName: "Elev",
      email: "alva@skola.se",
      studentGroupId: state.groupId,
    },
    school: null,
  }),
}));

// The week's ämne och läxa, its own lazy file with its own test
// (components/lesson-log/student-lesson-log.test.tsx).
vi.mock("@/components/lesson-log/student-lesson-log", () => ({
  StudentLessonLog: ({ from, to }: { from: string; to: string }) => <p>lesson-log {from} {to}</p>,
}));
// The card is its own lazy file with its own test (components/teaching-time-card.test.tsx).
vi.mock("@/components/teaching-time-card", () => ({
  TeachingTimeCard: ({ studentId }: { studentId: string }) => <p>teaching-time {studentId}</p>,
}));

vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations:
    (namespace: string) => (key: string, values?: Record<string, unknown>) =>
      values
        ? `${namespace}.${key}(${Object.values(values).join("|")})`
        : `${namespace}.${key}`,
}));

const GROUPS = [
  { id: "g-41", academicYearId: "y-1", name: "4.1", kind: "CLASS", gradeLevel: 4 },
  { id: "g-42", academicYearId: "y-1", name: "4.2", kind: "CLASS", gradeLevel: 4 },
];
const SUBJECTS = [{ id: "s-ma", name: "Matematik", code: "MA", color: null }];

/** Monday of a week the component will actually be showing. */
const MONDAY = "2026-09-07";

function lunch(id: string, studentGroupId: string, startsAt: string, endsAt: string) {
  return {
    id,
    studentGroupId,
    date: MONDAY,
    startsAt: `${MONDAY}T${startsAt}:00.000Z`,
    endsAt: `${MONDAY}T${endsAt}:00.000Z`,
  };
}

beforeEach(() => {
  cleanup();
  vi.setSystemTime(new Date(`${MONDAY}T09:00:00.000Z`));
  state.groupId = "g-41";
  state.role = "STUDENT";
  state.lessonsFailed = false;
  state.lessons = [
    {
      id: "l-1",
      subjectId: "s-ma",
      studentGroupId: "g-41",
      roomId: null,
      date: MONDAY,
      startsAt: `${MONDAY}T08:00:00.000Z`,
      endsAt: `${MONDAY}T09:00:00.000Z`,
      status: "SCHEDULED",
    },
  ];
  state.lunches = [
    lunch("cl-41", "g-41", "11:40", "12:00"),
    lunch("cl-42", "g-42", "12:00", "12:20"),
  ];
  state.rasts = [
    { ...lunch("cr-41", "g-41", "09:40", "10:00"), name: "Förmiddagsrast" },
    { ...lunch("cr-42", "g-42", "09:40", "10:00"), name: "Förmiddagsrast" },
  ];
});

/** Where the single band sits, in pixels from the top of the grid. */
function topOfBand(): string | undefined {
  return (screen.getByText("lunch.bandLabel") as HTMLElement).style.top;
}

/** The band labels on screen, which is the whole question here. */
function bandsOnScreen(): string[] {
  return screen.queryAllByText("lunch.bandLabel").map((el) => el.textContent ?? "");
}

describe("the pupil's meal", () => {
  it("draws one band, the class's own", () => {
    render(<StudentSchedulePage />);
    // Two meals are readable — a guardian legitimately has more than one class
    // in reach — and exactly one of them is this week.
    expect(bandsOnScreen()).toHaveLength(1);
  });

  it("draws the meal at the class's own hour", () => {
    // 4.1 eats 11:40, 4.2 eats 12:00. Rendering the wrong row is not an empty
    // screen, it is a confident wrong answer — so the POSITION is asserted, and
    // asserted as a difference between the two classes rather than against a
    // pixel arithmetic of the test's own, which would only restate the
    // component's formula back to it.
    render(<StudentSchedulePage />);
    const own = topOfBand();
    cleanup();
    state.groupId = "g-42";
    render(<StudentSchedulePage />);
    expect(topOfBand()).not.toBe(own);
  });

  it("draws nothing for a pupil who is in no class", () => {
    state.groupId = null;
    render(<StudentSchedulePage />);
    expect(bandsOnScreen()).toHaveLength(0);
  });
});

describe("a week that holds only a meal", () => {
  it("still draws the week", () => {
    // The grid used to be replaced by "inga lektioner" before bands were passed
    // down, so the one day a pupil most needs an answer for — a day whose only
    // entry is lunch — showed nothing at all.
    state.lessons = [];
    render(<StudentSchedulePage />);
    expect(screen.queryByText("schedule.noLessons")).toBeNull();
    expect(bandsOnScreen()).toHaveLength(1);
  });

  it("says so when the week holds nothing at all", () => {
    state.lessons = [];
    state.lunches = [];
    state.rasts = [];
    render(<StudentSchedulePage />);
    expect(screen.getByText("schedule.noLessons")).toBeInTheDocument();
  });
});

describe("a week that could not be read", () => {
  it("says so, and keeps the arrows to another week", () => {
    // A failed read drawn as "inga lektioner" is a free week that is not one.
    // The meal still arrives, and must not make the failure look like a week
    // with lunch in it either.
    state.lessonsFailed = true;
    render(<StudentSchedulePage />);
    expect(screen.getByRole("heading", { level: 2, name: "schedule.loadFailed" })).toBeInTheDocument();
    expect(screen.getByText("schedule.loadFailedHint")).toBeInTheDocument();
    expect(screen.queryByText("schedule.noLessons")).toBeNull();
    expect(bandsOnScreen()).toHaveLength(0);
    expect(screen.getByRole("button", { name: "schedule.previousWeek" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "schedule.nextWeek" })).toBeEnabled();
  });
});

describe("the pupil's rasts", () => {
  it("draws the class's own break, named by the school", () => {
    render(<StudentSchedulePage />);
    // Two classes' rasts are readable — a guardian has more than one child's
    // class in reach — and one of them is this pupil's.
    expect(screen.getAllByText("Förmiddagsrast")).toHaveLength(1);
  });

  it("names it rather than labelling it 'rast'", () => {
    // "Rast" alone does not distinguish the ten minutes between two lessons
    // from the half hour on the yard, which is why the declaration carries a
    // name at all.
    render(<StudentSchedulePage />);
    expect(screen.queryByText("rasts.bandLabel")).toBeNull();
  });

  it("draws a week that holds only a rast", () => {
    state.lessons = [];
    state.lunches = [];
    render(<StudentSchedulePage />);
    expect(screen.queryByText("schedule.noLessons")).toBeNull();
    expect(screen.getAllByText("Förmiddagsrast")).toHaveLength(1);
  });
});

describe("the pupil's Undervisningstid card", () => {
  it("is the pupil's own, loaded after the week", async () => {
    render(<StudentSchedulePage />);
    expect(await screen.findByText("teaching-time p-1")).toBeInTheDocument();
  });

  it("is not asked for by anyone else who opens the page", async () => {
    state.role = "TEACHER";
    render(<StudentSchedulePage />);
    await screen.findAllByText("lunch.bandLabel");
    expect(screen.queryByText(/^teaching-time/)).not.toBeInTheDocument();
  });
});

describe("the pupil's ämne och läxa (Lektionslogg)", () => {
  it("is the pupil's own, for the week on screen", async () => {
    render(<StudentSchedulePage />);
    expect(await screen.findByText(/^lesson-log \d{4}-\d{2}-\d{2} \d{4}-\d{2}-\d{2}$/)).toBeInTheDocument();
  });

  it("is not asked for by anyone else who opens the page", async () => {
    state.role = "TEACHER";
    render(<StudentSchedulePage />);
    await screen.findAllByText("lunch.bandLabel");
    expect(screen.queryByText(/^lesson-log/)).not.toBeInTheDocument();
  });
});

describe("the pupil's printed week", () => {
  it("is offered to the pupil", async () => {
    render(<StudentSchedulePage />);
    expect(await screen.findByRole("button", { name: "printWeek.print" })).toBeInTheDocument();
  });

  it("is no one else's to print: a teacher or an admin who opens the page sees no pupil's week", async () => {
    state.role = "TEACHER";
    render(<StudentSchedulePage />);
    await screen.findAllByText("lunch.bandLabel");
    expect(screen.queryByRole("button", { name: "printWeek.print" })).not.toBeInTheDocument();
  });
});
