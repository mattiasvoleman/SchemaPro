import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { MasterLesson } from "@/lib/types";
import type { ScheduleHistory } from "@/lib/use-schedule-history";
import { SelectionBar } from "./selection-bar";

/**
 * Byt plats is opened by a press, and only by a press. The dialog is not modal, so the person can go on marking while it is up; what it must not
 * do is open again by itself, for lessons nobody asked about, when the selection later comes to be two once more.
 */

vi.mock("next-intl", async () => {
  const { createTranslator } = await import("use-intl");
  const sv = (await import("@/messages/sv.json")).default;
  return {
    useLocale: () => "sv",
    useTranslations: (namespace: string) => createTranslator({ locale: "sv", messages: sv, namespace: namespace as never }),
  };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock("./swap-dialog", () => ({
  SwapPairDialog: (props: Record<string, unknown>) => (
    <div data-testid="pair-dialog" data-open={String(props["open"])} data-ids={(props["lessons"] as Array<{ id: string }>).map((entry) => entry.id).join(",")} />
  ),
}));

const lesson = (id: string): MasterLesson => ({
  id,
  academicYearId: "y1",
  subjectId: "Ma",
  studentGroupId: "7A",
  teacherId: "anna",
  coTeacherId: null,
  roomId: null,
  dayOfWeek: 1,
  startTime: "08:00:00",
  endTime: "09:00:00",
  isLocked: false,
  isParked: false,
  recurrence: "ALL_WEEKS",
  startDate: null,
  endDate: null,
  extraGroupIds: [],
  studentIds: [],
});

function bar(selected: MasterLesson[], shown = selected.length > 0) {
  return (
    <SelectionBar
      shown={shown}
      selectedLessons={() => selected}
      updateLesson={{ mutateAsync: vi.fn() } as never}
      deleteLesson={{ mutateAsync: vi.fn() } as never}
      createLesson={{ mutateAsync: vi.fn() } as never}
      history={{ push: vi.fn(), clear: vi.fn() } as unknown as ScheduleHistory}
      showError={vi.fn()}
      onClear={vi.fn()}
      deleteIcon={null}
    />
  );
}

describe("Byt plats opens on a press and is not opened again by the selection", () => {
  it("stays shut when the selection is cleared and two other lessons are marked", async () => {
    const view = render(bar([lesson("a"), lesson("b")]));
    expect(screen.queryByTestId("pair-dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Byt plats" }));
    expect(await screen.findByTestId("pair-dialog")).toHaveAttribute("data-open", "true");
    // Rensa (or a year, a filter or a view that drops the selection) while the dialog is up, and then two other lessons are marked.
    view.rerender(bar([], false));
    view.rerender(bar([lesson("c"), lesson("d")]));
    const dialog = screen.queryByTestId("pair-dialog");
    expect(dialog === null || dialog.getAttribute("data-open") === "false").toBe(true);
  });

  it("stays shut when a third lesson is marked and then unmarked", async () => {
    const view = render(bar([lesson("a"), lesson("b")]));
    fireEvent.click(screen.getByRole("button", { name: "Byt plats" }));
    expect(await screen.findByTestId("pair-dialog")).toHaveAttribute("data-open", "true");
    view.rerender(bar([lesson("a"), lesson("b"), lesson("c")]));
    expect(screen.getByTestId("pair-dialog")).toHaveAttribute("data-open", "false");
    view.rerender(bar([lesson("a"), lesson("c")]));
    expect(screen.getByTestId("pair-dialog")).toHaveAttribute("data-open", "false");
  });
});
