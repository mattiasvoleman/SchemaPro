import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { MasterLesson } from "@/lib/types";
import type { ScheduleHistory } from "@/lib/use-schedule-history";
import { SelectionBar } from "./selection-bar";

/**
 * E5a: the button Byt plats in the selection's bar. It is for exactly two lessons, it opens the dialog of the swap with the two lessons in the
 * order they were marked, and when the swap has been made the bar lets the selection go and the page's undo history is cleared, because the
 * lessons moved under it.
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

const dialog = vi.hoisted(() => ({ props: null as null | Record<string, unknown> }));
vi.mock("./swap-dialog", () => ({
  SwapPairDialog: (props: Record<string, unknown>) => {
    dialog.props = props;
    return <div data-testid="pair-dialog" data-open={String(props["open"])} />;
  },
}));

const lesson = (id: string, overrides: Partial<MasterLesson> = {}): MasterLesson => ({
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
  ...overrides,
});

function draw(selected: MasterLesson[], guard?: <T>(run: () => Promise<T>) => Promise<T>) {
  const clear = vi.fn();
  const onClear = vi.fn();
  render(
    <SelectionBar
      shown
      selectedLessons={() => selected}
      updateLesson={{ mutateAsync: vi.fn() } as never}
      deleteLesson={{ mutateAsync: vi.fn() } as never}
      createLesson={{ mutateAsync: vi.fn() } as never}
      history={{ push: vi.fn(), clear } as unknown as ScheduleHistory}
      showError={vi.fn()}
      guard={guard}
      onClear={onClear}
      deleteIcon={null}
    />,
  );
  return { clear, onClear };
}

describe("Byt plats in the selection's bar", () => {
  it("is for exactly two lessons: with one or three it is off and says why, with two it is on", () => {
    for (const selected of [[lesson("a")], [lesson("a"), lesson("b"), lesson("c")]]) {
      const { unmount } = render(<div />);
      unmount();
      const view = render(
        <SelectionBar shown selectedLessons={() => selected} updateLesson={{} as never} deleteLesson={{} as never} createLesson={{} as never} history={{} as never} showError={vi.fn()} onClear={vi.fn()} deleteIcon={null} />,
      );
      const button = screen.getByRole("button", { name: "Byt plats" });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute("title", "Markera exakt två lektioner för att byta plats på dem.");
      view.unmount();
    }
    draw([lesson("a"), lesson("b")]);
    expect(screen.getByRole("button", { name: "Byt plats" })).toBeEnabled();
  });

  it("fetches nothing until it is pressed, then opens the dialog with the two lessons in the order they were marked, and the page's question around an apply", async () => {
    const guard = (async (run: () => Promise<unknown>) => run()) as never;
    draw([lesson("a", { dayOfWeek: 1, startTime: "08:00:00" }), lesson("b", { dayOfWeek: 2, startTime: "10:00:00" })], guard);
    expect(screen.queryByTestId("pair-dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Byt plats" }));
    expect(await screen.findByTestId("pair-dialog")).toHaveAttribute("data-open", "true");
    expect(dialog.props).toMatchObject({
      lessons: [
        { id: "a", dayOfWeek: 1, startTime: "08:00:00" },
        { id: "b", dayOfWeek: 2, startTime: "10:00:00" },
      ],
      guard,
    });
  });

  it("clears the page's undo history and lets the selection go when a swap has been made, as it does after Ångra", async () => {
    const { clear, onClear } = draw([lesson("a"), lesson("b")]);
    fireEvent.click(screen.getByRole("button", { name: "Byt plats" }));
    await screen.findByTestId("pair-dialog");
    (dialog.props!["onApplied"] as () => void)();
    expect(clear).toHaveBeenCalledTimes(1);
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("closes when the dialog says so, and shows closed while the selection is no longer two", async () => {
    draw([lesson("a"), lesson("b")]);
    fireEvent.click(screen.getByRole("button", { name: "Byt plats" }));
    await screen.findByTestId("pair-dialog");
    (dialog.props!["onOpenChange"] as (open: boolean) => void)(false);
    await vi.waitFor(() => expect(screen.getByTestId("pair-dialog")).toHaveAttribute("data-open", "false"));
  });
});
