import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import TimetablePage from "./page";

/**
 * Whose week is on screen.
 *
 * The filter asked `lesson.studentGroupId === groupFilter`, a NAME question of
 * data that is a set — so filtering to 4.1 hid the half of 4.1 sitting in 4ma1,
 * while the pupils in that half saw the lesson on their own phones the whole
 * time. lib/lesson-audience.ts is not mocked here: the interesting failure is a
 * WIRING failure — the wrong group passed, the roster never passed, the map
 * rebuilt on the wrong key — and every one of those survives a mocked library.
 */

const state = vi.hoisted(() => ({
  lessons: [] as unknown[],
  // undefined models the query in flight, which is a different fact from an
  // empty roster and must reach the page as one.
  memberships: [] as unknown[] | undefined,
}));

const noMutation = { mutateAsync: vi.fn(), isPending: false };

vi.mock("@/lib/queries", () => ({
  useActiveYear: () => ({ activeYear: { id: "y-1" } }),
  useMasterLessons: () => ({ data: state.lessons, isLoading: false }),
  useGroups: () => ({ data: GROUPS }),
  usePeople: () => ({ data: PEOPLE }),
  useRooms: () => ({ data: [] }),
  useSubjects: () => ({ data: SUBJECTS }),
  useRequirements: () => ({ data: [] }),
  useConstraints: () => ({ data: [] }),
  useGroupMemberships: () => ({ data: state.memberships }),
  useFrameTimes: () => ({ data: [] }),
  useLunchSettings: () => ({ data: null }),
  useLunchSittings: () => ({ data: [] }),
  useRoomPreferences: () => ({ data: [] }),
  useScheduleVersions: () => ({ data: [] }),
  useScheduleVersionDetail: () => ({ data: null }),
  useScheduleVersionActions: () => ({ save: noMutation, restore: noMutation }),
  usePublishSchedule: () => noMutation,
  useCreateMasterLesson: () => noMutation,
  useUpdateMasterLesson: () => noMutation,
  useDeleteMasterLesson: () => noMutation,
}));

vi.mock("@/lib/use-timetable-realtime", () => ({
  useTimetableRealtime: () => ({ peers: [], setEditing: vi.fn() }),
}));
// The page links to the version history; next-intl's navigation helper pulls in
// the Next router, which has no place in a question about who is on screen.
vi.mock("@/i18n/navigation", () => ({
  Link: ({ children, ...rest }: { children: React.ReactNode }) => (
    <a {...rest}>{children}</a>
  ),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/lib/ics", () => ({ buildIcs: vi.fn(), downloadIcs: vi.fn() }));
vi.mock("@/lib/pdf", () => ({ exportTimetablePdf: vi.fn() }));

vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations:
    (namespace: string) => (key: string, values?: Record<string, unknown>) =>
      values
        ? `${namespace}.${key}(${Object.values(values).join("|")})`
        : `${namespace}.${key}`,
}));

// ---------------------------------------------------------------------------
// One year group, split the way Swedish schools actually split it.
//
//   4.1  Alva, Bo, Cim, Dag        4.2  Eva, Fia
//   4ma1 Alva, Bo, Eva             4ma2 Cim, Dag
//
// Monday: 4ma1 has Matematik, 4ma2 has Matematik, 4.2 has Idrott with 4.1
// invited, and 5.1 has Slöjd that touches nobody in year four.
// ---------------------------------------------------------------------------

const GROUPS = [
  { id: "g-41", academicYearId: "y-1", name: "4.1", kind: "CLASS", gradeLevel: 4 },
  { id: "g-42", academicYearId: "y-1", name: "4.2", kind: "CLASS", gradeLevel: 4 },
  { id: "g-51", academicYearId: "y-1", name: "5.1", kind: "CLASS", gradeLevel: 5 },
  {
    id: "g-ma1",
    academicYearId: "y-1",
    name: "4ma1",
    kind: "TEACHING_GROUP",
    gradeLevel: null,
  },
  {
    id: "g-ma2",
    academicYearId: "y-1",
    name: "4ma2",
    kind: "TEACHING_GROUP",
    gradeLevel: null,
  },
];

const SUBJECTS = [
  { id: "s-ma", name: "Matematik", code: "MA", color: null },
  { id: "s-id", name: "Idrott", code: "ID", color: null },
  { id: "s-sl", name: "Slöjd", code: "SL", color: null },
  { id: "s-mu", name: "Musik", code: "MU", color: null },
];

const pupil = (id: string, firstName: string, studentGroupId: string) => ({
  id,
  role: "STUDENT" as const,
  firstName,
  lastName: "Elev",
  email: `${id}@skola.se`,
  phone: null,
  isActive: true,
  invitedAt: null,
  studentGroupId,
});

const PEOPLE = [
  {
    id: "t-1",
    role: "TEACHER" as const,
    firstName: "Karin",
    lastName: "Ek",
    email: "karin@skola.se",
    phone: null,
    isActive: true,
    invitedAt: null,
    studentGroupId: null,
  },
  pupil("p-alva", "Alva", "g-41"),
  pupil("p-bo", "Bo", "g-41"),
  pupil("p-cim", "Cim", "g-41"),
  pupil("p-dag", "Dag", "g-41"),
  pupil("p-eva", "Eva", "g-42"),
  pupil("p-fia", "Fia", "g-42"),
];

const MEMBERSHIPS = [
  { studentId: "p-alva", studentGroupId: "g-ma1" },
  { studentId: "p-bo", studentGroupId: "g-ma1" },
  { studentId: "p-eva", studentGroupId: "g-ma1" },
  { studentId: "p-cim", studentGroupId: "g-ma2" },
  { studentId: "p-dag", studentGroupId: "g-ma2" },
];

function lesson(
  id: string,
  subjectId: string,
  studentGroupId: string,
  startTime: string,
  overrides: { extraGroupIds?: string[]; studentIds?: string[] } = {},
) {
  return {
    id,
    academicYearId: "y-1",
    subjectId,
    studentGroupId,
    teacherId: "t-1",
    coTeacherId: null,
    roomId: null,
    dayOfWeek: 1,
    startTime,
    endTime: `${String(Number(startTime.slice(0, 2)) + 1).padStart(2, "0")}:00`,
    isLocked: false,
    recurrence: "WEEKLY",
    startDate: null,
    endDate: null,
    extraGroupIds: overrides.extraGroupIds ?? [],
    studentIds: overrides.studentIds ?? [],
  };
}

const LESSONS = [
  lesson("l-ma1", "s-ma", "g-ma1", "08:00"),
  lesson("l-ma2", "s-ma", "g-ma2", "09:00"),
  lesson("l-idrott", "s-id", "g-42", "10:00", { extraGroupIds: ["g-41"] }),
  lesson("l-slojd", "s-sl", "g-51", "11:00"),
  lesson("l-musik", "s-mu", "g-51", "12:00", { studentIds: ["p-alva"] }),
];

beforeEach(() => {
  cleanup();
  state.lessons = LESSONS;
  state.memberships = MEMBERSHIPS;
});

/** Pick a class in the group filter. */
async function filterTo(name: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: "timetable.filterGroup" }));
  await user.click(await screen.findByRole("option", { name }));
}

/** The subjects on screen, which is the whole question this page answers. */
function subjectsOnScreen(): string[] {
  return SUBJECTS.filter((subject) =>
    screen.queryAllByRole("button").some((el) => el.textContent?.includes(subject.name)),
  ).map((subject) => subject.name);
}

describe("the week of one class", () => {
  it("shows every lesson holding one of the class's pupils", async () => {
    render(<TimetablePage />);
    await filterTo("4.1");
    // Matematik is filed under 4ma1 and 4ma2, neither of which is named "4.1";
    // Idrott is filed under 4.2. All three are 4.1's week. Slöjd is 5.1's, and
    // Musik reaches Alva individually.
    expect(subjectsOnScreen()).toEqual(["Matematik", "Idrott", "Musik"]);
  });

  it("keeps out a lesson that holds none of the class's pupils", async () => {
    render(<TimetablePage />);
    await filterTo("4.2");
    // 4ma2 is Cim and Dag, both of 4.1 — so 4.2 sees only the 4ma1 half of
    // maths, not both halves.
    expect(screen.queryAllByRole("button").filter((el) =>
      el.textContent?.includes("Matematik"),
    )).toHaveLength(1);
    expect(subjectsOnScreen()).toEqual(["Matematik", "Idrott"]);
  });

  it("leaves the unfiltered view showing everything", () => {
    render(<TimetablePage />);
    expect(subjectsOnScreen()).toEqual(["Matematik", "Idrott", "Slöjd", "Musik"]);
  });

  it("names the other class on a shared lesson instead of counting it", async () => {
    render(<TimetablePage />);
    await filterTo("4.1");
    // "+1" said another class was in the room without saying which.
    const idrott = screen
      .queryAllByRole("button")
      .find((el) => el.textContent?.includes("Idrott"));
    expect(idrott?.textContent).toContain("4.2 + 4.1");
    expect(idrott?.textContent).not.toContain("+1");
  });

  it("marks how much of the class a partial lesson holds", async () => {
    render(<TimetablePage />);
    await filterTo("4.1");
    const maths = screen
      .queryAllByRole("button")
      .find((el) => el.textContent?.includes("Matematik"));
    // 4ma1 is Alva and Bo of 4.1's four. Drawn as one rectangle it would claim
    // the whole class, the way an every-other-week lesson claims every week.
    expect(maths?.textContent).toContain("2/4");
    // And spelled out for a reader who cannot see the badge.
    expect(maths?.textContent).toContain("timetable.sharePupils(2|4|4.1)");
  });

  it("leaves a lesson the whole class attends unmarked", async () => {
    render(<TimetablePage />);
    await filterTo("4.1");
    const idrott = screen
      .queryAllByRole("button")
      .find((el) => el.textContent?.includes("Idrott"));
    // "4/4" on a class's own lesson is noise on the common case.
    expect(idrott?.textContent).not.toContain("4/4");
    expect(idrott?.textContent).not.toContain("timetable.sharePupils");
  });

  it("marks nothing at all in the unfiltered view", () => {
    render(<TimetablePage />);
    // There is no class in view to be a fraction OF.
    expect(document.body.textContent).not.toContain("timetable.sharePupils");
  });

  it("falls back to the named lessons, not a blank grid, while the roster loads", async () => {
    state.memberships = undefined;
    render(<TimetablePage />);
    await filterTo("4.1");
    // Fewer cards, never zero: Idrott names 4.1 outright. Maths arrives when
    // the roster does, so the flicker is fewer→more rather than empty→full.
    expect(subjectsOnScreen()).toEqual(["Idrott"]);
  });
});
