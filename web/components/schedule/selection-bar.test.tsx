import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DirectReachDeclined } from "@/lib/direct-reach";
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
    // Each write says the lock the lesson had when it was selected (E9), so that a colleague's lock or unlock since is not written over.
    expect(mutate).toHaveBeenNthCalledWith(1, { id: "a", isLocked: false, propagate: false, expected: { isLocked: true } });

    mutate.mockClear();
    await pushed[0]!.undo();
    expect(mutate).toHaveBeenNthCalledWith(1, { id: "a", isLocked: true, propagate: false, exempt: ["FRAME"], expected: { isLocked: false } });
    // A lesson with no exemption is locked again as it always was: no word of one.
    expect(mutate).toHaveBeenNthCalledWith(2, { id: "b", isLocked: true, propagate: false, expected: { isLocked: false } });

    // The redo takes the lock off and says nothing of the exemption: it ends again, as the first time.
    mutate.mockClear();
    await pushed[0]!.redo();
    expect(mutate).toHaveBeenNthCalledWith(1, { id: "a", isLocked: false, propagate: false, expected: { isLocked: true } });
  });

  it("says nothing of an exemption when the lock is put on: the lesson that is locked has none to give", async () => {
    const free = lesson("a", { isLocked: false });
    const { pushed, mutate } = draw([free]);
    fireEvent.click(screen.getByRole("button", { name: "Lås" }));
    await vi.waitFor(() => expect(pushed).toHaveLength(1));
    mutate.mockClear();
    await pushed[0]!.undo();
    expect(mutate).toHaveBeenCalledWith({ id: "a", isLocked: false, propagate: false, expected: { isLocked: true } });
  });
});

// The question before a change in Direkt that reaches families (P5, beslut 8): a bulk delete is a write of published lessons like a drag, and the
// page asked about the drag and the single delete and not about this one, so a school that had not answered got "make the change in Schema" on the
// page it was on, with no question to answer.
describe("Ta bort on a selection, and the question before a change in Direkt", () => {
  function drawDelete(selected: MasterLesson[], guard?: <T>(run: () => Promise<T>) => Promise<T>) {
    const deleted: string[] = [];
    const showError = vi.fn();
    const pushed: HistoryEntry[] = [];
    render(
      <SelectionBar
        shown
        selectedLessons={() => selected}
        updateLesson={{ mutateAsync: vi.fn() } as never}
        deleteLesson={{ mutateAsync: vi.fn(async (id: string) => void deleted.push(id)) } as never}
        createLesson={{ mutateAsync: vi.fn() } as never}
        history={{ push: (entry: HistoryEntry) => void pushed.push(entry) } as unknown as ScheduleHistory}
        showError={showError}
        guard={guard}
        onClear={vi.fn()}
        deleteIcon={null}
      />,
    );
    return { deleted, showError, pushed };
  }

  it("asks around each delete, so the first one asks and the answer holds for the rest", async () => {
    const order: string[] = [];
    const asked = vi.fn(async <T,>(run: () => Promise<T>) => {
      order.push("ask");
      return run();
    });
    const { deleted } = drawDelete([lesson("a"), lesson("b")], asked as never);
    fireEvent.click(screen.getByRole("button", { name: "Ta bort" }));
    await vi.waitFor(() => expect(deleted).toEqual(["a", "b"]));
    expect(asked).toHaveBeenCalledTimes(2);
    expect(order).toEqual(["ask", "ask"]);
  });

  it("deletes nothing and records no history when the school answers no", async () => {
    const declined = vi.fn(async () => {
      throw new DirectReachDeclined();
    });
    const { deleted, showError, pushed } = drawDelete([lesson("a"), lesson("b")], declined as never);
    fireEvent.click(screen.getByRole("button", { name: "Ta bort" }));
    await vi.waitFor(() => expect(showError).toHaveBeenCalledTimes(1));
    expect(showError.mock.calls[0]![0]).toBeInstanceOf(DirectReachDeclined);
    expect(deleted).toEqual([]);
    expect(pushed).toEqual([]);
  });
});
