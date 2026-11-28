import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NextIntlClientProvider } from "next-intl";
import { ApiError } from "@/lib/api";
import { NETWORK_FAILURE } from "@/lib/api-error-text";
import type { BoardTray } from "@/lib/board-tray";
import type { FillProposal } from "@/lib/board-fill";
import { fillPreview } from "@/lib/fill-store";
import { FillDialog } from "./fill-dialog";
import sv from "@/messages/sv.json";
import en from "@/messages/en.json";

/*
 * Ta in that gets no answer (E7a, granskaren g519). A request that dies on the way (the connection, or the edge's 502 or 504 over a transaction that
 * runs on) may have been written all the same. The dialog said "try again" and kept the proposal, and the try came back 409 "the schedule has changed.
 * Nothing was written": the schedule had changed because the first try had landed. It says it does not know, reads the board again and lets go of
 * the proposal, so that what it says next is about what stands.
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
  placed: [{ key: "k1", postId: "p1", studentGroupId: "g1", subjectId: "s1", teacherId: "t1", minutes: 60, lessonId: null, dayOfWeek: 2, startMinutes: 540, endMinutes: 600, roomId: "r1", noRoom: false }],
  left: [],
  moved: [],
  truncated: false,
};

let client: QueryClient;
const view = (locale: "sv" | "en" = "sv") =>
  render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale={locale} messages={locale === "sv" ? sv : en}>
        <FillDialog open onClose={() => undefined} yearId="y1" revision={1} groupById={groups} subjectById={subjects} />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );

async function takeIn(locale: "sv" | "en" = "sv") {
  view(locale);
  await screen.findByRole("option", { name: locale === "sv" ? "7A (3 kvar)" : "7A (3 left)" });
  fireEvent.click(screen.getByRole("button", { name: locale === "sv" ? /^Föreslå$/ : /^Propose$/ }));
  await screen.findByText(/Lade 1 av 3|Laid 1 of 3/);
  fireEvent.click(screen.getByRole("button", { name: locale === "sv" ? "Ta in i schemat" : "Take into the schedule" }));
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  propose.mockReset().mockResolvedValue(PROPOSAL);
  apply.mockReset();
  fetchTray.mockReset().mockResolvedValue(TRAY);
  fillPreview.set(null);
});
afterEach(() => {
  cleanup();
  fillPreview.set(null);
});

describe("Ta in that gets no answer", () => {
  for (const [name, failure] of [
    ["the connection", () => new ApiError(0, "Failed to fetch", NETWORK_FAILURE)],
    ["the edge's 502", () => new ApiError(502, "HTTP 502")],
    ["the edge's 504", () => new ApiError(504, "HTTP 504")],
  ] as const) {
    it(`says it does not know, reads the board again and lets go of the proposal (${name})`, async () => {
      apply.mockRejectedValue(failure());
      const invalidate = vi.spyOn(client, "invalidateQueries");
      await takeIn();
      expect(await screen.findByText(/inte säkert att förslaget togs in/)).toBeTruthy();
      const keys = invalidate.mock.calls.map((call) => JSON.stringify((call[0] as { queryKey: unknown }).queryKey));
      expect(keys).toEqual(expect.arrayContaining(['["masterLessons"]', '["boardTray"]']));
      expect(fillPreview.get()).toBeNull();
      expect(screen.queryByRole("button", { name: "Ta in i schemat" })).toBeNull();
      expect(screen.getByRole("button", { name: /^Föreslå$/ })).toBeTruthy();
    });
  }

  it("says it in English too", async () => {
    apply.mockRejectedValue(new ApiError(0, "Failed to fetch", NETWORK_FAILURE));
    await takeIn("en");
    expect(await screen.findByText(/not certain that the proposal was taken in/)).toBeTruthy();
  });

  it("reads the board again after a stale proposal too: the next proposal is drawn over what stands, not over what the board last showed", async () => {
    apply.mockRejectedValue(new ApiError(409, "stale", "BOARD_FILL_STALE"));
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await takeIn();
    expect(await screen.findByText(/Schemat har ändrats sedan förslaget gjordes/)).toBeTruthy();
    const keys = invalidate.mock.calls.map((call) => JSON.stringify((call[0] as { queryKey: unknown }).queryKey));
    expect(keys).toEqual(expect.arrayContaining(['["masterLessons"]', '["boardTray"]']));
  });

  it("still keeps the proposal for a refusal that says nothing was written (the year is being rewritten by another run)", async () => {
    apply.mockRejectedValue(new ApiError(409, "Grundschemat skrivs om av en annan körning just nu.", "SCHEDULE_BUSY"));
    await takeIn();
    expect(await screen.findByText("Grundschemat skrivs om av en annan körning just nu.")).toBeTruthy();
    expect(fillPreview.get()).not.toBeNull();
    expect(screen.getByRole("button", { name: "Ta in i schemat" })).toBeTruthy();
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
  });
});
