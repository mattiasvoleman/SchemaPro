import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NextIntlClientProvider } from "next-intl";
import { ApiError } from "@/lib/api";
import type { BoardTray, TrayBrick } from "@/lib/board-tray";
import { DIRECT_REACH_UNANSWERED, DirectReachDeclined, type DirectReach } from "@/lib/direct-reach";
import { useDirectReachAsk } from "@/lib/use-direct-reach-ask";
import { TrayPanel } from "./tray";
import sv from "@/messages/sv.json";

/*
 * ATT LÄGGA in Direkt (E4, beslut 9; P5, beslut 8): the lay of a lesson from the parking reaches published lessons, so the school is asked before the
 * first one, with the page's own question (useDirectReachAsk), and the lay is made only after the answer. The wiring is the page's: `guard={directReach.ask}`.
 */
const get = vi.hoisted(() => vi.fn());
const post = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/api", async (original) => ({ ...(await original<typeof import("@/lib/api")>()), api: { get, post } }));
vi.mock("sonner", () => ({ toast }));

const parked: TrayBrick = {
  postId: "p2", nth: 1, partKey: "aaaaaaaaaaaaaaaa", lessonId: "l9", studentGroupId: "g2", subjectId: "s2", teacherId: "t2", coTeacherId: null,
  minutes: 45, recurrence: "ALL_WEEKS", startDate: null, endDate: null, blockId: null, cannotPlace: null, possibleTimes: null,
};
const TRAY: BoardTray = { academicYearId: "y1", bricks: [parked], tally: { lessons: 4, laid: 3, placedByRow: 0, left: 1 }, groups: [{ studentGroupId: "g2", left: 1 }] };
const ASKED: DirectReach = { academicYearId: "y1", mode: "DIRECT", period: { from: "2026-08-17", to: "2027-06-11" }, acknowledgedAt: null, ask: true, audience: { pupils: 412, guardians: 689 } };
const ANSWERED: DirectReach = { ...ASKED, ask: false, audience: null, acknowledgedAt: "2026-08-18T10:00:00.000Z" };

function Page() {
  const reach = useDirectReachAsk();
  return (
    <>
      <TrayPanel
        yearId="y1"
        revision={1}
        groupById={new Map([["g2", { name: "7B" }]])}
        subjectById={new Map([["s2", { name: "Svenska" }]])}
        teacherById={new Map([["t2", { firstName: "Bo", lastName: "Lind" }]])}
        writable
        guard={reach.ask}
        declined={(error) => error instanceof DirectReachDeclined}
        onClose={vi.fn()}
      />
      {reach.question}
    </>
  );
}

function gateway(states: DirectReach[], lay: () => unknown) {
  let read = 0;
  get.mockImplementation(async (path: string) => {
    if (path.startsWith("/api/v1/board-tray")) return TRAY;
    if (path === "/api/v1/publication-settings/direct-reach") return states[Math.min(read++, states.length - 1)];
    throw new Error(`no route ${path}`);
  });
  post.mockImplementation(async (path: string) => {
    if (path === "/api/v1/master-lessons/possible-times") return { options: [], days: [] };
    if (path === "/api/v1/master-lessons/room-choices") return { rooms: [] };
    if (path === "/api/v1/board-tray/lay") return lay();
    if (path === "/api/v1/publication-settings/direct-reach/acknowledge") return ANSWERED;
    throw new Error(`no route ${path}`);
  });
}
const laid = () => ({ lesson: { id: "l9", dayOfWeek: 1, startTime: "13:00", endTime: "13:45", roomId: null }, noRoom: true });

async function press() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <NextIntlClientProvider locale="sv" messages={sv as never} timeZone="Europe/Stockholm">
        <Page />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
  await screen.findByRole("list");
  fireEvent.click(screen.getByRole("button", { name: "Lägg Svenska 7B" }));
  fireEvent.change(screen.getByRole("textbox", { name: /Start/ }), { target: { value: "13:00" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Lägg" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Lägg" }));
}
const lays = () => post.mock.calls.filter((call) => call[0] === "/api/v1/board-tray/lay").length;

beforeAll(async () => {
  await import("@/components/publication/direct-reach-dialog");
}, 60_000);
beforeEach(() => {
  get.mockReset();
  post.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
});
afterEach(cleanup);

describe("Att lägga in Direkt", () => {
  it("asks the school before the lay, and lays only after Fortsätt i Direkt", async () => {
    gateway([ASKED], laid);
    await press();
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(/412 elever/);
    expect(lays()).toBe(0);
    await userEvent.setup().click(screen.getByRole("button", { name: "Fortsätt i Direkt" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    expect(lays()).toBe(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("lays nothing and says no failure when the school answers Avbryt", async () => {
    gateway([ASKED], laid);
    await press();
    await screen.findByRole("dialog");
    await userEvent.setup().click(screen.getByRole("button", { name: "Avbryt" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(lays()).toBe(0);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(toast.error).not.toHaveBeenCalled();
    expect(screen.getByRole("form", { name: "Lägg Svenska 7B" })).toBeInTheDocument();
  });

  it("asks when the page's state was stale and the gateway refuses the lay: the question, then the lay again", async () => {
    let tries = 0;
    gateway([ANSWERED, ASKED], () => {
      tries += 1;
      if (tries === 1) throw new ApiError(409, "x", DIRECT_REACH_UNANSWERED, { validFrom: "2026-08-17", validTo: "2027-06-11" });
      return laid();
    });
    await press();
    await screen.findByRole("dialog");
    await userEvent.setup().click(screen.getByRole("button", { name: "Fortsätt i Direkt" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    expect(lays()).toBe(2);
  });
});
