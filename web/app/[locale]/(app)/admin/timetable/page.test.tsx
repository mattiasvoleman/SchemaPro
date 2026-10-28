import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TimetablePage from "./page";
import { buildIcs } from "@/lib/ics";
import { exportTimetablePdf } from "@/lib/pdf";
import { ApiError } from "@/lib/api";
import { ProfileProvider } from "@/components/profile-context";
import type { Profile } from "@/lib/types";

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
  // undefined models a board never read: the first request failed.
  lessons: [] as unknown[] | undefined,
  /** The last read of the lessons failed (a first read, or a refetch over a cached board). */
  lessonsFailed: false,
  // undefined models the query in flight, which is a different fact from an
  // empty roster and must reach the page as one.
  memberships: [] as unknown[] | undefined,
  lunchSettings: null as unknown,
  // undefined models the query in flight; [] is a year the solver has not
  // yet placed a meal for. The notice must tell the two apart.
  sittings: [] as unknown[] | undefined,
  // The saved versions, and the snapshot the dialog fetches for the one being
  // compared.
  versions: [] as unknown[],
  snapshot: null as unknown,
  // Next year's grundschema, which useMasterLessons answers for "y-2".
  nextLessons: [] as unknown[],
  /** The year each year-keyed read was last asked for. */
  askedFor: {} as Record<string, string | null>,
  /** The years themselves still on their way (the page's state ladder). */
  yearsLoading: false,
  /** The year's timplansposter: only their blockId is read here (Block i schemat). */
  requirements: [] as unknown[],
  /** GROUPS and PEOPLE unless a row adds to them; null between tests. */
  groups: null as unknown[] | null,
  people: null as unknown[] | null,
}));

/*
 * Block i schemat (components/schedule/block-cards.tsx): the year's block
 * names as PostgREST answers them, and the card's own writes, which go to the
 * gateway past the page's mutation hooks.
 */
const blockNames = vi.hoisted(() => ({
  read: vi.fn(async () => ({ data: [{ id: "b-sv", academicYearId: "y-1", name: "Språkval åk 4" }], error: null })),
}));
vi.mock("@/utils/supabase/client", () => ({
  createClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ order: blockNames.read }) }) }),
  }),
}));
const blockApi = vi.hoisted(() => ({ patch: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  return { ...real, api: { ...real.api, patch: blockApi.patch } };
});

/**
 * The year choice (lib/planning-year.ts), as a hook with the real one's
 * contract: this year unless next year was picked, and the gateway's rosters
 * only for next year. What the gateway sends is the test's to set; whether
 * the page lays it over its people is what is under test.
 */
const planning = vi.hoisted(() => ({
  active: {
    id: "y-1",
    name: "2026/27",
    isActive: true,
    predecessorId: null as string | null,
    startDate: "2026-08-17",
    endDate: "2027-06-11",
    /** Absent is NIOARIG; the tioårig rast rows set it and put it back. */
    gradeNumbering: undefined as "NIOARIG" | "TIOARIG" | undefined,
  },
  successor: null as null | {
    id: string;
    name: string;
    isActive: boolean;
    predecessorId: string | null;
    startDate: string;
    endDate: string;
    gradeNumbering?: "NIOARIG" | "TIOARIG";
  },
  rosters: null as unknown,
}));

vi.mock("@/lib/planning-year", async () => {
  const { useState } = await import("react");
  return {
    usePlanningYear: () => {
      const [yearId, setYearId] = useState(planning.active.id);
      const year =
        [planning.active, planning.successor].find((entry) => entry?.id === yearId) ??
        planning.active;
      return {
        year,
        active: planning.active,
        successor: planning.successor,
        choose: setYearId,
        rosters: year.isActive ? null : planning.rosters,
        rostersFailed: false,
      };
    },
  };
});

const noMutation = { mutateAsync: vi.fn().mockResolvedValue({ id: "x" }), isPending: false };

/** The room optimisation's two calls, each a spy a wiring test can steer. */
const roomOptimization = {
  propose: { mutateAsync: vi.fn(), isPending: false },
  apply: { mutateAsync: vi.fn(), isPending: false },
};

/** The three verbs of a meal placed by hand, each a spy a test can read. */
const lunch = {
  create: { mutateAsync: vi.fn(), isPending: false },
  update: { mutateAsync: vi.fn(), isPending: false },
  remove: { mutateAsync: vi.fn(), isPending: false },
};

vi.mock("@/lib/queries", () => ({
  // Read by the page's state ladder only; the year itself comes from the
  // usePlanningYear mock above.
  useAcademicYears: () => ({ isLoading: state.yearsLoading, isError: false }),
  useMasterLessons: (yearId: string | null) => {
    state.askedFor.lessons = yearId;
    return {
      data: yearId === "y-2" ? state.nextLessons : state.lessons,
      isLoading: false,
      isError: state.lessonsFailed,
    };
  },
  useGroups: () => ({ data: state.groups ?? GROUPS }),
  usePeople: () => ({ data: state.people ?? PEOPLE }),
  useRooms: () => ({ data: ROOMS }),
  useSubjects: () => ({ data: SUBJECTS }),
  useRequirements: (yearId: string | null) => {
    state.askedFor.requirements = yearId;
    return { data: state.requirements };
  },
  useConstraints: () => ({ data: [] }),
  useGroupMemberships: () => ({ data: state.memberships }),
  useFrameTimes: () => ({ data: [] }),
  useLunchSettings: () => ({ data: state.lunchSettings }),
  useLunchSittings: (yearId: string | null) => {
    state.askedFor.sittings = yearId;
    return { data: state.sittings };
  },
  useLunchSittingMutations: () => lunch,
  useRoomPreferences: () => ({ data: [] }),
  useRasts: () => ({ data: RASTS }),
  // Read by the Lektionstid panel once it is opened.
  useSchoolBreaks: () => ({ data: [] }),
  useScheduleVersions: () => ({ data: state.versions }),
  useScheduleVersionDetail: (id: string | null) => ({ data: id ? state.snapshot : null }),
  useScheduleVersionActions: () => ({
    save: noMutation,
    restore: noMutation,
    remove: noMutation,
  }),
  // Imported by the room optimisation dialog the page renders.
  useRoomOptimization: () => roomOptimization,
  useCreateMasterLesson: () => noMutation,
  useUpdateMasterLesson: () => noMutation,
  useDeleteMasterLesson: () => noMutation,
}));

/*
 * Publicering (lib/publication-queries.ts) as the gateway would answer: the
 * school's mode, a timeline whose today is Saturday 2026-10-10, the draft's
 * changes in utkastläge, and a dry run whose warnings a row can switch on.
 */
const publication = vi.hoisted(() => ({
  mode: "DIRECT" as "DIRECT" | "DRAFT",
  needsAcknowledgement: false,
  draftPending: false,
  publish: { mutateAsync: vi.fn(), isPending: false },
}));
vi.mock("@/lib/publication-queries", () => ({
  usePublicationSettings: () => ({ data: { publishMode: publication.mode }, isError: false }),
  usePublicationTimeline: (yearId: string | null) => ({
    data: yearId
      ? { academicYearId: yearId, today: "2026-10-10", publications: [], segments: [], validNow: null }
      : undefined,
    isError: false,
  }),
  useDraftState: (_yearId: string | null, enabled: boolean) => ({
    data: enabled
      ? {
          academicYearId: "y-1",
          publishMode: "DRAFT",
          publicationId: "p-1",
          added: [],
          changed: [
            {
              before: { id: "l-slojd", subjectId: "s-sl", studentGroupId: "g-41", teacherId: null, coTeacherId: null, roomId: null, dayOfWeek: 1, startTime: "11:00", endTime: "12:00", isParked: false },
              after: { id: "l-slojd", subjectId: "s-sl", studentGroupId: "g-41", teacherId: null, coTeacherId: null, roomId: null, dayOfWeek: 2, startTime: "11:00", endTime: "12:00", isParked: false },
            },
          ],
          removed: [{ id: "l-gone", subjectId: "s-sl", studentGroupId: "g-41", teacherId: null, coTeacherId: null, roomId: null, dayOfWeek: 3, startTime: "08:00", endTime: "09:00", isParked: false }],
          pendingRemovals: 0,
        }
      : undefined,
  }),
  usePublicationPreview: (range: { academicYearId: string; validFrom: string; validTo: string } | null) => ({
    data: range
      ? {
          ...range,
          publishMode: publication.mode,
          result: { created: 120, cancelled: 2, skipped: 30, fromDate: range.validFrom, toDate: range.validTo },
          gates: publication.needsAcknowledgement
            ? [{ code: "PUB_NO_ROOM", severity: "WARN", count: 1, items: [{ label: "Slöjd · 4.1, mån 11:00" }], params: {} }]
            : [],
          refused: false,
          needsAcknowledgement: publication.needsAcknowledgement,
          digest: "d".repeat(64),
        }
      : undefined,
    isFetching: false,
    isError: false,
  }),
  usePublishTimetable: () => publication.publish,
}));
vi.mock("@/lib/publication-draft-notice", () => ({
  draftPendingFor: vi.fn(async () => publication.draftPending),
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
  useTranslations: (namespace: string) =>
    Object.assign(
      (key: string, values?: Record<string, unknown>) =>
        values
          ? `${namespace}.${key}(${Object.values(values).join("|")})`
          : `${namespace}.${key}`,
      // engineMessage asks before it renders a code; every key exists here.
      { has: () => true },
    ),
}));

const toasts = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: toasts }));

/*
 * Justera as it really is, unless a row says its chunk did not arrive: then it
 * throws while it renders, which is what lazy() does with a fetch that failed
 * (see "a lesson dialog whose code does not arrive").
 */
const lessonDialogsLoad = vi.hoisted(() => ({ fail: false }));
vi.mock("@/components/schedule/lesson-edit-dialog", async (importOriginal) => {
  const { createElement } = await import("react");
  const real =
    await importOriginal<typeof import("@/components/schedule/lesson-edit-dialog")>();
  return {
    ...real,
    LessonEditDialog: (props: Parameters<typeof real.LessonEditDialog>[0]) => {
      if (lessonDialogsLoad.fail) throw new Error("Failed to load chunk lesson-dialogs");
      return createElement(real.LessonEditDialog, props);
    },
  };
});

/*
 * The selection's bar as it really is, unless a row says its chunk did not
 * arrive: then it throws while it renders, as lazy() does with a fetch that
 * failed. Every draw is noted, so a row can see that the bar was in hand
 * before anything was selected.
 */
const selectionBarLoad = vi.hoisted(() => ({ fail: false, draws: [] as boolean[] }));
vi.mock("@/components/schedule/selection-bar", async (importOriginal) => {
  const { createElement } = await import("react");
  const real = await importOriginal<typeof import("@/components/schedule/selection-bar")>();
  return {
    ...real,
    SelectionBar: (props: Parameters<typeof real.SelectionBar>[0]) => {
      selectionBarLoad.draws.push(props.shown);
      if (selectionBarLoad.fail) throw new Error("Failed to load chunk lesson-dialogs");
      return createElement(real.SelectionBar, props);
    },
  };
});

/* The two exports as they really are, unless a row says their chunk did not arrive. */
const exportsLoad = vi.hoisted(() => ({ fail: false }));
vi.mock("./timetable-exports", async (importOriginal) => {
  const real = await importOriginal<typeof import("./timetable-exports")>();
  const arrive = () => {
    if (exportsLoad.fail) throw new Error("Failed to load chunk timetable-exports");
  };
  return {
    ...real,
    exportIcs: async (input: Parameters<typeof real.exportIcs>[0]) => {
      arrive();
      return real.exportIcs(input);
    },
    exportPdf: async (input: Parameters<typeof real.exportPdf>[0]) => {
      arrive();
      return real.exportPdf(input);
    },
  };
});

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
  // Next year's 5.1: this year's 4.1, rolled over and not yet active. Same
  // name as this year's 5.1, no lesson in this schedule.
  { id: "g-next-51", academicYearId: "y-2", name: "5.1", kind: "CLASS", gradeLevel: 5 },
  // Next year's 5.2 (this year's 4.2), and its maths group, carried at the
  // rollover with Alva in it.
  { id: "g-next-52", academicYearId: "y-2", name: "5.2", kind: "CLASS", gradeLevel: 5 },
  {
    id: "g-next-5ma",
    academicYearId: "y-2",
    name: "5ma1",
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
    coTeacherId: null as string | null,
    roomId: overrides.roomId ?? null,
    dayOfWeek: 1,
    startTime,
    endTime: `${String(Number(startTime.slice(0, 2)) + 1).padStart(2, "0")}:00`,
    isLocked: false,
    isParked: false,
    recurrence: "ALL_WEEKS",
    startDate: null as string | null,
    endDate: null as string | null,
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
  state.lessonsFailed = false;
  state.memberships = MEMBERSHIPS;
  state.lunchSettings = null;
  state.sittings = [];
  state.versions = [];
  state.snapshot = null;
  state.nextLessons = [];
  state.askedFor = {};
  state.yearsLoading = false;
  state.requirements = [];
  state.groups = null;
  state.people = null;
  planning.successor = null;
  planning.rosters = null;
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

/**
 * Pick one of the header's overflow actions: Optimera salar, the two exports
 * and Skriv ut sit behind "Fler åtgärder" since the header was cut to four
 * controls (the design overhaul's header rule), and each runs once the menu
 * has closed.
 */
async function fromMoreMenu(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole("button", { name: "timetable.moreActions" }));
  await user.click(await screen.findByRole("menuitem", { name }));
}

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
  it("offers the groups of the year on screen only", async () => {
    // Between a rollover and its activation every class name exists twice.
    const user = userEvent.setup();
    render(<TimetablePage />);
    await user.click(screen.getByRole("button", { name: "timetable.filterGroup" }));
    expect(await screen.findAllByRole("menuitemcheckbox", { name: "5.1" })).toHaveLength(1);
  });

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
  it("names the classes before the drag takes effect", async () => {
    render(<TimetablePage />);
    // Not filtered to anything: the question is asked of the LESSON. 4ma1 holds
    // Alva and Bo of 4.1 and Eva of 4.2, so this drag moves 4.2's week too.
    dragToTuesday("Matematik");
    // Awaited: the dialog's code is fetched the first time it is needed.
    expect(await screen.findByText("timetable.sharedMoveTitle")).toBeInTheDocument();
    expect(screen.getByText(/timetable.sharedMoveBody\(4\.1, 4\.2\)/)).toBeInTheDocument();
    expect(noMutation.mutateAsync).not.toHaveBeenCalled();
  });

  it("applies the move once it is confirmed", async () => {
    const user = userEvent.setup();
    render(<TimetablePage />);
    dragToTuesday("Matematik");
    // Läsbehörighet: the confirmation is the move itself.
    expect(await screen.findByRole("button", { name: "timetable.sharedMoveConfirm" })).toHaveAttribute(
      "data-writes",
      "SCHEMALAGGNING DRIFT",
    );
    await user.click(await screen.findByRole("button", { name: "timetable.sharedMoveConfirm" }));
    expect(noMutation.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ id: "l-ma1" }),
    );
  });

  it("drops the move when it is cancelled", async () => {
    const user = userEvent.setup();
    render(<TimetablePage />);
    dragToTuesday("Matematik");
    await user.click(await screen.findByRole("button", { name: "common.cancel" }));
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
    await fromMoreMenu(user, "timetable.exportIcs");
    // Awaited: the builder is fetched when the button is pressed, so the call
    // lands a tick after the click rather than during it.
    await waitFor(() => expect(buildIcs).toHaveBeenCalled());
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
    await fromMoreMenu(user, "timetable.exportPdf");
    await waitFor(() => expect(exportTimetablePdf).toHaveBeenCalled());
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

  /*
   * A tioårig läsår on screen (SFS 2025:729). A rast is school-wide and stated
   * in NIOARIG (grade-numbering.ts), and a TIOARIG läsår's classes are one
   * higher than the same children in it, so the page reads the class's span
   * in NIOARIG through the shown year's numbering before it asks which rasts
   * bind — the one map frames, year rules and room locks are judged by too.
   * Its 7.1 is the 6 the 4–6 rast was written for; its 4.1 the 3 it never
   * reached.
   */
  describe("in a tioårig läsår", () => {
    afterEach(() => {
      planning.active.gradeNumbering = undefined;
    });

    it("draws the 4–6 rast for 7.1, the NIOARIG 6", async () => {
      planning.active.gradeNumbering = "TIOARIG";
      render(<TimetablePage />);
      await filterTo("7.1");
      expect(screen.getAllByText("Förmiddagsrast")).toHaveLength(5);
    });

    it("draws nothing for 4.1, the NIOARIG 3", async () => {
      planning.active.gradeNumbering = "TIOARIG";
      render(<TimetablePage />);
      await filterTo("4.1");
      expect(screen.queryByText("Förmiddagsrast")).toBeNull();
    });

    it("reads a year numbered NIOARIG as the unnumbered one above", async () => {
      // The first two rows of this describe, with the numbering spelled out.
      planning.active.gradeNumbering = "NIOARIG";
      render(<TimetablePage />);
      await filterTo("7.1");
      expect(screen.queryByText("Förmiddagsrast")).toBeNull();
      cleanup();
      render(<TimetablePage />);
      await filterTo("4.1");
      expect(screen.getAllByText("Förmiddagsrast")).toHaveLength(5);
    });
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
    // create a lesson for them; asking again would be asking twice. (The
    // dialog's code arrives on that first click: create-lesson-dialog.tsx.)
    expect(
      (await screen.findByRole("combobox", { name: "timetable.addGroup" })).textContent,
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
      (await screen.findByRole("combobox", { name: "timetable.editTeacher" })).textContent,
    ).toBe("timetable.noTeacher");
    // The group placeholder, not one of the two picked.
    expect(
      screen.getByRole("combobox", { name: "timetable.addGroup" }).textContent,
    ).toBe("timetable.addGroup");
  });
});

describe("the edit dialog", () => {
  it("names the lesson it opened on", async () => {
    // Three maths lessons on a Tuesday all opened on "Justera lektion" and
    // nothing else, and the reader had to remember which one they clicked.
    render(<TimetablePage />);
    const card = screen
      .queryAllByRole("button")
      .find((el) => el.textContent?.includes("Slöjd"))!;
    fireEvent.pointerDown(card, { pointerId: 1, button: 0, clientX: 100, clientY: 60 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 100, clientY: 60 });

    // Awaited: the dialog's code arrives after the click when it is not yet cached.
    expect((await screen.findByRole("dialog")).textContent).toContain("Slöjd · 5.1 · K. Ek");
  });

  it("can set the lesson aside from there", async () => {
    const user = userEvent.setup();
    render(<TimetablePage />);
    const card = screen
      .queryAllByRole("button")
      .find((el) => el.textContent?.includes("Slöjd"))!;
    fireEvent.pointerDown(card, { pointerId: 1, button: 0, clientX: 100, clientY: 60 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 100, clientY: 60 });

    await user.click(await screen.findByRole("button", { name: "timetable.park" }));

    expect(noMutation.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ id: "l-slojd", isParked: true }),
    );
  });
});

describe("a re-teachered lesson under the staffing policy", () => {
  /*
   * PATCH /master-lessons/:id answers a new teacher with the policy's verdict:
   * WARN as `warnings` beside the saved lesson, REFUSE as a 409 with a STAFF_*
   * code. Both used to vanish here — the warning was never read, and the
   * refusal was toasted as "Schemakonflikt: …" in the gateway's Swedish.
   */
  const NOT_QUALIFIED = {
    code: "STAFF_TEACHER_NOT_QUALIFIED",
    params: { role: "TEACHER", subject: "Slöjd", grades: "5" },
  };
  const saveSlojd = async () => {
    const user = userEvent.setup();
    render(<TimetablePage />);
    const card = screen
      .queryAllByRole("button")
      .find((el) => el.textContent?.includes("Slöjd"))!;
    fireEvent.pointerDown(card, { pointerId: 1, button: 0, clientX: 100, clientY: 60 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 100, clientY: 60 });
    await user.click(await screen.findByRole("button", { name: "common.save" }));
  };

  beforeEach(() => {
    toasts.success.mockClear();
    toasts.error.mockClear();
    toasts.warning.mockClear();
  });
  afterEach(() => {
    noMutation.mutateAsync.mockReset().mockResolvedValue({ id: "x" });
  });

  it("says a WARN out loud: saved, with the policy's sentence", async () => {
    noMutation.mutateAsync.mockResolvedValue({ id: "l-slojd", propagatedLessons: 2, warnings: [NOT_QUALIFIED] });

    await saveSlojd();

    await waitFor(() => expect(toasts.warning).toHaveBeenCalledTimes(1));
    const [title, options] = toasts.warning.mock.calls[0]!;
    expect(title).toBe("timetable.editSaved(2)");
    expect(options.description).toBe("engineMessages.STAFF_TEACHER_NOT_QUALIFIED(TEACHER|Slöjd|5)");
    expect(toasts.success).not.toHaveBeenCalled();
  });

  it("says an ämnesfördelning breach the same way: saved, with the rule's sentence", async () => {
    // Two idrott on one Monday by hand is allowed and warned about, never a 409.
    const TOO_MANY = {
      code: "DISTRIBUTION_TOO_MANY_ON_DAY",
      params: { requirement: "Slöjd för 5.1", day: 1, count: 2, maxPerDay: 1 },
    };
    noMutation.mutateAsync.mockResolvedValue({ id: "l-slojd", propagatedLessons: 0, warnings: [TOO_MANY] });

    await saveSlojd();

    await waitFor(() => expect(toasts.warning).toHaveBeenCalledTimes(1));
    const [title, options] = toasts.warning.mock.calls[0]!;
    expect(title).toBe("timetable.editSaved(0)");
    expect(options.description).toBe("engineMessages.DISTRIBUTION_TOO_MANY_ON_DAY(Slöjd för 5.1|1|2|1)");
  });

  it("says a breach of the teacher's day the same way, the days masked for a reader without HR-läs", async () => {
    // Lärarens dag: the gateway warns, never refuses, and words the days per
    // reader. The page adds no code for it — savedToast renders any code. The
    // lesson is named in the sentence (`requirement`, as a distribution
    // warning names it): on a block card the role alone could be any member's.
    const TOO_LONG = {
      code: "TEACHER_DAY_TOO_LONG",
      params: { role: "LEAD", requirement: "Slöjd för 5.1", day: 1, minutes: 330, cap: 300 },
    };
    const TOO_MANY_HIDDEN = {
      code: "TEACHER_WEEK_TOO_MANY_DAYS_HIDDEN",
      params: { role: "LEAD", requirement: "Slöjd för 5.1" },
    };
    noMutation.mutateAsync.mockResolvedValue({
      id: "l-slojd",
      propagatedLessons: 0,
      warnings: [TOO_LONG, TOO_MANY_HIDDEN],
    });

    await saveSlojd();

    await waitFor(() => expect(toasts.warning).toHaveBeenCalledTimes(1));
    const [, options] = toasts.warning.mock.calls[0]!;
    expect(options.description).toBe(
      "engineMessages.TEACHER_DAY_TOO_LONG(LEAD|Slöjd för 5.1|1|330|300) engineMessages.TEACHER_WEEK_TOO_MANY_DAYS_HIDDEN(LEAD|Slöjd för 5.1)",
    );
  });

  it("warns about a lesson placed by hand as it is created, too", async () => {
    // Duplicated, so the new lesson's subject and class are filled in.
    const TOO_CLOSE = {
      code: "DISTRIBUTION_DAYS_TOO_CLOSE",
      params: { requirement: "Slöjd för 5.1", firstDay: 1, secondDay: 2, minDaysBetween: 2 },
    };
    noMutation.mutateAsync.mockResolvedValue({ id: "l-copy", warnings: [TOO_CLOSE] });
    const user = userEvent.setup();
    render(<TimetablePage />);
    const card = screen
      .queryAllByRole("button")
      .find((el) => el.textContent?.includes("Slöjd"))!;
    fireEvent.pointerDown(card, { pointerId: 1, button: 0, clientX: 100, clientY: 60 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 100, clientY: 60 });
    await user.click(await screen.findByRole("button", { name: "timetable.duplicateLesson" }));
    await user.click(await screen.findByRole("button", { name: "timetable.addConfirm" }));

    await waitFor(() => expect(toasts.warning).toHaveBeenCalledTimes(1));
    const [title, options] = toasts.warning.mock.calls[0]!;
    expect(title).toBe("timetable.created");
    expect(options.description).toBe("engineMessages.DISTRIBUTION_DAYS_TOO_CLOSE(Slöjd för 5.1|1|2|2)");
    expect(toasts.success).not.toHaveBeenCalled();
  });

  it("shows a REFUSE as the policy's sentence, not as a schedule clash", async () => {
    noMutation.mutateAsync.mockRejectedValue(
      new ApiError(409, "Läraren saknar behörighet i Slöjd för åk 5.", NOT_QUALIFIED.code, NOT_QUALIFIED.params),
    );

    await saveSlojd();

    await waitFor(() => expect(toasts.error).toHaveBeenCalledTimes(1));
    const [text] = toasts.error.mock.calls[0]!;
    expect(text).toContain("engineMessages.STAFF_TEACHER_NOT_QUALIFIED(TEACHER|Slöjd|5)");
    expect(text).not.toContain("timetable.editConflict");
  });
});

describe("the edit dialog's width", () => {
  /*
   * jsdom lays nothing out, so "does it scroll sideways" is unobservable here.
   * What is asserted is the three tokens that decide it — the same way
   * gaps/page.test.tsx asserts h-11 for a touch target it cannot measure.
   */
  const openSlojd = async () => {
    render(<TimetablePage />);
    const card = screen
      .queryAllByRole("button")
      .find((el) => el.textContent?.includes("Slöjd"))!;
    fireEvent.pointerDown(card, { pointerId: 1, button: 0, clientX: 100, clientY: 60 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 100, clientY: 60 });
    return screen.findByRole("dialog");
  };

  it("keeps the component's own width rather than narrowing it", async () => {
    const dialog = await openSlojd();
    expect(dialog.className).toContain("max-w-lg");
    expect(dialog.className).not.toContain("max-w-md");
  });

  it("lets both button groups wrap onto a second row", async () => {
    await openSlojd();
    for (const name of ["timetable.park", "common.cancel"]) {
      const group = screen.getByRole("button", { name }).parentElement!;
      expect(group.className, name).toContain("flex-wrap");
    }
  });

  it("lets a form cell shrink below its content", async () => {
    // A grid child defaults to min-width:auto and will widen the whole grid
    // to fit a long teacher name rather than let the select ellipsize it.
    const dialog = await openSlojd();
    const grid = dialog.querySelector(".grid-cols-2")!;
    expect(grid.className).toContain("[&>*]:min-w-0");
  });
});

/*
 * The two dialogs whose deepest controls arrive with the dialog's own code:
 * the recurrence fields in the edit dialog and the publish dates. Both
 * dialogs are React.lazy behind a Suspense boundary, and each imports those
 * controls statically, so a loader that never settled would leave no dialog
 * at all — waiting for the controls themselves is what proves the whole body
 * was drawn. The switch sits after the fields in the edit dialog's body.
 */
describe("the controls a dialog fetches when it opens", () => {
  it("finishes drawing the edit dialog", async () => {
    render(<TimetablePage />);
    const card = screen
      .queryAllByRole("button")
      .find((el) => el.textContent?.includes("Slöjd"))!;
    fireEvent.pointerDown(card, { pointerId: 1, button: 0, clientX: 100, clientY: 60 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 100, clientY: 60 });

    expect(
      await screen.findByRole("combobox", { name: "timetable.recurrenceLabel" }),
    ).toBeInTheDocument();
    expect(await screen.findByRole("switch")).toBeInTheDocument();
  });

  it("finishes drawing the publish dialog", async () => {
    const user = userEvent.setup();
    render(<TimetablePage />);

    await user.click(screen.getByRole("button", { name: "timetable.publish" }));

    expect(await screen.findByLabelText("publishing.validFrom")).toBeInTheDocument();
    expect(await screen.findByLabelText("publishing.validTo")).toBeInTheDocument();
  });
});

/*
 * What each lifted dialog DOES, not only that it draws. Justera, Publicera and
 * the placement suggestions live in their own modules now and take their
 * values and callbacks from the page, so a prop wired to the wrong setter or
 * handler would draw a perfectly good dialog that saves nothing. These rows
 * press the buttons and read what reached the API.
 */
describe("the dialogs the page lifts out", () => {
  afterEach(() => {
    noMutation.mutateAsync.mockReset().mockResolvedValue({ id: "x" });
  });

  it("saves what was changed in the edit dialog", async () => {
    const user = userEvent.setup();
    render(<TimetablePage />);
    const card = screen
      .queryAllByRole("button")
      .find((el) => el.textContent?.includes("Slöjd"))!;
    fireEvent.pointerDown(card, { pointerId: 1, button: 0, clientX: 100, clientY: 60 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 100, clientY: 60 });

    // Two fields written by different controls: the lock is the Switch, the
    // end time an input. Both have to reach the page's draft and back.
    await user.click(await screen.findByRole("switch"));
    fireEvent.change(screen.getByLabelText("timetable.editEnd"), {
      target: { value: "12:30" },
    });
    await user.click(screen.getByRole("button", { name: "common.save" }));

    await waitFor(() =>
      expect(noMutation.mutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "l-slojd",
          isLocked: true,
          startTime: "11:00",
          endTime: "12:30",
        }),
      ),
    );
  });

  it("offers the free times when a drop is refused, and moves the lesson to the one picked", async () => {
    const user = userEvent.setup();
    render(<TimetablePage />);
    // Slöjd onto Monday 08:00, which Matematik (4ma1) holds with the same
    // teacher — the drop "frees the slot a parked lesson remembers" makes
    // with Matematik parked, made here with it in place.
    const card = screen
      .queryAllByRole("button")
      .find((el) => el.textContent?.includes("Slöjd"))!;
    fireEvent.pointerDown(card, { pointerId: 1, button: 0, clientX: 100, clientY: 260 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 100, clientY: 62 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 100, clientY: 62 });

    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("timetable.suggestTitle");
    const options = Array.from(dialog.querySelectorAll("button")).filter((button) =>
      button.textContent?.includes("–"),
    );
    expect(options.length).toBeGreaterThan(0);
    // Läsbehörighet: each free time picked is a move.
    for (const option of options) expect(option).toHaveAttribute("data-writes", "SCHEMALAGGNING DRIFT");
    await user.click(options[0]!);

    await waitFor(() =>
      expect(noMutation.mutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ id: "l-slojd" }),
      ),
    );
  });

  it("searches the week for a free time from Lägg till", async () => {
    // The slot finder's search is awaited from the lesson dialogs' chunk now,
    // not called in the page; its answer has to reach the dialog all the same.
    const user = userEvent.setup();
    render(<TimetablePage />);
    const card = screen
      .queryAllByRole("button")
      .find((el) => el.textContent?.includes("Slöjd"))!;
    fireEvent.pointerDown(card, { pointerId: 1, button: 0, clientX: 100, clientY: 60 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 100, clientY: 60 });
    // Duplicera fills Lägg till with Slöjd and 5.1, which the search needs.
    await user.click(await screen.findByRole("button", { name: "timetable.duplicateLesson" }));
    await user.click(await screen.findByRole("button", { name: "timetable.slotFinderSearch" }));

    expect(
      await screen.findAllByText(/timetable\.slotFinder(Assigned|Fallback|None)/),
    ).not.toHaveLength(0);
  });

  it("publishes the year on screen from the review dialog, from the school's today, with the dry run's digest", async () => {
    publication.publish.mutateAsync.mockReset().mockResolvedValue({ result: { created: 120 } });
    const user = userEvent.setup();
    render(<TimetablePage />);

    await user.click(screen.getByRole("button", { name: "timetable.publish" }));
    expect(await screen.findByText("publishing.previewResult(120|2|30)")).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "publishing.publishConfirm" }));

    // Direct mode: from the gateway's today (not the year's first day, which
    // re-created past lessons) to the year's last; no warning to acknowledge.
    await waitFor(() =>
      expect(publication.publish.mutateAsync).toHaveBeenCalledWith({
        academicYearId: "y-1",
        validFrom: "2026-10-10",
        validTo: "2027-06-11",
        expectedDigest: "d".repeat(64),
      }),
    );
  });

  it("names the warnings and publishes only through Publicera ändå", async () => {
    publication.needsAcknowledgement = true;
    publication.publish.mutateAsync.mockReset().mockResolvedValue({ result: { created: 1 } });
    const user = userEvent.setup();
    render(<TimetablePage />);

    await user.click(screen.getByRole("button", { name: "timetable.publish" }));
    expect(await screen.findByText("Slöjd · 4.1, mån 11:00")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "publishing.publishConfirm" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "publishing.publishAnyway" }));

    await waitFor(() =>
      expect(publication.publish.mutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ acknowledgeWarnings: true, expectedDigest: "d".repeat(64) }),
      ),
    );
    publication.needsAcknowledgement = false;
  });
});

/*
 * The lesson dialogs' chunk arriving late is one thing; not arriving at all is
 * another — a dropped connection, or an old tab after a deploy. Justera,
 * Publicera and the two drag questions used to ship inside the route and could
 * not fail this way. Now their lazy() rethrows the failed fetch while it
 * renders, and with no error boundary on the way up (the app has no error.tsx)
 * Next replaces the whole page with its client-exception screen.
 *
 * lazy() hands a failed fetch to React as an error thrown while the dialog
 * renders; the mock at the top (lessonDialogsLoad) throws the same way from
 * Justera, the one lifted dialog a row can reach with a single press.
 */
/*
 * Utkastläge on the grid: the badge says how much of the grundschema is not
 * published and opens the review with the draft against the published one;
 * an export of an unpublished draft says so. In direct mode — the default —
 * neither appears.
 */
describe("the grid in utkastläge", () => {
  afterEach(() => {
    publication.mode = "DIRECT";
    publication.draftPending = false;
  });

  it("shows no badge in direct mode", async () => {
    render(<TimetablePage />);
    // The lesson dialogs' chunk has arrived once the publish button can open it.
    await screen.findByRole("button", { name: "timetable.publish" });
    await waitFor(() => expect(screen.queryByText(/publishing\.badge/)).toBeNull());
  });

  it("counts the draft's changes and opens the review on them, defaulting to the next Monday", async () => {
    publication.mode = "DRAFT";
    const user = userEvent.setup();
    render(<TimetablePage />);

    await user.click(await screen.findByText("publishing.badgePending(2)"));

    expect(await screen.findByText("publishing.diffSummary(0|1|1)")).toBeInTheDocument();
    // The moved Slöjd, named and said what moved; the removed lesson, named.
    expect(screen.getByText("Slöjd · 4.1 · days.2 11:00–12:00 (publishing.diffField.time)")).toBeInTheDocument();
    expect(screen.getByText("Slöjd · 4.1 · days.3 08:00–09:00")).toBeInTheDocument();
    // Saturday's today: a draft is offered from Monday, so no week is split.
    expect(screen.getByText("publishing.previewResult(120|2|30)")).toBeInTheDocument();
    expect(screen.getByLabelText("publishing.validFrom")).toHaveValue("2026-10-12");
  });

  it("marks a PDF of an unpublished draft", async () => {
    publication.mode = "DRAFT";
    publication.draftPending = true;
    vi.mocked(exportTimetablePdf).mockClear();
    const user = userEvent.setup();
    render(<TimetablePage />);
    await fromMoreMenu(user, "timetable.exportPdf");
    await waitFor(() => expect(exportTimetablePdf).toHaveBeenCalled());
    expect(vi.mocked(exportTimetablePdf).mock.calls[0]![0].subtitle).toBe("2026/27 · timetable.draftExportNotice");
  });
});

describe("a lesson dialog whose code does not arrive", () => {
  afterEach(() => {
    lessonDialogsLoad.fail = false;
  });

  it("says so, keeps the page, and opens the dialog on the next try", async () => {
    lessonDialogsLoad.fail = true;
    toasts.error.mockClear();
    render(<TimetablePage />);

    const openSlojd = () => {
      const card = screen
        .queryAllByRole("button")
        .find((el) => el.textContent?.includes("Slöjd"))!;
      fireEvent.pointerDown(card, { pointerId: 1, button: 0, clientX: 100, clientY: 60 });
      fireEvent.pointerUp(window, { pointerId: 1, clientX: 100, clientY: 60 });
    };

    openSlojd();
    await waitFor(() =>
      expect(toasts.error).toHaveBeenCalledWith("Failed to load chunk lesson-dialogs"),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "timetable.publish" })).toBeInTheDocument();

    // The connection is back: the same press opens Justera this time.
    lessonDialogsLoad.fail = false;
    openSlojd();
    expect((await screen.findByRole("dialog")).textContent).toContain("Slöjd · 5.1 · K. Ek");
    expect(toasts.error).toHaveBeenCalledTimes(1);
  });
});

describe("the selection's bar", () => {
  beforeEach(() => {
    selectionBarLoad.draws = [];
    toasts.error.mockClear();
    toasts.success.mockClear();
    noMutation.mutateAsync.mockReset().mockResolvedValue({ id: "x" });
  });
  afterEach(() => {
    selectionBarLoad.fail = false;
  });

  const selectSlojd = (container: HTMLElement) =>
    fireEvent.keyDown(container.querySelector('[data-lesson-id="l-slojd"]')!, {
      key: "Enter",
      shiftKey: true,
    });

  it("is in hand before anything is selected, so the first selection shows it at once", async () => {
    const { container } = render(<TimetablePage />);
    // Drawn, empty, as soon as the lessons are read: its code has arrived.
    await waitFor(() => expect(selectionBarLoad.draws).toContain(false));

    selectSlojd(container);
    // In the same commit as the selection: nothing suspends, nothing waits.
    expect(screen.getByText("timetable.bulkSelected(1)")).toBeInTheDocument();
  });

  it("lets a selection go once when its code does not arrive, and fetches it again at the next one", async () => {
    selectionBarLoad.fail = true;
    const { container } = render(<TimetablePage />);
    // The first fetch fails with nothing selected: nobody lost anything, so
    // nothing is said.
    await waitFor(() => expect(selectionBarLoad.draws.length).toBeGreaterThan(0));
    expect(toasts.error).not.toHaveBeenCalled();

    // The next selection fetches again, fails again, and lets the selection go.
    const drawn = selectionBarLoad.draws.length;
    selectSlojd(container);
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith("timetable.selectionReleased"));
    expect(selectionBarLoad.draws.length).toBeGreaterThan(drawn);
    expect(screen.queryByText(/timetable\.bulkSelected/)).toBeNull();

    // The connection is back: the next selection shows the bar, and the one
    // failure was said once.
    selectionBarLoad.fail = false;
    selectSlojd(container);
    expect(await screen.findByText("timetable.bulkSelected(1)")).toBeInTheDocument();
    expect(toasts.error).toHaveBeenCalledTimes(1);
  });

  it("undoes and redoes a bulk lock and a bulk delete, and lets a deleted selection go", async () => {
    const user = userEvent.setup();
    const { container } = render(<TimetablePage />);
    selectSlojd(container);
    await user.click(await screen.findByRole("button", { name: "timetable.bulkLock" }));
    await waitFor(() =>
      expect(noMutation.mutateAsync).toHaveBeenCalledWith({ id: "l-slojd", isLocked: true, propagate: false }),
    );
    expect(toasts.success).toHaveBeenCalledWith("timetable.bulkDone(1)");

    noMutation.mutateAsync.mockClear();
    await user.click(screen.getByRole("button", { name: "timetable.undo" }));
    await waitFor(() =>
      expect(noMutation.mutateAsync).toHaveBeenCalledWith({ id: "l-slojd", isLocked: false, propagate: false }),
    );
    noMutation.mutateAsync.mockClear();
    await user.click(screen.getByRole("button", { name: "timetable.redo" }));
    await waitFor(() =>
      expect(noMutation.mutateAsync).toHaveBeenCalledWith({ id: "l-slojd", isLocked: true, propagate: false }),
    );

    // Ta bort: the selection goes with the lessons it named.
    noMutation.mutateAsync.mockClear();
    await user.click(screen.getByRole("button", { name: "timetable.bulkDelete" }));
    await waitFor(() => expect(noMutation.mutateAsync).toHaveBeenCalledWith("l-slojd"));
    await waitFor(() => expect(screen.queryByText(/timetable\.bulkSelected/)).toBeNull());
    expect(toasts.success).toHaveBeenCalledWith("timetable.bulkDeleted(1)");

    // Undo puts the lesson back with the fields a restore keeps; redo deletes
    // the lesson undo made.
    noMutation.mutateAsync.mockClear();
    await user.click(screen.getByRole("button", { name: "timetable.undo" }));
    await waitFor(() =>
      expect(noMutation.mutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          academicYearId: "y-1",
          subjectId: "s-sl",
          studentGroupId: "g-51",
          dayOfWeek: 1,
          startTime: "11:00",
          endTime: "12:00",
          recurrence: "ALL_WEEKS",
        }),
      ),
    );
    noMutation.mutateAsync.mockClear();
    await user.click(screen.getByRole("button", { name: "timetable.redo" }));
    await waitFor(() => expect(noMutation.mutateAsync).toHaveBeenCalledWith("x"));
  });
});

describe("an export whose code does not arrive", () => {
  afterEach(() => {
    exportsLoad.fail = false;
  });

  it("says so in a toast and keeps the page", async () => {
    exportsLoad.fail = true;
    toasts.error.mockClear();
    const user = userEvent.setup();
    render(<TimetablePage />);

    await fromMoreMenu(user, "timetable.exportIcs");
    await waitFor(() =>
      expect(toasts.error).toHaveBeenCalledWith("Failed to load chunk timetable-exports"),
    );
    expect(buildIcs).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "timetable.publish" })).toBeInTheDocument();
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

describe("comparing a version with the timetable", () => {
  /*
   * A parked lesson occupies nothing; its day and time are only a memory of
   * where it was. The diff keyed lessons on that memory and never read the
   * flag, so a lesson on the tray in the snapshot and back at its remembered
   * hour now came out identical — though restoring the snapshot lifts it off
   * the grid again. And the list named the parked lesson by that hour.
   */
  type Lesson = (typeof LESSONS)[number];

  const VERSION = {
    id: "v-1",
    academicYearId: "y-1",
    name: "Före bytet",
    lessonCount: LESSONS.length,
    createdAt: "2026-09-10T08:00:00.000Z",
  };

  /** A lesson the way the gateway snapshots it: no id, the flag carried. */
  const snapshotOf = (l: Lesson) => ({
    subjectId: l.subjectId,
    studentGroupId: l.studentGroupId,
    teacherId: l.teacherId,
    coTeacherId: l.coTeacherId,
    roomId: l.roomId,
    dayOfWeek: l.dayOfWeek,
    startTime: l.startTime,
    endTime: l.endTime,
    isLocked: l.isLocked,
    isParked: l.isParked,
    recurrence: l.recurrence,
    startDate: l.startDate,
    endDate: l.endDate,
    extraGroupIds: l.extraGroupIds,
    studentIds: l.studentIds,
  });

  /** Set aside, remembering the slot it had — or another one, if given. */
  const onTray = (l: Lesson, remembers: Partial<Lesson> = {}): Lesson => ({
    ...l,
    ...remembers,
    isParked: true,
  });

  const withSlojd = (change: (l: Lesson) => Lesson) =>
    LESSONS.map((l) => (l.id === "l-slojd" ? change(l) : l));

  function saved(lessons: object[]) {
    state.versions = [VERSION];
    state.snapshot = { ...VERSION, lessons };
  }

  async function compare() {
    const user = userEvent.setup();
    render(<TimetablePage />);
    await user.click(screen.getByRole("button", { name: "timetable.versions" }));
    // The dialog's code arrives on that first press (versions-dialog.tsx).
    // Named by the version it compares since the design overhaul, so a list
    // of versions is not a column of identical buttons.
    await user.click(
      await screen.findByRole("button", { name: "timetable.versionCompareNamed(Före bytet)" }),
    );
    return screen.getByText("timetable.diffTitle(Före bytet)").parentElement!;
  }

  const lines = (diff: HTMLElement) =>
    [...diff.querySelectorAll("li")].map((li) => li.textContent);

  it("sees a lesson that was on the tray then and is back at its hour now", async () => {
    saved(withSlojd(onTray).map(snapshotOf));

    const diff = await compare();

    expect(diff.textContent).not.toContain("timetable.diffIdentical");
    // Named by the tray, not by the hour it remembers — the hour the placed
    // one now holds, which would make the pair read as one lesson twice.
    expect(lines(diff)).toEqual([
      "+ Slöjd · 5.1 · days.1 11:00–12:00 · K. Ek",
      "− Slöjd · 5.1 · timetable.diffOnTray · K. Ek",
    ]);
  });

  it("sees a lesson that is on the tray now and was placed then", async () => {
    saved(LESSONS.map(snapshotOf));
    state.lessons = withSlojd(onTray);

    const diff = await compare();

    expect(lines(diff)).toEqual([
      "+ Slöjd · 5.1 · timetable.diffOnTray · K. Ek",
      "− Slöjd · 5.1 · days.1 11:00–12:00 · K. Ek",
    ]);
  });

  it("does not count the hour a parked lesson remembers as a change", async () => {
    // Parked from Monday then; since put back, moved to Wednesday and parked
    // again. Neither hour is a placement, so the timetable is the same.
    saved(withSlojd(onTray).map(snapshotOf));
    state.lessons = withSlojd((l) =>
      onTray(l, { dayOfWeek: 3, startTime: "14:00", endTime: "15:00" }),
    );

    const diff = await compare();

    expect(diff.textContent).toContain("timetable.diffIdentical");
  });

  it("counts two parked lessons of one class and teacher as two", async () => {
    // Without the hour they share a key. Collected into a map, the second one
    // vanished, and taking it off the tray would not show.
    const live = LESSONS.map((l) => (l.id === "l-ma1" ? onTray(l) : l));
    saved([...live, onTray(lesson("l-ma1-b", "s-ma", "g-ma1", "13:00"))].map(snapshotOf));
    state.lessons = live;

    const diff = await compare();

    expect(diff.textContent).toContain("timetable.diffRemoved(1)");
    expect(diff.textContent).toContain("timetable.diffAdded(0)");
    expect(lines(diff)).toEqual(["− Matematik · 4ma1 · timetable.diffOnTray · K. Ek"]);
  });

  it("reads a snapshot stored before the flag was carried as having nothing parked", async () => {
    // The key is absent, not false. Restore reads it as false as well, so the
    // diff must: read as true, every old snapshot would differ in every lesson.
    saved(
      LESSONS.map(snapshotOf).map((s) => {
        const keyless: Partial<typeof s> = { ...s };
        delete keyless.isParked;
        return keyless;
      }),
    );

    const diff = await compare();

    expect(diff.textContent).toContain("timetable.diffIdentical");
  });

  /*
   * Restore writes the weeks, the date window, the co-teacher, the invited
   * classes and the pupils back, and the key read none of them: a lesson moved
   * to odd weeks, or cut to half a term, made the dialog call the timetable
   * identical to a version that restoring would change. And the line showed
   * neither the teacher nor the room already in the key, so a teacher swap
   * printed as a + and a − that read the same.
   */

  /** The fixture with one lesson changed. */
  const withChanged = (changes: Record<string, Partial<Lesson>>) =>
    LESSONS.map((l) => ({ ...l, ...changes[l.id] }));

  it("sees a lesson that runs odd weeks only now, and says so", async () => {
    saved(LESSONS.map(snapshotOf));
    state.lessons = withChanged({ "l-slojd": { recurrence: "ODD_WEEKS" } });

    const diff = await compare();

    expect(lines(diff)).toEqual([
      "+ Slöjd · 5.1 · days.1 11:00–12:00 · K. Ek · timetable.badgeOdd",
      "− Slöjd · 5.1 · days.1 11:00–12:00 · K. Ek",
    ]);
  });

  it("sees a lesson's date window change, and prints the window", async () => {
    // "period" alone would print both Slöjd lines alike.
    saved(
      withChanged({
        "l-ma1": { endDate: "2027-06-01" },
        "l-slojd": { startDate: "2026-08-17" },
      }).map(snapshotOf),
    );
    state.lessons = withChanged({
      "l-slojd": { startDate: "2026-08-17", endDate: "2026-10-30" },
    });

    const diff = await compare();

    expect(lines(diff)).toEqual([
      "+ Matematik · 4ma1 · days.1 08:00–09:00 · K. Ek",
      "+ Slöjd · 5.1 · days.1 11:00–12:00 · K. Ek · timetable.badgePeriod · 2026-08-17–2026-10-30",
      "− Matematik · 4ma1 · days.1 08:00–09:00 · K. Ek · timetable.badgePeriod · timetable.diffUntil(2027-06-01)",
      "− Slöjd · 5.1 · days.1 11:00–12:00 · K. Ek · timetable.badgePeriod · timetable.diffFrom(2026-08-17)",
    ]);
  });

  it("reads a snapshot without the weeks, the window or the co-teacher as restore does", async () => {
    // Every week, the whole year, nobody beside the teacher: what restore
    // writes for a missing key. Read any other way, every snapshot stored
    // before the gateway carried them differs in every lesson.
    saved(
      LESSONS.map(snapshotOf).map((s) => {
        const keyless: Partial<typeof s> = { ...s };
        delete keyless.recurrence;
        delete keyless.startDate;
        delete keyless.endDate;
        delete keyless.coTeacherId;
        return keyless;
      }),
    );

    const diff = await compare();

    expect(diff.textContent).toContain("timetable.diffIdentical");
  });

  it("reads a date spelled as a timestamp as the day restore reads from it", async () => {
    const live = withChanged({ "l-slojd": { endDate: "2026-10-30" } });
    saved(
      live
        .map(snapshotOf)
        .map((s) => (s.endDate ? { ...s, endDate: `${s.endDate}T00:00:00.000Z` } : s)),
    );
    state.lessons = live;

    const diff = await compare();

    expect(diff.textContent).toContain("timetable.diffIdentical");
  });

  it("names the teacher and the room, so a swap does not read as one lesson twice", async () => {
    saved(LESSONS.map(snapshotOf));
    state.lessons = withChanged({
      "l-ma1": { teacherId: "t-2" },
      "l-ma2": { roomId: "r-verkstad" },
    });

    const diff = await compare();

    expect(lines(diff)).toEqual([
      "+ Matematik · 4ma1 · days.1 08:00–09:00 · N. Berg",
      "+ Matematik · 4ma2 · days.1 09:00–10:00 · N. Berg · timetable.diffRoom(Verkstaden)",
      "− Matematik · 4ma1 · days.1 08:00–09:00 · K. Ek",
      "− Matematik · 4ma2 · days.1 09:00–10:00 · N. Berg · timetable.diffRoom(A1)",
    ]);
  });

  it("sees a co-teacher added and a class invited in, and names them", async () => {
    saved(LESSONS.map(snapshotOf));
    state.lessons = withChanged({
      "l-idrott": { extraGroupIds: ["g-41", "g-51"] },
      "l-slojd": { coTeacherId: "t-2" },
    });

    const diff = await compare();

    expect(lines(diff)).toEqual([
      "+ Idrott · 4.2 + 4.1 + 5.1 · days.1 10:00–11:00 · K. Ek",
      "+ Slöjd · 5.1 · days.1 11:00–12:00 · K. Ek · timetable.diffCoTeacher(N. Berg)",
      "− Idrott · 4.2 + 4.1 · days.1 10:00–11:00 · K. Ek",
      "− Slöjd · 5.1 · days.1 11:00–12:00 · K. Ek",
    ]);
  });

  it("names the pupils where one was swapped for another", async () => {
    // Counted, the pair would read "⊕1" on both sides.
    saved(withChanged({ "l-musik": { studentIds: ["p-bo"] } }).map(snapshotOf));

    const diff = await compare();

    expect(lines(diff)).toEqual([
      "+ Musik · 5.1 · days.1 12:00–13:00 · K. Ek · timetable.diffRoom(Verkstaden) · ⊕ Alva Elev",
      "− Musik · 5.1 · days.1 12:00–13:00 · K. Ek · timetable.diffRoom(Verkstaden) · ⊕ Bo Elev",
    ]);
  });

  it("only counts the pupils where something else tells the lines apart", async () => {
    saved(LESSONS.map(snapshotOf));
    state.lessons = withChanged({ "l-musik": { startTime: "13:00", endTime: "14:00" } });

    const diff = await compare();

    expect(lines(diff)).toEqual([
      "+ Musik · 5.1 · days.1 13:00–14:00 · K. Ek · timetable.diffRoom(Verkstaden) · ⊕1",
      "− Musik · 5.1 · days.1 12:00–13:00 · K. Ek · timetable.diffRoom(Verkstaden) · ⊕1",
    ]);
  });

  it("does not read the order of the classes or the pupils as a change", async () => {
    // Both are sets to restore; the order is whatever the rows came back in.
    saved(
      withChanged({
        "l-idrott": { extraGroupIds: ["g-51", "g-41"] },
        "l-musik": { studentIds: ["p-bo", "p-alva"] },
      }).map(snapshotOf),
    );
    state.lessons = withChanged({
      "l-idrott": { extraGroupIds: ["g-41", "g-51"] },
      "l-musik": { studentIds: ["p-alva", "p-bo"] },
    });

    const diff = await compare();

    expect(diff.textContent).toContain("timetable.diffIdentical");
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

  it("marks a meal's writes as schemaläggning's: the grip takes no pointer, the mode and the × are hidden (Läsbehörighet)", async () => {
    state.sittings = [meal(1, false)];
    const { unmount } = render(<TimetablePage />);
    await filterTo("4.1");
    // The grip carries the meal's name, so it stays on screen to read.
    expect(screen.getByRole("button", { name: "timetable.lunchMove" })).toHaveAttribute("data-writes-inert", "SCHEMALAGGNING");
    expect(screen.getByRole("button", { name: "timetable.lunchRemove" })).toHaveAttribute("data-writes", "SCHEMALAGGNING");
    expect(screen.getByRole("button", { name: /^timetable\.placeLunch$/ })).toHaveAttribute("data-writes", "SCHEMALAGGNING");
    unmount();

    state.sittings = [];
    render(<TimetablePage />);
    await filterTo("4.1");
    expect(screen.getByRole("button", { name: "timetable.noSittingsPlace" })).toHaveAttribute("data-writes", "SCHEMALAGGNING");
  });
});

describe("the room optimisation", () => {
  const PROPOSAL = {
    status: "OPTIMAL",
    basis: "b-1",
    changes: [{ lessonId: "l-ma2", fromRoomId: "r-sal", toRoomId: "r-verkstad" }],
    teachers: {
      before: { roomChanges: 1, floorChanges: 0, buildingChanges: 0 },
      after: { roomChanges: 0, floorChanges: 0, buildingChanges: 0 },
    },
    groups: {
      before: { roomChanges: 0, floorChanges: 0, buildingChanges: 0 },
      after: { roomChanges: 0, floorChanges: 0, buildingChanges: 0 },
    },
    missedWishes: { before: 0, after: 0 },
    walkers: [],
    frozenLessonIds: [],
    roomsTotal: 2,
    roomsWithoutFloor: 0,
  };

  beforeEach(() => {
    roomOptimization.propose.mutateAsync.mockReset();
    roomOptimization.apply.mutateAsync.mockReset();
  });

  it("sits in the header's overflow menu, beside the versions, and opens its dialog", async () => {
    // The header holds four controls since the design overhaul; Optimera
    // salar went behind "Fler åtgärder" with the exports and the print, and
    // that menu sits beside Versioner.
    const user = userEvent.setup();
    render(<TimetablePage />);

    expect(screen.getByRole("button", { name: "timetable.moreActions" }).parentElement).toBe(
      screen.getByRole("button", { name: "timetable.versions" }).parentElement,
    );
    await fromMoreMenu(user, "timetable.optimizeRooms");

    // Awaited, not read straight away: the dialog's code is fetched when this
    // button is pressed rather than with the page, so it arrives a tick later.
    expect(await screen.findByRole("dialog")).toHaveTextContent("roomOptimization.title");
  });

  it("is not offered for a grundschema with no lessons", async () => {
    state.lessons = [];
    const user = userEvent.setup();
    render(<TimetablePage />);

    await user.click(screen.getByRole("button", { name: "timetable.moreActions" }));
    expect(await screen.findByRole("menuitem", { name: "timetable.optimizeRooms" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("forgets the page's own undo history once the rooms are rewritten", async () => {
    // A drag made before the optimisation holds the lesson's room as it was.
    // Undoing it afterwards would put one lesson back where the proposal just
    // moved it from — so the history goes, as it does after a version restore.
    roomOptimization.propose.mutateAsync.mockResolvedValueOnce(PROPOSAL);
    roomOptimization.apply.mutateAsync.mockResolvedValueOnce({
      updated: 1,
      basis: "b-2",
      versionId: "v-1",
      calendarUpdated: 0,
    });
    const user = userEvent.setup();
    render(<TimetablePage />);

    dragToTuesday("Slöjd");
    // Named by its own label now, with the shortcut in the tooltip from the
    // catalogue rather than a hard-coded "(Ctrl+Z)".
    const undo = screen.getByRole("button", { name: "timetable.undo" });
    await waitFor(() => expect(undo).toBeEnabled());

    await fromMoreMenu(user, "timetable.optimizeRooms");
    await user.click(await screen.findByRole("button", { name: "roomOptimization.compute" }));
    await user.click(await screen.findByRole("button", { name: "roomOptimization.apply" }));

    expect(roomOptimization.apply.mutateAsync).toHaveBeenCalledWith({
      academicYearId: "y-1",
      basis: "b-1",
      changes: PROPOSAL.changes,
    });
    await waitFor(() => expect(undo).toBeDisabled());
  });

  it("names the people it helped from the page's own teacher list", async () => {
    roomOptimization.propose.mutateAsync.mockResolvedValueOnce({
      ...PROPOSAL,
      walkers: [
        {
          kind: "TEACHER",
          id: "t-2",
          before: PROPOSAL.teachers.before,
          after: PROPOSAL.teachers.after,
        },
      ],
    });
    const user = userEvent.setup();
    render(<TimetablePage />);

    await fromMoreMenu(user, "timetable.optimizeRooms");
    await user.click(await screen.findByRole("button", { name: "roomOptimization.compute" }));

    const list = await screen.findByRole("list", { name: "roomOptimization.mostImproved" });
    expect(list).toHaveTextContent("Nils Berg");
  });
});

/*
 * Next year before its activation. Its classes have no home pupils until
 * then — every pupil in PEOPLE sits in a class of this year — so the grid
 * reads the people with the home class the gateway projects for each pupil the
 * activation moves. That is what lets a clash on next year's grid be drawn
 * before anyone has moved, and redrawn when a class change this year moves a
 * pupil's projected class.
 */
describe("next year's grid, before its activation", () => {
  const NEXT = {
    id: "y-2",
    name: "2027/28",
    isActive: false,
    predecessorId: "y-1",
    startDate: "2027-08-16",
    endDate: "2028-06-09",
  };
  const nextLesson = (id: string, subjectId: string, studentGroupId: string, teacherId: string) => ({
    ...lesson(id, subjectId, studentGroupId, "08:00", { teacherId }),
    academicYearId: "y-2",
  });
  /** What the gateway projects for Alva: the class her class this year rolls into. */
  const rostersWithAlvaIn = (studentGroupId: string) => ({
    academicYearId: "y-2",
    basis: "PROJECTED",
    homeClasses: [{ studentId: "p-alva", studentGroupId }],
    counts: { moved: 1, graduates: 0, unplaced: 0 },
    membershipsOutOfDate: { missing: 0, stale: 0 },
  });

  beforeEach(() => {
    planning.successor = NEXT;
    // Monday 08:00 next year: 5.1 has Slöjd, and 5ma1 — Alva's maths group,
    // carried at the rollover — has Matematik with another teacher.
    state.nextLessons = [
      nextLesson("l-next-slojd", "s-sl", "g-next-51", "t-1"),
      nextLesson("l-next-ma", "s-ma", "g-next-5ma", "t-2"),
    ];
    state.memberships = [...MEMBERSHIPS, { studentId: "p-alva", studentGroupId: "g-next-5ma" }];
  });

  async function showNextYear() {
    const user = userEvent.setup();
    render(<TimetablePage />);
    await user.click(screen.getByRole("button", { name: "planningYear.optionNext(2027/28)" }));
    return user;
  }

  const card = (subject: string) =>
    screen.queryAllByRole("button").find((el) => el.textContent?.includes(subject));
  // The clash ring is the destructive token since the design overhaul (it was
  // a raw ring-red-500/80); the token is what marks a clash now.
  const clashes = (subject: string) => card(subject)?.className.includes("ring-destructive") ?? false;

  it("shows next year's lessons, and every year-keyed read follows the choice", async () => {
    await showNextYear();

    expect(state.askedFor).toEqual({ lessons: "y-2", requirements: "y-2", sittings: "y-2" });
    expect(card("Slöjd")).toBeDefined();
    expect(card("Idrott")).toBeUndefined();
  });

  it("puts the year choice first among the header's actions, now that they are four", async () => {
    // jsdom does no layout, so the width is measured elsewhere. Beside nine
    // buttons the choice once ran past a 1440 px screen and pushed Publicera
    // out of sight, so it had a row of its own. The design overhaul cut the
    // header to Lägg till, Versioner, the overflow menu and Publicera, and the
    // scope selector goes first in the actions as on every page. What this
    // pins is that, and that the exports and the print did not come back.
    render(<TimetablePage />);
    const choice = screen.getByRole("group", { name: "planningYear.label" });
    const actions = screen.getByRole("button", { name: /timetable\.publish/ }).parentElement!;
    expect(actions.firstElementChild).toBe(choice);
    expect(choice.closest("h1")).toBeNull();
    for (const name of ["timetable.optimizeRooms", "timetable.exportIcs", "timetable.exportPdf", "timetable.print"]) {
      expect(within(actions).queryByRole("button", { name })).toBeNull();
    }
  });

  it("offers next year's groups in the filter, and not this year's", async () => {
    const user = await showNextYear();
    await user.click(screen.getByRole("button", { name: "timetable.filterGroup" }));

    expect(await screen.findByRole("menuitemcheckbox", { name: "5ma1" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitemcheckbox", { name: "4.1" })).toBeNull();
  });

  it("draws the clash a class change this year creates on next year's grid", async () => {
    // Alva is in 4.2 this year, so the activation would put her in 5.2: the
    // two Monday lessons share nobody.
    planning.rosters = rostersWithAlvaIn("g-next-52");
    await showNextYear();
    expect(clashes("Slöjd")).toBe(false);
    expect(clashes("Matematik")).toBe(false);
    cleanup();

    // She changes to 4.1 in May; the gateway's projection now puts her in
    // 5.1, which has Slöjd while her maths group has Matematik.
    planning.rosters = rostersWithAlvaIn("g-next-51");
    await showNextYear();
    expect(clashes("Slöjd")).toBe(true);
    expect(clashes("Matematik")).toBe(true);
  });

  it("draws no clash at all without the projection: next year's 5.1 has nobody yet", async () => {
    planning.rosters = null;
    await showNextYear();

    expect(clashes("Slöjd")).toBe(false);
    expect(clashes("Matematik")).toBe(false);
  });

  it("says the class lists are projected, and only for next year", async () => {
    planning.rosters = rostersWithAlvaIn("g-next-51");
    render(<TimetablePage />);
    expect(screen.queryByText(/planningYear\.bannerTitle/)).toBeNull();
    cleanup();

    await showNextYear();
    expect(screen.getByText("planningYear.bannerTitle(2027/28)")).toBeInTheDocument();
  });

  it("drops the group filter picked on this year's grid", async () => {
    render(<TimetablePage />);
    await filterTo("4.1");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "planningYear.optionNext(2027/28)" }));

    // Both of next year's lessons, not the nothing a filter on this year's
    // 4.1 would leave.
    expect(card("Slöjd")).toBeDefined();
    expect(card("Matematik")).toBeDefined();
  });

  it("adds a lesson to next year, among next year's groups only", async () => {
    const user = await showNextYear();
    await user.click(screen.getByRole("button", { name: "timetable.addLesson" }));
    await user.click(await screen.findByRole("combobox", { name: "timetable.addGroup" }));

    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "5.1",
      "5.2",
      "5ma1",
    ]);
  });

  it("offers no choice while there is no next year to plan", () => {
    planning.successor = null;
    render(<TimetablePage />);

    expect(screen.queryByRole("group", { name: "planningYear.label" })).toBeNull();
  });

  /*
   * Next year tioårig while this year is not (SFS 2025:729). A rast is
   * school-wide and stated in NIOARIG (grade-numbering.ts), so a class's span
   * is read through the numbering of the year ON SCREEN — the one thing the
   * two years here do not share. And the spans are built from that year's
   * groups only, as the gateway builds them (room-eligibility.ts
   * gradeSpanOf): a pupil not yet moved has this year's class as home, and
   * that class is no årskurs of next year's.
   */
  describe("when next year is tioårig", () => {
    const TIOARIG_NEXT = {
      ...NEXT,
      name: "2028/29",
      startDate: "2028-08-14",
      endDate: "2029-06-08",
      gradeNumbering: "TIOARIG" as const,
    };
    /** Next year's 7.1: a new cohort, the NIOARIG 6. This year's 7.1 is the NIOARIG 7. */
    const NEXT_71 = { id: "g-next-71", academicYearId: "y-2", name: "7.1", kind: "CLASS", gradeLevel: 7 };

    beforeEach(() => {
      planning.successor = TIOARIG_NEXT;
      state.groups = [...GROUPS, NEXT_71];
    });

    async function showTioarigYear() {
      const user = userEvent.setup();
      render(<TimetablePage />);
      await user.click(screen.getByRole("button", { name: "planningYear.optionNext(2028/29)" }));
    }

    it("draws the 4–6 rast for next year's 7.1, the NIOARIG 6, and still not for this year's", async () => {
      await showTioarigYear();
      await filterTo("7.1");
      expect(screen.getAllByText("Förmiddagsrast")).toHaveLength(5);

      cleanup();
      // This year's 7.1, a nine-year 7, whatever next year is numbered.
      render(<TimetablePage />);
      await filterTo("7.1");
      expect(screen.queryByText("Förmiddagsrast")).toBeNull();
    });

    it("reads next year's 7.1 as the 7 it is when next year is numbered NIOARIG", async () => {
      planning.successor = { ...TIOARIG_NEXT, gradeNumbering: "NIOARIG" };
      await showTioarigYear();
      await filterTo("7.1");
      expect(screen.queryByText("Förmiddagsrast")).toBeNull();
    });

    it("lends 5ma1 no årskurs from this year's classes while the projection is on its way", async () => {
      // Gus sits in this year's 7.1 and in next year's 5ma1. Read with this
      // year's groups, his 7 would come out of the tioårig translation as 6
      // and draw the 4–6 rast for a group next year has placed nobody in.
      state.people = [...PEOPLE, pupil("p-gus", "Gus", "g-71")];
      state.memberships = [
        ...MEMBERSHIPS,
        { studentId: "p-alva", studentGroupId: "g-next-5ma" },
        { studentId: "p-gus", studentGroupId: "g-next-5ma" },
      ];
      planning.rosters = null;
      await showTioarigYear();
      await filterTo("5ma1");
      expect(screen.queryByText("Förmiddagsrast")).toBeNull();

      cleanup();
      // The overlay arrives with Alva in next year's 5.1, the NIOARIG 4; Gus,
      // not moved, still lends nothing.
      planning.rosters = rostersWithAlvaIn("g-next-51");
      await showTioarigYear();
      await filterTo("5ma1");
      expect(screen.getAllByText("Förmiddagsrast")).toHaveLength(5);
    });
  });
});

describe("the state ladder", () => {
  it("waits for the years rather than saying there is no grundschema", () => {
    // With no year the lessons are never asked for, so they read as loaded
    // and empty; the empty state's "generate one" would be a guess.
    state.yearsLoading = true;
    state.lessons = [];
    const { container } = render(<TimetablePage />);

    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(screen.queryByText("timetable.emptyTitle")).toBeNull();
  });

  it("offers the generate page when the year has no grundschema", () => {
    state.lessons = [];
    render(<TimetablePage />);

    expect(screen.getByRole("heading", { level: 2, name: "timetable.emptyTitle" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "timetable.emptyAction" }).getAttribute("href")).toBe(
      "/admin/generate",
    );
  });

  it("says the board could not be read when the first read fails", () => {
    state.lessons = undefined;
    state.lessonsFailed = true;
    render(<TimetablePage />);

    expect(screen.getByRole("heading", { level: 2, name: "timetable.loadFailed" })).toBeTruthy();
    expect(screen.getByText("timetable.loadFailedHint")).toBeTruthy();
    expect(screen.queryByText("timetable.emptyTitle")).toBeNull();
  });

  it("keeps a board it has read when a refetch fails, and says so above it", () => {
    // A realtime peer invalidates the lessons on every edit; a background
    // read that fails must not unmount the board someone is dragging on.
    const { rerender } = render(<TimetablePage />);
    expect(subjectsOnScreen().length).toBeGreaterThan(0);
    const before = subjectsOnScreen();

    state.lessonsFailed = true;
    rerender(<TimetablePage />);

    expect(subjectsOnScreen()).toEqual(before);
    const notice = screen.getByRole("alert");
    expect(within(notice).getByText("timetable.loadFailed")).toBeTruthy();
    expect(within(notice).getByText("common.refetchFailedHint")).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 2, name: "timetable.loadFailed" })).toBeNull();
  });
});

describe("the Lektionstid panel", () => {
  afterEach(() => {
    try {
      sessionStorage.clear();
    } catch {}
  });

  it("is fetched on the first press, shows the year's lines, and closes again", async () => {
    const user = userEvent.setup();
    render(<TimetablePage />);
    const button = screen.getByRole("button", { name: "timetable.lessonTime.button" });
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("region", { name: "timetable.lessonTime.region" })).toBeNull();

    await user.click(button);
    const panel = await screen.findByRole("region", { name: "timetable.lessonTime.region" });
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(button).toHaveAttribute("aria-controls", panel.id);
    // No posts in this fixture: every subject with lessons is a line without
    // one, and none of them matches.
    expect(panel.textContent).toContain("timetable.lessonTime.summary(0|");
    expect(panel.textContent).toContain("timetable.lessonTime.unplanned(Slöjd|60)");

    await user.click(button);
    expect(screen.queryByRole("region", { name: "timetable.lessonTime.region" })).toBeNull();
  });

  it("is open again after a reload in the same tab", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<TimetablePage />);
    await user.click(screen.getByRole("button", { name: "timetable.lessonTime.button" }));
    await screen.findByRole("region", { name: "timetable.lessonTime.region" });
    unmount();

    render(<TimetablePage />);
    expect(await screen.findByRole("region", { name: "timetable.lessonTime.region" })).toBeDefined();
  });

  it("links to the groups in view on Täckning", async () => {
    const user = userEvent.setup();
    render(<TimetablePage />);
    await filterTo("5.1");
    await user.click(screen.getByRole("button", { name: "timetable.lessonTime.button" }));
    const panel = await screen.findByRole("region", { name: "timetable.lessonTime.region" });
    expect(panel.querySelector("a")?.getAttribute("href")).toBe(
      "/admin/timplan/tackning?year=y-1&layer=scheduled&group=g-51",
    );
    // One group in view: every one of its lines, Slöjd and Musik.
    expect(panel.textContent).toContain("timetable.lessonTime.unplanned(Musik|60)");
  });
});

// ---------------------------------------------------------------------------
// Block i schemat: a parallel block on the grid
// ---------------------------------------------------------------------------

describe("a parallel block (Block i schemat)", () => {
  // Språkval åk 4, say: Slöjd för 4ma1 (Karin) and Musik för 4ma2 (Nils), one
  // card on Monday at 13:00. The two groups share no pupil.
  const BLOCK_LESSONS = [
    lesson("l-sv1", "s-sl", "g-ma1", "13:00"),
    lesson("l-sv2", "s-mu", "g-ma2", "13:00", { teacherId: "t-2" }),
  ];

  beforeEach(() => {
    state.lessons = [...LESSONS, ...BLOCK_LESSONS];
    state.requirements = [
      { id: "r-sv1", studentGroupId: "g-ma1", subjectId: "s-sl", blockId: "b-sv" },
      { id: "r-sv2", studentGroupId: "g-ma2", subjectId: "s-mu", blockId: "b-sv" },
    ];
    blockApi.patch.mockReset();
    blockNames.read.mockClear();
    toasts.warning.mockClear();
    toasts.success.mockClear();
    toasts.error.mockClear();
  });

  const card = () => screen.findByRole("button", { name: /Språkval åk 4/ });
  // 4ma1 holds pupils of 4.1 and 4.2, so a move of the card reaches both
  // classes and is asked first, as a shared lesson's drag is.
  const confirmClasses = async () =>
    userEvent.setup().click(await screen.findByRole("button", { name: "timetable.sharedMoveConfirm" }));
  /** Karin teaches 7.1 on Tuesday 13:00: the card's Slöjd cannot go there, its Musik can. */
  const karinOnTuesday = () => {
    state.lessons = [...LESSONS, ...BLOCK_LESSONS, { ...lesson("l-tue", "s-ma", "g-71", "13:00"), dayOfWeek: 2 }];
  };
  // The block module reads its names through react-query, as the app does;
  // the page's own reads are the mocks above. `again` draws the page anew,
  // as a refetch after a write does.
  const showPage = () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const page = () => (
      <QueryClientProvider client={client}>
        <TimetablePage />
      </QueryClientProvider>
    );
    const view = render(page());
    return { ...view, again: () => view.rerender(page()) };
  };
  const focusedId = () => document.activeElement?.getAttribute("data-lesson-id");

  it("draws the block as one card naming the block and its members", async () => {
    showPage();

    const drawn = await card();
    expect(drawn.textContent).toContain("4ma1");
    expect(drawn.textContent).toContain("4ma2");
    // The two lessons are inside the card, not beside it: no card of its own
    // reads Musik for 4ma2 (5.1's Musik at 12:00 is another lesson).
    expect(
      screen.queryAllByRole("button").filter((el) => el.textContent?.includes("Musik") && el.textContent.includes("4ma2")),
    ).toEqual([]);
  });

  it("moves the card as one move, with the way back on the undo stack", async () => {
    blockApi.patch.mockResolvedValue({ lessons: [], propagatedLessons: 0, removedCalendarLessons: 0, warnings: [] });
    showPage();
    await card();

    dragToTuesday("Språkval åk 4");
    // The classes by name, and the block's, before anything moves.
    expect(await screen.findByText("timetable.sharedCardTitle")).toBeInTheDocument();
    expect(screen.getByText("timetable.sharedCardBody(Språkval åk 4|4.1, 4.2)")).toBeInTheDocument();
    expect(blockApi.patch).not.toHaveBeenCalled();
    await confirmClasses();

    await waitFor(() =>
      expect(blockApi.patch).toHaveBeenCalledWith("/api/v1/master-lessons/block-card", {
        lessonIds: ["l-sv1", "l-sv2"],
        dayOfWeek: 2,
        startTime: "13:00",
        endTime: "14:00",
      }),
    );
    expect(noMutation.mutateAsync).not.toHaveBeenCalled();
    await userEvent.setup().click(screen.getByRole("button", { name: /timetable\.undo/ }));
    await waitFor(() =>
      expect(blockApi.patch).toHaveBeenLastCalledWith("/api/v1/master-lessons/block-card", {
        lessonIds: ["l-sv1", "l-sv2"],
        dayOfWeek: 1,
        startTime: "13:00",
        endTime: "14:00",
      }),
    );
  });

  it("asks before one member is moved out of its block, and moves only it when told", async () => {
    noMutation.mutateAsync.mockResolvedValueOnce({
      id: "l-sv2",
      propagatedLessons: 0,
      removedCalendarLessons: 0,
      warnings: [{ code: "BLOCK_SPLIT", params: { block: "Språkval åk 4" } }],
    });
    showPage();
    await card();
    // Nils's week: of the block only his Musik is on screen.
    await filterToTeacher("Nils Berg");

    dragToTuesday("Musik");

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("timetable.blocks.splitTitle(Språkval åk 4)");
    expect(noMutation.mutateAsync).not.toHaveBeenCalled();
    // Läsbehörighet: both answers are a move, the master lessons' write.
    for (const name of ["timetable.blocks.moveOne", "timetable.blocks.moveBlock"]) {
      expect(within(dialog).getByRole("button", { name })).toHaveAttribute("data-writes", "SCHEMALAGGNING DRIFT");
    }
    await userEvent.setup().click(within(dialog).getByRole("button", { name: "timetable.blocks.moveOne" }));

    await waitFor(() =>
      expect(noMutation.mutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ id: "l-sv2", dayOfWeek: 2, startTime: "13:00", endTime: "14:00" }),
      ),
    );
    // The save said the block is split, with the way back beside it.
    await waitFor(() => expect(toasts.warning).toHaveBeenCalled());
    const [, options] = toasts.warning.mock.calls.at(-1)! as [string, { action: { label: string; onClick: () => void } }];
    expect(options.action.label).toBe("timetable.blocks.moveBack");
    options.action.onClick();
    await waitFor(() =>
      expect(noMutation.mutateAsync).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: "l-sv2", dayOfWeek: 1, startTime: "13:00", endTime: "14:00" }),
      ),
    );
  });

  it("moves the whole block instead when asked to from the same question", async () => {
    blockApi.patch.mockResolvedValue({ lessons: [], propagatedLessons: 0, removedCalendarLessons: 0, warnings: [] });
    showPage();
    await card();
    await filterToTeacher("Nils Berg");

    dragToTuesday("Musik");
    const dialog = await screen.findByRole("dialog");
    await userEvent.setup().click(within(dialog).getByRole("button", { name: "timetable.blocks.moveBlock" }));
    await confirmClasses();

    await waitFor(() =>
      expect(blockApi.patch).toHaveBeenCalledWith(
        "/api/v1/master-lessons/block-card",
        expect.objectContaining({ lessonIds: ["l-sv1", "l-sv2"], dayOfWeek: 2 }),
      ),
    );
    expect(noMutation.mutateAsync).not.toHaveBeenCalled();
  });

  it("opens the block's own dialog from the card, and locks the whole block from it", async () => {
    blockApi.patch.mockResolvedValue({ blockId: "b-sv", isLocked: true, lessonIds: ["l-sv1", "l-sv2"] });
    const user = userEvent.setup();
    showPage();

    await user.click(await card());
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: /timetable\.blocks\.editMemberNamed\(Slöjd/ })).toBeTruthy();
    // Läsbehörighet: the editor a member opens and the lock are the master lessons' writes.
    expect(within(dialog).getByRole("button", { name: /timetable\.blocks\.editMemberNamed\(Slöjd/ })).toHaveAttribute(
      "data-writes",
      "SCHEMALAGGNING DRIFT",
    );
    expect(within(dialog).getByRole("button", { name: "timetable.blocks.lock" })).toHaveAttribute(
      "data-writes",
      "SCHEMALAGGNING DRIFT",
    );
    await user.click(within(dialog).getByRole("button", { name: "timetable.blocks.lock" }));

    await waitFor(() =>
      expect(blockApi.patch).toHaveBeenCalledWith("/api/v1/master-lessons/block-lock", { blockId: "b-sv", isLocked: true }),
    );
    expect(toasts.success).toHaveBeenCalledWith("timetable.blocks.locked(Språkval åk 4|2)");
  });

  it("says with the lock that the block's lessons on the tray were not locked", async () => {
    blockApi.patch.mockResolvedValue({ blockId: "b-sv", isLocked: true, lessonIds: ["l-sv1", "l-sv2"], parked: 1 });
    const user = userEvent.setup();
    showPage();

    await user.click(await card());
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "timetable.blocks.lock" }));

    await waitFor(() =>
      expect(toasts.warning).toHaveBeenCalledWith(
        "timetable.blocks.locked(Språkval åk 4|2)",
        expect.objectContaining({ description: "timetable.blocks.lockedParked(1)" }),
      ),
    );
    expect(toasts.success).not.toHaveBeenCalled();
  });

  it("moves the card with the keyboard as a drag does", async () => {
    blockApi.patch.mockResolvedValue({ lessons: [], propagatedLessons: 0, removedCalendarLessons: 0, warnings: [] });
    showPage();

    fireEvent.keyDown(await card(), { key: "ArrowRight" });
    await confirmClasses();

    await waitFor(() =>
      expect(blockApi.patch).toHaveBeenCalledWith(
        "/api/v1/master-lessons/block-card",
        expect.objectContaining({ lessonIds: ["l-sv1", "l-sv2"], dayOfWeek: 2, startTime: "13:00" }),
      ),
    );
  });

  it("names the block under a member standing apart from it", async () => {
    // A second lesson each, at different hours: both stand apart.
    state.lessons = [
      ...LESSONS,
      ...BLOCK_LESSONS,
      lesson("l-sv3", "s-sl", "g-ma1", "14:00"),
      lesson("l-sv4", "s-mu", "g-ma2", "15:00", { teacherId: "t-2" }),
    ];
    showPage();
    await screen.findAllByRole("button", { name: /Språkval åk 4/ });

    expect(
      screen.queryAllByRole("button").filter((el) => el.textContent?.includes("timetable.blocks.apart(Språkval åk 4)")),
    ).toHaveLength(2);
  });

  it("selects a card's lessons with it: counted as lessons, locked as a whole block, deleted as the card", async () => {
    // Slöjd's second lesson stands apart at 15:00: the block's, not the card's.
    state.lessons = [...LESSONS, ...BLOCK_LESSONS, lesson("l-sv3", "s-sl", "g-ma1", "15:00")];
    const user = userEvent.setup();
    const ids = () =>
      noMutation.mutateAsync.mock.calls.map(([body]) => (typeof body === "string" ? body : (body as { id: string }).id)).sort();
    showPage();
    // The apart lesson names the block too; the card is the one with 4ma2.
    const drawn = (await screen.findAllByRole("button", { name: /Språkval åk 4/ })).find((el) =>
      el.textContent?.includes("4ma2"),
    )!;

    fireEvent.keyDown(drawn, { key: "Enter", shiftKey: true });
    expect(await screen.findByText("timetable.bulkSelected(2)")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "timetable.bulkLock" }));
    // A lock on one card of a block is refused by the next generation.
    await waitFor(() => expect(ids()).toEqual(["l-sv1", "l-sv2", "l-sv3"]));

    noMutation.mutateAsync.mockClear();
    await user.click(screen.getByRole("button", { name: "timetable.bulkDelete" }));
    await waitFor(() => expect(ids()).toEqual(["l-sv1", "l-sv2"]));
  });

  it("drops the selection when the view changes, as a filter does", async () => {
    const user = userEvent.setup();
    showPage();

    fireEvent.keyDown(await card(), { key: "Enter", shiftKey: true });
    expect(await screen.findByText("timetable.bulkSelected(2)")).toBeInTheDocument();
    await user.click(screen.getByRole("combobox", { name: "timetable.viewLabel" }));
    await user.click(await screen.findByRole("option", { name: "timetable.viewByTeacher" }));

    await waitFor(() => expect(screen.queryByText(/timetable\.bulkSelected/)).toBeNull());
  });

  it("names every member on a card a filter shows two of, since the drag moves them all", async () => {
    state.lessons = [...LESSONS, ...BLOCK_LESSONS, lesson("l-sv5", "s-id", "g-71", "13:00", { teacherId: "t-3" })];
    state.requirements = [
      ...state.requirements,
      { id: "r-sv3", studentGroupId: "g-71", subjectId: "s-id", blockId: "b-sv" },
    ];
    showPage();
    await card();

    await filterTo("4ma1", "4ma2");

    expect((await card()).textContent).toContain("7.1");
  });

  it("asks of a card whose lessons reach one class each and two together", async () => {
    // 4ma2's Musik reaches 4.1 only, 4.2's own Slöjd 4.2 only.
    state.lessons = [
      ...LESSONS,
      lesson("l-sva", "s-mu", "g-ma2", "13:00", { teacherId: "t-2" }),
      lesson("l-svb", "s-sl", "g-42", "13:00"),
    ];
    state.requirements = [
      { id: "r-sva", studentGroupId: "g-ma2", subjectId: "s-mu", blockId: "b-sv" },
      { id: "r-svb", studentGroupId: "g-42", subjectId: "s-sl", blockId: "b-sv" },
    ];
    showPage();
    await card();

    dragToTuesday("Språkval åk 4");

    expect(await screen.findByText("timetable.sharedCardBody(Språkval åk 4|4.1, 4.2)")).toBeInTheDocument();
    expect(blockApi.patch).not.toHaveBeenCalled();
  });

  it("names the block under its lessons on the boards per teacher", async () => {
    const user = userEvent.setup();
    showPage();
    await card();

    await user.click(screen.getByRole("combobox", { name: "timetable.viewLabel" }));
    await user.click(await screen.findByRole("option", { name: "timetable.viewByTeacher" }));

    // Karin's Slöjd and Nils's Musik, each on its own board, each named.
    await waitFor(() =>
      expect(screen.queryAllByRole("button").filter((el) => el.textContent?.includes("Språkval åk 4"))).toHaveLength(2),
    );
  });

  it("refuses a card dropped where one of its lessons clashes, and says why", async () => {
    karinOnTuesday();
    showPage();
    await card();

    dragToTuesday("Språkval åk 4");

    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith("timetable.blocks.refusedSlot(Språkval åk 4)"));
    expect(blockApi.patch).not.toHaveBeenCalled();
    expect(screen.queryByText("timetable.suggestTitle")).toBeNull();
  });

  it("checks the whole card before the question's move-the-block, though the one lesson fits", async () => {
    karinOnTuesday();
    showPage();
    await card();
    await filterToTeacher("Nils Berg");

    dragToTuesday("Musik");
    const dialog = await screen.findByRole("dialog");
    await userEvent.setup().click(within(dialog).getByRole("button", { name: "timetable.blocks.moveBlock" }));

    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith("timetable.blocks.refusedSlot(Språkval åk 4)"));
    expect(blockApi.patch).not.toHaveBeenCalled();
    expect(noMutation.mutateAsync).not.toHaveBeenCalled();
  });

  it("asks the classes question of one member moved alone, as of any lesson", async () => {
    showPage();
    await card();
    // 4ma1's Slöjd alone: its pupils are in 4.1 and 4.2.
    await filterTo("4ma1");

    dragToTuesday("Slöjd");
    await userEvent
      .setup()
      .click(within(await screen.findByRole("dialog")).getByRole("button", { name: "timetable.blocks.moveOne" }));
    expect(await screen.findByText("timetable.sharedMoveTitle")).toBeInTheDocument();
    expect(noMutation.mutateAsync).not.toHaveBeenCalled();
    await confirmClasses();

    await waitFor(() =>
      expect(noMutation.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ id: "l-sv1", dayOfWeek: 2 })),
    );
  });

  it("says a card is not set aside on the tray, and sets nothing aside", async () => {
    showPage();
    const drawn = await card();

    fireEvent.pointerDown(drawn, { pointerId: 1, button: 0, clientX: 100, clientY: 60 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 700, clientY: 100 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 700, clientY: 100 });

    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith("timetable.blocks.refusedTray(Språkval åk 4)"));
    expect(noMutation.mutateAsync).not.toHaveBeenCalled();
  });

  it("offers the way back when a refused member's suggestion splits the block", async () => {
    noMutation.mutateAsync.mockResolvedValueOnce({
      id: "l-sv2",
      propagatedLessons: 0,
      removedCalendarLessons: 0,
      warnings: [{ code: "BLOCK_SPLIT", params: { block: "Språkval åk 4" } }],
    });
    const user = userEvent.setup();
    showPage();
    await card();
    await filterToTeacher("Nils Berg");
    // Musik onto Monday 09:00, where Nils has 4ma2's Matematik: refused, so
    // the free times are offered (13:00 is y 330, 09:00 is 240 min earlier).
    const musik = screen.queryAllByRole("button").find((el) => el.textContent?.includes("Musik"))!;
    fireEvent.pointerDown(musik, { pointerId: 1, button: 0, clientX: 100, clientY: 330 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 100, clientY: 66 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 100, clientY: 66 });

    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("timetable.suggestTitle");
    await user.click(Array.from(dialog.querySelectorAll("button")).find((button) => button.textContent?.includes("–"))!);

    await waitFor(() => expect(toasts.warning).toHaveBeenCalled());
    const [, options] = toasts.warning.mock.calls.at(-1)! as [string, { action?: { label: string } }];
    expect(options.action?.label).toBe("timetable.blocks.moveBack");
  });

  it("offers the way back when a member's own dialog splits the block", async () => {
    noMutation.mutateAsync.mockResolvedValueOnce({
      id: "l-sv1",
      propagatedLessons: 0,
      removedCalendarLessons: 0,
      warnings: [{ code: "BLOCK_SPLIT", params: { block: "Språkval åk 4" } }],
    });
    const user = userEvent.setup();
    showPage();

    await user.click(await card());
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: /timetable\.blocks\.editMemberNamed\(Slöjd/ }),
    );
    await user.click(await screen.findByRole("button", { name: "common.save" }));

    await waitFor(() => expect(toasts.warning).toHaveBeenCalled());
    const [, options] = toasts.warning.mock.calls.at(-1)! as [string, { action?: { label: string } }];
    expect(options.action?.label).toBe("timetable.blocks.moveBack");
  });

  it("says a split when a lesson of the block is placed from Parkering elsewhere, with the way back", async () => {
    // Musik's second lesson for 4ma2 is parked; it goes to Tuesday, and the
    // gateway says it left its card (BLOCK_SPLIT).
    state.lessons = [...LESSONS, ...BLOCK_LESSONS, { ...lesson("l-sv4", "s-mu", "g-ma2", "15:00", { teacherId: "t-2" }), isParked: true }];
    noMutation.mutateAsync.mockResolvedValueOnce({
      id: "l-sv4",
      isParked: false,
      propagatedLessons: 0,
      removedCalendarLessons: 0,
      warnings: [{ code: "BLOCK_SPLIT", params: { block: "Språkval åk 4" } }],
    });
    showPage();
    await card();

    const handle = screen.getByRole("button", { name: /timetable\.dragToPlace\(Musik/ });
    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 700, clientY: 100 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 200, clientY: 60 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 200, clientY: 60 });

    await waitFor(() =>
      expect(noMutation.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ id: "l-sv4", isParked: false, dayOfWeek: 2 })),
    );
    await waitFor(() => expect(toasts.warning).toHaveBeenCalled());
    const [, options] = toasts.warning.mock.calls.at(-1)! as [string, { action: { label: string; onClick: () => void } }];
    expect(options.action.label).toBe("timetable.blocks.moveBack");
    // Back to the slot it was parked from, beside its card.
    options.action.onClick();
    await waitFor(() =>
      expect(noMutation.mutateAsync).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: "l-sv4", dayOfWeek: 1, startTime: "15:00", endTime: "16:00" }),
      ),
    );
  });

  it("leaves behind on undo what a card move took in where it landed, with the owner it had, after a redo too", async () => {
    const answer = (joined: { id: string; isGenerated: boolean }[]) => ({
      lessons: [],
      propagatedLessons: 0,
      removedCalendarLessons: 0,
      warnings: [],
      joined,
    });
    blockApi.patch
      .mockResolvedValueOnce(answer([{ id: "l-sv5", isGenerated: false }]))
      .mockResolvedValueOnce(answer([]))
      // The redo lands beside another lesson of the block by then.
      .mockResolvedValueOnce(answer([{ id: "l-sv6", isGenerated: true }]))
      .mockResolvedValueOnce(answer([]));
    const user = userEvent.setup();
    const back = (leave: { id: string; isGenerated: boolean }[]) => ({
      lessonIds: ["l-sv1", "l-sv2"],
      dayOfWeek: 1,
      startTime: "13:00",
      endTime: "14:00",
      leave,
    });
    showPage();
    await card();

    dragToTuesday("Språkval åk 4");
    await confirmClasses();
    await waitFor(() => expect(blockApi.patch).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: /timetable\.undo/ }));
    await waitFor(() =>
      expect(blockApi.patch).toHaveBeenLastCalledWith("/api/v1/master-lessons/block-card", back([{ id: "l-sv5", isGenerated: false }])),
    );

    await user.click(screen.getByRole("button", { name: /timetable\.redo/ }));
    await waitFor(() => expect(blockApi.patch).toHaveBeenCalledTimes(3));
    await user.click(screen.getByRole("button", { name: /timetable\.undo/ }));
    await waitFor(() =>
      expect(blockApi.patch).toHaveBeenLastCalledWith("/api/v1/master-lessons/block-card", back([{ id: "l-sv6", isGenerated: true }])),
    );
  });

  it("offers to lock the block from a card whose own lessons are locked while another lesson of it is not", async () => {
    // The card's two lessons are locked; Slöjd's 15:00 lesson is not.
    state.lessons = [
      ...LESSONS,
      ...BLOCK_LESSONS.map((row) => ({ ...row, isLocked: true })),
      lesson("l-sv3", "s-sl", "g-ma1", "15:00"),
    ];
    blockApi.patch.mockResolvedValue({ blockId: "b-sv", isLocked: true, lessonIds: ["l-sv3"], parked: 0 });
    const user = userEvent.setup();
    showPage();

    const drawn = (await screen.findAllByRole("button", { name: /Språkval åk 4/ })).find((el) =>
      el.textContent?.includes("4ma2"),
    )!;
    await user.click(drawn);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByRole("button", { name: "timetable.blocks.unlock" })).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "timetable.blocks.lock" }));

    await waitFor(() =>
      expect(blockApi.patch).toHaveBeenCalledWith("/api/v1/master-lessons/block-lock", { blockId: "b-sv", isLocked: true }),
    );
  });

  it("gives focus back to the card when the lesson editor its dialog opened is closed", async () => {
    const user = userEvent.setup();
    showPage();
    const drawn = await card();

    drawn.focus();
    await user.keyboard("{Enter}");
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: /timetable\.blocks\.editMemberNamed\(Slöjd/ }),
    );
    await screen.findByRole("button", { name: "common.save" });
    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(focusedId()).toBe("block:l-sv1"));
  });

  it("gives focus back to the lesson when the classes question after the split question is cancelled", async () => {
    const user = userEvent.setup();
    showPage();
    await card();
    // 4ma1's Slöjd alone, dragged by the pointer: nothing of the grid's own
    // keyboard refocus is at work.
    await filterTo("4ma1");

    dragToTuesday("Slöjd");
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "timetable.blocks.moveOne" }));
    await screen.findByText("timetable.sharedMoveTitle");
    await user.click(screen.getByRole("button", { name: "common.cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(focusedId()).toBe("l-sv1"));
    expect(noMutation.mutateAsync).not.toHaveBeenCalled();
  });

  it("gives focus back to the lesson when the classes question after moving the whole block is cancelled", async () => {
    const user = userEvent.setup();
    showPage();
    await card();
    await filterToTeacher("Nils Berg");

    dragToTuesday("Musik");
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "timetable.blocks.moveBlock" }));
    await screen.findByText("timetable.sharedCardTitle");
    await user.click(screen.getByRole("button", { name: "common.cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(focusedId()).toBe("l-sv2"));
    expect(blockApi.patch).not.toHaveBeenCalled();
  });

  it("follows a card moved with the keyboard onto a lesson of its block to the card they make together", async () => {
    // A third member, Idrott för 7.1, split off to Tuesday 13:00 and with the
    // lowest id: the card the move makes is named after it.
    const third = { ...lesson("l-sv0", "s-id", "g-71", "13:00", { teacherId: "t-3" }), dayOfWeek: 2 };
    state.lessons = [...LESSONS, ...BLOCK_LESSONS, third];
    state.requirements = [
      ...state.requirements,
      { id: "r-sv3", studentGroupId: "g-71", subjectId: "s-id", blockId: "b-sv" },
    ];
    blockApi.patch.mockResolvedValue({
      lessons: [],
      propagatedLessons: 0,
      removedCalendarLessons: 0,
      warnings: [],
      joined: [{ id: "l-sv0", isGenerated: false }],
    });
    const view = showPage();
    await screen.findAllByRole("button", { name: /Språkval åk 4/ });
    const drawn = document.querySelector<HTMLElement>('[data-lesson-id="block:l-sv1"]')!;

    drawn.focus();
    fireEvent.keyDown(drawn, { key: "ArrowRight" });
    await confirmClasses();
    await waitFor(() => expect(blockApi.patch).toHaveBeenCalled());
    // The refetch: all three on Tuesday 13:00, one card.
    state.lessons = [...LESSONS, ...BLOCK_LESSONS.map((row) => ({ ...row, dayOfWeek: 2 })), third];
    view.again();

    await waitFor(() => expect(focusedId()).toBe("block:l-sv0"));
  });

  it("fetches nothing of it for a year whose timplan names no block", async () => {
    state.requirements = [{ id: "r-sv1", studentGroupId: "g-ma1", subjectId: "s-sl", blockId: null }];
    showPage();

    await screen.findAllByRole("button", { name: /Slöjd/ });
    expect(screen.queryByRole("button", { name: /Språkval åk 4/ })).toBeNull();
    expect(blockNames.read).not.toHaveBeenCalled();
  });
});

describe("a post alone in its block on another's times (Dela i halvklass, ett ämne)", () => {
  // Slöjd read in turn, say: 4ma1 in the autumn (block HT), 4ma2 in the
  // spring (block VT, on HT's times), one post each, Monday 13:00 in their
  // own weeks.
  const HALF_LESSONS = [
    { ...lesson("l-ht", "s-sl", "g-ma1", "13:00"), endDate: "2026-12-20" },
    { ...lesson("l-vt", "s-sl", "g-ma2", "13:00", { teacherId: "t-2" }), startDate: "2027-01-08" },
  ];

  beforeEach(() => {
    state.lessons = [...LESSONS, ...HALF_LESSONS];
    state.requirements = [
      { id: "r-ht", studentGroupId: "g-ma1", subjectId: "s-sl", blockId: "b-ht" },
      { id: "r-vt", studentGroupId: "g-ma2", subjectId: "s-sl", blockId: "b-vt" },
    ];
    blockNames.read.mockResolvedValue({
      data: [
        { id: "b-ht", academicYearId: "y-1", name: "Slöjd 4M HT", sameTimesAsBlockId: null },
        { id: "b-vt", academicYearId: "y-1", name: "Slöjd 4M VT", sameTimesAsBlockId: "b-ht" },
      ] as never,
      error: null,
    });
    blockApi.patch.mockReset();
    noMutation.mutateAsync.mockClear();
    toasts.success.mockClear();
  });
  afterEach(() => {
    blockNames.read.mockReset();
    blockNames.read.mockResolvedValue({ data: [{ id: "b-sv", academicYearId: "y-1", name: "Språkval åk 4" }], error: null });
  });

  const showPage = () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={client}>
        <TimetablePage />
      </QueryClientProvider>,
    );
  };
  const autumn = () => screen.findByRole("button", { name: /Slöjd 4M HT/ });

  it("draws each half's lesson as a card of its own, named for its block", async () => {
    showPage();

    expect((await autumn()).textContent).toContain("4ma1");
    expect((await screen.findByRole("button", { name: /Slöjd 4M VT/ })).textContent).toContain("4ma2");
  });

  it("opens the card's dialog, which names the other block and locks both from Lås blocket", async () => {
    blockApi.patch.mockResolvedValue({ blockId: "b-ht", isLocked: true, lessonIds: ["l-ht", "l-vt"], parked: 0 });
    const user = userEvent.setup();
    showPage();

    await user.click(await autumn());
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("timetable.blocks.cardBodyLinked(days.1|13:00|14:00|Slöjd 4M VT)");
    await user.click(within(dialog).getByRole("button", { name: "timetable.blocks.lock" }));

    await waitFor(() =>
      expect(blockApi.patch).toHaveBeenCalledWith("/api/v1/master-lessons/block-lock", { blockId: "b-ht", isLocked: true }),
    );
    expect(toasts.success).toHaveBeenCalledWith("timetable.blocks.locked(Slöjd 4M HT|2)");
  });

  it("moves the card as a card of one lesson, which the gateway moves with the other half's", async () => {
    blockApi.patch.mockResolvedValue({ lessons: [], propagatedLessons: 0, removedCalendarLessons: 0, warnings: [], followed: ["l-vt"] });
    showPage();
    await autumn();

    dragToTuesday("Slöjd 4M HT");
    // 4ma1 holds pupils of 4.1 and 4.2: asked first, as any card is.
    await userEvent.setup().click(await screen.findByRole("button", { name: "timetable.sharedMoveConfirm" }));

    await waitFor(() =>
      expect(blockApi.patch).toHaveBeenCalledWith("/api/v1/master-lessons/block-card", {
        lessonIds: ["l-ht"],
        dayOfWeek: 2,
        startTime: "13:00",
        endTime: "14:00",
      }),
    );
    expect(noMutation.mutateAsync).not.toHaveBeenCalled();
  });

  it("selected and locked from the bar, takes the other half's lessons with it", async () => {
    const user = userEvent.setup();
    showPage();

    fireEvent.keyDown(await autumn(), { key: "Enter", shiftKey: true });
    expect(await screen.findByText("timetable.bulkSelected(1)")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "timetable.bulkLock" }));

    await waitFor(() =>
      expect(
        noMutation.mutateAsync.mock.calls.map(([body]) => (typeof body === "string" ? body : (body as { id: string }).id)).sort(),
      ).toEqual(["l-ht", "l-vt"]),
    );
  });
});

describe("what a profile that does not write the grundschema is spared (Läsbehörighet)", () => {
  /*
   * The (app) layout's style rule hides a control marked data-writes and takes
   * the pointer from a part marked data-writes-inert, for each area the
   * profile does not write (components/admin/area-refusal.tsx). jsdom draws
   * no style, so the marks are what is read here.
   */
  it("marks the header's writes with their routes' areas, and what is read beside them with none", async () => {
    const user = userEvent.setup();
    render(<TimetablePage />);
    expect(screen.getByRole("button", { name: "timetable.addLesson" })).toHaveAttribute("data-writes", "SCHEMALAGGNING DRIFT");
    expect(screen.getByRole("button", { name: "timetable.publish" })).toHaveAttribute("data-writes", "PUBLICERING DRIFT");
    for (const name of ["timetable.undo", "timetable.redo"]) {
      expect(screen.getByRole("button", { name }).closest("[data-writes]")).toHaveAttribute("data-writes", "SCHEMALAGGNING DRIFT");
    }
    // The hint says how to drag, click and key the writes: it goes with them.
    expect(screen.getByText(/^timetable\.dragHint/)).toHaveAttribute("data-writes", "SCHEMALAGGNING DRIFT");
    // The versions are a list to read and compare; its own buttons are marked in the dialog.
    expect(screen.getByRole("button", { name: "timetable.versions" }).closest("[data-writes]")).toBeNull();

    await user.click(screen.getByRole("button", { name: "timetable.moreActions" }));
    expect(await screen.findByRole("menuitem", { name: "timetable.optimizeRooms" })).toHaveAttribute(
      "data-writes",
      "SCHEMALAGGNING DRIFT",
    );
    for (const name of ["timetable.exportIcs", "timetable.exportPdf", "timetable.print"]) {
      expect(screen.getByRole("menuitem", { name })).not.toHaveAttribute("data-writes");
    }
  });

  it("keeps the grid's lessons on screen and takes the pointer from its columns: a drag, a click to edit or to add", () => {
    const { container } = render(<TimetablePage />);
    const card = container.querySelector('[data-lesson-id="l-slojd"]')!;
    expect(card).not.toBeNull();
    expect(card.closest("[data-writes]")).toBeNull();
    expect(card.closest("[data-writes-inert]")).toHaveAttribute("data-writes-inert", "SCHEMALAGGNING DRIFT");
  });

  it("gives a reader the grid to read: no column to press, no editor, the hover text kept", () => {
    const { container } = render(
      <ProfileProvider profile={{} as Profile} school={null} readOnly>
        <TimetablePage />
      </ProfileProvider>,
    );
    const card = container.querySelector<HTMLElement>('[data-lesson-id="l-slojd"]')!;
    expect(card.closest("[data-writes-inert]")).toBeNull();
    expect(card).toHaveClass("cursor-default");
    expect(card.getAttribute("title")).toBeTruthy();
    fireEvent.pointerDown(card, { button: 0 });
    fireEvent.pointerUp(card, { button: 0 });
    fireEvent.click(card);
    fireEvent.keyDown(card, { key: "Enter" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps a parked lesson on the tray to read, without its drag or its way back", () => {
    state.lessons = LESSONS.map((l) => (l.id === "l-slojd" ? { ...l, isParked: true } : l));
    render(<TimetablePage />);
    const tray = screen.getByTestId("lesson-tray");
    expect(within(tray).getByRole("button", { name: /^timetable\.dragToPlace/ })).toHaveAttribute(
      "data-writes-inert",
      "SCHEMALAGGNING DRIFT",
    );
    expect(within(tray).getByRole("button", { name: "timetable.putBack" })).toHaveAttribute("data-writes", "SCHEMALAGGNING DRIFT");
  });

  it("marks the selection's lock, unlock and delete, and leaves the clearing of it alone", async () => {
    const { container } = render(<TimetablePage />);
    fireEvent.keyDown(container.querySelector('[data-lesson-id="l-slojd"]')!, { key: "Enter", shiftKey: true });
    expect(await screen.findByText(/^timetable\.bulkSelected/)).toBeInTheDocument();
    for (const name of ["timetable.bulkLock", "timetable.bulkUnlock", "timetable.bulkDelete"]) {
      expect(screen.getByRole("button", { name })).toHaveAttribute("data-writes", "SCHEMALAGGNING DRIFT");
    }
    expect(screen.getByRole("button", { name: "timetable.bulkClear" })).not.toHaveAttribute("data-writes");
  });
});
