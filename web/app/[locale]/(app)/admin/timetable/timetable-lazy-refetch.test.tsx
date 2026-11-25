import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { Component, createElement, Suspense, type ComponentType, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The three dialogs fetched on their first press (Versioner, Optimera salar, Byten och flyttar), through timetable-lazy.ts as it is and a module
 * whose import fails the first time it is asked for and works the second: what is shown is that a new press fetches AGAIN. The page's own tests
 * replace the pieces by stand-ins that reject, and timetable-split.test.ts holds that a reset makes a new wrapper; neither would see a new wrapper
 * whose factory hands back the failure it already had (a promise kept from the first fetch), which is what a retry that does not retry is. A wrapper
 * is asked to start its fetch by hand with lazy()'s own initialiser, so that such a regression is a count that did not move and not a render that
 * suspends on a promise that is already rejected.
 */

const PIECES = [
  ["Versioner", "@/components/schedule/versions-dialog", "VersionsDialog", "resetVersionsDialog"],
  ["Optimera salar", "@/components/schedule/room-optimization-dialog", "RoomOptimizationDialog", "resetRoomOptimizationDialog"],
  ["Byten och flyttar", "@/components/schedule/swap-dialog", "SwapDialog", "resetSwapDialog"],
] as const;

class Boundary extends Component<{ children: ReactNode; onError: (error: unknown) => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    this.props.onError(error);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

afterEach(() => {
  cleanup();
  vi.doUnmock("@/components/schedule/versions-dialog");
  vi.doUnmock("@/components/schedule/room-optimization-dialog");
  vi.doUnmock("@/components/schedule/swap-dialog");
  vi.resetModules();
});

describe.each(PIECES)("%s", (_name, path, exportName, resetName) => {
  it("is fetched again by the next press after a fetch that failed, and only through a new wrapper", async () => {
    vi.resetModules();
    let fetches = 0;
    vi.doMock(path, () => {
      fetches += 1;
      if (fetches === 1) throw new Error("Failed to load chunk");
      return { [exportName]: () => createElement("p", null, "arrived") };
    });
    const lazyPieces = (await import("./timetable-lazy")) as unknown as Record<string, ComponentType | (() => void)>;
    const failures: unknown[] = [];
    const press = () =>
      render(
        <Boundary onError={(error) => failures.push(error)}>
          <Suspense fallback={null}>{createElement(lazyPieces[exportName] as ComponentType)}</Suspense>
        </Boundary>,
      );

    // The first press: the fetch fails, and the boundary has it.
    press();
    await waitFor(() => expect(failures).toHaveLength(1));
    expect(fetches).toBe(1);
    cleanup();

    // Pressing again with the wrapper that failed does not ask again: it holds the failure for good (what a lazy() does).
    press();
    await waitFor(() => expect(failures).toHaveLength(2));
    expect(fetches).toBe(1);
    cleanup();

    // The page's reset gives a new wrapper. It is asked to start its fetch before anything is drawn from it (a lazy() starts when React first asks it
    // for the component: this is that first ask, made by hand), so that a wrapper that hands back the failure it already had is seen as a count that
    // did not move, and not as a render that never ends.
    (lazyPieces[resetName] as () => void)();
    const fresh = lazyPieces[exportName] as unknown as { _init: (payload: unknown) => unknown; _payload: unknown };
    try {
      fresh._init(fresh._payload);
    } catch {
      // A lazy() that has not arrived throws what it waits for.
    }
    await waitFor(() => expect(fetches, "the new wrapper asks for the module again").toBe(2));

    // And the press after it gets the piece.
    press();
    expect(await screen.findByText("arrived")).toBeInTheDocument();
    expect(failures).toHaveLength(2);
  });
});
