import { Suspense } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import sv from "@/messages/sv.json";
import { ApiError } from "@/lib/api";
import LessonAttendancePage from "./page";

/**
 * /teacher/attendance/[lessonId]: what the register says when its list cannot
 * be shown. The list comes from the gateway (GET attendance/lessons/:id/roster),
 * which refuses a teacher who is not on the lesson. That is no failure to wait
 * out: a vikarie was put in, or the teacher was removed as a co-teacher, after
 * the lesson list that led here was read, and reloading never helps.
 */

/** Elevens lektion för dagen: the pupils moved to or from the lesson, as the page's list of moves reads them. */
const moves = vi.hoisted(() => ({
  arrivals: [] as Array<{ moveId: string; studentId: string; studentName: string; other: unknown; movedByName: string | null; createdAt: string }>,
}));
const roster = vi.hoisted(() => ({
  error: null as unknown,
  /** When set, the roster answers with these pupils instead of failing. */
  students: null as null | Array<{ id: string; firstName: string; lastName: string; studentGroupId: string | null }>,
}));
/**
 * One object per hook for the whole file: the page seeds its state from these
 * in effects, so a fresh array on every render would render it forever.
 */
const answers = vi.hoisted(() => ({
  lesson: {
    isLoading: false,
    isError: false,
    data: {
      id: "l-1",
      subjectId: "s-ma",
      studentGroupId: "g-7a",
      roomId: null,
      date: "2026-10-14",
      startsAt: "2026-10-14T07:00:00.000Z",
      endsAt: "2026-10-14T07:45:00.000Z",
      status: "SCHEDULED",
      note: null,
    },
  },
  attendance: { data: [] as unknown[] | undefined, isError: false },
  reported: { data: { studentIds: [] as string[] } },
  subjects: { data: [{ id: "s-ma", name: "Matematik" }] },
  report: { mutate: () => undefined, mutateAsync: vi.fn(async (_input: unknown) => undefined), isPending: false },
}));

vi.mock("@/utils/supabase/client", () => ({ createClient: () => ({}) }));
// Elevens lektion för dagen: the page asks which pupils were moved to or from the lesson. This file is about the
// register's list, so nobody was: the list of moves (and its chunk) is in components/lesson-moves/lesson-moves.test.tsx.
vi.mock("@/lib/lesson-moves-queries", () => ({
  useLessonMoves: () => ({ data: { departures: [], arrivals: moves.arrivals } }),
  // What the list of moves and its dialog read, closed: nothing asked, nothing answered.
  useUndoMove: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useMovablePupils: () => ({ data: undefined, isLoading: false, isError: false }),
  useMoveCandidates: () => ({ data: undefined, isLoading: false, isError: false }),
  useMovePupil: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/i18n/navigation", () => ({
  Link: ({ children, ...rest }: { children: React.ReactNode }) => <a {...rest}>{children}</a>,
}));
vi.mock("@/lib/queries", async (importOriginal) => ({
  // isNotOnLesson is the real one: the page and the hook share it.
  ...(await importOriginal<typeof import("@/lib/queries")>()),
  useLesson: () => answers.lesson,
  useLessonRoster: () =>
    roster.students
      ? { data: roster.students, isLoading: false, isError: false, error: null }
      : { data: undefined, isLoading: false, isError: true, error: roster.error },
  useLessonAttendance: () => answers.attendance,
  useLessonReportedAbsences: () => answers.reported,
  useSubjects: () => answers.subjects,
  useReportAttendance: () => answers.report,
}));

/**
 * The route's params as a promise React has already seen settle: `use` reads
 * a fulfilled thenable at once, where a fresh promise would suspend the first
 * render and leave nothing in the document to find.
 */
const params = Object.assign(Promise.resolve({ lessonId: "l-1" }), {
  status: "fulfilled",
  value: { lessonId: "l-1" },
});

function renderPage() {
  return render(
    <NextIntlClientProvider locale="sv" messages={sv} timeZone="Europe/Stockholm">
      <Suspense fallback={null}>
        <LessonAttendancePage params={params} />
      </Suspense>
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  moves.arrivals = [];
  roster.error = null;
  roster.students = null;
  answers.attendance = { data: [], isError: false };
  answers.reported = { data: { studentIds: [] } };
});

describe("/teacher/attendance/[lessonId] when the list cannot be shown", () => {
  it("tells a teacher who is not on the lesson so, and never to reload", async () => {
    roster.error = new ApiError(403, "You are not assigned to this lesson and cannot record attendance for it.");
    renderPage();

    expect(await screen.findByText("Du står inte som lärare på den här lektionen")).toBeInTheDocument();
    expect(screen.getByText(/kan ha fått en vikarie eller en annan lärare/)).toBeInTheDocument();
    expect(screen.queryByText("Elevlistan kunde inte hämtas")).not.toBeInTheDocument();
    expect(screen.queryByText(/Ladda om sidan om en stund/)).not.toBeInTheDocument();
    // The way back to the lessons as they are now.
    expect(screen.getByRole("link", { name: /Till dagens lektioner/ })).toHaveAttribute("href", "/teacher/attendance");
  });

  it("keeps the wait-and-reload hint for a failure that may pass", async () => {
    roster.error = new ApiError(503, "Service Unavailable");
    renderPage();

    expect(await screen.findByText("Elevlistan kunde inte hämtas")).toBeInTheDocument();
    expect(screen.getByText(/Ladda om sidan om en stund/)).toBeInTheDocument();
    expect(screen.queryByText("Du står inte som lärare på den här lektionen")).not.toBeInTheDocument();
  });

  it("treats a network failure, which carries no status, as one that may pass", async () => {
    roster.error = new TypeError("Failed to fetch");
    renderPage();

    expect(await screen.findByText("Elevlistan kunde inte hämtas")).toBeInTheDocument();
  });
});

describe("/teacher/attendance/[lessonId], what each pupil opens as", () => {
  const JAMAL = { id: "p-jamal", firstName: "Jamal", lastName: "Sjö", studentGroupId: "g-7a" };
  const ELLA = { id: "p-ella", firstName: "Ella", lastName: "Nord", studentGroupId: "g-7a" };
  const group = (name: string) => screen.getByRole("radiogroup", { name });

  it("opens a pupil with a stored record as stored, though a report answered first", () => {
    roster.students = [JAMAL, ELLA];
    // The reported absences answer before the stored records do.
    answers.attendance = { data: undefined, isError: false };
    answers.reported = { data: { studentIds: [JAMAL.id, ELLA.id] } };
    const view = renderPage();
    expect(within(group("Jamal Sjö")).getByRole("radio", { name: "Anmäld frånvaro" })).toBeChecked();

    answers.attendance = { data: [{ id: "r-1", calendarLessonId: "l-1", studentId: JAMAL.id, status: "ABSENT", recordedAt: null, note: null }], isError: false };
    view.rerender(
      <NextIntlClientProvider locale="sv" messages={sv} timeZone="Europe/Stockholm">
        <Suspense fallback={null}>
          <LessonAttendancePage params={params} />
        </Suspense>
      </NextIntlClientProvider>,
    );

    // Jamal's stored ABSENT wins over the pre-fill; Ella, with no record, keeps it.
    expect(within(group("Jamal Sjö")).getByRole("radio", { name: "Frånvarande" })).toBeChecked();
    expect(within(group("Ella Nord")).getByRole("radio", { name: "Anmäld frånvaro" })).toBeChecked();
  });

  it("keeps what the teacher chose over both", async () => {
    roster.students = [JAMAL];
    answers.reported = { data: { studentIds: [JAMAL.id] } };
    answers.attendance = { data: [{ id: "r-1", calendarLessonId: "l-1", studentId: JAMAL.id, status: "ABSENT", recordedAt: null, note: null }], isError: false };
    renderPage();
    await userEvent.setup().click(within(group("Jamal Sjö")).getByRole("radio", { name: "Sen" }));
    expect(within(group("Jamal Sjö")).getByRole("radio", { name: "Sen" })).toBeChecked();
  });

  it("saves only the listed pupils, whatever the stored records hold", async () => {
    // Hugo has a stored mark from before he left 7A; he is not on the roster.
    roster.students = [JAMAL, ELLA];
    answers.attendance = {
      data: [
        { id: "r-1", calendarLessonId: "l-1", studentId: JAMAL.id, status: "ABSENT", recordedAt: null, note: null },
        { id: "r-2", calendarLessonId: "l-1", studentId: "p-hugo", status: "PRESENT", recordedAt: null, note: null },
      ],
      isError: false,
    };
    answers.report.mutateAsync.mockClear();
    renderPage();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Spara närvaro" }));
    expect(answers.report.mutateAsync).toHaveBeenLastCalledWith({
      calendarLessonId: "l-1",
      records: [{ studentId: JAMAL.id, status: "ABSENT" }],
    });

    // "Markera alla" as well: the roster, and nobody else.
    await user.click(screen.getByRole("button", { name: "Markera alla närvarande" }));
    await user.click(screen.getByRole("button", { name: "Spara närvaro" }));
    const sent = answers.report.mutateAsync.mock.lastCall![0] as { records: Array<{ studentId: string }> };
    expect(sent.records.map((record) => record.studentId).sort()).toEqual([ELLA.id, JAMAL.id].sort());
  });

  // LM415: a pupil moved onto this lesson who was marked here cannot be moved back. "Rensa markering" (in the list of
  // moved pupils) saves UNKNOWN; this page must let go of what it held for the pupil, or the next save marks them again.
  it("lets go of a choice made for a pupil whose mark is cleared from the list of moved pupils", async () => {
    roster.students = [JAMAL, ELLA];
    moves.arrivals = [
      {
        moveId: "m-1",
        studentId: ELLA.id,
        studentName: "Ella Nord",
        other: { id: "l-2", subject: "Engelska", className: "7B", start: "08:00", end: "08:45", room: null },
        movedByName: null,
        createdAt: "2026-10-14T06:00:00.000Z",
      },
    ];
    answers.attendance = { data: [], isError: false };
    answers.report.mutateAsync.mockClear();
    renderPage();
    const user = userEvent.setup();

    // "Markera alla" marks everybody, Ella too, and the save stores it: that is how she came to hold a mark here.
    await user.click(screen.getByRole("button", { name: "Markera alla närvarande" }));
    await user.click(screen.getByRole("button", { name: "Spara närvaro" }));
    answers.attendance = {
      data: [
        { id: "r-1", calendarLessonId: "l-1", studentId: JAMAL.id, status: "PRESENT", recordedAt: null, note: null },
        { id: "r-2", calendarLessonId: "l-1", studentId: ELLA.id, status: "PRESENT", recordedAt: null, note: null },
      ],
      isError: false,
    };
    answers.report.mutateAsync.mockClear();
    // The save of the clear, as the gateway keeps it: Ella's record is UNKNOWN from then on.
    answers.report.mutateAsync.mockImplementationOnce(async () => {
      answers.attendance = {
        data: [
          { id: "r-1", calendarLessonId: "l-1", studentId: JAMAL.id, status: "PRESENT", recordedAt: null, note: null },
          { id: "r-2", calendarLessonId: "l-1", studentId: ELLA.id, status: "UNKNOWN", recordedAt: null, note: null },
        ],
        isError: false,
      };
      return undefined;
    });

    await user.click(await screen.findByRole("button", { name: /^Rensa markering/ }));

    await waitFor(() => expect(answers.report.mutateAsync).toHaveBeenCalledWith({ calendarLessonId: "l-1", records: [{ studentId: ELLA.id, status: "UNKNOWN" }] }));
    // Ella opens with no mark; Jamal keeps his.
    await waitFor(() => expect(within(group("Ella Nord")).queryByRole("radio", { checked: true })).toBeNull());
    expect(within(group("Jamal Sjö")).getByRole("radio", { name: "Närvarande" })).toBeChecked();
    // The next save sends Jamal's mark and not Ella's.
    answers.report.mutateAsync.mockClear();
    await user.click(screen.getByRole("button", { name: "Spara närvaro" }));
    expect(answers.report.mutateAsync).toHaveBeenLastCalledWith({ calendarLessonId: "l-1", records: [{ studentId: JAMAL.id, status: "PRESENT" }] });
  });
});

/*
 * Review of #309 (MEDEL-1): what the page holds between the save of "Rensa markering" and the moment the stored records
 * are read again. The mock below leaves answers.attendance as it was, which is what the gateway's records are until the
 * invalidation's refetch has answered (useReportAttendance does not wait for it). The pupil stands as UNKNOWN on the
 * page meanwhile; dropping the choice would show the register's old mark and a Spara would write it back.
 */
describe("/teacher/attendance/[lessonId], after Rensa markering and before the records are read again", () => {
  const JAMAL = { id: "p-jamal", firstName: "Jamal", lastName: "Sjö", studentGroupId: "g-7a" };
  const ELLA = { id: "p-ella", firstName: "Ella", lastName: "Nord", studentGroupId: "g-7a" };
  const arrival = {
    moveId: "m-1",
    studentId: ELLA.id,
    studentName: "Ella Nord",
    other: { id: "l-2", subject: "Engelska", className: "7B", start: "08:00", end: "08:45", room: null },
    movedByName: null,
    createdAt: "2026-10-14T06:00:00.000Z",
  };
  const stored = (status: string) => ({ id: `r-${status}`, calendarLessonId: "l-1", studentId: ELLA.id, status, recordedAt: null, note: null });

  it("a save does not mark the pupil who was just cleared", async () => {
    roster.students = [JAMAL, ELLA];
    moves.arrivals = [arrival];
    answers.attendance = { data: [stored("PRESENT"), { ...stored("PRESENT"), id: "r-j", studentId: JAMAL.id }], isError: false };
    answers.report.mutateAsync.mockClear();
    renderPage();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: /^Rensa markering/ }));
    await waitFor(() => expect(answers.report.mutateAsync).toHaveBeenCalledWith({ calendarLessonId: "l-1", records: [{ studentId: ELLA.id, status: "UNKNOWN" }] }));
    answers.report.mutateAsync.mockClear();
    await user.click(screen.getByRole("button", { name: "Spara närvaro" }));

    const sent = answers.report.mutateAsync.mock.lastCall![0] as { records: Array<{ studentId: string; status: string }> };
    expect(sent.records.map((record) => record.studentId)).not.toContain(ELLA.id);
  });

  it("clearing one pupil keeps what the teacher has chosen for another and not yet saved", async () => {
    roster.students = [JAMAL, ELLA];
    moves.arrivals = [arrival];
    answers.attendance = { data: [stored("PRESENT")], isError: false };
    answers.report.mutateAsync.mockClear();
    renderPage();
    const user = userEvent.setup();
    await user.click(within(screen.getByRole("radiogroup", { name: "Jamal Sjö" })).getByRole("radio", { name: "Sen" }));

    await user.click(await screen.findByRole("button", { name: /^Rensa markering/ }));
    await waitFor(() => expect(answers.report.mutateAsync).toHaveBeenCalled());
    expect(within(screen.getByRole("radiogroup", { name: "Jamal Sjö" })).getByRole("radio", { name: "Sen" })).toBeChecked();
  });
});
