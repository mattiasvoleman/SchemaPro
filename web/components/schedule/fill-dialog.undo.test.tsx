import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NextIntlClientProvider } from "next-intl";
import { toast } from "sonner";
import { ApiError } from "@/lib/api";
import type { BoardTray } from "@/lib/board-tray";
import type { FillProposal } from "@/lib/board-fill";
import { fillPreview } from "@/lib/fill-store";
import { FillDialog } from "./fill-dialog";
import sv from "@/messages/sv.json";

/*
 * ÅNGRA EFTER TA IN (E7a, granskaren g519 L-9). A Ta in saves a version before it writes, and the toast that says it was taken in offers the way back: that
 * version, restored. The restore is the whole grundschema as the version had it, so the toast says so; it is up for a few seconds only, and it runs from a
 * toast, after the dialog has closed. The version is named for what was asked ("Före påfyllning: 7A"), so that Versioner says what it was a version before.
 */

const propose = vi.hoisted(() => vi.fn());
const apply = vi.hoisted(() => vi.fn());
const undo = vi.hoisted(() => vi.fn());
const fetchTray = vi.hoisted(() => vi.fn());
vi.mock("@/lib/board-fill", async (original) => ({ ...(await original<typeof import("@/lib/board-fill")>()), proposeFill: propose, applyFill: apply, undoFill: undo }));
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
const APPLIED = { academicYearId: "y1", versionId: "v-before", laid: [{ key: "k1", lessonId: "l1", created: false, noRoom: false }] };

async function takeIn(scope?: RegExp, onApplied: () => void = () => undefined) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale="sv" messages={sv}>
        <FillDialog open onClose={() => undefined} yearId="y1" revision={1} groupById={groups} subjectById={subjects} onApplied={onApplied} />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
  await screen.findByRole("option", { name: "7A (3 kvar)" });
  if (scope) fireEvent.click(screen.getByRole("radio", { name: scope }));
  fireEvent.click(screen.getByRole("button", { name: /^Föreslå$/ }));
  await screen.findByText(/Lade 1 av 3/);
  fireEvent.click(screen.getByRole("button", { name: "Ta in i schemat" }));
  await waitFor(() => expect(toast.success).toHaveBeenCalled());
  return client;
}

/** The toast's own button, as sonner would call it. */
const toastAction = () => {
  const options = (toast.success as unknown as { mock: { calls: Array<[string, { action: { label: string; onClick: () => void }; duration: number; description: string }]> } }).mock.calls[0]![1];
  return options;
};

beforeEach(() => {
  propose.mockReset().mockResolvedValue(PROPOSAL);
  apply.mockReset().mockResolvedValue(APPLIED);
  undo.mockReset();
  fetchTray.mockReset().mockResolvedValue(TRAY);
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
  fillPreview.set(null);
});
afterEach(() => {
  cleanup();
  fillPreview.set(null);
});

describe("the version saved before Ta in", () => {
  it("is named for what was asked: the class, the year or the school", async () => {
    await takeIn();
    expect(apply).toHaveBeenLastCalledWith(PROPOSAL, "Före påfyllning: 7A");
    cleanup();
    apply.mockClear();
    vi.mocked(toast.success).mockClear();
    await takeIn(/^En årskurs$/);
    expect(apply).toHaveBeenLastCalledWith(PROPOSAL, "Före påfyllning: årskurs 7");
    cleanup();
    apply.mockClear();
    vi.mocked(toast.success).mockClear();
    await takeIn(/^Hela skolan/);
    expect(apply).toHaveBeenLastCalledWith(PROPOSAL, "Före påfyllning: hela skolan");
  });
});

describe("the toast of a Ta in", () => {
  it("offers Ångra for a few seconds, and says what it does: the whole schedule as it was before the fill", async () => {
    await takeIn();
    const options = toastAction();
    expect(options.action.label).toBe("Ångra");
    expect(options.duration).toBe(15_000);
    expect(options.description).toMatch(/hela schemat/);
  });

  it("restores the version saved before, reads the board again, lets the page drop its undo steps, and says the schedule is as it was", async () => {
    undo.mockResolvedValue({ restoredLessons: 120, safetyVersionId: "v-safety" });
    const onApplied = vi.fn();
    const client = await takeIn(undefined, onApplied);
    const invalidate = vi.spyOn(client, "invalidateQueries");
    onApplied.mockClear();
    toastAction().action.onClick();
    await waitFor(() => expect(undo).toHaveBeenCalledWith("v-before"));
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(2));
    expect(vi.mocked(toast.success).mock.calls[1]![0]).toMatch(/Återställde 120 lektioner\. Schemat är som före påfyllningen/);
    expect(onApplied).toHaveBeenCalledTimes(1);
    const keys = invalidate.mock.calls.map((call) => JSON.stringify((call[0] as { queryKey: unknown }).queryKey));
    expect(keys).toEqual(expect.arrayContaining(['["boardTray"]', '["masterLessons"]', '["calendarLessons"]', '["teacherLessons"]', '["scheduleVersions"]']));
  });

  it("still works when the dialog is gone: the toast outlives it", async () => {
    undo.mockResolvedValue({ restoredLessons: 1, safetyVersionId: "v-safety" });
    await takeIn();
    cleanup();
    toastAction().action.onClick();
    await waitFor(() => expect(undo).toHaveBeenCalledWith("v-before"));
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(2));
  });

  it("says that another run is rewriting the year when the restore is answered 409 SCHEDULE_BUSY, and leaves the page as it was", async () => {
    undo.mockRejectedValue(new ApiError(409, "busy", "SCHEDULE_BUSY"));
    const onApplied = vi.fn();
    await takeIn(undefined, onApplied);
    onApplied.mockClear();
    toastAction().action.onClick();
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect(vi.mocked(toast.error).mock.calls[0]![0]).toMatch(/skrivs om av en annan körning/);
    expect(onApplied).not.toHaveBeenCalled();
  });

  it("says what the gateway said for any other refusal, and does not call a restore that did not happen done", async () => {
    undo.mockRejectedValue(new ApiError(404, "Schedule version not found."));
    await takeIn();
    toastAction().action.onClick();
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect(toast.success).toHaveBeenCalledTimes(1);
  });
});
