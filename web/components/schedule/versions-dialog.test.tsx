import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import sv from "@/messages/sv.json";

const versionsByYear: Record<string, unknown[]> = {
  "y-1": [{ id: "v-a", name: "Vår v12 (2026/27)", createdAt: "2027-03-20T10:00:00Z", lessonCount: 1 }],
  "y-2": [{ id: "v-b", name: "Utkast (2027/28)", createdAt: "2027-04-02T10:00:00Z", lessonCount: 1 }],
};
const lessonA = { id: "l-a", subjectId: "s1", studentGroupId: "g-7a", teacherId: null, roomId: null, dayOfWeek: 1, startTime: "08:00", endTime: "09:00", extraGroupIds: [] };
/** The list's read failing, for the dialog's own state ladder. */
const versionsRead = vi.hoisted(() => ({ failed: false }));
vi.mock("@/lib/queries", () => ({
  useScheduleVersions: (yearId: string | null) =>
    versionsRead.failed
      ? { data: undefined, isError: true }
      : { data: yearId ? versionsByYear[yearId] : undefined },
  useScheduleVersionDetail: (id: string | null) => ({
    data: id === "v-a" ? { id: "v-a", name: "Vår v12 (2026/27)", lessons: [lessonA] } : undefined,
  }),
  useScheduleVersionActions: () => ({ save: { isPending: false }, restore: { isPending: false }, remove: { isPending: false } }),
}));

import { VersionsDialog } from "./versions-dialog";

const props = (open: boolean, yearId: string, lessons: unknown[]) => ({
  open,
  onOpenChange: () => {},
  academicYearId: yearId,
  lessons: lessons as never,
  subjectById: new Map(),
  teacherById: new Map(),
  roomById: new Map(),
  personById: new Map(),
  groupLabel: () => "G",
  onRestored: () => {},
  showError: () => {},
});

function wrap(ui: React.ReactElement) {
  return <NextIntlClientProvider locale="sv" messages={sv}>{ui}</NextIntlClientProvider>;
}

/**
 * The dialog is lazy and stays mounted once Versioner has been pressed, and
 * the timetable page switches between this year and next. A comparison
 * picked in one year must not be drawn under the other's versions: it would
 * diff last year's saved lessons against next year's grid, every lesson
 * added or removed.
 */
describe("VersionsDialog across a switch of läsår", () => {
  it("drops the comparison picked in the other year", async () => {
    const lessonB = { ...lessonA, id: "l-b", studentGroupId: "g-8a" };
    const { rerender } = render(wrap(<VersionsDialog {...props(true, "y-1", [lessonA])} />));
    await userEvent.click(screen.getByTitle("Jämför med nuvarande"));
    expect(screen.getByText(/Ändringar sedan ”Vår v12 \(2026\/27\)”/)).toBeTruthy();
    rerender(wrap(<VersionsDialog {...props(false, "y-1", [lessonA])} />));
    // The page switches to next year, and Versioner is pressed again.
    rerender(wrap(<VersionsDialog {...props(true, "y-2", [lessonB])} />));
    expect(screen.getByText("Utkast (2027/28)")).toBeTruthy();
    expect(screen.queryByText("Vår v12 (2026/27)")).toBeNull();
    expect(screen.queryByText(/Ändringar sedan/)).toBeNull();
    // Back in this year, nothing is compared until it is asked again.
    rerender(wrap(<VersionsDialog {...props(true, "y-1", [lessonA])} />));
    expect(screen.queryByText(/Ändringar sedan/)).toBeNull();
  });
});

describe("VersionsDialog's rows and list", () => {
  it("names every row's buttons after its version", () => {
    render(wrap(<VersionsDialog {...props(true, "y-1", [lessonA])} />));

    // A list whose rows all say "Återställ" is one question asked many times.
    expect(screen.getByRole("button", { name: "Återställ ”Vår v12 (2026/27)”" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ta bort ”Vår v12 (2026/27)”" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Jämför ”Vår v12 (2026/27)” med nuvarande" }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("textbox", { name: "Namn på versionen" })).toBeTruthy();
  });

  it("marks saving, restoring and deleting as schemaläggning's, and comparing as nobody's write (Läsbehörighet)", () => {
    render(wrap(<VersionsDialog {...props(true, "y-1", [lessonA])} />));

    // The name field goes with its Spara: a name with nowhere to send it is no use.
    expect(screen.getByRole("textbox", { name: "Namn på versionen" }).closest("[data-writes]")).toHaveAttribute(
      "data-writes",
      "SCHEMALAGGNING",
    );
    for (const name of ["Återställ ”Vår v12 (2026/27)”", "Ta bort ”Vår v12 (2026/27)”"]) {
      expect(screen.getByRole("button", { name })).toHaveAttribute("data-writes", "SCHEMALAGGNING");
    }
    expect(screen.getByRole("button", { name: "Jämför ”Vår v12 (2026/27)” med nuvarande" }).closest("[data-writes]")).toBeNull();
  });

  it("says the list could not be read, rather than that there are no versions", () => {
    versionsRead.failed = true;
    try {
      render(wrap(<VersionsDialog {...props(true, "y-1", [lessonA])} />));

      expect(screen.getByText("Versionerna kunde inte hämtas")).toBeTruthy();
      expect(screen.queryByText(/Inga versioner ännu/)).toBeNull();
    } finally {
      versionsRead.failed = false;
    }
  });
});
