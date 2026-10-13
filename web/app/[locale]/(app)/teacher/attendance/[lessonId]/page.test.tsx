import { Suspense } from "react";
import { render, screen } from "@testing-library/react";
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

const roster = vi.hoisted(() => ({ error: null as unknown }));
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
  attendance: { data: [], isError: false },
  reported: { data: { studentIds: [] } },
  subjects: { data: [{ id: "s-ma", name: "Matematik" }] },
  report: { mutate: () => undefined, isPending: false },
}));

vi.mock("@/utils/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("@/i18n/navigation", () => ({
  Link: ({ children, ...rest }: { children: React.ReactNode }) => <a {...rest}>{children}</a>,
}));
vi.mock("@/lib/queries", async (importOriginal) => ({
  // isNotOnLesson is the real one: the page and the hook share it.
  ...(await importOriginal<typeof import("@/lib/queries")>()),
  useLesson: () => answers.lesson,
  useLessonRoster: () => ({ data: undefined, isLoading: false, isError: true, error: roster.error }),
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
  roster.error = null;
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
