import { describe, expect, it } from "vitest";
import fixture from "./__fixtures__/frame-windows.json";
import { frameWindow, type FrameTime } from "@/lib/frame-times";

/**
 * The same sentence, implemented twice, checked against each other.
 *
 * A ramtid's window is computed in TypeScript here and in Python in
 * optimization-engine/app/solver/frames.py, because the grid warns in the
 * browser and the solver places in the engine. Neither test suite can see the
 * other, and the failure mode of the pair drifting is the worst one this
 * feature has: the grid says a slot is fine and the solver refuses to use it,
 * or the grid stays quiet about a lesson the school has closed.
 *
 * The fixture is 400 random frame sets run through the ENGINE, on a 15-minute
 * grid with deliberately off-grid clocks so the rounding is exercised. Rebuild
 * it with:
 *
 *   optimization-engine/.venv/bin/python \
 *     optimization-engine/tests/generate_frame_window_cases.py \
 *     > web/lib/__fixtures__/frame-windows.json
 *
 * TWO ASSERTIONS, because one of them alone is not enough.
 *
 * CONTAINMENT: everything the engine allows, the web allows. The engine rounds
 * its window inward to whole slots; the web works in raw minutes and does not
 * know the slot size, which is an engine setting it has no business carrying.
 * So an off-grid frame gives the engine the narrower window — 08:10 becomes
 * 08:15 there and stays 08:10 here — and the solver's own output is therefore
 * never flagged by the grid. The reverse would be the bug.
 *
 * WITHIN ONE SLOT: and the web is allowed to be wider only by that rounding.
 * Containment alone is satisfied by a web that ignores frames completely and
 * calls every day open, which is precisely the state this whole feature started
 * in. The two together pin the answer.
 *
 * On the real five-minute grid, with clocks entered in whole minutes, the two
 * agree exactly; the divergence measured here is at most one slot at each end.
 */
describe("frame windows agree with the engine", () => {
  const { slotMinutes, dayStartMinutes, dayEndMinutes, cases } = fixture;

  /** The web's answer, clamped to the day the engine reasons inside. */
  const webWindow = (
    frames: FrameTime[],
    span: { min: number; max: number },
    day: number,
  ): readonly [number, number] | null => {
    const raw = frameWindow(frames, span, day);
    if (raw === null) return null;
    const start = Math.max(raw.startMinutes, dayStartMinutes);
    const end = Math.min(raw.endMinutes, dayEndMinutes);
    return end > start ? ([start, end] as const) : null;
  };

  const eachDay = (
    check: (
      web: readonly [number, number] | null,
      engine: number[] | null,
      where: string,
    ) => string | null,
  ): string[] => {
    const failures: string[] = [];
    for (const [index, testCase] of cases.entries()) {
      const frames: FrameTime[] = testCase.frames.map((frame, i) => ({ id: `f${i}`, ...frame }));
      for (const day of [1, 2, 3, 4, 5]) {
        const engine = (testCase.windows as Record<string, number[]>)[String(day)] ?? null;
        const failure = check(
          webWindow(frames, testCase.span, day),
          engine,
          `#${index} day ${day}`,
        );
        if (failure) failures.push(failure);
      }
    }
    return failures;
  };

  it("never lets the engine place outside what the web accepts", () => {
    expect(
      eachDay((web, engine, where) => {
        if (engine === null) return null;
        if (web !== null && engine[0]! >= web[0] && engine[1]! <= web[1]) return null;
        return `${where}: web=${JSON.stringify(web)} engine=${JSON.stringify(engine)}`;
      }).slice(0, 5),
    ).toEqual([]);
  });

  it("never lets the web be wider than the engine by more than the rounding", () => {
    expect(
      eachDay((web, engine, where) => {
        const describe = () =>
          `${where}: web=${JSON.stringify(web)} engine=${JSON.stringify(engine)}`;
        if (engine === null) {
          // A day the engine closed, where the web still sees a sliver. TWO
          // slots, not one: the rounding eats a partial slot at each end, so a
          // window of up to 2 x slot - 1 minutes can straddle a boundary and
          // leave the engine nothing — 511-526 on a 15-minute grid rounds to
          // slot 35 at both ends and closes. Anything wider than that is the
          // web disagreeing about the frames themselves.
          if (web === null || web[1] - web[0] < 2 * slotMinutes) return null;
          return describe();
        }
        if (web === null) return describe();
        return engine[0]! - web[0] < slotMinutes && web[1] - engine[1]! < slotMinutes
          ? null
          : describe();
      }).slice(0, 5),
    ).toEqual([]);
  });

  it("actually exercises the rounding it claims to", () => {
    // A fixture regenerated on a grid the clocks happen to land on would make
    // both tests above vacuous, and they would still pass.
    const offGrid = cases.some((testCase) =>
      testCase.frames.some((frame) => Number(frame.startTime.slice(3, 5)) % slotMinutes !== 0),
    );
    expect(offGrid).toBe(true);
  });
});
