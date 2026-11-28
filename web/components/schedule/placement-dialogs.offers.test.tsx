import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { MasterLesson } from "@/lib/types";
import { SuggestPlacementsDialog, type RefusedDrop } from "./placement-dialogs";

/**
 * E5a: a lesson let go on a time that is taken offers, besides the free times it could have gone to, to swap with what stands there (Byt) or to
 * make room (Gör plats). Both lists are the gateway's and are fetched when one is first asked for; the dialog is not modal while they are shown,
 * so that the board is in reach.
 */

vi.mock("next-intl", async () => {
  const { createTranslator } = await import("use-intl");
  const sv = (await import("@/messages/sv.json")).default;
  return {
    useLocale: () => "sv",
    useTranslations: (namespace: string) => createTranslator({ locale: "sv", messages: sv, namespace: namespace as never }),
  };
});

const list = vi.hoisted(() => ({ props: null as null | Record<string, unknown> }));
vi.mock("./swap-dialog", () => ({
  SwapProposals: (props: Record<string, unknown>) => {
    list.props = props;
    return <div data-testid="proposals" data-ask={JSON.stringify(props["ask"])} />;
  },
}));

const lesson = (overrides: Partial<MasterLesson> = {}): MasterLesson => ({
  id: "l-a",
  academicYearId: "y1",
  subjectId: "Ma",
  studentGroupId: "7A",
  teacherId: "anna",
  coTeacherId: null,
  roomId: null,
  dayOfWeek: 1,
  startTime: "08:00:00",
  endTime: "09:00:00",
  isLocked: false,
  isParked: false,
  recurrence: "ALL_WEEKS",
  startDate: null,
  endDate: null,
  extraGroupIds: [],
  studentIds: [],
  ...overrides,
});
const OPTIONS = [{ dayOfWeek: 3, startMinutes: 540, endMinutes: 600 }] as never;
const dropOf = (over: Partial<MasterLesson> = {}): RefusedDrop => ({ lesson: lesson(over), drop: { dayOfWeek: 2, startMinutes: 600 } });

function draw(refused: RefusedDrop | null | undefined, extra: { onClose?: () => void; guard?: never; onApplied?: () => void } = {}) {
  return render(<SuggestPlacementsDialog open options={OPTIONS} onPick={vi.fn()} onClose={extra.onClose ?? vi.fn()} refused={refused} onApplied={extra.onApplied} guard={extra.guard} />);
}

describe("the dialog of a refused drop, and what it offers besides the free times", () => {
  it("offers Byt and Gör plats for a lesson that stands, beside the free times that were always there", () => {
    draw(dropOf());
    expect(screen.getByRole("button", { name: "Byt" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Gör plats" })).toBeInTheDocument();
    expect(screen.getByText(/Onsdag|Ons/)).toBeInTheDocument();
    expect(screen.queryByTestId("proposals")).not.toBeInTheDocument();
  });

  it.each([
    ["a lesson on the tray", { isParked: true }],
    ["a lesson written from a förläggning", { fromPlacement: true }],
  ] as const)("offers neither for %s: it has no place to leave, and the dialog is what it was", (_name, over) => {
    draw(dropOf(over));
    expect(screen.queryByRole("button", { name: "Byt" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Gör plats" })).not.toBeInTheDocument();
    expect(screen.getByText(/Onsdag|Ons/)).toBeInTheDocument();
  });

  it.each([6, 7])("offers neither for a drop on day %i: the gateway's search is for the school days, Monday to Friday, and answers 400 for another", (dayOfWeek) => {
    draw({ lesson: lesson(), drop: { dayOfWeek, startMinutes: 600 } });
    expect(screen.queryByRole("button", { name: "Byt" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Gör plats" })).not.toBeInTheDocument();
    expect(screen.getByText(/Onsdag|Ons/)).toBeInTheDocument();
  });

  it("is what it was when the page does not say what was refused", () => {
    draw(undefined);
    expect(screen.queryByRole("button", { name: "Byt" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Gör plats" })).not.toBeInTheDocument();
  });

  it("asks for what makes room at the time the lesson was let go on, hands on the page's question and undo history, and closes when it is done", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onApplied = vi.fn();
    const guard = (async (run: () => Promise<unknown>) => run()) as never;
    draw(dropOf(), { onClose, onApplied, guard });
    await user.click(screen.getByRole("button", { name: "Gör plats" }));
    const proposals = await screen.findByTestId("proposals");
    expect(JSON.parse(proposals.getAttribute("data-ask")!)).toEqual({ kind: "room", lessonId: "l-a", target: { dayOfWeek: 2, startMinutes: 600 } });
    expect(list.props).toMatchObject({ onApplied, guard, onDone: onClose });
    // The free times are not shown beside it: the dialog is the list, and Tillbaka brings them back.
    expect(screen.queryByText(/Onsdag/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Tillbaka till tiderna" }));
    expect(screen.queryByTestId("proposals")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Byt" })).toBeInTheDocument();
  });

  it("asks for the swap with the one that stands there when Byt is pressed", async () => {
    const user = userEvent.setup();
    draw(dropOf());
    await user.click(screen.getByRole("button", { name: "Byt" }));
    const proposals = await screen.findByTestId("proposals");
    expect(JSON.parse(proposals.getAttribute("data-ask")!)).toEqual({ kind: "swap", lessonId: "l-a", target: { dayOfWeek: 2, startMinutes: 600 } });
  });

  it("is not modal while the lists are shown, so that the board is in reach: the page behind is not made inert, and a press on it does not close the dialog", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <>
        <button type="button">Brädet</button>
        <SuggestPlacementsDialog open options={OPTIONS} onPick={vi.fn()} onClose={onClose} refused={dropOf()} />
      </>,
    );
    await user.click(screen.getByRole("button", { name: "Gör plats" }));
    await screen.findByTestId("proposals");
    // A modal dialog hides the page from assistive technology and takes pointer events; this one does neither.
    expect(screen.getByText("Brädet")).not.toHaveAttribute("aria-hidden");
    await user.click(screen.getByText("Brädet"));
    expect(onClose).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });
});
