import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { MasterLesson } from "@/lib/types";
import { SuggestPlacementsDialog, type RefusedDrop } from "./placement-dialogs";

/** The dialog of a refused drop starts at the free times every time it opens, whatever it was showing when it was closed. */
vi.mock("next-intl", async () => {
  const { createTranslator } = await import("use-intl");
  const sv = (await import("@/messages/sv.json")).default;
  return {
    useLocale: () => "sv",
    useTranslations: (namespace: string) => createTranslator({ locale: "sv", messages: sv, namespace: namespace as never }),
  };
});
vi.mock("./swap-dialog", async () => {
  const { createElement } = await import("react");
  return { SwapProposals: () => createElement("div", { "data-testid": "proposals" }) };
});

const lesson: MasterLesson = {
  id: "l-a",
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
};
const OPTIONS = [{ dayOfWeek: 3, startMinutes: 540, endMinutes: 600 }] as never;
const dropOf = (): RefusedDrop => ({ lesson, drop: { dayOfWeek: 2, startMinutes: 600 } });

describe("the dialog of a refused drop, opened again", () => {
  it("opens at the free times each time, whatever it was showing when it was closed", async () => {
    const user = userEvent.setup();
    const view = render(<SuggestPlacementsDialog open options={OPTIONS} onPick={vi.fn()} onClose={vi.fn()} refused={dropOf()} />);
    await user.click(screen.getByRole("button", { name: "Gör plats" }));
    await screen.findByTestId("proposals");
    view.rerender(<SuggestPlacementsDialog open={false} options={[]} onPick={vi.fn()} onClose={vi.fn()} refused={null} />);
    view.rerender(<SuggestPlacementsDialog open options={OPTIONS} onPick={vi.fn()} onClose={vi.fn()} refused={dropOf()} />);
    expect(screen.queryByTestId("proposals")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Gör plats" })).toBeInTheDocument();
    expect(screen.getByText(/Onsdag|Ons/)).toBeInTheDocument();
  });

});
