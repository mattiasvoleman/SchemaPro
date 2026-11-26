import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { MasterLesson } from "@/lib/types";
import type { HistoryEntry, ScheduleHistory } from "@/lib/use-schedule-history";
import { SelectionBar } from "./selection-bar";

// The real catalogue through the real translator: the buttons under test are the reader's.
vi.mock("next-intl", async () => {
  const { createTranslator } = await import("use-intl");
  const sv = (await import("@/messages/sv.json")).default;
  return {
    useLocale: () => "sv",
    useTranslations: (namespace: string) => createTranslator({ locale: "sv", messages: sv, namespace: namespace as never }),
  };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

const lesson = (id: string, overrides: Partial<MasterLesson> = {}): MasterLesson => ({
  id,
  academicYearId: "y1",
  subjectId: "Ma",
  studentGroupId: "7A",
  teacherId: "anna",
  coTeacherId: null,
  roomId: null,
  dayOfWeek: 1,
  startTime: "14:30:00",
  endTime: "15:30:00",
  isLocked: true,
  isParked: false,
  recurrence: "ALL_WEEKS",
  startDate: null,
  endDate: null,
  extraGroupIds: [],
  studentIds: [],
  ...overrides,
});

function draw(selected: MasterLesson[]) {
  const pushed: HistoryEntry[] = [];
  const mutate = vi.fn(async () => ({}));
  const history = { push: (entry: HistoryEntry) => void pushed.push(entry) } as unknown as ScheduleHistory;
  render(
    <SelectionBar
      shown
      selectedLessons={() => selected}
      updateLesson={{ mutateAsync: mutate } as never}
      deleteLesson={{ mutateAsync: vi.fn() } as never}
      createLesson={{ mutateAsync: vi.fn() } as never}
      history={history}
      showError={vi.fn()}
      onClear={vi.fn()}
      deleteIcon={null}
    />,
  );
  return { pushed, mutate };
}

describe("Lås upp on a selection, and its Ångra (Undantag med flit)", () => {
  it("puts the exemption back with the lock: the gateway ends an exemption when its lock comes off, and an undo that only locks again would lose it", async () => {
    const exempt = lesson("a", { exemptFrom: ["FRAME"] });
    const plain = lesson("b");
    const { pushed, mutate } = draw([exempt, plain]);
    fireEvent.click(screen.getByRole("button", { name: /Lås upp/ }));
    await vi.waitFor(() => expect(pushed).toHaveLength(1));
    expect(mutate).toHaveBeenNthCalledWith(1, { id: "a", isLocked: false, propagate: false });

    mutate.mockClear();
    await pushed[0]!.undo();
    expect(mutate).toHaveBeenNthCalledWith(1, { id: "a", isLocked: true, propagate: false, exempt: ["FRAME"] });
    // A lesson with no exemption is locked again as it always was: no word of one.
    expect(mutate).toHaveBeenNthCalledWith(2, { id: "b", isLocked: true, propagate: false });

    // The redo takes the lock off and says nothing of the exemption: it ends again, as the first time.
    mutate.mockClear();
    await pushed[0]!.redo();
    expect(mutate).toHaveBeenNthCalledWith(1, { id: "a", isLocked: false, propagate: false });
  });

  it("says nothing of an exemption when the lock is put on: the lesson that is locked has none to give", async () => {
    const free = lesson("a", { isLocked: false });
    const { pushed, mutate } = draw([free]);
    fireEvent.click(screen.getByRole("button", { name: "Lås" }));
    await vi.waitFor(() => expect(pushed).toHaveLength(1));
    mutate.mockClear();
    await pushed[0]!.undo();
    expect(mutate).toHaveBeenCalledWith({ id: "a", isLocked: false, propagate: false });
  });
});
