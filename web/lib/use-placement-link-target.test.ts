import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { usePlacementLinkTarget } from "./use-placement-link-target";

/*
 * What the week says about the card an address names (A3), and for how long (review of #333, LÅG-6): the sentence "no longer there" is
 * about the läsår it was found for, and goes when the school picks another läsår or lays a row on the very place.
 */

const row = (id: string, over: Partial<{ requirementId: string; dayOfWeek: number; startTime: string }> = {}) => ({
  id,
  requirementId: "post-1",
  dayOfWeek: 3,
  startTime: "10:00",
  ...over,
});
const keys = new Map<string, string>();

const at = (search: string) => window.history.replaceState(null, "", `/sv/admin/placements${search}`);
const years = (shownId: string | undefined, activeId: string | undefined = "y-active") => ({ shownId, activeId });

type Props = { rows: ReturnType<typeof row>[] | undefined; openCard?: string | null; years: ReturnType<typeof years> };
const render = (initial: Props) =>
  renderHook((props: Props) => usePlacementLinkTarget(props.rows, keys, props.openCard ?? null, props.years), { initialProps: initial });

beforeEach(() => at(""));
afterEach(() => at(""));

describe("the card an address names", () => {
  it("is marked when the row is on the week, and nothing is said missing", async () => {
    at("?post=post-1&day=3&start=10:00");
    const { result } = render({ rows: [row("r1")], years: years("y-active") });
    await waitFor(() => expect(result.current.markedCard).toBe("placement:r1"));
    expect(result.current.missing).toBe(false);
  });

  it("is said to be gone when no row is on the post, the day and the start", async () => {
    at("?post=post-1&day=3&start=10:00");
    const { result } = render({ rows: [row("r1", { startTime: "11:00" })], years: years("y-active") });
    await waitFor(() => expect(result.current.missing).toBe(true));
    expect(result.current.markedCard).toBeNull();
  });

  it("says nothing about an address that names no card", () => {
    at("?year=y-active");
    const { result } = render({ rows: [], years: years("y-active") });
    expect(result.current).toEqual({ markedCard: null, missing: false });
  });
});

describe("the läsår the address names", () => {
  it("is the active one when the address names none: a week of the next läsår is not looked in", async () => {
    at("?post=post-1&day=3&start=10:00");
    const { result } = render({ rows: [], years: years("y-next") });
    await act(async () => undefined);
    expect(result.current.missing).toBe(false);
  });

  it("is the one on screen when it is named: a läsår the week fell back from says nothing", async () => {
    // The address names an old läsår, the week shows the active one (planning-year.ts), whose posts are others'.
    at("?year=y-old&post=post-1&day=3&start=10:00");
    const { result } = render({ rows: [row("r1", { startTime: "11:00" })], years: years("y-active") });
    await act(async () => undefined);
    expect(result.current).toEqual({ markedCard: null, missing: false });
  });

  it("is looked in when the läsår it names is the one on screen", async () => {
    at("?year=y-next&post=post-1&day=3&start=10:00");
    const { result } = render({ rows: [row("r1")], years: years("y-next") });
    await waitFor(() => expect(result.current.markedCard).toBe("placement:r1"));
  });

  it("waits until both the läsår on screen and the active one are known", async () => {
    at("?post=post-1&day=3&start=10:00");
    const { result, rerender } = render({ rows: [], years: years(undefined, undefined) });
    await act(async () => undefined);
    expect(result.current.missing).toBe(false);
    rerender({ rows: [], years: years("y-active", "y-active") });
    await waitFor(() => expect(result.current.missing).toBe(true));
  });
});

describe('"no longer there"', () => {
  const gone = async (): Promise<ReturnType<typeof render>> => {
    at("?post=post-1&day=3&start=10:00");
    const hooked = render({ rows: [], years: years("y-active") });
    await waitFor(() => expect(hooked.result.current.missing).toBe(true));
    return hooked;
  };

  it("stays while the school works on the same läsår, and is not looked for again", async () => {
    const { result, rerender } = await gone();
    rerender({ rows: [row("other", { dayOfWeek: 2 })], years: years("y-active") });
    expect(result.current.missing).toBe(true);
  });

  it("goes when the school picks another läsår, and the other läsår's week is not marked by it", async () => {
    const { result, rerender } = await gone();
    rerender({ rows: undefined, years: years("y-next") });
    expect(result.current).toEqual({ markedCard: null, missing: false });
    // The other läsår's week has nothing on that place, as it would not (its posts are others'): still nothing is said of it.
    rerender({ rows: [row("r9", { requirementId: "post-of-next" })], years: years("y-next") });
    expect(result.current).toEqual({ markedCard: null, missing: false });
  });

  it("does not flash while the week it returns to is still being read", async () => {
    const { result, rerender } = await gone();
    rerender({ rows: undefined, years: years("y-active") });
    expect(result.current.missing).toBe(false);
  });

  it("goes when a row is laid on the very place: it is there again, and unmarked, as the school's own doing", async () => {
    const { result, rerender } = await gone();
    rerender({ rows: [row("laid")], years: years("y-active") });
    expect(result.current).toEqual({ markedCard: null, missing: false });
  });
});

describe("the mark", () => {
  it("ends when the school opens a card", async () => {
    at("?post=post-1&day=3&start=10:00");
    const { result, rerender } = render({ rows: [row("r1")], years: years("y-active") });
    await waitFor(() => expect(result.current.markedCard).toBe("placement:r1"));
    rerender({ rows: [row("r1")], openCard: "placement:r1", years: years("y-active") });
    expect(result.current.markedCard).toBeNull();
  });

  it("is not made for an address with a block: the block's card is the week's block card's", async () => {
    at("?post=post-1&day=3&start=10:00&block=b1");
    const { result } = render({ rows: [row("r1")], years: years("y-active") });
    await act(async () => undefined);
    expect(result.current).toEqual({ markedCard: null, missing: false });
  });
});
