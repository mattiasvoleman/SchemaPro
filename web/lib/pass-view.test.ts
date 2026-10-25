import { describe, expect, it } from "vitest";
import type { PassBoardItem } from "@/lib/cover-types";
import { otherPassTeacherOptions, passActions, passesByDate, passKey, passStatusKey } from "./pass-view";

/**
 * What the board shows and offers for an absent rastvakt's pass: the
 * gateway's rules (src/cover/supervision-cover.service.ts) as the buttons
 * follow them.
 */

describe("an absent rastvakt's pass (Rastvakt i vardagen)", () => {
  function pass(overrides: Partial<PassBoardItem> = {}): PassBoardItem {
    return {
      shiftId: "s-1",
      date: "2026-10-12",
      absenceId: "a-1",
      absentTeacherId: "t-anna",
      areaId: "area-1",
      startsAt: "2026-10-12T08:00:00Z",
      endsAt: "2026-10-12T08:20:00Z",
      decision: null,
      decidedAt: null,
      substituteId: null,
      status: "OPEN",
      decisionStale: false,
      passed: false,
      outsideAbsence: false,
      ...overrides,
    };
  }
  const before = Date.parse("2026-10-12T07:00:00Z");

  it("badges an open pass, a vikarie, one left without and one that ran out", () => {
    expect(passStatusKey(pass())).toBe("OPEN");
    expect(passStatusKey(pass({ status: "OPEN", passed: true }))).toBe("PASSED");
    expect(passStatusKey(pass({ status: "COVERED", decision: "SUBSTITUTE" }))).toBe("COVERED");
    expect(passStatusKey(pass({ status: "HANDLED", decision: "NO_COVER" }))).toBe("NO_COVER");
  });

  it("offers a vikarie or none to an open pass, Ångra to a decided one, and nothing once it has ended", () => {
    expect(passActions(pass(), before)).toEqual({ assign: true, noCover: true, undo: false });
    expect(passActions(pass({ status: "COVERED", decision: "SUBSTITUTE" }), before)).toEqual({
      assign: false,
      noCover: false,
      undo: true,
    });
    // A vikarie who is away themself: open again, and the decision can still be undone.
    expect(passActions(pass({ decision: "SUBSTITUTE", decisionStale: true }), before)).toEqual({
      assign: true,
      noCover: true,
      undo: true,
    });
    expect(passActions(pass({ decision: "NO_COVER", status: "HANDLED" }), Date.parse("2026-10-12T08:20:00Z"))).toEqual({
      assign: false,
      noCover: false,
      undo: false,
    });
  });

  it("offers only Ångra on a decision left on a day the pass no longer runs, even with its vikarie away", () => {
    expect(passActions(pass({ decision: "SUBSTITUTE", decisionStale: true, runs: false }), before)).toEqual({
      assign: false,
      noCover: false,
      undo: true,
    });
    expect(passActions(pass({ decision: "NO_COVER", status: "HANDLED", runs: false }), before)).toEqual({
      assign: false,
      noCover: false,
      undo: true,
    });
  });

  it("offers as another teacher nobody suggested, not the absent one, and nobody the gateway refuses", () => {
    const teachers = ["t-anna", "t-bo", "t-cia", "t-dan", "t-eva"].map((id) => ({ id }));
    expect(
      otherPassTeacherOptions(teachers, pass(), {
        candidates: [{ userId: "t-bo" }],
        excluded: [
          { userId: "t-cia", codes: [{ code: "BUSY_SUPERVISION", params: {} }] },
          { userId: "t-dan", codes: [{ code: "LUNCH", params: { minutes: 30 } }] },
        ],
      }).map((teacher) => teacher.id),
    ).toEqual(["t-dan", "t-eva"]);
  });

  it("keys a pass by its pass and date, and lists the week by day in time order", () => {
    expect(passKey(pass())).toBe("s-1:2026-10-12");
    const days = passesByDate([
      pass({ shiftId: "s-2", date: "2026-10-13", startsAt: "2026-10-13T10:00:00Z" }),
      pass({ shiftId: "s-3", startsAt: "2026-10-12T11:00:00Z" }),
      pass(),
    ]);
    expect(days.map((day) => [day.date, day.passes.map((row) => row.shiftId)])).toEqual([
      ["2026-10-12", ["s-1", "s-3"]],
      ["2026-10-13", ["s-2"]],
    ]);
  });

});
