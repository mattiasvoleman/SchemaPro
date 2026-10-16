import { describe, expect, it } from "vitest";
import {
  loadsUnderSelection,
  orderedTeachers,
  reversed,
  selectedChanges,
  touchedTeachers,
} from "./proposal-selection";
import type { ProposalAssignment, ProposalTeacher } from "./use-staffing-proposal";

/**
 * The selection arithmetic: a teacher's minutes under a selection are the
 * proposal's after with the left-out rows given back, judged with the same
 * loadStatus and percentOfTarget the gateway uses, and flagged only when they
 * grow — enforcement's question.
 */

const teacher = (
  userId: string,
  target: number | null,
  before: number,
  after: number,
  status: ProposalTeacher["after"]["status"],
): ProposalTeacher => ({
  userId,
  targetMinutesPerWeek: target,
  limitMinutesPerWeek: target === null ? null : Math.floor(target * 1.1),
  keepOrShed: target === null,
  before: { countedMinutesPerWeek: Math.round(before), countedExact: before, percentOfTarget: null, status: "UNDER" },
  after: { countedMinutesPerWeek: Math.round(after), countedExact: after, percentOfTarget: 99.9, status },
});

const move = (requirementId: string, from: string | null, to: string, charge: number): ProposalAssignment => ({
  requirementId,
  subjectId: "s",
  studentGroupId: "g",
  fromTeacherId: from,
  toTeacherId: to,
  chargeMinutesPerWeek: charge,
  reasons: { qualificationKind: null, familiarWithSubject: false, taughtLastYear: false, teachesGroupAlready: false },
});

describe("loadsUnderSelection", () => {
  const proposal = {
    teachers: [teacher("a", 1000, 900, 1059.3, "OK"), teacher("b", 600, 660, 540, "OK"), teacher("c", null, 0, 0, "NO_TARGET")],
    assignments: [move("r1", null, "a", 59.3), move("r2", "b", "a", 120), move("r3", "a", "b", 20)],
  };

  // Anna: 100 % (target 600) until January, 50 % (target 300) after, planned on the spring.
  const changingAnna = (before: [number, number], after: [number, number]): ProposalTeacher => ({
    ...teacher("anna", 300, before[1], after[1], "OK"),
    period: { from: "2027-01-11", to: "2027-06-11" },
    plannedStretch: 1,
    stretches: [
      { from: "2026-08-17", to: "2027-01-10", weeks: 19, targetMinutesPerWeek: 600, before: before[0], after: after[0] },
      { from: "2027-01-11", to: "2027-06-11", weeks: 20, targetMinutesPerWeek: 300, before: before[1], after: after[1] },
    ],
  });

  it("gives a changing post back what a left-out dated row charges each stretch, not the year's charge", () => {
    // Shown on the spring, which an autumn row does not weigh: 0 there, 117 over the year.
    const changing = {
      teachers: [changingAnna([180, 180], [414, 180])],
      assignments: [{ ...move("autumn", null, "anna", 117), toStretchCharges: [234, 0] }],
    };
    const load = loadsUnderSelection(changing, new Set(), 5).get("anna")!;
    expect(load.exact).toBe(180);
    expect(load.overLimit).toBe(false);
    // Without the stretches' charges the year's is given back, as for any other post.
    const plain = { teachers: [teacher("anna", 150, 180, 180, "OVER")], assignments: [move("autumn", null, "anna", 117)] };
    expect(loadsUnderSelection(plain, new Set(), 10).get("anna")?.exact).toBe(63);
  });

  it("flags a changing post a selection takes over the limit in a stretch other than the planned one", () => {
    // The engine moves U (250, undated) from Anna to Bob to give her A, an autumn row: 400 in the autumn,
    // 0 in the spring. All of it fits; keeping A and leaving U where it is does not: the autumn goes
    // from 250 to 650, over 630 at 5 %, though the spring she is shown on stays at 250.
    const proposal = {
      teachers: [changingAnna([250, 250], [400, 0]), teacher("bob", 1000, 500, 750, "OK")],
      assignments: [
        { ...move("U", "anna", "bob", 250), fromStretchCharges: [250, 250] },
        { ...move("A", null, "anna", 200), toStretchCharges: [400, 0] },
      ],
    };
    expect(loadsUnderSelection(proposal, new Set(["U", "A"]), 5).get("anna")?.overLimit).toBe(false);
    const partial = loadsUnderSelection(proposal, new Set(["A"]), 5).get("anna")!;
    expect(partial.exact).toBe(250);
    expect(partial.overLimit).toBe(true);
    // Leaving A out too: nothing grows, nothing to flag.
    expect(loadsUnderSelection(proposal, new Set(), 5).get("anna")?.overLimit).toBe(false);
  });

  it("is the gateway's own figures, untouched, when every change is selected", () => {
    const loads = loadsUnderSelection(proposal, new Set(["r1", "r2", "r3"]), 10);
    expect(loads.get("a")).toEqual({
      minutes: 1059,
      exact: 1059.3,
      percentOfTarget: 99.9,
      status: "OK",
      grows: true,
      overLimit: false,
    });
  });

  it("gives back a left-out row's charge to the teacher it came from and takes it off the one it went to", () => {
    const loads = loadsUnderSelection(proposal, new Set(["r1", "r3"]), 10);
    expect(loads.get("a")).toMatchObject({ exact: 939.3, minutes: 939, percentOfTarget: 93.9, status: "OK" });
    expect(loads.get("b")).toMatchObject({ exact: 660, percentOfTarget: 110, status: "OK", grows: false });
  });

  it("flags only a teacher who grows past the limit, never one who stays where they were", () => {
    const loads = loadsUnderSelection(
      {
        teachers: [teacher("b", 600, 680, 600, "OK"), teacher("d", 600, 600, 680, "OVER")],
        assignments: [move("r1", "b", "d", 120), move("r2", "d", "b", 40)],
      },
      new Set(["r1"]),
      10,
    );
    // b sheds r1 and does not get r2: 680 − 120 = 560.
    expect(loads.get("b")).toMatchObject({ exact: 560, status: "OK", grows: false, overLimit: false });
    // d takes r1 and keeps r2: 600 + 120 = 720, past 660.
    expect(loads.get("d")).toMatchObject({ exact: 720, status: "OVER", grows: true, overLimit: true });
  });

  it("judges with loadStatus's own rounding: 660.4 against a 660 limit is not over", () => {
    const loads = loadsUnderSelection(
      { teachers: [teacher("e", 600, 600, 660.4, "OK")], assignments: [move("r1", null, "e", 60.4), move("r2", null, "e", 10)] },
      new Set(["r1"]),
      10,
    );
    // 660.4 − 10 for the left-out r2 = 650.4.
    expect(loads.get("e")).toMatchObject({ exact: 650.4, status: "OK", overLimit: false });
    const edge = loadsUnderSelection(
      { teachers: [teacher("e", 600, 600, 670.4, "OVER")], assignments: [move("r1", null, "e", 60.4), move("r2", null, "e", 10)] },
      new Set(["r1"]),
      10,
    );
    expect(edge.get("e")).toMatchObject({ exact: 660.4, status: "OK", overLimit: false });
  });

  it("leaves a teacher without a target without a status beyond NO_TARGET", () => {
    const loads = loadsUnderSelection(
      { teachers: [teacher("c", null, 300, 180, "NO_TARGET")], assignments: [move("r1", "c", "x", 120)] },
      new Set(),
      10,
    );
    expect(loads.get("c")).toMatchObject({ exact: 300, status: "NO_TARGET", percentOfTarget: null, grows: false });
  });
});

describe("the lists", () => {
  it("lists the teachers a change touches first, each part by name", () => {
    const teachers = [teacher("z", 1, 0, 0, "OK"), teacher("y", 1, 0, 0, "OK"), teacher("x", 1, 0, 0, "OK")];
    const names: Record<string, string> = { x: "Åsa", y: "Bo", z: "Ärla" };
    const touched = touchedTeachers([move("r1", null, "x", 1), move("r2", "gone", "z", 1)]);
    expect([...touched]).toEqual(["x", "z", "gone"]);
    expect(orderedTeachers(teachers, touched, (id) => names[id]!).map((row) => row.userId)).toEqual(["x", "z", "y"]);
  });

  it("sends the selected changes from today's lead, and undoes them back to it — nobody included", () => {
    const changes = selectedChanges([move("r1", null, "a", 1), move("r2", "b", "a", 1), move("r3", "c", "d", 1)], new Set(["r1", "r3"]));
    expect(changes).toEqual([
      { requirementId: "r1", fromTeacherId: null, toTeacherId: "a" },
      { requirementId: "r3", fromTeacherId: "c", toTeacherId: "d" },
    ]);
    expect(reversed(changes)).toEqual([
      { requirementId: "r1", fromTeacherId: "a", toTeacherId: null },
      { requirementId: "r3", fromTeacherId: "d", toTeacherId: "c" },
    ]);
  });
});
