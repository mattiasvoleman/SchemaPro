import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NextIntlClientProvider } from "next-intl";
import type { BoardTray } from "@/lib/board-tray";
import type { FillProposal } from "@/lib/board-fill";
import { fillPreview } from "@/lib/fill-store";
import { FillHead } from "./fill-head";
import sv from "@/messages/sv.json";

/*
 * A proposal belongs to the year it was asked for (E7a, granskaren g519). The dialog is not modal, so the page's year picker still works while a proposal is
 * on the board; the board then shows the other year's lessons, and a proposal of the first year drawn over them, with a Ta in that writes to the first year,
 * is a picture of something that is not there.
 */

const propose = vi.hoisted(() => vi.fn());
const apply = vi.hoisted(() => vi.fn());
const fetchTray = vi.hoisted(() => vi.fn());
vi.mock("@/lib/board-fill", async (original) => ({ ...(await original<typeof import("@/lib/board-fill")>()), proposeFill: propose, applyFill: apply }));
vi.mock("@/lib/board-tray", async (original) => ({ ...(await original<typeof import("@/lib/board-tray")>()), fetchTray }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const trayOf = (yearId: string): BoardTray => ({ academicYearId: yearId, bricks: [], tally: { lessons: 40, laid: 37, placedByRow: 0, left: 3 }, groups: [{ studentGroupId: "g1", left: 3 }] });
const groups = new Map([["g1", { name: "7A", gradeLevel: 7 }]]);
const subjects = new Map([["s1", { name: "Matematik" }]]);
const PROPOSAL: FillProposal = {
  academicYearId: "y1",
  answeredBy: "FILL",
  basis: "b".repeat(32),
  asked: 3,
  placed: [{ key: "k1", postId: "p1", studentGroupId: "g1", subjectId: "s1", teacherId: "t1", minutes: 60, lessonId: null, dayOfWeek: 2, startMinutes: 540, endMinutes: 600, roomId: "r1", noRoom: false }],
  left: [],
  moved: [],
  truncated: false,
};

let client: QueryClient;
const head = (yearId: string) => (
  <QueryClientProvider client={client}>
    <NextIntlClientProvider locale="sv" messages={sv}>
      <FillHead yearId={yearId} revision={1} groupById={groups} subjectById={subjects} writable />
    </NextIntlClientProvider>
  </QueryClientProvider>
);

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  propose.mockReset().mockResolvedValue(PROPOSAL);
  apply.mockReset();
  fetchTray.mockReset().mockImplementation(async (yearId: string) => trayOf(yearId));
  fillPreview.set(null);
});
afterEach(() => {
  cleanup();
  fillPreview.set(null);
});

describe("Lägg det som går when the board is switched to another year", () => {
  it("drops the proposal and its boxes, keeps the dialog open for the new year, and writes nothing", async () => {
    const view = render(head("y1"));
    fireEvent.click(screen.getByRole("button", { name: "Lägg det som går" }));
    await screen.findByRole("option", { name: "7A (3 kvar)" });
    fireEvent.click(screen.getByRole("button", { name: /^Föreslå$/ }));
    await screen.findByText(/Lade 1 av 3/);
    expect(fillPreview.get()?.proposal.academicYearId).toBe("y1");

    view.rerender(head("y2"));

    await waitFor(() => expect(fillPreview.get()).toBeNull());
    expect(screen.queryByText(/Lade 1 av 3/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Ta in i schemat" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Lägg det som går" })).toBeTruthy();
    await waitFor(() => expect(fetchTray).toHaveBeenCalledWith("y2"));
    expect(apply).not.toHaveBeenCalled();
  });
});
