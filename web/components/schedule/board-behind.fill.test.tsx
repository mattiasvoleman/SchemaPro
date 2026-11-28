import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fillPreview } from "@/lib/fill-store";
import { swapPreview } from "@/lib/swap-store";
import type { SwapProposal } from "@/lib/swaps";
import { boardBehind } from "./board-behind";

/**
 * The grundschema board has two layers in its one `behind` slot (E5a's Byt och Gör plats, E7a's Lägg det som går). They are two proposals of two
 * different questions and can be up together (the sheet of one is not modal), so both are drawn, each by its own store.
 */
vi.mock("next-intl", async () => {
  const { createTranslator } = await import("use-intl");
  const sv = (await import("@/messages/sv.json")).default;
  return {
    useLocale: () => "sv",
    useTranslations: (namespace: string) => createTranslator({ locale: "sv", messages: sv, namespace: namespace as never }),
  };
});

const scale = { startMinutes: 480, pxPerMinute: 1 };
const slot = (dayOfWeek: number, start: number) => ({ dayOfWeek, startMinutes: start, endMinutes: start + 60 });
const SWAP: SwapProposal = {
  id: "p-1",
  kind: "SWAP",
  moves: [
    { lessonId: "l-a", from: slot(1, 480), to: slot(1, 600) },
    { lessonId: "l-b", from: slot(1, 600), to: slot(1, 480) },
  ],
  parallels: [],
  external: [],
  hard: [],
  soft: [],
  lessons: [
    { id: "l-a", subjectName: "Matematik", groupName: "7A", teacherId: null, coTeacherId: null, roomId: null, isLocked: false },
    { id: "l-b", subjectName: "Kemi", groupName: "7B", teacherId: null, coTeacherId: null, roomId: null, isLocked: false },
  ],
  removedCalendarLessons: 0,
};

afterEach(() => {
  swapPreview.set(null);
  fillPreview.set(null);
});

describe("boardBehind with both layers", () => {
  it("draws the swap and the fill when both are in view, and each alone when only it is", async () => {
    const { container } = render(<>{boardBehind(1, scale)}</>);
    act(() => swapPreview.set(SWAP));
    await screen.findByText(/Matematik 7A kommer hit/);
    act(() =>
      fillPreview.set({
        proposal: { placed: [{ key: "b-1", dayOfWeek: 1, startMinutes: 540, endMinutes: 600, noRoom: false }] } as never,
        labels: new Map([["b-1", "Historia 7C"]]),
      }),
    );
    expect(await screen.findByText(/Historia 7C/)).toBeInTheDocument();
    expect(screen.getByText(/Matematik 7A kommer hit/)).toBeInTheDocument();
    expect(container.querySelectorAll("[data-swap-layer]")).toHaveLength(1);
    expect(container.querySelectorAll("[data-fill-layer]")).toHaveLength(1);
    act(() => swapPreview.set(null));
    expect(container.querySelectorAll("[data-swap-layer]")).toHaveLength(0);
    expect(container.querySelectorAll("[data-fill-layer]")).toHaveLength(1);
  });
});
