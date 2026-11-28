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
 * A proposal the time ran out on (E7a, granskaren g519). The bricks not begun are left with the reason TIME, and the dialog said "propose again for the rest". A
 * proposal that is not taken in is thrown away, so the second one starts from the first brick, on the same schedule, in the same order, and runs out in the
 * same place. What gets to the rest is taking in what was laid and asking again on the schedule that has it.
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
const placed = { ...brick("k1"), dayOfWeek: 2, startMinutes: 540, endMinutes: 600, roomId: "r1", noRoom: false };
const ranOut = (laid: boolean): FillProposal => ({
  academicYearId: "y1",
  answeredBy: "FILL",
  basis: "b".repeat(32),
  asked: laid ? 3 : 2,
  placed: laid ? [placed] : [],
  left: [{ ...brick("k2"), reason: "TIME" }, { ...brick("k3"), reason: "TIME" }],
  moved: [],
  truncated: true,
});

async function proposed(answer: FillProposal, locale: "sv" | "en" = "sv") {
  propose.mockResolvedValue(answer);
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

describe("a proposal the time ran out on", () => {
  it("tells the reader to take in what was laid and ask again, when something was laid", async () => {
    await proposed(ranOut(true));
    expect(await screen.findByText("2 hann inte prövas: tiden tog slut. Ta in det som lades och föreslå igen för resten.")).toBeTruthy();
  });

  it("says it in English too", async () => {
    await proposed(ranOut(true), "en");
    expect(await screen.findByText("2 were not tried: the time ran out. Take in what was laid and propose again for the rest.")).toBeTruthy();
  });

  it("tells the reader to ask again when nothing was laid (there is nothing to take in)", async () => {
    await proposed(ranOut(false));
    expect(await screen.findByText("2 hann inte prövas: tiden tog slut. Föreslå igen för resten.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Ta in i schemat" })).toBeNull();
  });
});
