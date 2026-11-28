import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { swapPreview } from "@/lib/swap-store";
import type { SwapPair, SwapProposal } from "@/lib/swaps";
import { SwapProposals } from "./swap-dialog";

/**
 * Byt plats is a hand act, so it may move a lesson that stands against a rule on purpose (an undantag, E1b): the trigger takes the exemption away
 * when the lesson's day or clock changes, and the apply says so in `exemptionsEnded`. A hand edit says the same (EXEMPTION_ENDED on its toast), and
 * what is gone is not brought back by Ångra, so the person has to be told before the toast goes.
 */

const swaps = vi.hoisted(() => ({
  suggest: { mutateAsync: vi.fn(), isPending: false },
  pair: { mutateAsync: vi.fn(), isPending: false },
  apply: { mutateAsync: vi.fn(), isPending: false },
}));
vi.mock("@/lib/swaps", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/swaps")>()), useSwaps: () => swaps }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("next-intl", async () => {
  const { createTranslator } = await import("use-intl");
  const sv = (await import("@/messages/sv.json")).default;
  return {
    useLocale: () => "sv",
    useTranslations: (namespace: string) => createTranslator({ locale: "sv", messages: sv, namespace: namespace as never }),
  };
});

const slot = (dayOfWeek: number, start: number) => ({ dayOfWeek, startMinutes: start, endMinutes: start + 60 });
const view = (id: string, subjectName: string, groupName: string) => ({ id, subjectName, groupName, teacherId: null, coTeacherId: null, roomId: null, isLocked: false });
const SWAP: SwapProposal = {
  id: "p-swap",
  kind: "SWAP",
  moves: [
    { lessonId: "l-a", from: slot(1, 480), to: slot(2, 600) },
    { lessonId: "l-b", from: slot(2, 600), to: slot(1, 480) },
  ],
  parallels: [],
  external: [],
  hard: ["CLASH"],
  soft: [],
  lessons: [view("l-a", "Matematik", "7A"), view("l-b", "Kemi", "7B")],
  removedCalendarLessons: 0,
};
const pairOk: SwapPair = { academicYearId: "y-1", ok: true, proposal: SWAP, refusals: [] };

const description = () => (vi.mocked(toast.success).mock.calls[0]![1] as { description?: string } | undefined)?.description ?? "";

async function applied(result: Record<string, unknown>) {
  const user = userEvent.setup();
  swaps.pair.mutateAsync.mockResolvedValue(pairOk);
  swaps.apply.mutateAsync.mockResolvedValue({ propagatedLessons: 0, removedCalendarLessons: 0, versionId: "v", undo: [], ...result });
  render(<SwapProposals ask={{ kind: "pair", lessonId: "l-a", otherLessonId: "l-b" }} teacherName={() => null} roomName={() => null} onApplied={vi.fn()} onDone={vi.fn()} />);
  await user.click(await screen.findByRole("button", { name: "Tillämpa" }));
  await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
}

beforeEach(() => {
  vi.clearAllMocks();
  swapPreview.set(null);
});

describe("a swap that ended an exemption says so", () => {
  it("tells how many lessons lost the exemption they stood on, and that Ångra does not bring it back", async () => {
    await applied({ exemptionsEnded: [{ lessonId: "l-a", rules: "FRAME" }, { lessonId: "l-b", rules: "FRAME,LUNCH" }] });
    expect(description()).toMatch(/2 lektioner stod mot en regel med flit/);
    expect(description()).toMatch(/Ångra .* inte undantaget/);
  });

  it("says it in the singular for one lesson", async () => {
    await applied({ exemptionsEnded: [{ lessonId: "l-a", rules: "LUNCH" }] });
    expect(description()).toMatch(/En lektion stod mot en regel med flit/);
  });

  it("says nothing of exemptions when none ended, or when an older gateway does not send the field", async () => {
    await applied({ exemptionsEnded: [] });
    expect(description()).not.toMatch(/med flit/);
    vi.clearAllMocks();
    await applied({});
    expect(description()).not.toMatch(/med flit/);
  });
});
