import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NextIntlClientProvider } from "next-intl";
import { ApiError } from "@/lib/api";
import type { BoardTray } from "@/lib/board-tray";
import { fillPreview } from "@/lib/fill-store";
import { FillDialog } from "./fill-dialog";
import sv from "@/messages/sv.json";

/*
 * The dialog while Att lägga is being read, and when it cannot be (E7a, granskaren g519). What the dialog offers is read from the tray (the classes with
 * a brick left, and how many). Until it arrived, and when it did not, the dialog showed its title and its sentence and nothing else: no word that something
 * was being fetched, none that it had failed, and no way to ask again short of closing it.
 */

const fetchTray = vi.hoisted(() => vi.fn());
vi.mock("@/lib/board-tray", async (original) => ({ ...(await original<typeof import("@/lib/board-tray")>()), fetchTray }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const TRAY: BoardTray = { academicYearId: "y1", bricks: [], tally: { lessons: 40, laid: 37, placedByRow: 0, left: 3 }, groups: [{ studentGroupId: "g1", left: 3 }] };
const groups = new Map([["g1", { name: "7A", gradeLevel: 7 }]]);
const subjects = new Map([["s1", { name: "Matematik" }]]);

const view = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <NextIntlClientProvider locale="sv" messages={sv}>
        <FillDialog open onClose={() => undefined} yearId="y1" revision={1} groupById={groups} subjectById={subjects} />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );

beforeEach(() => {
  fetchTray.mockReset();
  fillPreview.set(null);
});
afterEach(() => {
  cleanup();
  fillPreview.set(null);
});

describe("the dialog and the tray it reads", () => {
  it("says that the bricks are being fetched, until they are", async () => {
    let arrive!: (tray: BoardTray) => void;
    fetchTray.mockImplementation(() => new Promise<BoardTray>((resolve) => (arrive = resolve)));
    view();
    expect(await screen.findByText("Hämtar brickorna …")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Föreslå$/ })).toBeNull();
    arrive(TRAY);
    expect(await screen.findByRole("option", { name: "7A (3 kvar)" })).toBeTruthy();
    expect(screen.queryByText("Hämtar brickorna …")).toBeNull();
  });

  it("says that they could not be fetched, and asks again from a button", async () => {
    fetchTray.mockRejectedValueOnce(new ApiError(500, "boom")).mockResolvedValue(TRAY);
    view();
    expect(await screen.findByText("Det gick inte att hämta brickorna.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Försök igen" }));
    expect(await screen.findByRole("option", { name: "7A (3 kvar)" })).toBeTruthy();
    expect(screen.queryByText("Det gick inte att hämta brickorna.")).toBeNull();
  });

  it("keeps what it offers while the board is read again (the page reads the lessons again on every return to the tab), and does not blink", async () => {
    fetchTray.mockResolvedValue(TRAY);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const dialog = (revision: number) => (
      <QueryClientProvider client={client}>
        <NextIntlClientProvider locale="sv" messages={sv}>
          <FillDialog open onClose={() => undefined} yearId="y1" revision={revision} groupById={groups} subjectById={subjects} />
        </NextIntlClientProvider>
      </QueryClientProvider>
    );
    const view = render(dialog(1));
    expect(await screen.findByRole("option", { name: "7A (3 kvar)" })).toBeTruthy();

    let arrive!: (tray: BoardTray) => void;
    fetchTray.mockImplementation(() => new Promise<BoardTray>((resolve) => (arrive = resolve)));
    view.rerender(dialog(2));

    expect(screen.getByRole("option", { name: "7A (3 kvar)" })).toBeTruthy();
    expect(screen.queryByText("Hämtar brickorna …")).toBeNull();
    arrive(TRAY);
  });
});
