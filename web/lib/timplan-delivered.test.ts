import { describe, expect, it } from "vitest";
import { DELIVERED_DRILL_7A, DELIVERED_IDS, DELIVERED_OVERVIEW } from "@/lib/__fixtures__/timplan-delivered";
import {
  buildDeliveredMatrix,
  hoursOf,
  isDetail,
  lostShares,
  ownFindingPupils,
  subjectOfKey,
} from "@/lib/timplan-delivered";

describe("hoursOf", () => {
  it("writes the reader's decimal sign: a point in English, a comma in Swedish", () => {
    expect([hoursOf(6300, "en"), hoursOf(-252, "en"), hoursOf(6300, "sv"), hoursOf(70_000, "sv")]).toEqual([
      "105.0 h",
      "−4.2 h",
      "105,0 h",
      "1166,7 h",
    ]);
  });

  it("writes minutes as hours to the tenth with a decimal comma and a real minus", () => {
    expect([hoursOf(6300), hoursOf(6552), hoursOf(0), hoursOf(-252), hoursOf(-12), hoursOf(29)]).toEqual([
      "105,0 h",
      "109,2 h",
      "0,0 h",
      "−4,2 h",
      "−0,2 h",
      "0,5 h",
    ]);
  });
});

describe("buildDeliveredMatrix", () => {
  it("puts subjects in the school's order, an unknown one by its id, and Utan ämne last", () => {
    const matrix = buildDeliveredMatrix(DELIVERED_OVERVIEW, [
      { id: DELIVERED_IDS.ma, name: "Matematik" },
      { id: "s-other", name: "Bild" },
    ]);
    expect(matrix.columns).toEqual([
      { key: `subject:${DELIVERED_IDS.ma}`, subjectId: DELIVERED_IDS.ma, name: "Matematik" },
      { key: `subject:${DELIVERED_IDS.idh}`, subjectId: DELIVERED_IDS.idh, name: DELIVERED_IDS.idh },
      { key: "none", subjectId: null, name: null },
    ]);
    expect(matrix.classes.map((g) => g.studentGroupId)).toEqual([DELIVERED_IDS.class7A]);
    expect(matrix.teachingGroups.map((g) => g.studentGroupId)).toEqual([DELIVERED_IDS.fordjupning]);
    expect(matrix.line(DELIVERED_IDS.class7A, "none")?.creditedMinutes).toBe(120);
    expect(matrix.line(DELIVERED_IDS.fordjupning, "none")).toBeNull();
  });
});

describe("the drill-down's helpers", () => {
  it("tells a detail line from a summary line, and reads a key's subject", () => {
    expect(DELIVERED_OVERVIEW.groups[0]!.lines.some(isDetail)).toBe(false);
    expect(DELIVERED_DRILL_7A.groups[0]!.lines.every(isDetail)).toBe(true);
    expect([subjectOfKey(`subject:${DELIVERED_IDS.ma}`), subjectOfKey("none")]).toEqual([DELIVERED_IDS.ma, null]);
  });

  it("draws the lost bar in the causes' order, leaving out what lost nothing", () => {
    expect(lostShares({ teacherless: 60, cancelledTeacherUnavailable: 120, cancelledManual: 0 })).toEqual([
      { cause: "cancelledTeacherUnavailable", minutes: 120, percent: (100 * 120) / 180 },
      { cause: "teacherless", minutes: 60, percent: (100 * 60) / 180 },
    ]);
    expect(lostShares({})).toEqual([]);
  });

  it("lists as own findings exactly the pupils a pupil verdict names, each with the line it is about", () => {
    expect([...ownFindingPupils(DELIVERED_OVERVIEW)]).toEqual([`${DELIVERED_IDS.bea}|subject:${DELIVERED_IDS.ma}`]);
  });
});
