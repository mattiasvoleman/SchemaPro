import { describe, expect, it } from "vitest";
import type { ConflictHit } from "@/lib/conflicts";
import { exemptableReasons, EXEMPT_RULES, splitExemptions } from "@/lib/exemptions";
import type { MasterLesson } from "@/lib/types";

/*
 * UNDANTAG MED FLIT, in the page's own reading: a lesson an administrator let stand outside the ramtid or over the class's meal stands there on
 * purpose, so the hit the grid finds for that rule is no conflict. It is said apart (the card's märke, the krocklistan's "Undantag"), never as a
 * ring and a triangle, and only for the rule it was given for and that the lesson really breaks.
 */
const lesson = (id: string, exemptFrom?: MasterLesson["exemptFrom"]): MasterLesson =>
  ({ id, exemptFrom, dayOfWeek: 1, startTime: "14:30:00", endTime: "15:30:00" }) as MasterLesson;
const hit = (kind: ConflictHit["kind"]): ConflictHit => ({ kind });

describe("splitExemptions", () => {
  it("takes the hit of the rule a lesson is exempt from out of its conflicts, and keeps the others", () => {
    const lessons = new Map([["a", lesson("a", ["FRAME"])]]);
    const { conflicts, exemptions } = splitExemptions(new Map([["a", [hit("FRAME"), hit("TEACHER")]]]), lessons);
    expect(conflicts.get("a")).toEqual([hit("TEACHER")]);
    expect(exemptions.get("a")).toEqual(["FRAME"]);
  });

  it("takes a lesson out of the conflicts when every hit it has is one it is exempt from", () => {
    const lessons = new Map([["a", lesson("a", ["FRAME", "LUNCH"])]]);
    const { conflicts, exemptions } = splitExemptions(new Map([["a", [hit("FRAME"), hit("LUNCH")]]]), lessons);
    expect(conflicts.has("a")).toBe(false);
    expect(exemptions.get("a")).toEqual(["FRAME", "LUNCH"]);
  });

  it("says an exemption for a rule the lesson does not break now as an exemption nothing needs: the gateway has saved it and the publication counts it", () => {
    const lessons = new Map([["a", lesson("a", ["FRAME", "LUNCH"])]]);
    const { conflicts, exemptions, standing } = splitExemptions(new Map([["a", [hit("LUNCH")]]]), lessons);
    expect(exemptions.get("a")).toEqual(["FRAME", "LUNCH"]);
    expect(standing.get("a")).toEqual(["LUNCH"]);
    expect(conflicts.has("a")).toBe(false);
    // A lesson whose meal Generera has laid elsewhere: nothing stands there, and the exemption is still on the lesson.
    const idle = splitExemptions(new Map(), lessons);
    expect(idle.exemptions.get("a")).toEqual(["FRAME", "LUNCH"]);
    expect(idle.standing.size).toBe(0);
  });

  it("counts what the publication counts: the placed lessons that carry an exemption, and not a lesson on the tray or one with the names of no rule", () => {
    const lessons = new Map<string, MasterLesson>([
      ["a", lesson("a", ["FRAME"])],
      ["b", lesson("b", ["LUNCH"])],
      ["c", lesson("c")],
      ["d", lesson("d", [])],
      ["e", { ...lesson("e", ["FRAME"]), isParked: true } as MasterLesson],
    ]);
    expect([...splitExemptions(new Map(), lessons).exemptions.keys()]).toEqual(["a", "b"]);
  });

  it("never lets an exemption through for another rule: a clash, a closed hour and a locked room stay conflicts", () => {
    const lessons = new Map([["a", lesson("a", ["FRAME", "LUNCH"])]]);
    const hits = [hit("TEACHER"), hit("ROOM"), hit("GROUP"), hit("AVAILABILITY"), hit("ROOM_LOCK")];
    const { conflicts, standing } = splitExemptions(new Map([["a", hits]]), lessons);
    expect(conflicts.get("a")).toEqual(hits);
    expect(standing.size).toBe(0);
  });

  it("is the same map, and the same arrays, for a page with no exemption: nothing is redrawn", () => {
    const map = new Map<string, readonly ConflictHit[]>([["a", [hit("FRAME")]], ["b", [hit("TEACHER")]]]);
    const lessons = new Map([["a", lesson("a")], ["b", lesson("b", [])]]);
    const { conflicts, exemptions } = splitExemptions(map, lessons);
    expect(conflicts).toBe(map);
    expect(exemptions.size).toBe(0);
  });
});

describe("exemptableReasons", () => {
  it("reads a refusal's reasons as the rules a yes would let through, when they are the ramtid and the lunch and nothing else", () => {
    expect(exemptableReasons("FRAME")).toEqual(["FRAME"]);
    expect(exemptableReasons("LUNCH,FRAME")).toEqual(["FRAME", "LUNCH"]);
    expect(exemptableReasons("FRAME,TEACHER")).toBeNull();
    expect(exemptableReasons("GRADE_RULE")).toBeNull();
    expect(exemptableReasons("SCHOOL_DAY")).toBeNull();
    expect(exemptableReasons("")).toBeNull();
    expect(exemptableReasons(undefined)).toBeNull();
    expect(EXEMPT_RULES).toEqual(["FRAME", "LUNCH"]);
  });
});
