import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NextIntlClientProvider } from "next-intl";
import { ApiError } from "@/lib/api";
import type { BoardTray } from "@/lib/board-tray";
import type { FillProposal } from "@/lib/board-fill";
import { fillPreview } from "@/lib/fill-store";
import { FillDialog, type FillDialogProps } from "./fill-dialog";
import sv from "@/messages/sv.json";
import en from "@/messages/en.json";

/*
 * LÄGG DET SOM GÅR (E7a), the dialog: what it asks for, what it says of the answer, what it draws on the board, and what it does when the
 * gateway says no. The gateway counts, judges and writes; these tests hold what the page does with its answers, in both languages.
 */

const propose = vi.hoisted(() => vi.fn());
const apply = vi.hoisted(() => vi.fn());
const fetchTray = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/board-fill", async (original) => ({ ...(await original<typeof import("@/lib/board-fill")>()), proposeFill: propose, applyFill: apply }));
vi.mock("@/lib/board-tray", async (original) => ({ ...(await original<typeof import("@/lib/board-tray")>()), fetchTray }));
vi.mock("sonner", () => ({ toast }));

const TRAY: BoardTray = {
  academicYearId: "y1",
  bricks: [],
  tally: { lessons: 40, laid: 35, placedByRow: 0, left: 5 },
  groups: [
    { studentGroupId: "g2", left: 2 },
    { studentGroupId: "g1", left: 3 },
    { studentGroupId: "g3", left: 0 },
  ],
};
const groups = new Map([["g1", { name: "7A", gradeLevel: 7 }], ["g2", { name: "7B", gradeLevel: 7 }], ["g3", { name: "8A", gradeLevel: 8 }]]);
const subjects = new Map([["s1", { name: "Matematik" }], ["s2", { name: "Svenska" }]]);

const brick = (key: string, over: Record<string, unknown> = {}) => ({ key, postId: "p1", studentGroupId: "g1", subjectId: "s1", teacherId: "t1", minutes: 60, lessonId: null, ...over });
const PROPOSAL: FillProposal = {
  academicYearId: "y1",
  answeredBy: "FILL",
  basis: "b".repeat(32),
  asked: 3,
  placed: [
    { ...brick("k1"), dayOfWeek: 2, startMinutes: 540, endMinutes: 600, roomId: "r1", noRoom: false },
    { ...brick("k2", { subjectId: "s2", studentGroupId: "g2" }), dayOfWeek: 3, startMinutes: 600, endMinutes: 660, roomId: null, noRoom: true },
  ],
  left: [{ ...brick("k3"), reason: "NO_FREE_START" }],
  moved: [],
  truncated: false,
};

let client: QueryClient;
const onClose = vi.fn();

function view(over: Partial<FillDialogProps> = {}, locale: "sv" | "en" = "sv") {
  return render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale={locale} messages={locale === "sv" ? sv : en}>
        <FillDialog open onClose={onClose} yearId="y1" revision={1} groupById={groups} subjectById={subjects} {...over} />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

const pressed = (name: RegExp) => fireEvent.click(screen.getByRole("button", { name }));

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  propose.mockReset().mockResolvedValue(PROPOSAL);
  apply.mockReset().mockResolvedValue({ academicYearId: "y1", versionId: "v1", laid: [{ key: "k1", lessonId: "l1", created: true, noRoom: false }, { key: "k2", lessonId: "l2", created: true, noRoom: true }] });
  fetchTray.mockReset().mockResolvedValue(TRAY);
  toast.success.mockReset();
  toast.error.mockReset();
  onClose.mockReset();
  fillPreview.set(null);
});

afterEach(() => {
  cleanup();
  fillPreview.set(null);
});

describe("what it asks for", () => {
  it("offers the classes that have a brick left with their counts, and the school, and draws no overlay: the board stays in view", async () => {
    view();
    expect(await screen.findByRole("option", { name: "7A (3 kvar)" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "7B (2 kvar)" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /8A/ })).toBeNull();
    expect(screen.getByRole("radio", { name: "Hela skolan (5 kvar)" })).toBeTruthy();
    expect(document.querySelector(".bg-black\\/60")).toBeNull();
    expect(document.querySelector("[data-fill-dialog]")).not.toBeNull();
  });

  it("asks for the class it shows, the year it is set to, and the school", async () => {
    view();
    await screen.findByRole("option", { name: "7A (3 kvar)" });
    pressed(/^Föreslå$/);
    await waitFor(() => expect(propose).toHaveBeenCalledTimes(1));
    expect(propose.mock.calls[0]![0]).toEqual({ academicYearId: "y1", scope: "CLASS", studentGroupId: "g1" });

    fireEvent.click(screen.getByRole("radio", { name: "En årskurs" }));
    expect(await screen.findByRole("option", { name: "Årskurs 7 (5 kvar)" })).toBeTruthy();
    pressed(/^Föreslå igen$/);
    await waitFor(() => expect(propose).toHaveBeenCalledTimes(2));
    expect(propose.mock.calls[1]![0]).toEqual({ academicYearId: "y1", scope: "GRADE", gradeLevel: 7 });

    fireEvent.click(screen.getByRole("radio", { name: "Hela skolan (5 kvar)" }));
    pressed(/^Föreslå igen$/);
    await waitFor(() => expect(propose).toHaveBeenCalledTimes(3));
    expect(propose.mock.calls[2]![0]).toEqual({ academicYearId: "y1", scope: "SCHOOL" });
  });

  it("says there is nothing to lay when the tray is empty, and offers no proposal", async () => {
    fetchTray.mockResolvedValue({ ...TRAY, bricks: [], tally: { ...TRAY.tally, left: 0 }, groups: [] });
    view();
    expect(await screen.findByText("Det finns inget kvar i Att lägga.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Föreslå/ })).toBeNull();
  });
});

describe("what it says of the answer", () => {
  it("says how many fitted and that nothing else was moved, and why the others were not laid, and who answered", async () => {
    view();
    await screen.findByRole("option", { name: "7A (3 kvar)" });
    pressed(/^Föreslå$/);
    expect(await screen.findByText("Lade 2 av 3. Ingenting annat flyttades.")).toBeTruthy();
    expect(screen.getByText("1 fick ingen ledig tid med det som ligger.")).toBeTruthy();
    expect(screen.getByText(/Påfyllningen svarade, och den bevisar ingenting/)).toBeTruthy();
    expect(screen.getByText("Förslaget är ritat med streckade rutor på brädet.")).toBeTruthy();
  });

  it("lists the lessons laid, in words, with \"utan sal\" for the one with no room", async () => {
    view();
    await screen.findByRole("option", { name: "7A (3 kvar)" });
    pressed(/^Föreslå$/);
    const summary = await screen.findByText("Visa de 2 lagda");
    fireEvent.click(summary);
    expect(screen.getByText("Matematik 7A: Tisdag 09:00–10:00")).toBeTruthy();
    expect(screen.getByText("Svenska 7B: Onsdag 10:00–11:00, utan sal")).toBeTruthy();
  });

  it("never says that something cannot be laid: a brick left over is not laid by this, and only the engine proves otherwise, in either language", async () => {
    for (const locale of ["sv", "en"] as const) {
      propose.mockResolvedValue({ ...PROPOSAL, left: [...PROPOSAL.left, { ...brick("k4"), reason: "JUDGE" }, { ...brick("k5"), reason: "TIME" }, { ...brick("k6"), reason: "BLOCK" }, { ...brick("k7"), reason: "NO_TEACHER" }] });
      const { container } = view({}, locale);
      await screen.findByRole("option", { name: locale === "sv" ? "7A (3 kvar)" : "7A (3 left)" });
      fireEvent.click(screen.getByRole("button", { name: locale === "sv" ? /^Föreslå$/ : /^Propose$/ }));
      await waitFor(() => expect(container.ownerDocument.body.textContent).toMatch(/Lade 2 av 3|Laid 2 of 3/));
      expect(container.ownerDocument.body.textContent).not.toMatch(/går inte|cannot be laid|impossible|omöjlig/i);
      cleanup();
      propose.mockReset();
    }
  });

  it("says when none of the bricks got a time, and when the time ran out before every brick was tried", async () => {
    propose.mockResolvedValue({ ...PROPOSAL, asked: 2, placed: [], left: [{ ...brick("k1"), reason: "TIME" }, { ...brick("k2"), reason: "TIME" }], truncated: true });
    view();
    await screen.findByRole("option", { name: "7A (3 kvar)" });
    pressed(/^Föreslå$/);
    expect(await screen.findByText("Ingen av de 2 brickorna fick en tid. Ingenting flyttades.")).toBeTruthy();
    expect(screen.getByText("2 hann inte prövas: tiden tog slut. Föreslå igen för resten.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Ta in i schemat" })).toBeNull();
  });
});

describe("what it draws", () => {
  it("puts the proposal on the board with each brick's name, and takes it away when it is discarded, and when the dialog is closed", async () => {
    const { unmount } = view();
    await screen.findByRole("option", { name: "7A (3 kvar)" });
    pressed(/^Föreslå$/);
    await screen.findByText("Lade 2 av 3. Ingenting annat flyttades.");
    expect(fillPreview.get()?.proposal.basis).toBe("b".repeat(32));
    expect(fillPreview.get()?.labels.get("k2")).toBe("Svenska 7B");
    pressed(/^Kasta$/);
    expect(fillPreview.get()).toBeNull();
    expect(screen.queryByText(/Lade 2 av 3/)).toBeNull();
    pressed(/^Föreslå$/);
    await screen.findByText("Lade 2 av 3. Ingenting annat flyttades.");
    expect(fillPreview.get()).not.toBeNull();
    unmount();
    expect(fillPreview.get()).toBeNull();
  });

  it("closes without writing anything and leaves the board as it was", async () => {
    view();
    await screen.findByRole("option", { name: "7A (3 kvar)" });
    pressed(/^Föreslå$/);
    await screen.findByText(/Lade 2 av 3/);
    pressed(/^Stäng$/);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(apply).not.toHaveBeenCalled();
    expect(fillPreview.get()).toBeNull();
  });
});

describe("Ta in", () => {
  it("writes the proposal as it was read, says how many lessons and that a version was saved, reads the board again, and closes", async () => {
    view();
    await screen.findByRole("option", { name: "7A (3 kvar)" });
    pressed(/^Föreslå$/);
    await screen.findByText(/Lade 2 av 3/);
    pressed(/^Ta in i schemat$/);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(apply).toHaveBeenCalledWith(PROPOSAL, "Före påfyllning: 7A");
    expect(toast.success).toHaveBeenCalledWith("Lade 2 lektioner. En version sparades före: se Versioner.", expect.objectContaining({ action: expect.objectContaining({ label: "Ångra" }) }));
    expect(fillPreview.get()).toBeNull();
  });

  it("asks the school's question first in Direkt, around the write, and says nothing when the reader answers no", async () => {
    const guard = vi.fn(async (run: () => Promise<unknown>) => run());
    view({ guard: guard as FillDialogProps["guard"] });
    await screen.findByRole("option", { name: "7A (3 kvar)" });
    pressed(/^Föreslå$/);
    await screen.findByText(/Lade 2 av 3/);
    pressed(/^Ta in i schemat$/);
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    expect(guard).toHaveBeenCalledTimes(1);
    cleanup();

    class Declined extends Error {}
    const refusing = vi.fn(async () => {
      throw new Declined();
    });
    apply.mockClear();
    onClose.mockClear();
    view({ guard: refusing as unknown as FillDialogProps["guard"], declined: (error) => error instanceof Declined });
    await screen.findByRole("option", { name: "7A (3 kvar)" });
    pressed(/^Föreslå$/);
    await screen.findByText(/Lade 2 av 3/);
    pressed(/^Ta in i schemat$/);
    await waitFor(() => expect(refusing).toHaveBeenCalledTimes(1));
    expect(apply).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText(/Lade 2 av 3/)).toBeTruthy();
    expect(fillPreview.get()).not.toBeNull();
  });

  it("says a changed schedule is a changed schedule: nothing was written, the proposal goes, and the reader can ask again", async () => {
    apply.mockRejectedValue(new ApiError(409, "stale", "BOARD_FILL_STALE"));
    view();
    await screen.findByRole("option", { name: "7A (3 kvar)" });
    pressed(/^Föreslå$/);
    await screen.findByText(/Lade 2 av 3/);
    pressed(/^Ta in i schemat$/);
    expect(await screen.findByText("Schemat har ändrats sedan förslaget gjordes. Ingenting skrevs. Föreslå igen.")).toBeTruthy();
    expect(fillPreview.get()).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Ta in i schemat" })).toBeNull();
    expect(screen.getByRole("button", { name: /^Föreslå$/ })).toBeTruthy();
  });

  it("says a time the judge no longer lets through is that, and keeps nothing", async () => {
    apply.mockRejectedValue(new ApiError(409, "refused", "MASTER_LESSON_REFUSED"));
    view();
    await screen.findByRole("option", { name: "7A (3 kvar)" });
    pressed(/^Föreslå$/);
    await screen.findByText(/Lade 2 av 3/);
    pressed(/^Ta in i schemat$/);
    expect(await screen.findByText("En tid som förslaget lade släpptes inte igenom nu. Ingenting skrevs. Föreslå igen.")).toBeTruthy();
    expect(fillPreview.get()).toBeNull();
  });

  it("says any other failure in the app's own words and keeps the proposal, so that Ta in can be pressed again", async () => {
    apply.mockRejectedValue(new ApiError(500, "boom"));
    view();
    await screen.findByRole("option", { name: "7A (3 kvar)" });
    pressed(/^Föreslå$/);
    await screen.findByText(/Lade 2 av 3/);
    pressed(/^Ta in i schemat$/);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(fillPreview.get()).not.toBeNull();
    expect(screen.getByRole("button", { name: "Ta in i schemat" })).toBeTruthy();
  });
});

describe("when the proposal cannot be had", () => {
  it("says so when the answer is not the gateway's, and when the request fails, and draws nothing", async () => {
    propose.mockResolvedValueOnce(null);
    view();
    await screen.findByRole("option", { name: "7A (3 kvar)" });
    pressed(/^Föreslå$/);
    expect(await screen.findByText("Förslaget gick inte att få. Försök igen.")).toBeTruthy();
    expect(fillPreview.get()).toBeNull();
    propose.mockRejectedValueOnce(new ApiError(500, "boom"));
    pressed(/^Föreslå$/);
    await waitFor(() => expect(propose).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(within(screen.getByRole("alert")).queryByText(/Lade/)).toBeNull();
  });
});
