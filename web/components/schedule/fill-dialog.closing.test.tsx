import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NextIntlClientProvider } from "next-intl";
import { ApiError } from "@/lib/api";
import type { BoardTray } from "@/lib/board-tray";
import type { FillProposal } from "@/lib/board-fill";
import { fillPreview } from "@/lib/fill-store";
import { FillDialog } from "./fill-dialog";
import sv from "@/messages/sv.json";

/*
 * Closing the dialog while Ta in is on its way (E7a, granskaren g519). Escape and the X read as "never mind", but a write that is on its way is not taken back
 * by closing the window it was asked from: the lessons are written, and a failure, which the dialog would have said, is said to nobody. While Ta in runs
 * the dialog stays, with its X dimmed (as Kasta is), and closes when the answer is in.
 */

const propose = vi.hoisted(() => vi.fn());
const apply = vi.hoisted(() => vi.fn());
const fetchTray = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/board-fill", async (original) => ({ ...(await original<typeof import("@/lib/board-fill")>()), proposeFill: propose, applyFill: apply }));
vi.mock("@/lib/board-tray", async (original) => ({ ...(await original<typeof import("@/lib/board-tray")>()), fetchTray }));
vi.mock("sonner", () => ({ toast }));

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

const onClose = vi.fn();
async function takingIn() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale="sv" messages={sv}>
        <FillDialog open onClose={onClose} yearId="y1" revision={1} groupById={groups} subjectById={subjects} />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
  await screen.findByRole("option", { name: "7A (3 kvar)" });
  fireEvent.click(screen.getByRole("button", { name: /^Föreslå$/ }));
  await screen.findByText(/Lade 1 av 3/);
  fireEvent.click(screen.getByRole("button", { name: "Ta in i schemat" }));
  await screen.findByRole("button", { name: "Tar in…" });
}

beforeEach(() => {
  propose.mockReset().mockResolvedValue(PROPOSAL);
  apply.mockReset();
  fetchTray.mockReset().mockResolvedValue(TRAY);
  toast.success.mockReset();
  onClose.mockReset();
  fillPreview.set(null);
});
afterEach(() => {
  cleanup();
  fillPreview.set(null);
});

describe("closing while Ta in runs", () => {
  it("is not possible with Escape or the X, and the dialog closes when the answer is in", async () => {
    let answer!: (value: unknown) => void;
    apply.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    await takingIn();

    fireEvent.keyDown(document, { key: "Escape" });
    expect((screen.getByRole("button", { name: "Stäng" }) as HTMLButtonElement).disabled).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Lägg det som går" })).toBeTruthy();
    expect(fillPreview.get()).not.toBeNull();

    answer({ academicYearId: "y1", versionId: "v1", laid: [{ key: "k1", lessonId: "l1", created: true, noRoom: false }] });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it("leaves the dialog there to say it when the write fails after Escape was pressed", async () => {
    let fail!: (error: unknown) => void;
    apply.mockImplementation(() => new Promise((_, reject) => (fail = reject)));
    await takingIn();

    fireEvent.keyDown(document, { key: "Escape" });
    fail(new ApiError(409, "Grundschemat skrivs om av en annan körning just nu.", "SCHEDULE_BUSY"));

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes as before when nothing is on its way", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <NextIntlClientProvider locale="sv" messages={sv}>
          <FillDialog open onClose={onClose} yearId="y1" revision={1} groupById={groups} subjectById={subjects} />
        </NextIntlClientProvider>
      </QueryClientProvider>,
    );
    await screen.findByRole("option", { name: "7A (3 kvar)" });
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(apply).not.toHaveBeenCalled();
  });

  it("does not close for a click on the board: the dialog is not modal, and the proposal is looked at over the board", async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <NextIntlClientProvider locale="sv" messages={sv}>
          <FillDialog open onClose={onClose} yearId="y1" revision={1} groupById={groups} subjectById={subjects} />
        </NextIntlClientProvider>
      </QueryClientProvider>,
    );
    await screen.findByRole("option", { name: "7A (3 kvar)" });
    fireEvent.pointerDown(document.body);
    fireEvent.click(document.body);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Lägg det som går" })).toBeTruthy();
  });
});

describe("closing while the proposal is being asked for", () => {
  const open = () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={client}>
        <NextIntlClientProvider locale="sv" messages={sv}>
          <FillDialog open onClose={onClose} yearId="y1" revision={1} groupById={groups} subjectById={subjects} />
        </NextIntlClientProvider>
      </QueryClientProvider>,
    );
  };

  it("lets go of the request: an answer that comes after the X draws nothing, on the board or in the dialog", async () => {
    let answer!: (value: FillProposal) => void;
    propose.mockImplementation(() => new Promise<FillProposal>((resolve) => (answer = resolve)));
    open();
    await screen.findByRole("option", { name: "7A (3 kvar)" });
    fireEvent.click(screen.getByRole("button", { name: /^Föreslå$/ }));
    await screen.findByRole("button", { name: "Letar tider…" });

    fireEvent.click(screen.getByRole("button", { name: "Stäng" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    answer(PROPOSAL);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(fillPreview.get()).toBeNull();
    expect(screen.queryByText(/Lade 1 av 3/)).toBeNull();
  });

  it("lets go of the request when the dialog is gone: an answer that comes after it must not leave dashed boxes on a board that has no dialog to take them away", async () => {
    let answer!: (value: FillProposal) => void;
    propose.mockImplementation(() => new Promise<FillProposal>((resolve) => (answer = resolve)));
    const view = open();
    await screen.findByRole("option", { name: "7A (3 kvar)" });
    fireEvent.click(screen.getByRole("button", { name: /^Föreslå$/ }));
    await screen.findByRole("button", { name: "Letar tider…" });

    view.unmount();
    answer(PROPOSAL);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(fillPreview.get()).toBeNull();
  });

  it("says nothing of a request that fails after the X: the reader asked for nothing more", async () => {
    let fail!: (error: unknown) => void;
    propose.mockImplementation(() => new Promise<FillProposal>((_, reject) => (fail = reject)));
    open();
    await screen.findByRole("option", { name: "7A (3 kvar)" });
    fireEvent.click(screen.getByRole("button", { name: /^Föreslå$/ }));
    await screen.findByRole("button", { name: "Letar tider…" });

    fireEvent.click(screen.getByRole("button", { name: "Stäng" }));
    fail(new ApiError(500, "boom"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(screen.queryByRole("alert")).toBeNull();
  });
});
