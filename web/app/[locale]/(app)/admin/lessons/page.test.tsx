import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sv from "@/messages/sv.json";
import DayPlannerPage from "./page";

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
 * Dagsplanering: one day's lessons, asked for by the school's own date, a
 * read that failed said as such (never "no lessons"), and each row's
 * actions named after their lesson, opening the dialogs it shares with
 * Lärarfrånvaro.
 */

const cancel = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => ({
  asked: [] as string[],
  lessons: { data: undefined as unknown, isLoading: false, isError: false },
}));

const LESSON = {
  id: "cl-1",
  date: "2026-10-12",
  startsAt: "2026-10-12T08:00:00Z",
  endsAt: "2026-10-12T09:00:00Z",
  subjectId: "s-ma",
  studentGroupId: "g-7a",
  roomId: null,
  status: "SCHEDULED",
  teachers: [{ role: "LEAD", teacherId: "t-1" }],
};

vi.mock("@/lib/queries", () => ({
  useDayLessons: (date: string) => {
    state.asked.push(date);
    return state.lessons;
  },
  usePeople: () => ({
    data: [
      { id: "t-1", role: "TEACHER", isActive: true, firstName: "Nils", lastName: "Berg" },
      { id: "t-2", role: "TEACHER", isActive: true, firstName: "Bo", lastName: "Ek" },
    ],
    isError: false,
  }),
  useSubjects: () => ({ data: [{ id: "s-ma", name: "Matematik" }], isError: false }),
  useGroups: () => ({ data: [{ id: "g-7a", name: "7A" }], isError: false }),
  useRooms: () => ({ data: [], isError: false }),
  useLessonActions: () => ({
    cancel: { mutateAsync: cancel, isPending: false },
    reinstate: { mutateAsync: vi.fn(), isPending: false },
    substitute: { mutateAsync: vi.fn(), isPending: false },
    changeRoom: { mutateAsync: vi.fn(), isPending: false },
  }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

function renderPage() {
  return render(
    <NextIntlClientProvider locale="sv" messages={sv} timeZone="Europe/Stockholm">
      <DayPlannerPage />
    </NextIntlClientProvider>,
  );
}

const originalTz = process.env.TZ;

beforeEach(() => {
  state.asked = [];
  state.lessons = { data: [LESSON], isLoading: false, isError: false };
  cancel.mockReset().mockResolvedValue({});
});

afterEach(() => {
  vi.useRealTimers();
  process.env.TZ = originalTz;
});

describe("Dagsplanering", () => {
  it("opens on today by the school's wall clock, not UTC's", () => {
    // 00:30 on Monday in Stockholm is still Sunday in UTC: toISOString()
    // asked for the day before.
    process.env.TZ = "Europe/Stockholm";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-11T22:30:00Z"));
    renderPage();
    expect(state.asked.at(-1)).toBe("2026-10-12");
    expect(screen.getByLabelText("Datum")).toHaveValue("2026-10-12");
  });

  it("says the day could not be read, and never draws it as a day without lessons", () => {
    state.lessons = { data: undefined, isLoading: false, isError: true };
    renderPage();
    expect(screen.getByRole("heading", { level: 2, name: "Dagens lektioner kunde inte hämtas" })).toBeInTheDocument();
    expect(screen.queryByText("Inga lektioner den här dagen")).not.toBeInTheDocument();
  });

  it("says why a day is empty", () => {
    state.lessons = { data: [], isLoading: false, isError: false };
    renderPage();
    expect(screen.getByRole("heading", { level: 2, name: "Inga lektioner den här dagen" })).toBeInTheDocument();
  });

  it("names each action after its lesson, and cancels through the shared dialog", async () => {
    const user = userEvent.setup();
    renderPage();
    const table = screen.getByRole("table", { name: /Dagens lektioner/ });
    const row = within(table).getByText("Matematik").closest("tr")!;
    expect(within(row).getByRole("button", { name: "Tilldela vikarie 08:00–09:00 Matematik 7A" })).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Byt sal 08:00–09:00 Matematik 7A" })).toBeInTheDocument();
    await user.click(within(row).getByRole("button", { name: "Ställ in lektion 08:00–09:00 Matematik 7A" }));
    // The dialogs are a chunk of their own (React.lazy), fetched on this first click.
    const dialog = await screen.findByRole("dialog", {}, { timeout: 5000 });
    await user.type(within(dialog).getByLabelText(/Meddelande till elever och vårdnadshavare/), "Läxa på Classroom");
    await user.click(within(dialog).getByRole("button", { name: "Ställ in lektion" }));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith({ id: "cl-1", reason: "Läxa på Classroom" }));
  });
});
