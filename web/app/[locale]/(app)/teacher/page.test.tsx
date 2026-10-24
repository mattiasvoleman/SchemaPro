import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import TeacherSchedulePage from "./page";

/**
 * The teacher's week: a covered lesson says so under its group, and a lesson
 * opens its page (Lektionslogg), where its topic, homework and note to the
 * substitute are kept and its register is one click away.
 */

const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ push: nav.push, replace: vi.fn() }),
}));

/** A Monday: the grid places a lesson by its weekday. */
const MONDAY = "2026-09-07";

vi.mock("@/lib/queries", () => ({
  useTeacherLessons: () => ({
    data: [
      {
        id: "l-own",
        subjectId: "s-ma",
        studentGroupId: "g-7a",
        roomId: null,
        date: MONDAY,
        startsAt: `${MONDAY}T08:00:00.000Z`,
        endsAt: `${MONDAY}T09:00:00.000Z`,
        status: "SCHEDULED",
        note: null,
        assignmentRole: "LEAD",
      },
      {
        id: "l-cover",
        subjectId: "s-sv",
        studentGroupId: "g-8b",
        roomId: null,
        date: MONDAY,
        startsAt: `${MONDAY}T10:00:00.000Z`,
        endsAt: `${MONDAY}T11:00:00.000Z`,
        status: "SCHEDULED",
        note: null,
        assignmentRole: "SUBSTITUTE",
      },
    ],
    isLoading: false,
    isError: false,
  }),
  useSubjects: () => ({
    data: [
      { id: "s-ma", name: "Matematik", code: "MA", color: null },
      { id: "s-sv", name: "Svenska", code: "SV", color: null },
    ],
  }),
  useGroups: () => ({
    data: [
      { id: "g-7a", academicYearId: "y", name: "7A", kind: "CLASS", gradeLevel: 7 },
      { id: "g-8b", academicYearId: "y", name: "8B", kind: "CLASS", gradeLevel: 8 },
    ],
  }),
  useRooms: () => ({ data: [] }),
  useCalendarRasts: () => ({ data: [] }),
}));

vi.mock("@/components/profile-context", () => ({
  useProfile: () => ({
    profile: { id: "t-1", role: "TEACHER", firstName: "Anna", lastName: "Lind" },
    school: null,
  }),
}));

vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations:
    (namespace: string) => (key: string, values?: Record<string, unknown>) =>
      values ? `${namespace}.${key}(${Object.values(values).join("|")})` : `${namespace}.${key}`,
}));

beforeEach(() => {
  cleanup();
  nav.push.mockReset();
});

describe("the teacher's week", () => {
  it("opens a lesson's page when the lesson is chosen, a covered one too", async () => {
    const user = userEvent.setup();
    render(<TeacherSchedulePage />);
    const own = document.querySelector<HTMLElement>('[data-lesson-id="l-own"]');
    const covered = document.querySelector<HTMLElement>('[data-lesson-id="l-cover"]');
    expect(own).not.toBeNull();
    expect(covered).not.toBeNull();
    await user.click(own!);
    expect(nav.push).toHaveBeenLastCalledWith("/teacher/lektion/l-own");
    await user.click(covered!);
    expect(nav.push).toHaveBeenLastCalledWith("/teacher/lektion/l-cover");
    expect(screen.getAllByText(/schedule\.substituteMarker/).length).toBeGreaterThan(0);
  });
});
