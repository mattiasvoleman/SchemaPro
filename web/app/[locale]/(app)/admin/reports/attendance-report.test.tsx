import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import sv from "@/messages/sv.json";
import { AttendanceReport } from "./attendance-report";

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
 * Rapporter › Närvaro: a class and a period, the class's figures as a KPI
 * strip above the table, and no figure at all from a read that failed — a
 * roster that did not load would otherwise draw every pupil as "no
 * attendance".
 */

const state = vi.hoisted(() => ({
  people: { data: undefined as unknown, isLoading: false, isError: false },
  records: { data: undefined as unknown, isLoading: false, isError: false },
  /** "Gallrat före" per kind, as GET /api/v1/retention/purged-before answers. */
  purged: {} as Record<string, string>,
}));

vi.mock("@/lib/retention-queries", () => ({
  usePurgedBefore: () => ({ of: (kind: string) => state.purged[kind] ?? null }),
}));

vi.mock("@/lib/queries", () => ({
  useGroups: () => ({ data: [{ id: "g-7a", name: "7A", academicYearId: "y1" }], isLoading: false, isError: false }),
  useAcademicYears: () => ({ data: [{ id: "y1", name: "2026/27", isActive: true }] }),
  usePeople: () => state.people,
  useGroupAttendance: (groupId: string | null) =>
    groupId ? state.records : { data: undefined, isLoading: false, isError: false },
}));

const lesson = { startsAt: "2026-10-05T06:00:00.000Z", endsAt: "2026-10-05T07:00:00.000Z" };
const PEOPLE = [
  { id: "p-ada", role: "STUDENT", firstName: "Ada", lastName: "Berg", studentGroupId: "g-7a" },
  { id: "p-eli", role: "STUDENT", firstName: "Eli", lastName: "Åström", studentGroupId: "g-7a" },
];
const RECORDS = [
  { studentId: "p-ada", status: "PRESENT", lesson },
  { studentId: "p-ada", status: "ABSENT", lesson },
  { studentId: "p-eli", status: "PRESENT", lesson },
  { studentId: "p-eli", status: "EXCUSED", lesson },
];

function renderReport() {
  render(
    <NextIntlClientProvider locale="sv" messages={sv} timeZone="Europe/Stockholm">
      <AttendanceReport />
    </NextIntlClientProvider>,
  );
}

async function chooseClass() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: "Klass" }));
  await user.click(await screen.findByRole("option", { name: "7A" }));
  return user;
}

describe("Rapporter › Närvaro", () => {
  beforeEach(() => {
    state.people = { data: PEOPLE, isLoading: false, isError: false };
    state.records = { data: RECORDS, isLoading: false, isError: false };
    state.purged = {};
  });

  it("asks for a class first, with labelled filters", () => {
    renderReport();
    expect(screen.getByRole("heading", { level: 2, name: "Välj en klass" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Klass" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Exportera CSV/ })).toBeDisabled();
  });

  it("puts the class's figures in a KPI strip above a named table", async () => {
    renderReport();
    await chooseClass();
    const average = screen.getByText("Klassens snitt");
    expect(average.tagName).toBe("DT");
    expect(average.nextElementSibling?.textContent?.replace(/\s/g, " ")).toBe("50 %");
    const table = screen.getByRole("table", { name: /Närvaro per elev under perioden/ });
    const ada = within(table).getByText("Berg, Ada").closest("tr")!;
    expect(within(ada).getByText(/50/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Exportera CSV/ })).toBeEnabled();
  });

  it("says the report could not be read, and draws no figure, when the roster fails", async () => {
    state.people = { data: undefined, isLoading: false, isError: true };
    renderReport();
    expect(screen.getByRole("heading", { level: 2, name: "Närvaron kunde inte hämtas" })).toBeInTheDocument();
    await chooseClass();
    expect(screen.getByRole("heading", { level: 2, name: "Närvaron kunde inte hämtas" })).toBeInTheDocument();
    expect(screen.queryByText("Klassens snitt")).not.toBeInTheDocument();
    expect(screen.queryByText("Ingen närvaro registrerad under perioden")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Exportera CSV/ })).toBeDisabled();
  });

  it("says when the period reaches back past the school's gallring, and not otherwise", async () => {
    state.purged = { ATTENDANCE: "2000-01-01" };
    const { unmount } = render(
      <NextIntlClientProvider locale="sv" messages={sv} timeZone="Europe/Stockholm">
        <AttendanceReport />
      </NextIntlClientProvider>,
    );
    await chooseClass();
    expect(screen.queryByText(/är gallrad enligt skolans beslut/)).not.toBeInTheDocument();
    unmount();

    // A purge date after the period's first day: the days before it are gone, not absence-free.
    state.purged = { ATTENDANCE: "2999-01-01" };
    renderReport();
    await chooseClass();
    expect(screen.getByText("Närvaro före 1 januari 2999 är gallrad enligt skolans beslut.")).toBeInTheDocument();
  });

  it("says why the class has no figures when nothing was recorded", async () => {
    state.records = { data: [], isLoading: false, isError: false };
    renderReport();
    await chooseClass();
    expect(screen.getByRole("heading", { level: 2, name: "Ingen närvaro registrerad under perioden" })).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});
