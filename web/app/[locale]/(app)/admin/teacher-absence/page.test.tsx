import { render, screen, waitFor, within } from "@testing-library/react";
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
  { id: "cl-1", date: "2026-10-12", startsAt: "2026-10-12T06:00:00Z", endsAt: "2026-10-12T07:00:00Z", subjectId: "s-ma", studentGroupId: "g-7a", roomId: null, status: "SCHEDULED", teachers: [{ role: "LEAD", teacherId: "t-1" }] },
  { id: "cl-2", date: "2026-10-12", startsAt: "2026-10-12T08:00:00Z", endsAt: "2026-10-12T09:00:00Z", subjectId: "s-ma", studentGroupId: "g-7b", roomId: null, status: "SCHEDULED", teachers: [{ role: "LEAD", teacherId: "t-1" }] },
];

// "Gallrat före": nothing gallrat in these rows.
vi.mock("@/lib/retention-queries", () => ({ usePurgedBefore: () => ({ of: () => null }) }));
vi.mock("@/lib/queries", () => ({
  usePeople: () => ({
    data: [
      { id: "t-1", role: "TEACHER", isActive: true, firstName: "Nils", lastName: "Berg" },
      { id: "t-2", role: "TEACHER", isActive: true, firstName: "Bo", lastName: "Ek" },
      // An administrator who teaches (Users.teaches), one who does not, and a teacher who has left.
      { id: "a-1", role: "SCHOOL_ADMIN", isActive: true, firstName: "Maja", lastName: "Mark", teaches: true },
      { id: "a-2", role: "SCHOOL_ADMIN", isActive: true, firstName: "Rolf", lastName: "Rektor" },
      { id: "t-3", role: "TEACHER", isActive: false, firstName: "Gun", lastName: "Borta" },
    ],
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
// What the register hands the pool's dialog (the dialog is its own file's test).
vi.mock("./cover-settings-dialog", () => ({
  CoverSettingsDialog: ({ open, teachers }: { open: boolean; teachers: { id: string; name: string }[] }) =>
    open ? <ul aria-label="poolCandidates">{teachers.map((teacher) => <li key={teacher.id}>{teacher.name}</li>)}</ul> : null,
}));
const absences = vi.hoisted(() => ({ data: [] as unknown[] }));
const register = vi.hoisted(() => ({
  props: undefined as { teachers: { id: string; name: string }[]; poolCandidates: { id: string; name: string }[] } | undefined,
}));
vi.mock("./absence-register", async (importOriginal) => {
  const real = await importOriginal<typeof import("./absence-register")>();
  return {
    AbsenceRegister: (props: NonNullable<typeof register.props>) => {
      register.props = props;
      return real.AbsenceRegister(props);
    },
  };
});
vi.mock("@/lib/cover-queries", () => ({
  useAbsences: () => ({ data: absences.data, isLoading: false }),
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
  absences.data = [];
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
    // The lesson dialogs are a chunk of their own (React.lazy), shared with
    // Dagsplanering, fetched on this first click: a cold import can take
    // longer than findBy's default second under a loaded test run.
    const dialog = await screen.findByRole("dialog", {}, { timeout: 5000 });
    await user.type(within(dialog).getByLabelText("dayPlanner.reason"), "Sjuk");
    await user.click(within(dialog).getByRole("button", { name: /dayPlanner\.cancelAction/ }));
    expect(cancel).toHaveBeenCalledWith({ id: "cl-1", cause: "TEACHER_UNAVAILABLE", reason: "Sjuk" });
  });

  it("says it for every lesson of a whole-list cancel, once the count has been confirmed", async () => {
    const user = await chooseTeacher();
    await user.click(screen.getByRole("button", { name: /teacherAbsence\.cancelAll/ }));
    // Every class is told: nothing is sent until the confirmation, which names the count.
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("teacherAbsence.cancelAllTitle(2)");
    expect(cancel).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "teacherAbsence.cancelAllConfirm(2)" }));
    await waitFor(() => expect(cancel).toHaveBeenCalledTimes(2));
    expect(cancel.mock.calls.map(([body]) => body)).toEqual([
      { id: "cl-1", cause: "TEACHER_UNAVAILABLE" },
      { id: "cl-2", cause: "TEACHER_UNAVAILABLE" },
    ]);
  });
});

describe("what a profile that does not write Drift is spared", () => {
  it("marks Registrera frånvaro, the whole-list cancel and each lesson's actions as Drift's, and the filter as no one's", async () => {
    await chooseTeacher();
    expect(screen.getByRole("button", { name: /teacherAbsence\.register/ })).toHaveAttribute("data-writes", "DRIFT");
    expect(screen.getByRole("button", { name: /teacherAbsence\.cancelAll/ })).toHaveAttribute("data-writes", "DRIFT");
    const row = screen.getByText("7A").closest("tr")!;
    for (const action of ["substituteAction", "roomChangeAction", "cancelAction"]) {
      expect(within(row).getByRole("button", { name: new RegExp(`dayPlanner\\.${action}`) })).toHaveAttribute(
        "data-writes",
        "DRIFT",
      );
    }
    expect(screen.getByLabelText("teacherAbsence.selectTeacher")).not.toHaveAttribute("data-writes");
  });
});

describe("the register dialog beside the page's own filter", () => {
  it("labels the dialog's teacher field, not the page's teacher filter behind it", async () => {
    // Both fields are "Lärare" Selects; with one shared id the dialog's label
    // pointed at the page's trigger, hidden behind the modal.
    const user = userEvent.setup();
    render(<TeacherAbsencePage />);
    const filter = screen.getByLabelText("teacherAbsence.selectTeacher");
    await user.click(screen.getByRole("button", { name: /teacherAbsence\.register/ }));
    const dialog = await screen.findByRole("dialog", {}, { timeout: 5000 });
    const field = within(dialog).getByLabelText("absenceForm.teacher");
    expect(field).toHaveAttribute("role", "combobox");
    expect(field.id).not.toBe(filter.id);
    expect(document.querySelectorAll(`[id="${field.id}"]`)).toHaveLength(1);
  });
});

describe("who can be absent, and who can step in (an administrator who teaches: Users.teaches)", () => {
  it("lists her among those who can be absent in the page's filter, and not an administrator who does not teach, nor a teacher who has left", async () => {
    const user = userEvent.setup();
    render(<TeacherAbsencePage />);
    await user.click(screen.getByRole("combobox"));
    expect(await screen.findByRole("option", { name: "Nils Berg" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Maja Mark" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Rolf Rektor" })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Gun Borta" })).not.toBeInTheDocument();
  });

  it("lists her in the register dialog's teacher field too", async () => {
    const user = userEvent.setup();
    render(<TeacherAbsencePage />);
    await user.click(screen.getByRole("button", { name: /teacherAbsence\.register/ }));
    const dialog = await screen.findByRole("dialog", {}, { timeout: 5000 });
    await user.click(within(dialog).getByLabelText("absenceForm.teacher"));
    expect(await screen.findByRole("option", { name: "Maja Mark" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Rolf Rektor" })).not.toBeInTheDocument();
  });

  it("hands the register the list of who can be absent, and the pool the teachers only", () => {
    // A pass-through spy (the register is drawn for real): which list goes to which prop is the page's choice, and the
    // register's own test holds what it does with each.
    render(<TeacherAbsencePage />);
    const names = (list: { name: string }[]) => list.map((entry) => entry.name);
    expect(names(register.props!.teachers)).toEqual(["Nils Berg", "Bo Ek", "Maja Mark"]);
    expect(names(register.props!.poolCandidates)).toEqual(["Nils Berg", "Bo Ek"]);
  });

  it("keeps her out of the substitute pool's candidates: the register hands its dialog the teachers only (SP409)", async () => {
    const user = userEvent.setup();
    render(<TeacherAbsencePage />);
    await user.click(screen.getByRole("button", { name: /teacherAbsence\.settings/ }));
    const list = await screen.findByRole("list", { name: "poolCandidates" });
    const names = within(list).getAllByRole("listitem").map((item) => item.textContent);
    expect(names).toEqual(["Nils Berg", "Bo Ek"]);
  });

  it("keeps her out of the substitute pick: she is not in the pool and is never asked (SP409)", async () => {
    const user = await chooseTeacher();
    const row = screen.getByText("7A").closest("tr")!;
    await user.click(within(row).getByRole("button", { name: /dayPlanner\.substituteAction/ }));
    const dialog = await screen.findByRole("dialog", {}, { timeout: 5000 });
    await user.click(within(dialog).getByRole("combobox", { name: "dayPlanner.substituteSelect" }));
    expect(await screen.findByRole("option", { name: "Bo Ek" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Maja Mark" })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Rolf Rektor" })).not.toBeInTheDocument();
  });
});
