import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import type { MasterLesson } from "@/lib/types";
import { SuggestPlacementsDialog } from "./placement-dialogs";

/**
 * The lists of Byt and Gör plats are fetched when one of them is first asked for, and the fetch can fail (a tab left open over a deploy: the chunk is
 * gone). The page retries every piece it fetches after a failure, by a new wrapper (timetable-lazy.ts), because a lazy() keeps a rejected fetch for
 * good. This one must be as good: the failure is said, the dialog goes back to the free times it was, and the next press fetches again.
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

const chunk = vi.hoisted(() => ({ fail: true }));
vi.mock("./swap-dialog", async () => {
  if (chunk.fail) throw new Error("Failed to load chunk swap-dialog");
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

describe("Gör plats when its code does not arrive", () => {
  it("says so, goes back to the free times, and fetches again at the next press", async () => {
    const user = userEvent.setup();
    render(<SuggestPlacementsDialog open options={[{ dayOfWeek: 3, startMinutes: 540, endMinutes: 600 }] as never} onPick={vi.fn()} onClose={vi.fn()} refused={{ lesson, drop: { dayOfWeek: 2, startMinutes: 600 } }} />);
    await user.click(screen.getByRole("button", { name: "Gör plats" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    // The dialog is what it was: the free times, and the two offers to press again.
    expect(await screen.findByRole("button", { name: "Gör plats" })).toBeInTheDocument();
    expect(screen.queryByTestId("proposals")).not.toBeInTheDocument();

    chunk.fail = false;
    await user.click(screen.getByRole("button", { name: "Gör plats" }));
    expect(await screen.findByTestId("proposals")).toBeInTheDocument();
    expect(toast.error).toHaveBeenCalledTimes(1);
  });
});
