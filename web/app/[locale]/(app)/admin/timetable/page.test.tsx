import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TimetablePage from "./page";
import { buildIcs } from "@/lib/ics";
import { exportTimetablePdf } from "@/lib/pdf";

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
  lunchSettings: null as unknown,
  // undefined models the query in flight; [] is a year the solver has not
  // yet placed a meal for. The notice must tell the two apart.
  sittings: [] as unknown[] | undefined,
}));

const noMutation = { mutateAsync: vi.fn().mockResolvedValue({ id: "x" }), isPending: false };

/** The three verbs of a meal placed by hand, each a spy a test can read. */
const lunch = {
  create: { mutateAsync: vi.fn(), isPending: false },
  update: { mutateAsync: vi.fn(), isPending: false },
  remove: { mutateAsync: vi.fn(), isPending: false },
};

vi.mock("@/lib/queries", () => ({
  useActiveYear: () => ({ activeYear: { id: "y-1" } }),
  useMasterLessons: () => ({ data: state.lessons, isLoading: false }),
  useGroups: () => ({ data: GROUPS }),
  usePeople: () => ({ data: PEOPLE }),
  useRooms: () => ({ data: ROOMS }),
  useSubjects: () => ({ data: SUBJECTS }),
  useRequirements: () => ({ data: [] }),
  useConstraints: () => ({ data: [] }),
  useGroupMemberships: () => ({ data: state.memberships }),
  useFrameTimes: () => ({ data: [] }),
  useLunchSettings: () => ({ data: state.lunchSettings }),
  useLunchSittings: () => ({ data: state.sittings }),
  useLunchSittingMutations: () => lunch,
  useRoomPreferences: () => ({ data: [] }),
  useRasts: () => ({ data: RASTS }),
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
  // Outside the 4-6 rast, so the band test has a class the rast does not reach.
  { id: "g-71", academicYearId: "y-1", name: "7.1", kind: "CLASS", gradeLevel: 7 },
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

/** One every-day rast for year four, so the bands have something to draw. */
const RASTS = [
  {
    id: "r-1",
    name: "Förmiddagsrast",
    minGradeLevel: 4,
    maxGradeLevel: 6,
    dayOfWeek: null,
    startTime: "09:40:00",
    endTime: "10:00:00",
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
  {
    id: "t-2",
    role: "TEACHER" as const,
    firstName: "Nils",
    lastName: "Berg",
    email: "nils@skola.se",
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
  overrides: {
    extraGroupIds?: string[];
    studentIds?: string[];
    teacherId?: string;
    roomId?: string;
  } = {},
) {
  return {
    id,
    academicYearId: "y-1",
    subjectId,
    studentGroupId,
    teacherId: overrides.teacherId ?? "t-1",
    coTeacherId: null,
    roomId: overrides.roomId ?? null,
    dayOfWeek: 1,
    startTime,
    endTime: `${String(Number(startTime.slice(0, 2)) + 1).padStart(2, "0")}:00`,
    isLocked: false,
    isParked: false,
    recurrence: "WEEKLY",
    startDate: null,
    endDate: null,
    extraGroupIds: overrides.extraGroupIds ?? [],
    studentIds: overrides.studentIds ?? [],
  };
}

/*
 * Two rooms, so the room filter has something to tell apart. Named so that
 * neither contains a subject name: subjectsOnScreen matches substrings across
 * every button on the page, and a room called "Slöjdsalen" would be counted as
 * the subject Slöjd being on screen.
 */
const ROOMS = [
  { id: "r-sal", name: "A1" },
  { id: "r-verkstad", name: "Verkstaden" },
];

const LESSONS = [
  lesson("l-ma1", "s-ma", "g-ma1", "08:00"),
  // The one lesson that is somebody else's and somewhere: it is what the
  // teacher and room filters are read against.
  lesson("l-ma2", "s-ma", "g-ma2", "09:00", { teacherId: "t-2", roomId: "r-sal" }),
  lesson("l-idrott", "s-id", "g-42", "10:00", { extraGroupIds: ["g-41"] }),
  lesson("l-slojd", "s-sl", "g-51", "11:00"),
  lesson("l-musik", "s-mu", "g-51", "12:00", {
    studentIds: ["p-alva"],
    roomId: "r-verkstad",
  }),
];

/**
 * jsdom computes no layout, so the grid's pointer-to-slot maths would bail out
 * on the zeros getBoundingClientRect returns. Pinned the same way
 * timetable-grid.test.tsx pins it: a 56px time axis and five 100px day columns.
 */
const GRID_RECT = {
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  right: 556,
  bottom: 528,
  width: 556,
  height: 528,
  toJSON: () => ({}),
} as DOMRect;

const TRAY_RECT = {
  x: 600,
  y: 0,
  top: 0,
  left: 600,
  right: 800,
  bottom: 200,
  width: 200,
  height: 200,
  toJSON: () => ({}),
} as DOMRect;

beforeEach(() => {
  cleanup();
  noMutation.mutateAsync.mockClear();
  vi.mocked(buildIcs).mockClear();
  vi.mocked(exportTimetablePdf).mockClear();
  // The tray sits well to the right of the grid's body, so a drop can be
  // outside one and inside the other. jsdom lays nothing out; this is the
  // whole geometry the tests have.
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
    this: Element,
  ) {
    return this.closest('[data-testid="lesson-tray"]') ? TRAY_RECT : GRID_RECT;
  });
  state.lessons = LESSONS;
  state.memberships = MEMBERSHIPS;
  state.lunchSettings = null;
  state.sittings = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Drag a lesson card into Tuesday and let go.
 *
 * Sideways rather than down the day on purpose: every lesson in the fixture is
 * Karin's, so any move within Monday lands on her and the grid answers with the
 * suggestion dialog instead — a different question than this one.
 * day = floor((clientX - 56) / 100) + 1, so x=100 is Monday and x=200 Tuesday.
 */
function dragToTuesday(subject: string) {
  const card = screen
    .queryAllByRole("button")
    .find((el) => el.textContent?.includes(subject))!;
  fireEvent.pointerDown(card, { pointerId: 1, button: 0, clientX: 100, clientY: 60 });
  fireEvent.pointerMove(window, { pointerId: 1, clientX: 200, clientY: 60 });
  fireEvent.pointerUp(window, { pointerId: 1, clientX: 200, clientY: 60 });
}

/** Tick options in one of the three pickers. The menu stays open between them. */
async function tick(picker: string, ...names: string[]) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: picker }));
  for (const name of names) {
    await user.click(await screen.findByRole("menuitemcheckbox", { name }));
  }
  await user.keyboard("{Escape}");
}

const filterTo = (...names: string[]) => tick("timetable.filterGroup", ...names);
const filterToTeacher = (...names: string[]) => tick("timetable.filterTeacher", ...names);
const filterToRoom = (...names: string[]) => tick("timetable.filterRoom", ...names);

/** The subjects on screen, which is the whole question this page answers. */
function subjectsOnScreen(): string[] {
  return SUBJECTS.filter((subject) =>
    screen.queryAllByRole("button").some((el) => el.textContent?.includes(subject.name)),
  ).map((subject) => subject.name);
}

describe("the week of one teacher, or several", () => {
  it("shows only what that teacher takes", async () => {
    render(<TimetablePage />);
    await filterToTeacher("Nils Berg");

    // Nils has the 4ma2 half of maths; everything else is Karin's.
    expect(subjectsOnScreen()).toEqual(["Matematik"]);
  });

  it("shows the union when two teachers are picked", async () => {
    render(<TimetablePage />);
    await filterToTeacher("Nils Berg", "Karin Ek");

    expect(subjectsOnScreen()).toEqual(["Matematik", "Idrott", "Slöjd", "Musik"]);
  });
});

describe("what is in a room, or in several", () => {
  it("shows only the lessons placed in it", async () => {
    render(<TimetablePage />);
    await filterToRoom("Verkstaden");

    expect(subjectsOnScreen()).toEqual(["Musik"]);
  });

  it("shows the union when two rooms are picked", async () => {
    render(<TimetablePage />);
    await filterToRoom("A1", "Verkstaden");

    expect(subjectsOnScreen()).toEqual(["Matematik", "Musik"]);
  });

  it("leaves out a lesson that has no room at all", async () => {
    // "Show me what is in the workshop" cannot honestly include a lesson that
    // is nowhere. Unfiltered they are all there, which is the contrast.
    render(<TimetablePage />);
    expect(subjectsOnScreen()).toContain("Idrott");

    await filterToRoom("A1");
    expect(subjectsOnScreen()).not.toContain("Idrott");
  });
});

describe("the three filters together", () => {
  it("narrows by all of them at once", async () => {
    render(<TimetablePage />);
    await filterTo("4.1");
    await filterToTeacher("Nils Berg");

    // 4.1's week holds both maths halves; only the 4ma2 one is Nils's.
    expect(subjectsOnScreen()).toEqual(["Matematik"]);

    await filterToRoom("Verkstaden");
    // ...and that one is in A1, not the workshop, so nothing is left.
    expect(subjectsOnScreen()).toEqual([]);
  });
});

describe("the week of one class", () => {
  it("shows every lesson holding one of the class's pupils", async () => {
    render(<TimetablePage />);
    await filterTo("4.1");
    // Matematik is filed under 4ma1 and 4ma2, neither of which is named "4.1";
    // Idrott is filed under 4.2. All three are 4.1's week. Slöjd is 5.1's, and
    // Musik reaches Alva individually.
    expect(subjectsOnScreen()).toEqual(["Matematik", "Idrott", "Musik"]);
  });

  it("shows the union when several groups are picked", async () => {
    // A rektor comparing two classes had to choose between one of them and the
    // whole school. Slöjd is 5.1's alone, so it stays out and the pair is not
    // quietly the same as "all".
    render(<TimetablePage />);
    await filterTo("4.1", "5.1");

    const shown = subjectsOnScreen();
    expect(shown).toContain("Matematik");
    expect(shown).toContain("Slöjd");
  });

  it("keeps a lesson out that reaches none of the groups picked", async () => {
    render(<TimetablePage />);
    await filterTo("4.1", "4.2");

    // Slöjd is 5.1's week and 5.1 is not in the selection.
    expect(subjectsOnScreen()).not.toContain("Slöjd");
  });

  it("stops answering the one-class questions when several are picked", async () => {
    /*
     * The rast stripe and the "2/4" badge are about a single class: whose
     * rast, and how much of WHICH class is here. With four classes on the grid
     * neither has an answer, and drawing one anyway would be drawing an answer
     * to a question nobody asked.
     */
    render(<TimetablePage />);
    await filterTo("4.1");
    expect(screen.getAllByText("Förmiddagsrast")).toHaveLength(5);

    await filterTo("5.1");
    expect(screen.queryByText("Förmiddagsrast")).toBeNull();
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

describe("moving a lesson that lands on more than one class", () => {
  it("names the classes before the drag takes effect", () => {
    render(<TimetablePage />);
    // Not filtered to anything: the question is asked of the LESSON. 4ma1 holds
    // Alva and Bo of 4.1 and Eva of 4.2, so this drag moves 4.2's week too.
    dragToTuesday("Matematik");
    expect(screen.getByText("timetable.sharedMoveTitle")).toBeInTheDocument();
    expect(screen.getByText(/timetable.sharedMoveBody\(4\.1, 4\.2\)/)).toBeInTheDocument();
    expect(noMutation.mutateAsync).not.toHaveBeenCalled();
  });

  it("applies the move once it is confirmed", async () => {
    const user = userEvent.setup();
    render(<TimetablePage />);
    dragToTuesday("Matematik");
    await user.click(screen.getByRole("button", { name: "timetable.sharedMoveConfirm" }));
    expect(noMutation.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ id: "l-ma1" }),
    );
  });

  it("drops the move when it is cancelled", async () => {
    const user = userEvent.setup();
    render(<TimetablePage />);
    dragToTuesday("Matematik");
    await user.click(screen.getByRole("button", { name: "common.cancel" }));
    expect(noMutation.mutateAsync).not.toHaveBeenCalled();
    expect(screen.queryByText("timetable.sharedMoveTitle")).toBeNull();
  });

  it("moves a lesson that stays inside one class without asking", () => {
    render(<TimetablePage />);
    // Slöjd is 5.1's alone. Asking here would make the dialog noise, and a
    // dialog that appears on every drag is one nobody reads.
    dragToTuesday("Slöjd");
    expect(screen.queryByText("timetable.sharedMoveTitle")).toBeNull();
    expect(noMutation.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ id: "l-slojd" }),
    );
  });
});

describe("exporting one class's week", () => {
  /** The lessons handed to the ICS builder, keyed by subject. */
  async function icsFor(className?: string) {
    const user = userEvent.setup();
    render(<TimetablePage />);
    if (className) await filterTo(className);
    await user.click(screen.getByRole("button", { name: "timetable.exportIcs" }));
    const [lessons] = vi.mocked(buildIcs).mock.calls[0];
    return lessons;
  }

  it("carries the lessons the class actually attends", async () => {
    const lessons = await icsFor("4.1");
    // The export reads the same widened view the grid does, so a pupil
    // subscribing to 4.1's calendar gets their own maths — which they could
    // already see in the portal but not in the file the school handed out.
    // BOTH maths halves: 4.1's four pupils are split across 4ma1 and 4ma2, so
    // the class's week holds two maths lessons and neither is the whole class.
    expect(lessons.map((l) => l.summary)).toEqual([
      "Matematik — 4ma1",
      "Matematik — 4ma2",
      "Idrott — 4.2 + 4.1",
      "Musik — 5.1",
    ]);
  });

  it("names every class in the room, not only the owner", async () => {
    const lessons = await icsFor("4.1");
    // "Idrott — 4.2" told a 4.1 subscriber nothing about why it was in their
    // calendar at all.
    expect(lessons.find((l) => l.summary.startsWith("Idrott"))?.summary).toBe(
      "Idrott — 4.2 + 4.1",
    );
  });

  it("says how much of the class a partial lesson holds", async () => {
    const lessons = await icsFor("4.1");
    // A calendar entry is one block on a phone whether two pupils or four are
    // in it, and there is no badge to see.
    expect(lessons.find((l) => l.summary.startsWith("Matematik"))?.description)
      .toBe("Karin Ek · timetable.sharePupils(2|4|4.1)");
    expect(lessons.find((l) => l.summary.startsWith("Idrott"))?.description).toBe(
      "Karin Ek",
    );
  });

  it("leaves the unfiltered export without fractions", async () => {
    const lessons = await icsFor();
    expect(lessons).toHaveLength(5);
    expect(
      lessons.every((l) => !l.description?.includes("sharePupils")),
    ).toBe(true);
  });

  it("prints the classes and the fraction in the PDF's group column", async () => {
    const user = userEvent.setup();
    render(<TimetablePage />);
    await filterTo("4.1");
    await user.click(screen.getByRole("button", { name: "timetable.exportPdf" }));
    const [{ lessons }] = vi.mocked(exportTimetablePdf).mock.calls[0];
    expect(lessons.map((l) => l.group)).toEqual([
      "4ma1 2/4",
      "4ma2 2/4",
      "4.2 + 4.1",
      "5.1 1/4",
    ]);
  });
});

describe("the rasts a class must observe", () => {
  it("draws a band for the class in view", async () => {
    render(<TimetablePage />);
    await filterTo("4.1");
    // One every-day row for years 4-6, so 4.1 is bound by it on all five days.
    expect(screen.getAllByText("Förmiddagsrast")).toHaveLength(5);
  });

  it("draws nothing for a class the rast does not reach", async () => {
    render(<TimetablePage />);
    // 7.1 is year seven; the rast is written for 4-6. A band drawn here would
    // tell a stage it is free at an hour it is taught.
    await filterTo("7.1");
    expect(screen.queryByText("Förmiddagsrast")).toBeNull();
  });

  it("draws it for another class inside the same span", async () => {
    render(<TimetablePage />);
    await filterTo("5.1");
    // Written for 4-6, and 5.1 is inside it. Matching is by overlap, so a
    // class need not be the span to be bound by it.
    expect(screen.getAllByText("Förmiddagsrast")).toHaveLength(5);
  });

  it("draws nothing before a class is picked", () => {
    render(<TimetablePage />);
    // The default view is every class at once, and a stripe across that grid
    // would claim every stage keeps the same hours — the same reason the lunch
    // bands are hidden there.
    expect(screen.queryByText("Förmiddagsrast")).toBeNull();
  });
});

describe("what a new lesson starts out as", () => {
  /** Click the empty part of a day column, which is what opens the dialog. */
  function clickEmptySlot() {
    const column = screen
      .queryAllByRole("button")
      .find((el) => el.textContent?.includes("Slöjd"))!.parentElement as HTMLElement;
    fireEvent.click(column, { clientX: 100, clientY: 400 });
  }

  it("presets the group and the teacher when exactly one of each is picked", async () => {
    render(<TimetablePage />);
    await filterTo("5.1");
    await filterToTeacher("Karin Ek");
    clickEmptySlot();

    // A rektor who has narrowed to one class and one teacher is about to
    // create a lesson for them; asking again would be asking twice.
    expect(
      screen.getByRole("combobox", { name: "timetable.addGroup" }).textContent,
    ).toBe("5.1");
    expect(
      screen.getByRole("combobox", { name: "timetable.editTeacher" }).textContent,
    ).toBe("Karin Ek");
  });

  it("presets neither when several are picked", async () => {
    /*
     * With two teachers on screen there is no answer to "whose lesson is
     * this", and guessing one of them would put a name on a lesson the reader
     * never chose. A closed Select shows only its selected item, so the
     * dialog's own text is the whole answer.
     */
    render(<TimetablePage />);
    await filterTo("4.1", "5.1");
    await filterToTeacher("Karin Ek", "Nils Berg");
    clickEmptySlot();

    expect(
      screen.getByRole("combobox", { name: "timetable.editTeacher" }).textContent,
    ).toBe("timetable.noTeacher");
    // The group placeholder, not one of the two picked.
    expect(
      screen.getByRole("combobox", { name: "timetable.addGroup" }).textContent,
    ).toBe("timetable.addGroup");
  });
});

describe("the edit dialog", () => {
  it("names the lesson it opened on", () => {
    // Three maths lessons on a Tuesday all opened on "Justera lektion" and
    // nothing else, and the reader had to remember which one they clicked.
    render(<TimetablePage />);
    const card = screen
      .queryAllByRole("button")
      .find((el) => el.textContent?.includes("Slöjd"))!;
    fireEvent.pointerDown(card, { pointerId: 1, button: 0, clientX: 100, clientY: 60 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 100, clientY: 60 });

    expect(screen.getByRole("dialog").textContent).toContain("Slöjd · 5.1 · K. Ek");
  });

  it("can set the lesson aside from there", async () => {
    const user = userEvent.setup();
    render(<TimetablePage />);
    const card = screen
      .queryAllByRole("button")
      .find((el) => el.textContent?.includes("Slöjd"))!;
    fireEvent.pointerDown(card, { pointerId: 1, button: 0, clientX: 100, clientY: 60 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 100, clientY: 60 });

    await user.click(screen.getByRole("button", { name: "timetable.park" }));

    expect(noMutation.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ id: "l-slojd", isParked: true }),
    );
  });
});

describe("the edit dialog's width", () => {
  /*
   * jsdom lays nothing out, so "does it scroll sideways" is unobservable here.
   * What is asserted is the three tokens that decide it — the same way
   * gaps/page.test.tsx asserts h-11 for a touch target it cannot measure.
   */
  const openSlojd = () => {
    render(<TimetablePage />);
    const card = screen
      .queryAllByRole("button")
      .find((el) => el.textContent?.includes("Slöjd"))!;
    fireEvent.pointerDown(card, { pointerId: 1, button: 0, clientX: 100, clientY: 60 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 100, clientY: 60 });
    return screen.getByRole("dialog");
  };

  it("keeps the component's own width rather than narrowing it", () => {
    const dialog = openSlojd();
    expect(dialog.className).toContain("max-w-lg");
    expect(dialog.className).not.toContain("max-w-md");
  });

  it("lets both button groups wrap onto a second row", () => {
    openSlojd();
    for (const name of ["timetable.park", "common.cancel"]) {
      const group = screen.getByRole("button", { name }).parentElement!;
      expect(group.className, name).toContain("flex-wrap");
    }
  });

  it("lets a form cell shrink below its content", () => {
    // A grid child defaults to min-width:auto and will widen the whole grid
    // to fit a long teacher name rather than let the select ellipsize it.
    const dialog = openSlojd();
    const grid = dialog.querySelector(".grid-cols-2")!;
    expect(grid.className).toContain("[&>*]:min-w-0");
  });
});

describe("the tray", () => {
  const parkedSlojd = () =>
    LESSONS.map((l) => (l.id === "l-slojd" ? { ...l, isParked: true } : l));

  it("holds a parked lesson, and the grid does not", () => {
    state.lessons = parkedSlojd();
    render(<TimetablePage />);

    const tray = screen.getByTestId("lesson-tray");
    expect(tray.textContent).toContain("Slöjd · 5.1 · K. Ek");
    // Off the grid entirely — not dimmed, not pinned, gone. Its remembered
    // slot is not a placement.
    const onGrid = screen
      .queryAllByRole("button")
      .filter((el) => el.textContent?.includes("Slöjd") && !tray.contains(el));
    expect(onGrid).toHaveLength(0);
  });

  it("puts a lesson back where it was", async () => {
    const user = userEvent.setup();
    state.lessons = parkedSlojd();
    render(<TimetablePage />);

    await user.click(screen.getByRole("button", { name: "timetable.putBack" }));

    // Only the flag: the server reads the remembered day and time, and checks
    // the slot like any placement — it may since have been taken.
    expect(noMutation.mutateAsync).toHaveBeenCalledWith({ id: "l-slojd", isParked: false });
  });

  it("parks a lesson dropped onto it", () => {
    render(<TimetablePage />);
    const card = screen
      .queryAllByRole("button")
      .find((el) => el.textContent?.includes("Slöjd"))!;
    fireEvent.pointerDown(card, { pointerId: 1, button: 0, clientX: 100, clientY: 60 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 700, clientY: 100 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 700, clientY: 100 });

    expect(noMutation.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ id: "l-slojd", isParked: true }),
    );
  });

  it("does nothing with a drop that is off the grid but not on the tray", () => {
    // Letting go over the page header is a fumble, not an instruction.
    render(<TimetablePage />);
    const card = screen
      .queryAllByRole("button")
      .find((el) => el.textContent?.includes("Slöjd"))!;
    fireEvent.pointerDown(card, { pointerId: 1, button: 0, clientX: 100, clientY: 60 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 700, clientY: 400 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 700, clientY: 400 });

    expect(noMutation.mutateAsync).not.toHaveBeenCalled();
  });

  it("places a lesson dragged from it onto the grid", () => {
    state.lessons = parkedSlojd();
    render(<TimetablePage />);
    const handle = screen.getByRole("button", {
      name: "timetable.dragToPlace(Slöjd · 5.1 · K. Ek)",
    });
    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 700, clientY: 100 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 200, clientY: 60 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 200, clientY: 60 });

    // Arrives PLACED, on Tuesday, in one call — the server checks the slot.
    expect(noMutation.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ id: "l-slojd", isParked: false, dayOfWeek: 2 }),
    );
  });

  it("frees the slot a parked lesson remembers", () => {
    /*
     * The reason the tray exists. Matematik (4ma1) is parked from Monday
     * 08:00; Slöjd is dragged into that hour. With the parked lesson still
     * counted as an occupant — same teacher, same time — the grid would refuse
     * the drop and open the suggestions instead.
     */
    state.lessons = LESSONS.map((l) => (l.id === "l-ma1" ? { ...l, isParked: true } : l));
    render(<TimetablePage />);
    const card = screen
      .queryAllByRole("button")
      .find((el) => el.textContent?.includes("Slöjd"))!;
    // The card spans y 198–264 (11:00–12:00 at 1.1 px/min). Grabbed near its
    // foot at y 260 (≈11:56, a grab offset of 56 min), the START lands on
    // 08:00 when the pointer lets go at 480 + 56 min → y 62 — INSIDE the grid.
    // A first draft released above the top edge, which is "outside" and quite
    // rightly went to the tray handler instead of the grid.
    fireEvent.pointerDown(card, { pointerId: 1, button: 0, clientX: 100, clientY: 260 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 100, clientY: 62 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 100, clientY: 62 });

    expect(screen.queryByText("timetable.suggestTitle")).toBeNull();
    expect(noMutation.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ id: "l-slojd", dayOfWeek: 1, startTime: "08:00" }),
    );
  });
});

describe("why there is no lunch band", () => {
  const enabled = () => {
    state.lunchSettings = {
      id: "ls-1",
      lunchEnabled: true,
      lunchStartTime: "11:00",
      lunchEndTime: "13:00",
      lunchMinutes: 30,
    };
  };
  const sitting = (studentGroupId: string) => ({
    id: `s-${studentGroupId}`,
    studentGroupId,
    dayOfWeek: 1,
    startTime: "11:40:00",
    endTime: "12:00:00",
    headcount: 24,
  });

  it("says the year has not been generated, and offers to", async () => {
    // Rasts appear the moment they are declared; the meal only after a run.
    // A school that has just declared its rasts reads the missing lunch as a
    // bug unless the grid says which of the two it is.
    enabled();
    state.sittings = [];
    render(<TimetablePage />);
    await filterTo("4.1");

    const status = screen.getByRole("status");
    expect(status.textContent).toContain("timetable.noSittingsYear");
    expect(screen.getByRole("link", { name: "timetable.noSittingsYearLink" })).toHaveAttribute(
      "href",
      "/admin/generate",
    );
  });

  it("names the class when the year has meals but this class has none", async () => {
    enabled();
    state.sittings = [sitting("g-42")];
    render(<TimetablePage />);
    await filterTo("4.1");

    expect(screen.getByRole("status").textContent).toContain(
      "timetable.noSittingsGroup(4.1)",
    );
  });

  it("says nothing when the class has its meal", async () => {
    enabled();
    state.sittings = [sitting("g-41")];
    render(<TimetablePage />);
    await filterTo("4.1");

    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getAllByText("lunch.bandLabel")).toHaveLength(1);
  });

  it("says nothing while every class is in view", () => {
    // The bands are hidden there on purpose; a notice about their absence
    // would explain a choice, not a gap.
    enabled();
    state.sittings = [];
    render(<TimetablePage />);

    expect(screen.queryByRole("status")).toBeNull();
  });

  it("says nothing when lunch is switched off", async () => {
    // Then there is no meal to miss. The publish dialog already carries that
    // warning, at the moment it matters.
    state.lunchSettings = { id: "ls-1", lunchEnabled: false };
    state.sittings = [];
    render(<TimetablePage />);
    await filterTo("4.1");

    expect(screen.queryByRole("status")).toBeNull();
  });

  it("says nothing while the sittings are still loading", async () => {
    // undefined is the query in flight, not a year without a meal, and a
    // warning that flashes on every page load teaches people to ignore it.
    enabled();
    state.sittings = undefined;
    render(<TimetablePage />);
    await filterTo("4.1");

    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("placing a lunch by hand", () => {
  /*
   * The school's case: a run refused because locked lessons left 4.1 no lunch
   * gap. The meal has to go somewhere the solver will not put it, and this is
   * the screen where the school can say where.
   */
  beforeEach(() => {
    lunch.create.mutateAsync.mockReset().mockResolvedValue({ id: "placed-1" });
    lunch.update.mutateAsync.mockReset().mockResolvedValue({});
    lunch.remove.mutateAsync.mockReset().mockResolvedValue(undefined);
    state.lunchSettings = {
      id: "ls-1",
      lunchEnabled: true,
      lunchStartTime: "10:30",
      lunchEndTime: "13:00",
      lunchMinutes: 30,
    };
  });
  afterEach(() => vi.restoreAllMocks());

  const meal = (dayOfWeek: number, isGenerated: boolean) => ({
    id: `m-${dayOfWeek}`,
    studentGroupId: "g-41",
    dayOfWeek,
    startTime: "11:40:00",
    endTime: "12:10:00",
    headcount: 24,
    isGenerated,
  });

  it("offers the mode only with one class in view", async () => {
    // A meal belongs to a class. On a grid of several there is no answer to
    // "whose", so there is nothing to place.
    state.sittings = [];
    render(<TimetablePage />);
    expect(screen.queryByRole("button", { name: /^timetable\.placeLunch$/ })).toBeNull();

    await filterTo("4.1");
    expect(screen.getByRole("button", { name: /^timetable\.placeLunch$/ })).toBeTruthy();
  });

  it("offers nothing when the school has no lunch to place", async () => {
    state.lunchSettings = { ...(state.lunchSettings as object), lunchEnabled: false };
    state.sittings = [];
    render(<TimetablePage />);
    await filterTo("4.1");

    expect(screen.queryByRole("button", { name: /^timetable\.placeLunch$/ })).toBeNull();
  });

  it("gives the refused school a way out instead of a loop", async () => {
    // The notice used to link only to the generation screen — the screen that
    // had just refused this school, for exactly this reason.
    state.sittings = [];
    render(<TimetablePage />);
    await filterTo("4.1");

    fireEvent.click(screen.getByRole("button", { name: "timetable.noSittingsPlace" }));

    expect(screen.getByText("timetable.placeLunchHint(30)")).toBeTruthy();
  });

  it("places the class's meal where empty time is clicked, not a lesson", async () => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, top: 0, left: 0, right: 556, bottom: 528, width: 556, height: 528,
      toJSON: () => ({}),
    } as DOMRect);
    state.sittings = [];
    const { container } = render(<TimetablePage />);
    await filterTo("4.1");
    fireEvent.click(screen.getByRole("button", { name: /^timetable\.placeLunch$/ }));

    const columns = container.querySelectorAll('div[class="relative border-l"]');
    expect(columns.length).toBeGreaterThan(0);
    fireEvent.click(columns[0], { clientX: 106, clientY: 200 });

    expect(lunch.create.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ academicYearId: "y-1", studentGroupId: "g-41", dayOfWeek: 1 }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("moves the meal with the keyboard", async () => {
    state.sittings = [meal(1, true)];
    render(<TimetablePage />);
    await filterTo("4.1");

    fireEvent.keyDown(screen.getByRole("button", { name: "timetable.lunchMove" }), {
      key: "ArrowDown",
    });

    expect(lunch.update.mutateAsync).toHaveBeenCalledWith({
      id: "m-1",
      dayOfWeek: 1,
      startTime: "11:55",
    });
  });

  it("will not drop a meal on a day that already has one", async () => {
    // The server would replace the other meal. A drag that silently deleted
    // Tuesday's lunch is the worst thing this gesture could do.
    state.sittings = [meal(1, false), meal(2, false)];
    render(<TimetablePage />);
    await filterTo("4.1");

    const [monday] = screen.getAllByRole("button", { name: "timetable.lunchMove" });
    fireEvent.keyDown(monday, { key: "ArrowRight" });

    expect(lunch.update.mutateAsync).not.toHaveBeenCalled();
  });

  it("removes a meal the school placed, and only one it placed", async () => {
    state.sittings = [meal(1, true)];
    const { unmount } = render(<TimetablePage />);
    await filterTo("4.1");
    expect(screen.queryByRole("button", { name: "timetable.lunchRemove" })).toBeNull();
    unmount();

    state.sittings = [meal(1, false)];
    render(<TimetablePage />);
    await filterTo("4.1");
    fireEvent.click(screen.getByRole("button", { name: "timetable.lunchRemove" }));

    expect(lunch.remove.mutateAsync).toHaveBeenCalledWith("m-1");
  });
});

