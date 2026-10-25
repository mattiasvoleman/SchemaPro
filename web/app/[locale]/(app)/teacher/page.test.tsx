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

/** The week's rastvaktspass (Rastvakt i vardagen): her own on Monday, one she takes as vikarie, one handed over. */
const passes = vi.hoisted(() => ({
  state: {
    data: undefined as unknown,
    isError: false,
  },
}));
vi.mock("@/lib/supervision-week", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/supervision-week")>();
  return { ...actual, useSupervisionWeek: () => passes.state };
});

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
  passes.state = {
    data: {
      from: MONDAY,
      to: "2026-09-13",
      passes: [
        {
          kind: "OWN", shiftId: "s-own", date: MONDAY, startsAt: `${MONDAY}T07:00:00.000Z`, endsAt: `${MONDAY}T07:20:00.000Z`,
          areaName: "Skolgården", siteName: "Norra", handover: null,
        },
        {
          kind: "COVER", shiftId: "s-other", date: "2026-09-08", startsAt: "2026-09-08T09:30:00.000Z", endsAt: "2026-09-08T10:00:00.000Z",
          areaName: "Matsalen", siteName: null, handover: null,
        },
        {
          kind: "OWN", shiftId: "s-wed", date: "2026-09-09", startsAt: "2026-09-09T07:00:00.000Z", endsAt: "2026-09-09T07:20:00.000Z",
          areaName: "Skolgården", siteName: "Norra", handover: "SUBSTITUTE",
        },
      ],
    },
    isError: false,
  };
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

  it("draws the week's rastvaktspass beside the lessons, opens no page for one, and says a vikarie and a handover", async () => {
    const user = userEvent.setup();
    render(<TeacherSchedulePage />);
    const own = document.querySelector<HTMLElement>('[data-lesson-id="pass:OWN:s-own:2026-09-07"]');
    const cover = document.querySelector<HTMLElement>('[data-lesson-id="pass:COVER:s-other:2026-09-08"]');
    const handed = document.querySelector<HTMLElement>('[data-lesson-id="pass:OWN:s-wed:2026-09-09"]');
    expect(own).not.toBeNull();
    expect(cover).not.toBeNull();
    expect(handed).not.toBeNull();
    expect(own!.textContent).toContain("schedule.passTitle");
    expect(own!.textContent).toContain("Skolgården");
    expect(own!.textContent).toContain("Norra");
    // The strip's one line: where to go for a pass taken, who has it for one handed on.
    expect(cover!.textContent).toContain("schedule.passTitle · Matsalen · schedule.passCover");
    expect(handed!.textContent).toContain("schedule.passTitle · schedule.passHandedOver · Skolgården");
    expect(handed!.className).toContain("outline-dashed");
    await user.click(own!);
    expect(nav.push).not.toHaveBeenCalled();
  });

  it("says when the passes could not be read, and keeps the lessons", () => {
    passes.state = { data: undefined, isError: true };
    render(<TeacherSchedulePage />);
    expect(screen.getByText("schedule.passesLoadFailed")).toBeInTheDocument();
    expect(document.querySelector('[data-lesson-id="l-own"]')).not.toBeNull();
  });
});
