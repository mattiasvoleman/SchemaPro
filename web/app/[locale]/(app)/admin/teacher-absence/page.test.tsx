import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import TeacherAbsencePage from "./page";

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};
globalThis.ResizeObserver ??= class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
};

/**
 * What a cancellation from this page SAYS about why.
 *
 * Publishing cancels a lesson for a teacher's closure that already exists;
 * an absence that arrives after publishing is handled here. Täckning splits
 * the year's lost minutes by cause (CalendarLessons.cancelCause), and the
 * teacher's absence is the cause a school is asked about most — so every
 * cancel from this page, one lesson or the whole list, is sent as
 * TEACHER_UNAVAILABLE, with the free-text reason beside it unchanged. A
 * cancel sent without it would read "Inställd av skolan".
 */

const cancel = vi.hoisted(() => vi.fn());

const LESSONS = [
  { id: "cl-1", date: "2026-10-12", startsAt: "2026-10-12T06:00:00Z", endsAt: "2026-10-12T07:00:00Z", subjectId: "s-ma", studentGroupId: "g-7a", roomId: null, status: "SCHEDULED" },
  { id: "cl-2", date: "2026-10-12", startsAt: "2026-10-12T08:00:00Z", endsAt: "2026-10-12T09:00:00Z", subjectId: "s-ma", studentGroupId: "g-7b", roomId: null, status: "SCHEDULED" },
];

vi.mock("@/lib/queries", () => ({
  usePeople: () => ({
    data: [{ id: "t-1", role: "TEACHER", isActive: true, firstName: "Nils", lastName: "Berg" }],
  }),
  useSubjects: () => ({ data: [{ id: "s-ma", name: "Matematik" }] }),
  useGroups: () => ({ data: [{ id: "g-7a", name: "7A" }, { id: "g-7b", name: "7B" }] }),
  useRooms: () => ({ data: [] }),
  useLessonActions: () => ({
    cancel: { mutateAsync: cancel, isPending: false },
    substitute: { mutateAsync: vi.fn(), isPending: false },
    changeRoom: { mutateAsync: vi.fn(), isPending: false },
  }),
  useTeacherAbsenceLessons: (teacherId: string | null) => ({
    data: teacherId ? LESSONS : undefined,
    isLoading: false,
  }),
  useSubstituteSuggestions: () => ({ data: [], isLoading: false }),
}));
vi.mock("@/lib/cover-queries", () => ({
  useAbsences: () => ({ data: [], isLoading: false }),
  useAbsenceReasons: () => ({ data: [] }),
  useAbsenceActions: () => ({
    create: { mutateAsync: vi.fn(), isPending: false },
    update: { mutateAsync: vi.fn(), isPending: false },
    end: { mutateAsync: vi.fn(), isPending: false },
    withdraw: { mutateAsync: vi.fn(), isPending: false },
  }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) =>
    values ? `${namespace}.${key}(${Object.values(values).join("|")})` : `${namespace}.${key}`,
}));

beforeEach(() => {
  cancel.mockReset().mockResolvedValue({});
});

const chooseTeacher = async () => {
  const user = userEvent.setup();
  render(<TeacherAbsencePage />);
  await user.click(screen.getByRole("combobox"));
  await user.click(await screen.findByRole("option", { name: "Nils Berg" }));
  return user;
};

describe("cancelling from Lärarfrånvaro", () => {
  it("says the teacher was unavailable, beside the reason the admin wrote", async () => {
    const user = await chooseTeacher();
    const row = screen.getByText("7A").closest("tr")!;
    await user.click(within(row).getByRole("button", { name: /dayPlanner\.cancelAction/ }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("dayPlanner.reason"), "Sjuk");
    await user.click(within(dialog).getByRole("button", { name: /dayPlanner\.cancelAction/ }));
    expect(cancel).toHaveBeenCalledWith({ id: "cl-1", cause: "TEACHER_UNAVAILABLE", reason: "Sjuk" });
  });

  it("says it for every lesson of a whole-list cancel", async () => {
    const user = await chooseTeacher();
    await user.click(screen.getByRole("button", { name: /teacherAbsence\.cancelAll/ }));
    expect(cancel.mock.calls.map(([body]) => body)).toEqual([
      { id: "cl-1", cause: "TEACHER_UNAVAILABLE" },
      { id: "cl-2", cause: "TEACHER_UNAVAILABLE" },
    ]);
  });
});
