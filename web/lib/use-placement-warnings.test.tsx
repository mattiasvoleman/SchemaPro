import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NO_FILTERS } from "@/lib/placement-board";
import type { PlacementWarning } from "@/lib/requirement-placements";
import { usePlacementWarnings } from "./use-placement-warnings";

vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: () =>
    Object.assign((key: string, values?: Record<string, unknown>) => (values ? `${key}(${Object.values(values).join("|")})` : key), { has: () => true }),
}));

/*
 * What is said after a save, for the polite region (D1). It is said anew after every write, even when it is the same, so a write on its way
 * empties it (D1's review, LÅG-2 (d): the mutant `if (!saving)` emptied it at every other moment, and nothing noticed).
 */
const warning = (over: Partial<PlacementWarning> = {}): PlacementWarning => ({
  code: "TEACHER_DAY_TOO_LONG",
  refuses: false,
  rowId: "row-1",
  requirementId: "post-1",
  ...over,
});

const render = (saving: boolean) =>
  renderHook(
    ({ saving }) => usePlacementWarnings({ board: undefined, filters: NO_FILTERS, keys: new Map(), blockKeys: new Map(), saving }),
    { initialProps: { saving } },
  );

describe("what the week said after the last save", () => {
  it("is nothing before a save has said anything", () => {
    expect(render(false).result.current.said).toBe("");
  });

  it("is the sentences of the save's warnings, counted", () => {
    const { result } = render(false);
    act(() => result.current.say([warning(), warning({ code: "TEACHER_STRETCH_TOO_LONG" })]));
    expect(result.current.said).toContain("said(2|");
  });

  it("is nothing for a save with no warnings, which empties what an earlier one said", () => {
    const { result } = render(false);
    act(() => result.current.say([warning()]));
    expect(result.current.said).not.toBe("");
    act(() => result.current.say([]));
    expect(result.current.said).toBe("");
    act(() => result.current.say(undefined));
    expect(result.current.said).toBe("");
  });

  it("stays while the page is not saving: it is not emptied by a render, by the page going quiet or by the same answer again", () => {
    const { result, rerender } = render(false);
    act(() => result.current.say([warning()]));
    const said = result.current.said;
    expect(said).not.toBe("");
    rerender({ saving: false });
    expect(result.current.said).toBe(said);
  });

  it("is emptied when the next write begins, and said anew when that write has answered the same", () => {
    const { result, rerender } = render(false);
    act(() => result.current.say([warning()]));
    const said = result.current.said;
    rerender({ saving: true });
    expect(result.current.said).toBe("");
    // The write answers: the same sentence is said again, and a polite region announces a change of text, which is why it was emptied.
    act(() => result.current.say([warning()]));
    rerender({ saving: false });
    expect(result.current.said).toBe(said);
  });

  it("is not said by a write that is still going: what the last one said does not stand in the region while the next is on its way", () => {
    const { result, rerender } = render(false);
    act(() => result.current.say([warning()]));
    rerender({ saving: true });
    rerender({ saving: true });
    expect(result.current.said).toBe("");
  });
});
