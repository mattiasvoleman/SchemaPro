import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ConflictHit } from "@/lib/conflicts";
import type { MasterLesson } from "@/lib/types";
import { ConflictList } from "./conflict-list";

// The real catalogue through the real translator: the sentences under test are the reader's.
vi.mock("next-intl", async () => {
  const { createTranslator } = await import("use-intl");
  const sv = (await import("@/messages/sv.json")).default;
  return {
    useLocale: () => "sv",
    useTranslations: (namespace: string) => createTranslator({ locale: "sv", messages: sv, namespace: namespace as never }),
  };
});

const lesson = (id: string, overrides: Partial<MasterLesson>): MasterLesson => ({
  id,
  academicYearId: "y1",
  subjectId: "Ma",
  studentGroupId: "7A",
  teacherId: "anna",
  coTeacherId: null,
  roomId: null,
  dayOfWeek: 1,
  startTime: "10:00:00",
  endTime: "11:00:00",
  isLocked: false,
  isParked: false,
  recurrence: "ALL_WEEKS",
  startDate: null,
  endDate: null,
  extraGroupIds: [],
  studentIds: [],
  ...overrides,
});

const a = lesson("a", {});
const b = lesson("b", { subjectId: "Ke", studentGroupId: "8B", startTime: "10:30:00", endTime: "11:30:00" });
const lessonById = new Map([a, b].map((entry) => [entry.id, entry]));
const conflictMap = new Map<string, ConflictHit[]>([
  ["a", [{ kind: "TEACHER", otherLessonId: "b" }]],
  ["b", [{ kind: "TEACHER", otherLessonId: "a" }, { kind: "ROOM_LOCK" }]],
]);
const NAMES: Record<string, string> = { Ma: "Matematik", Ke: "Kemi", "7A": "7A", "8B": "8B" };

const draw = (overrides: Partial<React.ComponentProps<typeof ConflictList>> = {}) => {
  const onGo = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <ConflictList
      open
      onOpenChange={onOpenChange}
      conflictMap={conflictMap}
      lessonById={lessonById}
      group={(id) => NAMES[id] ?? id}
      subject={(id) => NAMES[id] ?? id}
      onGo={onGo}
      {...overrides}
    />,
  );
  return { onGo, onOpenChange };
};

describe("the krocklista", () => {
  it("says each lesson that clashes, and what it clashes with by class, subject, day and time", () => {
    draw();
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Konflikter i schemat")).toBeTruthy();
    const items = within(dialog).getAllByRole("listitem").filter((item) => item.querySelector("button"));
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain("Matematik med 7A, måndag 10:00–11:00");
    expect(items[0]!.textContent).toContain("Läraren har redan Kemi med 8B, måndag 10:30–11:30.");
    expect(items[1]!.textContent).toContain("Kemi med 8B, måndag 10:30–11:30");
    expect(items[1]!.textContent).toContain("Läraren har redan Matematik med 7A, måndag 10:00–11:00.");
    // The room lock is the web's own rule: the list words it itself.
    expect(items[1]!.textContent).toContain("Salen är låst för ämnet.");
  });

  it("opens the lesson that was pressed", () => {
    const { onGo } = draw();
    fireEvent.click(screen.getAllByRole("button", { name: "Öppna" })[1]!);
    expect(onGo).toHaveBeenCalledWith("b");
  });

  it("has no way to open a lesson for a reader: the list is then only read", () => {
    draw({ onGo: undefined });
    expect(screen.queryByRole("button", { name: "Öppna" })).toBeNull();
    // What it says is all there.
    expect(screen.getAllByText(/Läraren har redan/)).toHaveLength(2);
  });

  it("marks the way to a lesson as a write, so that a profile without the area is not shown it", () => {
    draw();
    for (const button of screen.getAllByRole("button", { name: "Öppna" })) {
      expect(button.getAttribute("data-writes")).toBe("SCHEMALAGGNING DRIFT");
    }
  });

  it("says there is nothing to list for a week with no clash, and draws nothing while closed", () => {
    draw({ conflictMap: new Map() });
    expect(screen.getByText("Inga konflikter i schemat.")).toBeTruthy();
  });

  it("draws no dialog when it is not open", () => {
    draw({ open: false });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
