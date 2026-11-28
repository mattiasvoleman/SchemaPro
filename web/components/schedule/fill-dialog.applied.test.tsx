import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NextIntlClientProvider } from "next-intl";
import { ApiError } from "@/lib/api";
import type { BoardTray } from "@/lib/board-tray";
import type { FillProposal } from "@/lib/board-fill";
import { fillPreview } from "@/lib/fill-store";
import { FillDialog, type FillDialogProps } from "./fill-dialog";
import sv from "@/messages/sv.json";

/*
 * What the page is told when Ta in has written (E7a, granskaren g519). A Ta in writes up to six hundred lessons under the page's stack of undo steps: lessons
 * laid back from the parking are ones a step holds a snapshot of, and Ctrl+Z would put such a lesson back where it stood before the fill, with no word of
 * it. A swap and the room optimisation tell the page for that reason, and the page clears the stack; a fill that is refused tells it nothing.
 */

const propose = vi.hoisted(() => vi.fn());
const apply = vi.hoisted(() => vi.fn());
const fetchTray = vi.hoisted(() => vi.fn());
vi.mock("@/lib/board-fill", async (original) => ({ ...(await original<typeof import("@/lib/board-fill")>()), proposeFill: propose, applyFill: apply }));
vi.mock("@/lib/board-tray", async (original) => ({ ...(await original<typeof import("@/lib/board-tray")>()), fetchTray }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const TRAY: BoardTray = { academicYearId: "y1", bricks: [], tally: { lessons: 40, laid: 37, placedByRow: 0, left: 3 }, groups: [{ studentGroupId: "g1", left: 3 }] };
const groups = new Map([["g1", { name: "7A", gradeLevel: 7 }]]);
const subjects = new Map([["s1", { name: "Matematik" }]]);
const PROPOSAL: FillProposal = {
  academicYearId: "y1",
  answeredBy: "FILL",
  basis: "b".repeat(32),
  asked: 3,
  placed: [{ key: "k1", postId: "p1", studentGroupId: "g1", subjectId: "s1", teacherId: "t1", minutes: 60, lessonId: "l1", dayOfWeek: 2, startMinutes: 540, endMinutes: 600, roomId: "r1", noRoom: false }],
  left: [],
  moved: [],
  truncated: false,
};

async function takeIn(onApplied: () => void) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const props = { onApplied } as Partial<FillDialogProps>;
  render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale="sv" messages={sv}>
        <FillDialog open onClose={() => undefined} yearId="y1" revision={1} groupById={groups} subjectById={subjects} {...props} />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
  await screen.findByRole("option", { name: "7A (3 kvar)" });
  fireEvent.click(screen.getByRole("button", { name: /^Föreslå$/ }));
  await screen.findByText(/Lade 1 av 3/);
  fireEvent.click(screen.getByRole("button", { name: "Ta in i schemat" }));
}

beforeEach(() => {
  propose.mockReset().mockResolvedValue(PROPOSAL);
  apply.mockReset();
  fetchTray.mockReset().mockResolvedValue(TRAY);
  fillPreview.set(null);
});
afterEach(() => {
  cleanup();
  fillPreview.set(null);
});

describe("onApplied", () => {
  it("is called once when Ta in has written, so that the page can let go of the steps it holds", async () => {
    apply.mockResolvedValue({ academicYearId: "y1", versionId: "v1", laid: [{ key: "k1", lessonId: "l1", created: false, noRoom: false }] });
    const onApplied = vi.fn();
    await takeIn(onApplied);
    await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1));
  });

  it("reads the tray, the lessons and the versions again, so that the board shows what was written and Versioner has the version saved before", async () => {
    apply.mockResolvedValue({ academicYearId: "y1", versionId: "v1", laid: [{ key: "k1", lessonId: "l1", created: false, noRoom: false }] });
    const invalidate = vi.spyOn(QueryClient.prototype, "invalidateQueries");
    await takeIn(vi.fn());
    await waitFor(() => expect(invalidate).toHaveBeenCalled());
    const keys = invalidate.mock.calls.map((call) => JSON.stringify((call[0] as { queryKey: unknown }).queryKey));
    expect(keys).toEqual(expect.arrayContaining(['["boardTray"]', '["masterLessons"]', '["calendarLessons"]', '["teacherLessons"]', '["scheduleVersions"]']));
    invalidate.mockRestore();
  });

  it("is not called when Ta in was refused: nothing was written", async () => {
    apply.mockRejectedValue(new ApiError(409, "stale", "BOARD_FILL_STALE"));
    const onApplied = vi.fn();
    await takeIn(onApplied);
    await screen.findByText(/Schemat har ändrats/);
    expect(onApplied).not.toHaveBeenCalled();
  });
});
