import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NextIntlClientProvider } from "next-intl";
import type { BoardTray } from "@/lib/board-tray";
import type { FillProposal } from "@/lib/board-fill";
import { fillPreview } from "@/lib/fill-store";
import { FillDialog } from "./fill-dialog";
import sv from "@/messages/sv.json";
import en from "@/messages/en.json";

/*
 * A reason the page has no sentence for (E7a, granskaren g519). The gateway is allowed to grow (NO_ROOM, the room that ran out and not the time, is decided,
 * and the web is deployed on its own): the dialog counted the reasons it knew and dropped the rest, so "Lade 31 av 36" was followed by a list that
 * accounted for four of the five that were left. Every brick that is left is counted somewhere.
 */

const propose = vi.hoisted(() => vi.fn());
const fetchTray = vi.hoisted(() => vi.fn());
vi.mock("@/lib/board-fill", async (original) => ({ ...(await original<typeof import("@/lib/board-fill")>()), proposeFill: propose }));
vi.mock("@/lib/board-tray", async (original) => ({ ...(await original<typeof import("@/lib/board-tray")>()), fetchTray }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const TRAY: BoardTray = { academicYearId: "y1", bricks: [], tally: { lessons: 40, laid: 37, placedByRow: 0, left: 3 }, groups: [{ studentGroupId: "g1", left: 3 }] };
const groups = new Map([["g1", { name: "7A", gradeLevel: 7 }]]);
const subjects = new Map([["s1", { name: "Matematik" }]]);
const brick = (key: string) => ({ key, postId: "p1", studentGroupId: "g1", subjectId: "s1", teacherId: "t1", minutes: 60, lessonId: null });
const PROPOSAL = {
  academicYearId: "y1",
  answeredBy: "FILL",
  basis: "b".repeat(32),
  asked: 5,
  placed: [{ ...brick("k1"), dayOfWeek: 2, startMinutes: 540, endMinutes: 600, roomId: "r1", noRoom: false }],
  left: [
    { ...brick("k2"), reason: "NO_FREE_START" },
    { ...brick("k3"), reason: "NO_ROOM" },
    { ...brick("k4"), reason: "NO_ROOM" },
    { ...brick("k5"), reason: "SOMETHING_NEWER" },
  ],
  moved: [],
  truncated: false,
} as unknown as FillProposal;

async function proposed(locale: "sv" | "en") {
  propose.mockResolvedValue(PROPOSAL);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale={locale} messages={locale === "sv" ? sv : en}>
        <FillDialog open onClose={() => undefined} yearId="y1" revision={1} groupById={groups} subjectById={subjects} />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
  await screen.findByRole("option", { name: locale === "sv" ? "7A (3 kvar)" : "7A (3 left)" });
  fireEvent.click(screen.getByRole("button", { name: locale === "sv" ? /^Föreslå$/ : /^Propose$/ }));
}

beforeEach(() => {
  propose.mockReset();
  fetchTray.mockReset().mockResolvedValue(TRAY);
  fillPreview.set(null);
});
afterEach(() => {
  cleanup();
  fillPreview.set(null);
});

describe("a brick left for a reason the page has no words for", () => {
  it("is counted, and the reader is told to reload the page for the words (sv)", async () => {
    await proposed("sv");
    expect(await screen.findByText("1 fick ingen ledig tid med det som ligger.")).toBeTruthy();
    expect(screen.getByText("3 blev över av en orsak som sidan inte har ord för än. Ladda om sidan.")).toBeTruthy();
  });

  it("is counted in English too", async () => {
    await proposed("en");
    expect(await screen.findByText("3 were left for a reason this page has no words for yet. Reload the page.")).toBeTruthy();
  });
});
