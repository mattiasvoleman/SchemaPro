import { render, screen, within } from "@testing-library/react";
import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import sv from "@/messages/sv.json";

/*
 * Versioner (E9): the comparison of a version with the grid or with another version, class by class, every entry and a move as one line; a version
 * renamed; and a restore that asks first.
 */
const lesson = (over: Record<string, unknown> = {}) => ({ subjectId: "ma", studentGroupId: "g-7a", teacherId: "t-anna", coTeacherId: null, roomId: null, dayOfWeek: 1, startTime: "08:00", endTime: "09:00", isParked: false, extraGroupIds: [], studentIds: [], ...over });

const VERSIONS = [
  { id: "v-a", name: "Före lovet", createdAt: "2027-03-20T10:00:00Z", lessonCount: 2 },
  { id: "v-b", name: "Efter lovet", createdAt: "2027-04-02T10:00:00Z", lessonCount: 2 },
];
const DETAILS: Record<string, { id: string; name: string; lessons: unknown[] }> = {
  "v-a": { id: "v-a", name: "Före lovet", lessons: [lesson(), lesson({ subjectId: "no", studentGroupId: "g-8b", dayOfWeek: 2 })] },
  "v-b": { id: "v-b", name: "Efter lovet", lessons: [lesson({ dayOfWeek: 3 }), lesson({ subjectId: "no", studentGroupId: "g-8b", dayOfWeek: 2 })] },
};
const actions = vi.hoisted(() => ({ rename: vi.fn(), restore: vi.fn(), remove: vi.fn(), save: vi.fn() }));
const pending = vi.hoisted(() => ({ restore: false }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/queries", () => ({
  useScheduleVersions: () => ({ data: VERSIONS }),
  useScheduleVersionDetail: (id: string | null) => ({ data: id ? DETAILS[id] : undefined }),
  useScheduleVersionActions: () => ({
    save: { isPending: false, mutateAsync: actions.save },
    rename: { isPending: false, mutateAsync: actions.rename },
    restore: { isPending: pending.restore, mutateAsync: actions.restore },
    remove: { isPending: false, mutateAsync: actions.remove },
  }),
}));

import { VersionsDialog } from "./versions-dialog";

const NAMES: Record<string, string> = { "g-7a": "7A", "g-8b": "8B", "g-9c": "9C" };
const props = (live: unknown[], over: Record<string, unknown> = {}) => ({
  open: true,
  onOpenChange: () => {},
  academicYearId: "y-1",
  lessons: live as never,
  subjectById: new Map([["ma", { id: "ma", name: "Matematik" }], ["no", { id: "no", name: "Naturkunskap" }]]) as never,
  teacherById: new Map([["t-anna", { id: "t-anna", firstName: "Anna", lastName: "Ek" }]]) as never,
  roomById: new Map(),
  personById: new Map(),
  groupLabel: (l: { studentGroupId: string }) => NAMES[l.studentGroupId] ?? "",
  onRestored: vi.fn(),
  showError: vi.fn(),
  ...over,
});
const wrap = (ui: React.ReactElement) => <NextIntlClientProvider locale="sv" messages={sv}>{ui}</NextIntlClientProvider>;
const entries = (container: HTMLElement) => [...container.querySelectorAll("li")].map((li) => li.textContent?.replace(/^(.) (Flyttad|Ändrad|Tillagd|Borttagen): /, "$1 "));

beforeEach(() => Object.values(actions).forEach((fn) => fn.mockReset()));

describe("a version compared with the grid", () => {
  it("shows a lesson that moved as one line, and groups the lines by class with the counts of each", async () => {
    const live = [lesson({ dayOfWeek: 3 }), lesson({ subjectId: "no", studentGroupId: "g-8b", dayOfWeek: 2 }), lesson({ studentGroupId: "g-9c", subjectId: "ma" })];
    render(wrap(<VersionsDialog {...props(live)} />));
    await userEvent.click(screen.getByRole("button", { name: "Jämför ”Före lovet” med nuvarande" }));
    const diff = screen.getByRole("region", { name: /Ändringar sedan ”Före lovet”/ });
    // The total, then each class that has anything, in their own order.
    expect(within(diff).getByText("1 flyttad, 1 tillagd")).toBeTruthy();
    expect(within(diff).getAllByRole("heading", { level: 4 }).map((heading) => heading.textContent)).toEqual(["7A · 1 flyttad", "9C · 1 tillagd"]);
    expect(entries(diff)).toEqual(["↔ Matematik · Måndag 08:00–09:00 → Onsdag 08:00–09:00", "+ Matematik · 9C · Måndag 08:00–09:00 · A. Ek"]);
  });

  it("shows every entry, however many: the list is no longer cut at eight", async () => {
    const live = Array.from({ length: 30 }, (_unused, index) => lesson({ studentGroupId: "g-9c", dayOfWeek: 1 + (index % 5), startTime: `${String(8 + Math.floor(index / 5)).padStart(2, "0")}:00`, endTime: `${String(9 + Math.floor(index / 5)).padStart(2, "0")}:00` }));
    render(wrap(<VersionsDialog {...props(live)} />));
    await userEvent.click(screen.getByRole("button", { name: "Jämför ”Före lovet” med nuvarande" }));
    const diff = screen.getByRole("region", { name: /Ändringar sedan/ });
    expect(entries(diff).filter((line) => line?.startsWith("+"))).toHaveLength(30);
    expect(within(diff).queryByText("…")).toBeNull();
  });

  it("says the grid is identical to the version when nothing differs", async () => {
    render(wrap(<VersionsDialog {...props(DETAILS["v-a"]!.lessons)} />));
    await userEvent.click(screen.getByRole("button", { name: "Jämför ”Före lovet” med nuvarande" }));
    expect(screen.getByText("Det nuvarande schemat är identiskt med denna version.")).toBeTruthy();
  });
});

describe("a lesson that more than one class has", () => {
  it("names the classes on the line that says it moved, and on a line that says it changed, but not where the classes are what changed", async () => {
    const before = DETAILS["v-a"]!;
    const shared = { subjectId: "ma", studentGroupId: "g-7a", extraGroupIds: ["g-8b"] };
    DETAILS["v-a"] = { ...before, lessons: [lesson({ ...shared }), lesson({ ...shared, subjectId: "no", dayOfWeek: 2 }), lesson({ studentGroupId: "g-9c", subjectId: "no", dayOfWeek: 4, extraGroupIds: ["g-7a"] })] };
    try {
      const live = [lesson({ ...shared, dayOfWeek: 3 }), lesson({ ...shared, subjectId: "no", dayOfWeek: 2, teacherId: "t-bo" }), lesson({ studentGroupId: "g-9c", subjectId: "no", dayOfWeek: 4, extraGroupIds: ["g-7a", "g-8b"] })];
      const names = { ...props(live), groupLabel: (l: { studentGroupId: string; extraGroupIds?: string[] }) => [l.studentGroupId, ...(l.extraGroupIds ?? [])].map((id) => NAMES[id] ?? "").join(" + ") };
      render(wrap(<VersionsDialog {...names} teacherById={new Map([["t-anna", { id: "t-anna", firstName: "Anna", lastName: "Ek" }], ["t-bo", { id: "t-bo", firstName: "Bo", lastName: "Lind" }]]) as never} />));
      await userEvent.click(screen.getByRole("button", { name: "Jämför ”Före lovet” med nuvarande" }));
      const diff = screen.getByRole("region", { name: /Ändringar sedan/ });
      expect(entries(diff)).toEqual([
        "↔ Matematik · 7A + 8B · Måndag 08:00–09:00 → Onsdag 08:00–09:00",
        "~ Naturkunskap · 7A + 8B · Tisdag 08:00–09:00 · lärare: A. Ek → B. Lind",
        "~ Naturkunskap · Torsdag 08:00–09:00 · klasser: 9C + 7A → 9C + 7A + 8B",
      ]);
    } finally {
      DETAILS["v-a"] = before;
    }
  });
});

describe("a lock", () => {
  it("is a change of a lesson that stands where it stood, told as locking: before → after", async () => {
    render(wrap(<VersionsDialog {...props([lesson({ isLocked: true }), DETAILS["v-a"]!.lessons[1]])} />));
    await userEvent.click(screen.getByRole("button", { name: "Jämför ”Före lovet” med nuvarande" }));
    expect(entries(screen.getByRole("region", { name: /Ändringar sedan/ }))).toEqual(["~ Matematik · Måndag 08:00–09:00 · låsning: olåst → låst"]);
  });
});

describe("two versions against each other", () => {
  it("compares the version with another one chosen in the list, and reads the other's name in the title", async () => {
    render(wrap(<VersionsDialog {...props([])} />));
    await userEvent.click(screen.getByRole("button", { name: "Jämför ”Före lovet” med nuvarande" }));
    const against = screen.getByLabelText("Jämför med") as HTMLSelectElement;
    // The version itself is not one of the choices.
    expect([...against.options].map((option) => option.value)).toEqual(["live", "v-b"]);
    await userEvent.selectOptions(against, "v-b");
    const diff = screen.getByRole("region", { name: "Skillnader mellan ”Före lovet” och ”Efter lovet”" });
    expect(entries(diff)).toEqual(["↔ Matematik · Måndag 08:00–09:00 → Onsdag 08:00–09:00"]);
  });

  it("says the two are identical when they are", async () => {
    DETAILS["v-b"] = { ...DETAILS["v-a"]!, id: "v-b", name: "Efter lovet" };
    try {
      render(wrap(<VersionsDialog {...props([])} />));
      await userEvent.click(screen.getByRole("button", { name: "Jämför ”Före lovet” med nuvarande" }));
      await userEvent.selectOptions(screen.getByLabelText("Jämför med"), "v-b");
      expect(screen.getByText("De två versionerna är identiska.")).toBeTruthy();
    } finally {
      DETAILS["v-b"] = { id: "v-b", name: "Efter lovet", lessons: [lesson({ dayOfWeek: 3 }), lesson({ subjectId: "no", studentGroupId: "g-8b", dayOfWeek: 2 })] };
    }
  });

  it("drops a comparison whose version is deleted: the other one is no longer the partner, and the one being read is no longer read", async () => {
    const kept = [...VERSIONS];
    const { rerender } = render(wrap(<VersionsDialog {...props([])} />));
    try {
      await userEvent.click(screen.getByRole("button", { name: "Jämför ”Före lovet” med nuvarande" }));
      await userEvent.selectOptions(screen.getByLabelText("Jämför med"), "v-b");
      expect(screen.getByRole("region", { name: "Skillnader mellan ”Före lovet” och ”Efter lovet”" })).toBeTruthy();
      VERSIONS.splice(1, 1);
      rerender(wrap(<VersionsDialog {...props([])} />));
      expect((screen.getByLabelText("Jämför med") as HTMLSelectElement).value).toBe("live");
      expect(screen.getByRole("region", { name: "Ändringar sedan ”Före lovet”" })).toBeTruthy();
      VERSIONS.splice(0, 1);
      rerender(wrap(<VersionsDialog {...props([])} />));
      expect(screen.queryByRole("region")).toBeNull();
    } finally {
      VERSIONS.splice(0, VERSIONS.length, ...kept);
    }
  });
});

describe("renaming a version", () => {
  it("opens a field with the name, saves the trimmed name with Enter, and says the new name", async () => {
    actions.rename.mockResolvedValue({});
    render(wrap(<VersionsDialog {...props([])} />));
    await userEvent.click(screen.getByRole("button", { name: "Döp om ”Före lovet”" }));
    const field = screen.getByRole("textbox", { name: "Nytt namn på versionen" });
    expect(field).toHaveValue("Före lovet");
    expect(field.closest("[data-writes]")).toHaveAttribute("data-writes", "SCHEMALAGGNING");
    await userEvent.clear(field);
    await userEvent.type(field, "  Vårens första{Enter}");
    expect(actions.rename).toHaveBeenCalledWith({ id: "v-a", name: "Vårens första" });
    await vi.waitFor(() => expect(screen.queryByRole("textbox", { name: "Nytt namn på versionen" })).toBeNull());
  });

  it("lets the name be, and writes nothing, on Escape and on Avbryt, and does not save a name of blanks", async () => {
    render(wrap(<VersionsDialog {...props([])} />));
    await userEvent.click(screen.getByRole("button", { name: "Döp om ”Före lovet”" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Nytt namn på versionen" }), "x{Escape}");
    expect(screen.queryByRole("textbox", { name: "Nytt namn på versionen" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Döp om ”Före lovet”" }));
    await userEvent.clear(screen.getByRole("textbox", { name: "Nytt namn på versionen" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Nytt namn på versionen" }), "   ");
    expect(screen.getByRole("button", { name: "Spara namnet" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Avbryt" }));
    expect(actions.rename).not.toHaveBeenCalled();
  });

  // `onOpenChange` of the other tests is a no-op, so a dialog that closed on Escape looked open to them: this host does what the page does.
  function Controlled() {
    const [open, setOpen] = useState(true);
    return <VersionsDialog {...props([])} open={open} onOpenChange={setOpen} />;
  }

  it("lets the name be on Escape and keeps the dialog open, with focus back on the pencil; a second Escape closes the dialog", async () => {
    render(wrap(<Controlled />));
    await userEvent.click(screen.getByRole("button", { name: "Döp om ”Före lovet”" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Nytt namn på versionen" }), "x{Escape}");
    expect(screen.queryByRole("textbox", { name: "Nytt namn på versionen" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Schemaversioner" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Döp om ”Före lovet”" })).toHaveFocus();
    expect(actions.rename).not.toHaveBeenCalled();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Schemaversioner" })).toBeNull();
  });

  it("puts focus back on the pencil after the name is saved with Enter", async () => {
    actions.rename.mockResolvedValue({});
    render(wrap(<Controlled />));
    await userEvent.click(screen.getByRole("button", { name: "Döp om ”Före lovet”" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Nytt namn på versionen" }), "!{Enter}");
    await vi.waitFor(() => expect(screen.getByRole("button", { name: "Döp om ”Före lovet”" })).toHaveFocus());
    expect(screen.getByRole("dialog", { name: "Schemaversioner" })).toBeTruthy();
  });

  it("marks the pencil as schemaläggning's write", () => {
    render(wrap(<VersionsDialog {...props([])} />));
    expect(screen.getByRole("button", { name: "Döp om ”Före lovet”" })).toHaveAttribute("data-writes", "SCHEMALAGGNING");
  });
});

describe("restoring a version", () => {
  it("asks first, says what would change and that the schedule is saved before, and replaces nothing until the reader says yes", async () => {
    actions.restore.mockResolvedValue({ restoredLessons: 2, safetyVersionId: "s-1" });
    const onRestored = vi.fn();
    // The grid has the Monday lesson moved to Wednesday and no lesson of 8B.
    render(wrap(<VersionsDialog {...props([lesson({ dayOfWeek: 3 })], { onRestored })} />));
    await userEvent.click(screen.getByRole("button", { name: "Återställ ”Före lovet”" }));
    const asked = screen.getByRole("dialog", { name: "Återställa ”Före lovet”?" });
    expect(within(asked).getByText(/Det nuvarande schemat sparas först som en version/)).toBeTruthy();
    expect(within(asked).getByText(/Jämfört med det nuvarande schemat: 1 flyttad, 1 tillagd\./)).toBeTruthy();
    expect(actions.restore).not.toHaveBeenCalled();

    await userEvent.click(within(asked).getByRole("button", { name: "Återställ" }));
    expect(actions.restore).toHaveBeenCalledWith("v-a");
    await vi.waitFor(() => expect(onRestored).toHaveBeenCalled());
  });

  it("restores nothing when the reader says no", async () => {
    render(wrap(<VersionsDialog {...props([])} />));
    await userEvent.click(screen.getByRole("button", { name: "Återställ ”Före lovet”" }));
    await userEvent.click(within(screen.getByRole("dialog", { name: "Återställa ”Före lovet”?" })).getByRole("button", { name: "Avbryt" }));
    expect(actions.restore).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Återställa ”Före lovet”?" })).toBeNull();
  });

  it("does not say the version is identical when it differs in what a restore also writes: a lock", async () => {
    render(wrap(<VersionsDialog {...props(DETAILS["v-a"]!.lessons.map((one) => ({ ...(one as object), isLocked: true })))} />));
    await userEvent.click(screen.getByRole("button", { name: "Återställ ”Före lovet”" }));
    expect(screen.queryByText(/Versionen är identisk med det nuvarande schemat\./)).toBeNull();
    expect(screen.getByText(/Jämfört med det nuvarande schemat: 2 ändrade\./)).toBeTruthy();
  });

  it("says when the version is the schedule that is on screen", async () => {
    render(wrap(<VersionsDialog {...props(DETAILS["v-a"]!.lessons)} />));
    await userEvent.click(screen.getByRole("button", { name: "Återställ ”Före lovet”" }));
    expect(screen.getByText(/Versionen är identisk med det nuvarande schemat\./)).toBeTruthy();
  });
});

describe("what the dialog holds on to while it is open", () => {
  beforeEach(() => {
    pending.restore = false;
  });

  it("keeps the question's Återställ shut while the restore is on its way, so that the reader cannot send it twice", async () => {
    actions.restore.mockReturnValue(new Promise(() => {}));
    const { rerender } = render(wrap(<VersionsDialog {...props([])} />));
    await userEvent.click(screen.getByRole("button", { name: "Återställ ”Före lovet”" }));
    const asked = screen.getByRole("dialog", { name: "Återställa ”Före lovet”?" });
    expect(within(asked).getByRole("button", { name: "Återställ" })).toBeEnabled();
    pending.restore = true;
    rerender(wrap(<VersionsDialog {...props([])} />));
    expect(within(asked).getByRole("button", { name: "Återställ" })).toBeDisabled();
    expect(within(asked).getByRole("button", { name: "Avbryt" })).toBeDisabled();
  });

  it("closes the question when the restore fails, and says why through the page's own error", async () => {
    const showError = vi.fn();
    const failure = new Error("nej");
    actions.restore.mockRejectedValue(failure);
    render(wrap(<VersionsDialog {...props([], { showError })} />));
    await userEvent.click(screen.getByRole("button", { name: "Återställ ”Före lovet”" }));
    await userEvent.click(within(screen.getByRole("dialog", { name: "Återställa ”Före lovet”?" })).getByRole("button", { name: "Återställ" }));
    await vi.waitFor(() => expect(showError).toHaveBeenCalledWith(failure));
    expect(screen.queryByRole("dialog", { name: "Återställa ”Före lovet”?" })).toBeNull();
  });

  it("starts from the grid again when another version is compared, and drops the comparison and the rename when the page changes year", async () => {
    const { rerender } = render(wrap(<VersionsDialog {...props([])} />));
    await userEvent.click(screen.getByRole("button", { name: "Jämför ”Före lovet” med nuvarande" }));
    await userEvent.selectOptions(screen.getByLabelText("Jämför med"), "v-b");
    expect(screen.getByRole("region", { name: "Skillnader mellan ”Före lovet” och ”Efter lovet”" })).toBeTruthy();
    // The other version's own compare button: that version against the grid, not against the one that was chosen a moment ago (which is itself).
    await userEvent.click(screen.getByRole("button", { name: "Jämför ”Efter lovet” med nuvarande" }));
    expect(screen.getByRole("region", { name: "Ändringar sedan ”Efter lovet”" })).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Döp om ”Före lovet”" }));
    rerender(wrap(<VersionsDialog {...props([], { academicYearId: "y-2" })} />));
    expect(screen.queryByRole("region", { name: /Skillnader|Ändringar/ })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Nytt namn på versionen" })).toBeNull();
  });

  it("drops the question when the page changes year: the version it names is another year's", async () => {
    const { rerender } = render(wrap(<VersionsDialog {...props([])} />));
    await userEvent.click(screen.getByRole("button", { name: "Återställ ”Före lovet”" }));
    expect(screen.getByRole("dialog", { name: "Återställa ”Före lovet”?" })).toBeTruthy();
    rerender(wrap(<VersionsDialog {...props([], { academicYearId: "y-2" })} />));
    expect(screen.queryByRole("dialog", { name: "Återställa ”Före lovet”?", hidden: true })).toBeNull();
  });

  it("lists the classes in their own order: 8B before 10A, as a reader counts", async () => {
    const live = [lesson({ studentGroupId: "g-10a", subjectId: "ma" }), lesson({ studentGroupId: "g-8b", subjectId: "ma" })];
    const groupLabel = (l: { studentGroupId: string }) => ({ "g-7a": "7A", "g-8b": "8B", "g-10a": "10A" })[l.studentGroupId] ?? "";
    render(wrap(<VersionsDialog {...props(live, { groupLabel })} />));
    await userEvent.click(screen.getByRole("button", { name: "Jämför ”Före lovet” med nuvarande" }));
    expect(within(screen.getByRole("region", { name: /Ändringar sedan/ })).getAllByRole("heading", { level: 4 }).map((heading) => heading.textContent?.split(" · ")[0])).toEqual(["7A", "8B", "10A"]);
  });
});
