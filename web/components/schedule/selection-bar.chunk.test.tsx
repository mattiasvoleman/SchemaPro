import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { MasterLesson } from "@/lib/types";
import type { ScheduleHistory } from "@/lib/use-schedule-history";
import { SelectionBar } from "./selection-bar";

/**
 * Byt plats's code is fetched at the first press, and the fetch can fail (a tab left open over a deploy: the chunk is gone). The page retries every
 * piece it fetches after a failure, by a new wrapper (timetable-lazy.ts), because a lazy() keeps a rejected fetch for good. This one must be as good:
 * the failure is said (showError), the bar is still there with the selection, and the next press fetches again.
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

const chunk = vi.hoisted(() => ({ fail: true, tried: 0 }));
vi.mock("./swap-dialog", async () => {
  chunk.tried += 1;
  if (chunk.fail) throw new Error("Failed to load chunk swap-dialog");
  const { createElement } = await import("react");
  return { SwapPairDialog: ({ open }: { open: boolean }) => createElement("div", { "data-testid": "pair-dialog", "data-open": String(open) }) };
});

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

describe("Byt plats when its code does not arrive", () => {
  it("says so, keeps the bar, and fetches again at the next press", async () => {
    const showError = vi.fn();
    const selected = [lesson("a"), lesson("b")];
    render(
      <SelectionBar
        shown
        selectedLessons={() => selected}
        updateLesson={{ mutateAsync: vi.fn() } as never}
        deleteLesson={{ mutateAsync: vi.fn() } as never}
        createLesson={{ mutateAsync: vi.fn() } as never}
        history={{ push: vi.fn(), clear: vi.fn() } as unknown as ScheduleHistory}
        showError={showError}
        onClear={vi.fn()}
        deleteIcon={null}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Byt plats" }));
    await waitFor(() => expect(showError).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Byt plats" })).toBeInTheDocument();
    expect(screen.queryByTestId("pair-dialog")).not.toBeInTheDocument();

    chunk.fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Byt plats" }));
    expect(await screen.findByTestId("pair-dialog")).toHaveAttribute("data-open", "true");
    expect(showError).toHaveBeenCalledTimes(1);
  });
});
