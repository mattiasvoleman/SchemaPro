import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import GapsPage from "./page";
import svMessages from "@/messages/sv.json";
import type { AvailabilityConstraint, LessonRecurrence, MasterLesson } from "@/lib/types";

/**
 * The three open questions, wired to real data.
 *
 * lib/gaps.ts and lib/conflicts.ts are NOT mocked here. The interesting
 * failures on this page are wiring failures — a schedule searched without its
 * group-conflict map, a lunch setting never passed on, a teaching group counted
 * as a body that sits idle — and every one of those survives a mocked engine.
 * So the fixture below is a small but real week, and the assertions are the
 * strings a reader actually gets.
 *
 * WHAT jsdom CANNOT SEE, and how it was checked instead:
 *
 *   Touch targets. jsdom computes no layout, so "44px" is unobservable. What is
 *   asserted is the token that produces it (h-11 / min-h-11) on every control,
 *   the same way app-shell.test.tsx asserts min-w-0. The 2.75rem those tokens
 *   resolve to is Tailwind's own scale, not a guess.
 *
 *   Contrast. Also unobservable, and worse than that: no assertion in this file
 *   can ever contradict a ratio written in it, because jsdom resolves no CSS
 *   variables. An earlier version of this docblock therefore carried a false
 *   inventory for a whole review cycle — it enumerated the page's own JSX and
 *   missed what the shared components paint. The numbers now live in page.tsx's
 *   docblock, computed from the tokens in app/globals.css; the short version is
 *   AAA for every piece of text and AA (6.18 light / 5.12 dark) for the two
 *   filled submit buttons, which are the product's brand colour and not one
 *   page's to change.
 *
 *   What IS asserted below is the half jsdom can see: the class tokens that
 *   decide those ratios. `text-foreground` on the column headers instead of
 *   TableHead's muted default, a visible border on every boxed control instead
 *   of the near-invisible `border-input`, `ring-offset-background` on every
 *   focus ring. Those three are exactly where the claim was silently lost.
 *
 *   Reading order in a real screen reader. Not verified in a browser: the route
 *   sits behind a Supabase session and no seeded instance was available. What
 *   is verified below is the structure it depends on — named regions, a named
 *   table, real <label> associations, live regions that exist before they fill,
 *   keyboard operation of every control, and where focus lands when a control
 *   destroys itself.
 */

const state = vi.hoisted(() => ({
  lessons: [] as unknown[],
  people: [] as unknown[],
  isLoading: false,
  constraints: [] as unknown[],
  // undefined models the query in flight, which is a different fact from an
  // empty roster and must reach the page as one.
  memberships: [] as unknown[] | undefined,
  // Same distinction as memberships: undefined is the query in flight, [] is a
  // school that has entered no ramtider. The page must pass the two on as they
  // are, not collapse them.
  frameTimes: [] as unknown[] | undefined,
  // Stateful because the ORDER the queries resolve in is itself a case: a
  // group's year span is derived from groups AND memberships, so groups
  // landing last changes the spans without changing the roster.
  groups: null as unknown[] | null,
  lunch: null as unknown,
}));

vi.mock("@/lib/queries", () => ({
  useActiveYear: () => ({ activeYear: { id: "y-1" } }),
  useMasterLessons: () => ({ data: state.lessons, isLoading: state.isLoading }),
  useConstraints: () => ({ data: state.constraints }),
  useGroups: () => ({ data: state.groups ?? GROUPS }),
  usePeople: () => ({ data: state.people }),
  useRooms: () => ({ data: ROOMS }),
  useGroupMemberships: () => ({ data: state.memberships }),
  useFrameTimes: () => ({ data: state.frameTimes }),
  useLunchSettings: () => ({ data: state.lunch }),
}));

// Namespace-aware key echo. The namespace is part of the assertion on purpose:
// this page deliberately reads the three parity labels out of `timetable` and
// the weekday names out of `days` rather than translating either a second time.
vi.mock("next-intl", () => ({
  // DateField reads the active locale for its month and weekday names.
  useLocale: () => "sv",
  useTranslations:
    (namespace: string) => (key: string, values?: Record<string, unknown>) =>
      values
        ? `${namespace}.${key}(${Object.values(values).join("|")})`
        : `${namespace}.${key}`,
}));

// ---------------------------------------------------------------------------
// A small but real week.
//
//          Wed (3)                                        Thu (4)         Fri (5)
//   7A     08–09        10:20–11:20        13–14
//   8B     08–09 09–10                                                    10–11 odd
//   9C                       10:30–11  11:30–12:30
//   Ma71                                             09–10  11:30–12:30
//
//   Karin  7A's two morning lessons
//   Per    both 8B lessons, both 9C lessons, 7A's afternoon               8B's Friday
//   Ola    Ma71 only
//   Ada    nothing at all, and deactivated
//
// Lunch is 11:00–12:30 with thirty minutes to eat.
//
// 7A is two pupils, Sara and Elin, and only Sara is enrolled in Ma71 — which
// is what makes 7A busy on Thursday without a lesson of its own, and what
// makes its Thursday hole one pupil of two rather than the whole class. 8B is
// Nils alone; 9C has no roster at all, which is the case a school that has not
// entered its pupils yet is in.
// ---------------------------------------------------------------------------

const GROUPS = [
  { id: "g-7a", academicYearId: "y-1", name: "7A", kind: "CLASS", gradeLevel: 7 },
  { id: "g-8b", academicYearId: "y-1", name: "8B", kind: "CLASS", gradeLevel: 8 },
  { id: "g-9c", academicYearId: "y-1", name: "9C", kind: "CLASS", gradeLevel: 9 },
  {
    id: "g-ma71",
    academicYearId: "y-1",
    name: "Ma71",
    kind: "TEACHING_GROUP",
    gradeLevel: null,
  },
];

const person = (
  id: string,
  firstName: string,
  lastName: string,
  role: "TEACHER" | "STUDENT",
  extra: { isActive?: boolean; studentGroupId?: string | null } = {},
) => ({
  id,
  role,
  firstName,
  lastName,
  email: `${id}@skola.se`,
  phone: null,
  isActive: extra.isActive ?? true,
  invitedAt: null,
  studentGroupId: extra.studentGroupId ?? null,
});

const PEOPLE = [
  person("t-karin", "Karin", "Ek", "TEACHER"),
  person("t-per", "Per", "Nord", "TEACHER"),
  person("t-ola", "Ola", "Sund", "TEACHER"),
  person("t-ada", "Ada", "Lind", "TEACHER", { isActive: false }),
  person("s-1", "Sara", "Alm", "STUDENT", { studentGroupId: "g-7a" }),
  person("s-3", "Elin", "Vik", "STUDENT", { studentGroupId: "g-7a" }),
  person("s-2", "Nils", "Berg", "STUDENT", { studentGroupId: "g-8b" }),
];

const room = (id: string, name: string) => ({
  id,
  name,
  code: null,
  capacity: 30,
  roomTypeId: null,
  minGradeLevel: null,
  maxGradeLevel: null,
  requiresApproval: false,
});

const ROOMS = [room("r-a12", "A12"), room("r-b03", "B03")];

function lesson(
  id: string,
  studentGroupId: string,
  teacherId: string,
  roomId: string,
  dayOfWeek: number,
  startTime: string,
  endTime: string,
  recurrence: LessonRecurrence = "ALL_WEEKS",
): MasterLesson {
  return {
    id,
    academicYearId: "y-1",
    subjectId: "sub-1",
    studentGroupId,
    teacherId,
    coTeacherId: null,
    roomId,
    dayOfWeek,
    startTime: `${startTime}:00`,
    endTime: `${endTime}:00`,
    isLocked: false,
    recurrence,
    startDate: null,
    endDate: null,
    extraGroupIds: [],
    studentIds: [],
  };
}

const WEEK: MasterLesson[] = [
  lesson("l1", "g-7a", "t-karin", "r-a12", 3, "08:00", "09:00"),
  lesson("l2", "g-7a", "t-karin", "r-a12", 3, "10:20", "11:20"),
  lesson("l3", "g-7a", "t-per", "r-b03", 3, "13:00", "14:00"),
  lesson("l4", "g-8b", "t-per", "r-b03", 3, "08:00", "09:00"),
  lesson("l5", "g-8b", "t-per", "r-b03", 3, "09:00", "10:00"),
  lesson("l6", "g-9c", "t-per", "r-b03", 3, "10:30", "11:00"),
  lesson("l7", "g-9c", "t-per", "r-b03", 3, "11:30", "12:30"),
  lesson("l8", "g-ma71", "t-ola", "r-a12", 4, "09:00", "10:00"),
  lesson("l9", "g-ma71", "t-ola", "r-a12", 4, "11:30", "12:30"),
  lesson("l10", "g-8b", "t-per", "r-b03", 5, "10:00", "11:00", "ODD_WEEKS"),
];

const LUNCH = {
  id: "lunch-1",
  lunchEnabled: true,
  lunchStartTime: "11:00:00",
  lunchEndTime: "12:30:00",
  lunchMinutes: 30,
  diningSeats: null,
  maxLessonsPerDayPerGroup: null,
};

const unavailable = (
  userId: string,
  dayOfWeek: number,
  startTime: string,
  endTime: string,
): AvailabilityConstraint => ({
  id: `c-${userId}-${dayOfWeek}`,
  resourceType: "TEACHER",
  userId,
  roomId: null,
  studentGroupId: null,
  minGradeLevel: null,
  maxGradeLevel: null,
  dayOfWeek,
  date: null,
  startTime: `${startTime}:00`,
  endTime: `${endTime}:00`,
  type: "UNAVAILABLE",
  reason: "Möte",
});

beforeEach(() => {
  state.lessons = WEEK;
  state.people = PEOPLE;
  state.isLoading = false;
  state.constraints = [];
  state.memberships = [{ studentId: "s-1", studentGroupId: "g-ma71" }];
  state.frameTimes = [];
  state.groups = null;
  state.lunch = LUNCH;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const region = (name: string) => screen.getByRole("region", { name });

/** Every result row of a section, as "cell | cell | cell". */
const rowsOf = (name: string) =>
  within(region(name))
    .getAllByRole("row")
    .slice(1)
    .map((row) =>
      Array.from(row.querySelectorAll("td"))
        .map((cell) => cell.textContent)
        .join(" | "),
    );

const onDay = (name: string, day: number) =>
  rowsOf(name).filter((row) => row.startsWith(`days.${day}`));

const statusOf = (name: string) => within(region(name)).getByRole("status");

const check = (user: ReturnType<typeof userEvent.setup>, name: string) =>
  user.click(screen.getByRole("checkbox", { name }));

const searchFree = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(
    within(region("gaps.freeTitle")).getByRole("button", { name: "gaps.freeSearch" }),
  );

const searchWho = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(
    within(region("gaps.whoTitle")).getByRole("button", { name: "gaps.whoSearch" }),
  );

/**
 * `<input type="time">` is one of the controls user-event drives by typing
 * segments, which jsdom models only partially; the value change is what this
 * page reads, so it is set directly. Keyboard operation is covered on its own
 * further down.
 */
const setTime = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

const pick = async (
  user: ReturnType<typeof userEvent.setup>,
  trigger: string,
  option: string,
) => {
  await user.click(screen.getByRole("combobox", { name: trigger }));
  await user.click(await screen.findByRole("option", { name: option }));
};

// ---------------------------------------------------------------------------
// 1. Ledig tid
// ---------------------------------------------------------------------------

describe("Gaps page — free time", () => {
  it("answers with whole windows, in day and time order", async () => {
    const user = userEvent.setup();
    render(<GapsPage />);

    await check(user, "7A");
    await searchFree(user);

    // Maximal windows, not fifteen-minute offsets: 7A is taught 08–09,
    // 10:20–11:20 and 13–14 on Wednesday, so the room it has is these three.
    expect(onDay("gaps.freeTitle", 3)).toEqual([
      "days.3 | 09:00–10:20 | gaps.durationHours(1|20) | timetable.recurrenceAll",
      "days.3 | 11:20–13:00 | gaps.durationHours(1|40) | timetable.recurrenceAll",
      "days.3 | 14:00–17:00 | gaps.durationHoursOnly(3) | timetable.recurrenceAll",
    ]);
  });

  it("announces the count in a live region that exists before it fills", async () => {
    const user = userEvent.setup();
    render(<GapsPage />);

    // Mounted empty: a live region inserted together with its text is not
    // announced by most screen readers, only a change inside an existing one.
    const status = statusOf("gaps.freeTitle");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status.textContent).toBe("");

    await check(user, "7A");
    await searchFree(user);

    expect(statusOf("gaps.freeTitle")).toHaveTextContent("gaps.freeCount(9|7A)");
  });

  it("narrows the answer when a second body is added", async () => {
    const user = userEvent.setup();
    render(<GapsPage />);

    await check(user, "7A");
    await searchFree(user);
    expect(onDay("gaps.freeTitle", 3)).toContain(
      "days.3 | 09:00–10:20 | gaps.durationHours(1|20) | timetable.recurrenceAll",
    );

    // B03 is taught in until 10:00, so 09:00–10:20 collapses to twenty minutes
    // and falls below the hour asked for. The afternoon survives, which is how
    // we know the search still ran.
    await check(user, "B03");
    await searchFree(user);
    expect(onDay("gaps.freeTitle", 3)).toEqual([
      "days.3 | 14:00–17:00 | gaps.durationHoursOnly(3) | timetable.recurrenceAll",
    ]);
  });

  it("offers an every-other-week window as one, beside the weekly ones", async () => {
    const user = userEvent.setup();
    render(<GapsPage />);

    await check(user, "8B");
    await searchFree(user);

    // 8B's Friday lesson runs odd weeks only. The whole day is free on even
    // weeks — a real answer — while the hours around the lesson are free every
    // week. Presenting the first as ordinary free time would mislead.
    expect(onDay("gaps.freeTitle", 5)).toEqual([
      "days.5 | 08:00–10:00 | gaps.durationHoursOnly(2) | timetable.recurrenceAll",
      "days.5 | 08:00–17:00 | gaps.durationHoursOnly(9) | timetable.recurrenceEven",
      "days.5 | 11:00–17:00 | gaps.durationHoursOnly(6) | timetable.recurrenceAll",
    ]);
  });

  it("names the results table after the bodies it answers about", async () => {
    const user = userEvent.setup();
    render(<GapsPage />);

    await check(user, "7A");
    await searchFree(user);

    // The <caption> is the table's only accessible name. Without it a screen
    // reader landing here by table navigation hears "table, 4 columns" and
    // nothing about whose free time it is looking at.
    expect(
      within(region("gaps.freeTitle")).getByRole("table", {
        name: "gaps.freeCaption(7A)",
      }),
    ).toBeTruthy();

    await check(user, "B03");
    await searchFree(user);
    expect(
      within(region("gaps.freeTitle")).getByRole("table", {
        name: "gaps.freeCaption(7A, B03)",
      }),
    ).toBeTruthy();
  });

  it("keeps the weekdays when the school also teaches on a Saturday", async () => {
    const user = userEvent.setup();
    // The searched days are Mon–Fri widened by the days that carry lessons,
    // not replaced by them: a Saturday school must not lose its Mondays, and a
    // school with an empty Monday still wants Monday offered as free.
    state.lessons = [...WEEK, lesson("sat", "g-8b", "t-per", "r-b03", 6, "09:00", "10:00")];
    render(<GapsPage />);

    await check(user, "8B");
    await searchFree(user);

    expect(onDay("gaps.freeTitle", 6)).toEqual([
      "days.6 | 08:00–09:00 | gaps.durationHoursOnly(1) | timetable.recurrenceAll",
      "days.6 | 10:00–17:00 | gaps.durationHoursOnly(7) | timetable.recurrenceAll",
    ]);
    expect(onDay("gaps.freeTitle", 1)).toEqual([
      "days.1 | 08:00–17:00 | gaps.durationHoursOnly(9) | timetable.recurrenceAll",
    ]);
  });

  it("counts a weekly unavailability as occupied time", async () => {
    const user = userEvent.setup();
    render(<GapsPage />);

    await check(user, "Karin Ek");
    await searchFree(user);
    expect(onDay("gaps.freeTitle", 3)).toContain(
      "days.3 | 11:20–17:00 | gaps.durationHours(5|40) | timetable.recurrenceAll",
    );

    cleanup();
    state.constraints = [unavailable("t-karin", 3, "14:00", "17:00")];
    render(<GapsPage />);
    await check(user, "Karin Ek");
    await searchFree(user);

    // A standing Wednesday meeting closes the afternoon exactly as a lesson
    // would; the morning hole it does not touch is unchanged.
    expect(onDay("gaps.freeTitle", 3)).toEqual([
      "days.3 | 09:00–10:20 | gaps.durationHours(1|20) | timetable.recurrenceAll",
      "days.3 | 11:20–14:00 | gaps.durationHours(2|40) | timetable.recurrenceAll",
    ]);
  });

  it("closes time for a year rule, on a group that has no year of its own", async () => {
    const user = userEvent.setup();
    render(<GapsPage />);

    await check(user, "Ma71");
    await searchFree(user);
    const before = onDay("gaps.freeTitle", 4);

    cleanup();
    // A GRADE_LEVEL rule names no row at all — no userId, no studentGroupId —
    // so it reaches Ma71 only through the years its members bring: Sara is a
    // 7A pupil, so Ma71 is a year-7 group even though its own gradeLevel is
    // null. Without buildGradeSpans on this page the rule matches nothing and
    // the search offers Thursday afternoon to a year that may not be there.
    state.constraints = [
      {
        id: "c-year-7",
        resourceType: "GRADE_LEVEL",
        userId: null,
        roomId: null,
        studentGroupId: null,
        minGradeLevel: 7,
        maxGradeLevel: 7,
        dayOfWeek: 4,
        date: null,
        startTime: "14:00:00",
        endTime: "17:00:00",
        type: "UNAVAILABLE",
        reason: "Ramtid",
      } as AvailabilityConstraint,
    ];
    render(<GapsPage />);
    await check(user, "Ma71");
    await searchFree(user);

    expect(onDay("gaps.freeTitle", 4)).not.toEqual(before);
    expect(onDay("gaps.freeTitle", 4).join("\n")).not.toMatch(/–1[5-7]:00/);
  });

  it("stops offering time a ramtid has closed", async () => {
    const user = userEvent.setup();
    render(<GapsPage />);

    await check(user, "8B");
    await searchFree(user);
    const openDay = onDay("gaps.freeTitle", 4).join(" ");
    expect(openDay).toContain("17:00");

    cleanup();
    // 8B is a year-8 class, so a 7-9 frame reaches it through its own
    // gradeLevel — no membership needed, unlike the Ma71 case above.
    state.frameTimes = [
      {
        id: "ram-1",
        minGradeLevel: 7,
        maxGradeLevel: 9,
        dayOfWeek: null,
        startTime: "08:00:00",
        endTime: "15:00:00",
      },
    ];
    render(<GapsPage />);
    await check(user, "8B");
    await searchFree(user);

    const framedDay = onDay("gaps.freeTitle", 4).join(" ");
    expect(framedDay).not.toContain("17:00");
    expect(framedDay).toContain("15:00");
  });

  it("picks up ramtider that arrive after the first render", async () => {
    /*
     * The real sequence, not the convenient one. Every other test here renders
     * with the fixture already in place, so the schedule memo is built once and
     * never has to notice anything — a dependency array missing frameTimes
     * passes all of them. On a real page the query resolves a moment after
     * mount, and a memo that does not name it goes on answering with the
     * frameless week it was built from.
     *
     * rerender, not a second render: a fresh mount would rebuild the memo from
     * scratch and prove nothing.
     */
    const user = userEvent.setup();
    const { rerender } = render(<GapsPage />);

    await check(user, "8B");
    await searchFree(user);
    expect(onDay("gaps.freeTitle", 4).join(" ")).toContain("17:00");

    state.frameTimes = [
      {
        id: "ram-1",
        minGradeLevel: 7,
        maxGradeLevel: 9,
        dayOfWeek: null,
        startTime: "08:00:00",
        endTime: "15:00:00",
      },
    ];
    rerender(<GapsPage />);
    await searchFree(user);

    expect(onDay("gaps.freeTitle", 4).join(" ")).not.toContain("17:00");
  });

  it("picks up year spans that change when the groups arrive", async () => {
    /*
     * A group's years come from groups AND memberships, and the schedule memo
     * lists both the roster and the derived spans. Only the spans cover this
     * ordering: groups resolving last moves a span without touching the
     * roster, and a memo that named memberships alone would keep the frameless
     * answer it was built from.
     */
    const user = userEvent.setup();
    // 8B without its gradeLevel: nothing for a 7-9 frame to match.
    state.groups = GROUPS.map((group) =>
      group.id === "g-8b" ? { ...group, gradeLevel: null } : group,
    );
    state.frameTimes = [
      {
        id: "ram-1",
        minGradeLevel: 7,
        maxGradeLevel: 9,
        dayOfWeek: null,
        startTime: "08:00:00",
        endTime: "15:00:00",
      },
    ];
    const { rerender } = render(<GapsPage />);

    await check(user, "8B");
    await searchFree(user);
    expect(onDay("gaps.freeTitle", 4).join(" ")).toContain("17:00");

    state.groups = GROUPS;
    rerender(<GapsPage />);
    await searchFree(user);

    expect(onDay("gaps.freeTitle", 4).join(" ")).not.toContain("17:00");
  });

  it("refuses to answer a question about nobody, and clears back to it", async () => {
    const user = userEvent.setup();
    render(<GapsPage />);

    await searchFree(user);

    // Every hour of every day would read as a result. It is not one.
    expect(statusOf("gaps.freeTitle")).toHaveTextContent("gaps.freeNobody");
    expect(within(region("gaps.freeTitle")).queryByRole("table")).toBeNull();

    await check(user, "7A");
    await searchFree(user);
    expect(within(region("gaps.freeTitle")).getByRole("table")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "gaps.freeClear" }));
    expect(screen.getByRole("checkbox", { name: "7A" })).not.toBeChecked();
    expect(within(region("gaps.freeTitle")).queryByRole("table")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. Håltimmar
// ---------------------------------------------------------------------------

const reportHeadings = () =>
  within(region("gaps.idleTitle")).getAllByRole("heading", { level: 3 });

const reportNames = () => reportHeadings().map((heading) => heading.textContent);

const reportFor = (name: string) =>
  reportHeadings()
    .find((heading) => heading.textContent?.startsWith(name))
    ?.closest("article") as HTMLElement;

/**
 * Eleven reports: seven more teachers, each with the same Thursday hole, to
 * push the list past the ten it shows. Their group is not a class, so only the
 * teachers gain a report.
 */
const elevenReports = () => {
  state.lessons = [
    ...WEEK,
    ...Array.from({ length: 7 }, (_, index) => [
      lesson(`x${index}a`, "g-none", `t-x${index}`, "r-a12", 4, "09:00", "10:00"),
      lesson(`x${index}b`, "g-none", `t-x${index}`, "r-a12", 4, "11:30", "12:30"),
    ]).flat(),
  ];
  state.people = [
    ...PEOPLE,
    ...Array.from({ length: 7 }, (_, index) =>
      person(`t-x${index}`, "Vikarie", `${index}`, "TEACHER"),
    ),
  ];
};

describe("Gaps page — idle gaps", () => {
  it("ranks by the heaviest week and leaves out whoever has none", () => {
    render(<GapsPage />);

    // 8B is taught 08–09 and 09–10 back to back: two lessons and no hole
    // between them, so it is not in the list at all. 7A is, three times over.
    expect(reportNames()).toEqual([
      "7Agaps.kindGroup",
      "Karin Ekgaps.kindTeacher",
      "Ola Sundgaps.kindTeacher",
      "Per Nordgaps.kindTeacher",
    ]);
    expect(statusOf("gaps.idleTitle")).toHaveTextContent("gaps.idleCount(4)");
  });

  it("names each gap in words: day, clock time, how many pupils, and how long it feels", () => {
    render(<GapsPage />);

    const lines = within(reportFor("7A"))
      .getAllByRole("listitem")
      .map((item) => item.textContent);

    // Colour is never the only carrier. "lång" and "medellång" are words in the
    // line itself, which is what a screen reader reads out.
    //
    // The pupil counts are the difference between a row you can act on and a
    // row you cannot. Wednesday is the whole of 7A waiting; Thursday is Sara
    // alone, idle because the other half of her class is in Ma71 — the same
    // wall clock, two entirely different problems, and only the count tells
    // them apart.
    expect(lines).toEqual([
      "days.3 09:00–10:20 · gaps.durationHours(1|20) · gaps.idleStudents(2|2) · gaps.lengthLong",
      "days.3 11:20–13:00 · gaps.durationHours(1|40) · gaps.idleStudents(2|2) · gaps.idleLunch(gaps.durationMinutes(30)) · gaps.lengthMedium",
      "days.4 10:00–11:30 · gaps.durationHours(1|30) · gaps.idleStudents(1|2) · gaps.idleLunch(gaps.durationMinutes(30)) · gaps.lengthMedium",
    ]);

    // And the twin: a teacher is one person, not a roster, so no count is
    // printed for one — "1 av 1 lärare ledig" would be a sentence about
    // nothing.
    const perLine = within(reportFor("Per Nord")).getAllByRole("listitem")[0].textContent;
    expect(perLine).toContain("gaps.lengthShort");
    expect(perLine).not.toContain("gaps.idleStudents");
  });

  it("credits lunch instead of thresholding it", () => {
    // 9C's only hole is 11:00–11:30, which is lunch and nothing else, so it is
    // not a håltimme and 9C is absent. Switch lunch off and the same hole is
    // thirty idle minutes — the twin that gives the absence its meaning.
    render(<GapsPage />);
    expect(reportNames()).not.toContain("9Cgaps.kindGroup");

    cleanup();
    state.lunch = { ...LUNCH, lunchEnabled: false };
    render(<GapsPage />);

    expect(reportNames()).toContain("9Cgaps.kindGroup");
    expect(within(reportFor("9C")).getByRole("listitem")).toHaveTextContent(
      "days.3 11:00–11:30 · gaps.durationMinutes(30) · gaps.lengthShort",
    );
  });

  it("sums the heaviest week rather than the year, and names the longest hole", () => {
    render(<GapsPage />);

    // 80 + 70 + 60 idle minutes, of which the 80 is the worst single hole.
    expect(reportFor("7A")).toHaveTextContent(
      "gaps.idleSummary(gaps.durationHours(3|30)|gaps.durationHours(1|20))",
    );
  });

  it("reports classes and teachers, never a teaching group or a room", () => {
    render(<GapsPage />);

    // Ma71 has a 90-minute hole on Thursday and would rank if it were asked
    // about — but its pupils are already counted inside 7A, whose Thursday gap
    // exists at all only because Sara is enrolled in Ma71. Counting both would
    // rank a school's own duplicates above its worst days.
    expect(reportNames()).not.toContain("Ma71gaps.kindGroup");
    expect(reportNames().join()).not.toContain("A12");
    expect(reportFor("7A")).toHaveTextContent("days.4 10:00–11:30");
  });

  it("hides the tail behind one button rather than rendering ninety reports", async () => {
    const user = userEvent.setup();
    elevenReports();

    render(<GapsPage />);
    expect(reportNames()).toHaveLength(10);

    await user.click(screen.getByRole("button", { name: "gaps.idleShowAll(11)" }));
    expect(reportNames()).toHaveLength(11);
  });

  it("hands focus to the first uncovered report and says the list grew", async () => {
    const user = userEvent.setup();
    elevenReports();
    render(<GapsPage />);

    const button = screen.getByRole("button", { name: "gaps.idleShowAll(11)" });
    button.focus();
    expect(document.activeElement).toBe(button);
    expect(statusOf("gaps.idleTitle")).toHaveTextContent("gaps.idleShowingSome(10)");

    await user.click(button);

    // The button's own click makes the condition that renders it false, so it
    // unmounts underneath the caret. With nowhere to send focus it lands on
    // <body> and a keyboard reader is returned to the top of the document —
    // three sections above the list they just expanded. And the count in the
    // live region is 11 both before and after, so a screen-reader user is told
    // nothing at all unless the second sentence changes.
    expect(document.activeElement).toBe(reportHeadings()[10]);
    expect(statusOf("gaps.idleTitle")).toHaveTextContent("gaps.idleShowingAll(11)");
  });

  it("labels an every-other-week hole as one, beside the weekly holes", () => {
    // 8B is taught Friday 08–09 and 11–12 every week, and 10–11 on odd weeks
    // only. So odd weeks have a one-hour hole 09–10, and even weeks have a
    // two-hour hole 09–11 that odd weeks do not: the same day, two different
    // schedules, and only one of them carries a parity.
    state.lessons = [
      ...WEEK,
      lesson("f1", "g-8b", "t-per", "r-b03", 5, "08:00", "09:00"),
      lesson("f2", "g-8b", "t-per", "r-b03", 5, "11:00", "12:00"),
    ];
    render(<GapsPage />);

    const lines = within(reportFor("8B"))
      .getAllByRole("listitem")
      .map((item) => item.textContent);

    expect(lines).toEqual([
      "days.5 09:00–10:00 · gaps.durationHoursOnly(1) · gaps.idleStudents(1|1) · timetable.recurrenceOdd · gaps.lengthMedium",
      "days.5 09:00–11:00 · gaps.durationHoursOnly(2) · gaps.idleStudents(1|1) · timetable.recurrenceEven · gaps.lengthLong",
    ]);

    // The twin that gives the label its meaning: 7A's Wednesday hole is the
    // same hole in every week, so it carries no parity and must not grow one.
    // Without this line "label every gap ODD_WEEKS" would pass the assertion
    // above.
    expect(within(reportFor("7A")).getAllByRole("listitem")[0].textContent).toBe(
      "days.3 09:00–10:20 · gaps.durationHours(1|20) · gaps.idleStudents(2|2) · gaps.lengthLong",
    );
  });

  it("filters to classes only", async () => {
    const user = userEvent.setup();
    render(<GapsPage />);

    await pick(user, "gaps.idleScope", "gaps.idleScopeGroups");

    expect(reportNames()).toEqual(["7Agaps.kindGroup"]);
    expect(statusOf("gaps.idleTitle")).toHaveTextContent("gaps.idleCount(1)");
  });
});

// ---------------------------------------------------------------------------
// 3. Vem är ledig då?
// ---------------------------------------------------------------------------

const freeListOf = (heading: string) =>
  within(
    within(region("gaps.whoTitle"))
      .getByRole("heading", { name: heading })
      .closest("div") as HTMLElement,
  )
    .queryAllByRole("listitem")
    .map((item) => item.textContent);

describe("Gaps page — who is free then", () => {
  it("answers with the ones who are free and without the ones who are not", async () => {
    const user = userEvent.setup();
    render(<GapsPage />);

    setTime("gaps.whoStart", "09:00");
    setTime("gaps.whoEnd", "10:00");
    await searchWho(user);

    // 8B is in a lesson for exactly that hour; 7A has its håltimme then. B03
    // holds the 8B lesson, A12 is empty between 7A's two.
    expect(freeListOf("gaps.whoGroups(3)")).toEqual(["7A", "9C", "Ma71"]);
    expect(freeListOf("gaps.whoTeachers(2)")).toEqual(["Karin Ek", "Ola Sund"]);
    expect(freeListOf("gaps.whoRooms(1)")).toEqual(["A12"]);
    expect(statusOf("gaps.whoTitle")).toHaveTextContent(
      "gaps.whoCount(3|2|1|days.3|09:00|10:00)",
    );
  });

  it("never offers a teacher who has left the school", async () => {
    const user = userEvent.setup();
    render(<GapsPage />);

    setTime("gaps.whoStart", "09:00");
    setTime("gaps.whoEnd", "10:00");
    await searchWho(user);

    // Ada teaches nothing at all, so she is free by every measure the engine
    // has — being deactivated is the only reason she must not be offered.
    expect(freeListOf("gaps.whoTeachers(2)")).toContain("Karin Ek");
    expect(freeListOf("gaps.whoTeachers(2)")).not.toContain("Ada Lind");
  });

  it("reads the week parity the question is asked about", async () => {
    const user = userEvent.setup();
    render(<GapsPage />);

    await pick(user, "gaps.whoDay", "days.5");
    await searchWho(user);
    expect(freeListOf("gaps.whoGroups(3)")).not.toContain("8B");

    // The same slot on even weeks: 8B's Friday lesson runs odd weeks only.
    await pick(user, "gaps.whoWeeks", "timetable.recurrenceEven");
    await searchWho(user);
    expect(freeListOf("gaps.whoGroups(4)")).toContain("8B");
  });

  it("counts an elective booked on one pupil as busying that pupil's class", async () => {
    const user = userEvent.setup();
    // Sara's home class is 7A. This lesson names no class of its own, only her
    // — the shape an elective takes when it is enrolled pupil by pupil rather
    // than as a teaching group. 7A is nonetheless in it, because she is.
    state.lessons = [
      ...WEEK,
      { ...lesson("l11", "g-none", "t-ola", "r-a12", 2, "09:00", "10:00"), studentIds: ["s-1"] },
    ];
    render(<GapsPage />);

    await pick(user, "gaps.whoDay", "days.2");
    setTime("gaps.whoStart", "09:00");
    setTime("gaps.whoEnd", "10:00");
    await searchWho(user);
    expect(freeListOf("gaps.whoGroups(3)")).not.toContain("7A");

    // The hour after, nothing holds her, and 7A is offered again — which is
    // how we know the absence above is the booking and not a broken query.
    setTime("gaps.whoStart", "10:00");
    setTime("gaps.whoEnd", "11:00");
    await searchWho(user);
    expect(freeListOf("gaps.whoGroups(4)")).toContain("7A");
  });

  it("refuses a backwards interval instead of answering it with everybody", async () => {
    const user = userEvent.setup();
    render(<GapsPage />);

    setTime("gaps.whoEnd", "09:00");
    await searchWho(user);

    // A backwards interval overlaps nothing, so the engine would call every
    // class, teacher and room free — an answer shaped exactly like a result.
    expect(statusOf("gaps.whoTitle")).toHaveTextContent("gaps.whoInvalid");
    expect(within(region("gaps.whoTitle")).queryByRole("listitem")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Shape of the page itself
// ---------------------------------------------------------------------------

describe("Gaps page — structure and operation", () => {
  /**
   * The one thing the key-echo mock above cannot see.
   *
   * Every other assertion in this file reads `gaps.whoCount(3|2|1|…)` and never
   * parses the message body, so a count interpolated bare into a plural
   * sentence — "1 salar är lediga", "1 valda" — is invisible here and shows up
   * only in a live region a screen reader reads out loud. next-intl is
   * un-mocked for this one test and the real sv.json is formatted.
   */
  it("counts in Swedish, at one as well as at three", async () => {
    const { createTranslator } =
      await vi.importActual<typeof import("next-intl")>("next-intl");
    const sv = createTranslator({
      locale: "sv",
      messages: svMessages,
      namespace: "gaps",
    });
    const at = (count: number) =>
      sv("whoCount", {
        groups: count,
        teachers: count,
        rooms: count,
        day: "Onsdag",
        start: "09:00",
        end: "10:00",
      });

    expect(at(1)).toBe("1 klass, 1 lärare och 1 sal är lediga Onsdag 09:00–10:00");
    expect(at(3)).toBe("3 klasser, 3 lärare och 3 salar är lediga Onsdag 09:00–10:00");
    expect(sv("freeSelected", { count: 1 })).toBe("1 vald");
    expect(sv("freeSelected", { count: 3 })).toBe("3 valda");
  });

  it("says there is nothing to search when no schedule has been laid", () => {
    state.lessons = [];
    render(<GapsPage />);

    expect(screen.getByText("gaps.empty")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "gaps.freeTitle" })).toBeNull();
  });

  it("labels every control with a label, not a placeholder", () => {
    render(<GapsPage />);

    for (const label of [
      "gaps.freeLength",
      "gaps.idleMinimum",
      "gaps.idleScope",
      "gaps.whoDay",
      "gaps.whoStart",
      "gaps.whoEnd",
      "gaps.whoWeeks",
    ]) {
      expect(screen.getByLabelText(label), label).toBeTruthy();
    }
    // The three pickers are named by their <legend>, which is what makes a
    // screen reader say "Klasser och grupper, group" before reading the boxes.
    expect(screen.getByRole("group", { name: "gaps.freeGroups" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Karin Ek" })).toBeTruthy();
  });

  it("is operable from the keyboard alone", async () => {
    const user = userEvent.setup();
    render(<GapsPage />);

    const box = screen.getByRole("checkbox", { name: "7A" });
    box.focus();
    await user.keyboard(" ");
    expect(box).toBeChecked();

    const search = within(region("gaps.freeTitle")).getByRole("button", {
      name: "gaps.freeSearch",
    });
    search.focus();
    await user.keyboard("{Enter}");

    expect(onDay("gaps.freeTitle", 3)).toContain(
      "days.3 | 09:00–10:20 | gaps.durationHours(1|20) | timetable.recurrenceAll",
    );
  });

  it("writes its column headers in the token that clears AAA", async () => {
    const user = userEvent.setup();
    render(<GapsPage />);

    await check(user, "7A");
    await searchFree(user);

    // TableHead's own base class is text-muted-foreground — 4.83:1 light and
    // 6.54:1 dark, AA and short of the 7:1 this page holds to. The page passes
    // text-foreground (18.69 / 16.36) and tailwind-merge drops the muted one.
    const headers = within(region("gaps.freeTitle")).getAllByRole("columnheader");
    expect(headers).toHaveLength(4);
    for (const header of headers) {
      expect(header.className, header.textContent ?? "").toContain("text-foreground");
      expect(header.className, header.textContent ?? "").not.toContain(
        "text-muted-foreground",
      );
    }
  });

  it("gives every boxed control an edge, and every focus ring a page-coloured offset", () => {
    const { container } = render(<GapsPage />);

    // A select trigger, a time field and an outline button are identified by
    // their boundary and nothing else. The shared border-input measures
    // 1.27:1 light / 1.40:1 dark against the page — under SC 1.4.11's 3:1 —
    // so this page draws its own at 4.83 / 6.54.
    for (const name of ["gaps.whoStart", "gaps.whoEnd"]) {
      expect(screen.getByLabelText(name).className, name).toContain(
        "border-muted-foreground",
      );
    }
    for (const name of ["gaps.freeLength", "gaps.idleScope", "gaps.whoDay"]) {
      expect(screen.getByRole("combobox", { name }).className, name).toContain(
        "border-muted-foreground",
      );
    }
    expect(screen.getByRole("button", { name: "gaps.freeClear" }).className).toContain(
      "border-muted-foreground",
    );

    // The filled submit button is the exception, and must stay one: its own
    // fill is 6.18 / 5.12 against the page, so the shape reads without a
    // border, and adding one would only make the AA button look AAA.
    const submit = screen.getByRole("button", { name: "gaps.freeSearch" });
    expect(submit.className).toContain("bg-primary");
    expect(submit.className).not.toContain("border-muted-foreground");

    // Every ring offset resolves to the page colour. Tailwind's default is a
    // hard-coded #fff, which in dark mode is a white halo on a near-black page.
    const ringed = Array.from(
      container.querySelectorAll<HTMLElement>('[class*="ring-offset-2"]'),
    );
    expect(ringed.length).toBeGreaterThan(5);
    for (const element of ringed) {
      expect(element.className, element.outerHTML.slice(0, 120)).toContain(
        "ring-offset-background",
      );
    }
  });

  it("gives every control a 44px target", () => {
    // jsdom computes no layout; the Tailwind token that resolves to 2.75rem is
    // what can be asserted. For a checkbox the target is the row it sits in —
    // the whole label toggles — so that is what carries the token.
    const { container } = render(<GapsPage />);

    const controls = Array.from(
      container.querySelectorAll<HTMLElement>("button, input"),
    ).filter((element) => element.getAttribute("aria-hidden") !== "true");

    expect(controls.length).toBeGreaterThan(5);
    for (const control of controls) {
      const target =
        control instanceof HTMLInputElement && control.type === "checkbox"
          ? control.closest("label")
          : control;
      expect(target?.className, control.outerHTML.slice(0, 120)).toMatch(
        /(^|\s)(min-)?h-11(\s|$)/,
      );
    }
  });

  describe("while the roster is still loading", () => {
    it("falls back to the whole-group reading instead of reporting nobody idle", async () => {
      // An empty array is a complete roster that holds nobody, and the library
      // reads it as one — it switches to the per-pupil count and finds no
      // pupils, so every class reports no håltimmar. `undefined` means "no
      // roster known", which is the coarser but safe answer.
      state.memberships = undefined;

      render(<GapsPage />);

      // The section still reports its gaps — it simply cannot say how many
      // pupils sit through them.
      expect(reportHeadings().length).toBeGreaterThan(0);
      expect(screen.queryByText(/idleStudents/)).toBeNull();
    });
  });
});
