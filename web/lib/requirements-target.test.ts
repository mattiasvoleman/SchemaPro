import { describe, expect, it } from "vitest";
import {
  buildTargetView,
  draftHint,
  targetInput,
  toneOf,
  type DraftFields,
  type TargetSources,
} from "@/lib/requirements-target";
import { computePlannedCoverage } from "@/lib/timplan-planned";

/**
 * Mål mode's data layer: the input it assembles from what the matrix holds,
 * the matrix-shaped index over the module's answer, and the dialog hint.
 *
 * The arithmetic itself is lib/timplan-planned.ts's and is held to the
 * gateway by its own contract test; what is pinned here is that this file
 * hands it the right rows and reads the right figure back out — the class of
 * bug where every number is computed correctly for the wrong cell.
 *
 * The läsår is 2026-08-17 (a Monday) to 2027-06-11 (a Friday), no lov, so an
 * all-weeks post is worth its face value per standardvecka and 43 weeks a
 * year: 180 min/vecka is 129 h.
 */

const year = { startDate: "2026-08-17", endDate: "2027-06-11" };

const subjects = [
  { id: "s-ma", name: "Matematik", nationalCode: "MA", countsTowardTimplan: true },
  { id: "s-sv", name: "Svenska", nationalCode: "SV_SVA", countsTowardTimplan: true },
  { id: "s-sva", name: "Svenska som andraspråk", nationalCode: "SV_SVA", countsTowardTimplan: true },
  { id: "s-bi", name: "Bild", nationalCode: "BL", countsTowardTimplan: true },
  { id: "s-mt", name: "Mentorstid", nationalCode: null, countsTowardTimplan: false },
];

const groups = [
  { id: "g-7a", name: "7A", kind: "CLASS" as const, gradeLevel: 7 },
  { id: "g-8a", name: "8A", kind: "CLASS" as const, gradeLevel: 8 },
  { id: "g-9a", name: "9A", kind: "CLASS" as const, gradeLevel: 9 },
  { id: "g-sva7", name: "SvA7", kind: "TEACHING_GROUP" as const, gradeLevel: null },
];

const plans = [
  {
    id: "p-decided",
    name: "Grundskola 2026",
    status: "DECIDED" as const,
    entries: [
      { subjectId: "s-ma", gradeLevel: 7, minutesPerWeek: 175 },
      { subjectId: "s-sv", gradeLevel: 7, minutesPerWeek: 180 },
      { subjectId: "s-sva", gradeLevel: 7, minutesPerWeek: 180 },
      { subjectId: "s-bi", gradeLevel: 7, minutesPerWeek: 60 },
    ],
  },
  {
    id: "p-draft",
    name: "Utkast 2027",
    status: "DRAFT" as const,
    entries: [{ subjectId: "s-ma", gradeLevel: 8, minutesPerWeek: 180 }],
  },
];

const attachments = [
  { gradeLevel: 7, localTimplanId: "p-decided" },
  { gradeLevel: 8, localTimplanId: "p-draft" },
];

const row = (
  id: string,
  studentGroupId: string,
  subjectId: string,
  lessonsPerWeek: number,
  minutesPerLesson: number,
) => ({
  id,
  studentGroupId,
  subjectId,
  lessonsPerWeek,
  minutesPerLesson,
  recurrence: "ALL_WEEKS" as const,
  startDate: null,
  endDate: null,
});

const requirements = [
  // 175 planned as 3 × 60: the generator's own rounding, which is on target.
  row("r-ma7", "g-7a", "s-ma", 3, 60),
  // Svenska carried whole by the class; SvA has no post of its own.
  row("r-sv7", "g-7a", "s-sv", 3, 60),
  // Bild is the short one: 40 of 60.
  row("r-bi7", "g-7a", "s-bi", 1, 40),
  // 8A plans matematik at 4 × 60 against the draft's 180: a lesson over.
  row("r-ma8", "g-8a", "s-ma", 4, 60),
  row("r-sva-group", "g-sva7", "s-sva", 3, 60),
];

const people = [
  { id: "u-1", role: "STUDENT", isActive: true, studentGroupId: "g-7a" },
  { id: "u-2", role: "STUDENT", isActive: true, studentGroupId: "g-7a" },
  { id: "u-gone", role: "STUDENT", isActive: false, studentGroupId: "g-7a" },
  { id: "t-1", role: "TEACHER", isActive: true, studentGroupId: null },
];

const memberships = [{ studentId: "u-2", studentGroupId: "g-sva7" }];

const sources: TargetSources = {
  year,
  closures: [],
  attachments,
  plans,
  subjects,
  groups,
  requirements,
  people,
  memberships,
};

const fields = (overrides: Partial<DraftFields> = {}): DraftFields => ({
  lessonsPerWeek: "3",
  minutesPerLesson: "60",
  recurrence: "ALL_WEEKS",
  startDate: "",
  endDate: "",
  ...overrides,
});

describe("targetInput", () => {
  it("hands the module active pupils only, each with the groups they are a member of", () => {
    const input = targetInput(sources);
    expect(input.pupils).toEqual([
      { id: "u-1", homeGroupId: "g-7a", groupIds: [] },
      { id: "u-2", homeGroupId: "g-7a", groupIds: ["g-sva7"] },
    ]);
    expect(input.includePupils).toBe(true);
    expect(input.requirements.map((entry) => entry.id)).toEqual(requirements.map((entry) => entry.id));
  });
});

describe("lektionslängder in Mål mode", () => {
  // Bild in 7A as 1 × 80 + 1 × 40 against a target of 60 a week: 120, not
  // the 160 that count × longest would say.
  const split = {
    ...row("r-bi7", "g-7a", "s-bi", 2, 80),
    lessonLengths: [80, 40],
  };
  const withSplit: TargetSources = {
    ...sources,
    requirements: [...requirements.filter((entry) => entry.id !== "r-bi7"), split],
  };

  it("passes a split row's lengths on, and leaves a uniform row without the key", () => {
    const input = targetInput(withSplit);
    expect(input.requirements.find((entry) => entry.id === "r-bi7")?.lessonLengths).toEqual([80, 40]);
    expect(input.requirements.find((entry) => entry.id === "r-ma7")).not.toHaveProperty("lessonLengths");
    const uniformList = targetInput({ ...sources, requirements: [{ ...requirements[0], lessonLengths: [] }] });
    expect(uniformList.requirements[0]).not.toHaveProperty("lessonLengths");
  });

  it("counts a split row by its lessons' minutes on the cell", () => {
    const view = buildTargetView(computePlannedCoverage(targetInput(withSplit)), plans);
    expect(view.cell("g-7a", "s-bi")).toMatchObject({ planned: 120, target: 60, delta: 60, tone: "over" });
  });

  it("judges a split draft in the dialog by its lengths: 1 × 80 + 1 × 40 is 120", () => {
    const hint = draftHint(
      targetInput(sources),
      "g-7a",
      "s-bi",
      fields({ lessonsPerWeek: "1", minutesPerLesson: "40", extraLengths: [{ lessons: "1", minutes: "80" }] }),
    );
    expect(hint).toMatchObject({
      kind: "target",
      planned: 120,
      lessonsPerWeek: 2,
      minutesPerLesson: 80,
      lessonLengths: [80, 40],
    });
  });

  it("says only the target while a split draft cannot be stored", () => {
    const hint = draftHint(
      targetInput(sources),
      "g-7a",
      "s-bi",
      fields({ extraLengths: [{ lessons: "1", minutes: "42" }] }),
    );
    expect(hint).toMatchObject({ kind: "target", planned: null, lessonLengths: [] });
  });

  it("reads parts that all say one length as a uniform post", () => {
    const hint = draftHint(
      targetInput(sources),
      "g-7a",
      "s-ma",
      fields({ lessonsPerWeek: "2", minutesPerLesson: "60", extraLengths: [{ lessons: "1", minutes: "60" }] }),
    );
    expect(hint).toMatchObject({ planned: 180, lessonsPerWeek: 3, minutesPerLesson: 60, lessonLengths: [] });
  });
});

describe("buildTargetView", () => {
  const input = targetInput(sources);
  const view = buildTargetView(computePlannedCoverage(input), plans);

  it("reads each cell at its own coordinates, judged on its line", () => {
    expect(view.cell("g-7a", "s-ma")).toEqual({
      planned: 180,
      target: 175,
      delta: 5,
      tone: "met",
      alternative: false,
      national: false,
      linePlanned: 180,
      lineTarget: 175,
      partnerSubjectIds: [],
    });
    expect(view.cell("g-7a", "s-bi")).toMatchObject({ planned: 40, target: 60, delta: -20, tone: "under" });
    expect(view.cell("g-8a", "s-ma")).toMatchObject({ planned: 240, target: 180, delta: 60, tone: "over" });
  });

  it("does not call an empty SvA cell a deficit when Svenska meets the shared target", () => {
    expect(view.cell("g-7a", "s-sva")).toEqual({
      planned: 0,
      target: 180,
      delta: 0,
      tone: "met",
      alternative: true,
      national: false,
      linePlanned: 180,
      lineTarget: 180,
      partnerSubjectIds: ["s-sv"],
    });
  });

  it("has no cell for a teaching group, a subject outside the timplan, or an unattached class", () => {
    expect(view.cell("g-sva7", "s-sva")).toBeNull();
    expect(view.cell("g-7a", "s-mt")).toBeNull();
    expect(view.summary("g-9a")).toMatchObject({ localTimplanId: null, linesWithTarget: 0 });
  });

  it("counts a class's coverage over its pupils and sums the columns over classes", () => {
    // Matematik and Svenska/SvA reach both pupils; Bild reaches neither.
    expect(view.summary("g-7a")).toMatchObject({ linesWithTarget: 3, linesCovered: 2 });
    expect(view.subjectTotals.get("s-ma")).toEqual({
      planned: 420,
      target: 355,
      plannedHours: 301,
      targetHours: 254.4,
      countedWith: null,
    });
    // Review reproduction (P2 review, lens webb): SvA's column added its own
    // 180 target although the class meets SV_SVA through Svenska, so the row
    // read "0 / 180" for SvA and the columns summed to more than the total.
    // An alternative line is totalled once, in its first column; the
    // partner column says it is counted there.
    expect(view.subjectTotals.get("s-sv")).toMatchObject({ planned: 180, target: 180, countedWith: null });
    expect(view.subjectTotals.get("s-sva")).toEqual({
      planned: 0,
      target: null,
      plannedHours: 0,
      targetHours: null,
      countedWith: "s-sv",
    });
    const columnTargets = [...view.subjectTotals.values()].reduce((sum, total) => sum + (total.target ?? 0), 0);
    expect(columnTargets).toBe(view.total.target);
    expect(view.total).toEqual({
      planned: 640,
      target: 595,
      plannedHours: 458.7,
      targetHours: 426.4,
    });
  });

  it("names the årskurser without a plan and the plans that are drafts", () => {
    expect(view.unattachedGrades).toEqual([9]);
    expect(view.draftPlans).toEqual([{ id: "p-draft", name: "Utkast 2027", gradeLevels: [8] }]);
    expect(view.emptyPlanGrades).toEqual([]);
  });

  it("names an årskurs whose plan gives it no minutes, instead of a 0/0 that looks covered", () => {
    const empty = buildTargetView(
      computePlannedCoverage({
        year,
        closures: [],
        plans,
        attachments: [{ gradeLevel: 9, localTimplanId: "p-decided" }],
        subjects,
        groups,
        requirements: [],
        pupils: [],
        includePupils: true,
      }),
      plans,
    );
    expect(empty.emptyPlanGrades).toEqual([{ gradeLevel: 9, planName: "Grundskola 2026" }]);
    expect(empty.summary("g-9a")).toMatchObject({ localTimplanId: "p-decided", linesWithTarget: 0 });
  });

  it("maps every status to a tone", () => {
    expect(toneOf("UNPLANNED")).toBe("unplanned");
    expect(toneOf("PUPILS")).toBe("pupils");
    expect(toneOf("NO_TARGET")).toBe("none");
  });
});

describe("draftHint", () => {
  const input = targetInput(sources);

  it("says the target and that 3 × 60 covers 175", () => {
    expect(draftHint(input, "g-7a", "s-ma", fields())).toEqual({
      kind: "target",
      gradeLevel: 7,
      draft: false,
      target: 175,
      planned: 180,
      delta: 5,
      status: "MET",
      lessonsPerWeek: 3,
      minutesPerLesson: 60,
      lessonLengths: [],
      partnerSubjectIds: [],
      national: false,
      carriedBy: [],
    });
  });

  // Review reproduction (P2 review, lens webb): a class cell whose subject
  // the pupils read in teaching groups is drawn 'i grupp', yet the dialog
  // opened from it said "2 × 60 täcker det" — and saving that post gives
  // those pupils the time twice.
  it("says a subject read in teaching groups is carried there, not that a class post covers it", () => {
    const withLanguages: TargetSources = {
      ...sources,
      subjects: [...subjects, { id: "s-es", name: "Spanska", nationalCode: "M2", countsTowardTimplan: true }],
      plans: [
        { ...plans[0]!, entries: [...plans[0]!.entries, { subjectId: "s-es", gradeLevel: 7, minutesPerWeek: 120 }] },
        plans[1]!,
      ],
      groups: [...groups, { id: "g-es7", name: "Spanska 7", kind: "TEACHING_GROUP" as const, gradeLevel: null }],
      requirements: [...requirements, row("r-es7", "g-es7", "s-es", 2, 60)],
      memberships: [...memberships, { studentId: "u-1", studentGroupId: "g-es7" }, { studentId: "u-2", studentGroupId: "g-es7" }],
    };
    const languages = targetInput(withLanguages);
    const view = buildTargetView(computePlannedCoverage(languages), withLanguages.plans);
    expect(view.cell("g-7a", "s-es")).toMatchObject({ tone: "pupils" });
    expect(draftHint(languages, "g-7a", "s-es", fields({ lessonsPerWeek: "2" }))).toMatchObject({
      kind: "target",
      target: 120,
      carriedBy: ["g-es7"],
    });
    // Matematik is the class's own: no group carries it.
    expect(draftHint(languages, "g-7a", "s-ma", fields())).toMatchObject({ status: "MET", carriedBy: [] });
  });

  it("follows the fields: the edited post replaces the stored one", () => {
    expect(draftHint(input, "g-7a", "s-ma", fields({ lessonsPerWeek: "2" }))).toMatchObject({
      planned: 120,
      delta: -55,
      status: "UNDER",
    });
    expect(draftHint(input, "g-7a", "s-ma", fields({ lessonsPerWeek: "5" }))).toMatchObject({
      planned: 300,
      status: "OVER",
    });
  });

  it("counts odd weeks by their share of the year, not at face value", () => {
    const hint = draftHint(input, "g-7a", "s-ma", fields({ recurrence: "ODD_WEEKS" }));
    // An undated odd-weeks post weighs exactly half: 3 × 60 is 90 a standardvecka.
    expect(hint).toMatchObject({ status: "UNDER", planned: 90, delta: -85 });
  });

  it("states the target alone while the fields hold no post the API would take", () => {
    expect(draftHint(input, "g-7a", "s-ma", fields({ lessonsPerWeek: "" }))).toMatchObject({
      kind: "target",
      target: 175,
      planned: null,
      status: null,
    });
    expect(draftHint(input, "g-7a", "s-ma", fields({ minutesPerLesson: "12" }))).toMatchObject({
      planned: null,
    });
  });

  it("judges Svenska with SvA as one line", () => {
    expect(draftHint(input, "g-7a", "s-sva", fields({ lessonsPerWeek: "1" }))).toMatchObject({
      target: 180,
      // Svenska's 180 stays; SvA's 60 joins it on the line.
      planned: 240,
      partnerSubjectIds: ["s-sv"],
    });
  });

  it("marks a draft plan and explains the cells without a target", () => {
    expect(draftHint(input, "g-8a", "s-ma", fields())).toMatchObject({ kind: "target", draft: true });
    expect(draftHint(input, "g-8a", "s-bi", fields())).toEqual({
      kind: "noTarget",
      gradeLevel: 8,
      draft: true,
    });
    expect(draftHint(input, "g-9a", "s-ma", fields())).toEqual({ kind: "noPlan", gradeLevel: 9 });
    expect(draftHint(input, "g-7a", "s-mt", fields())).toEqual({
      kind: "notCounted",
      gradeLevel: 7,
      draft: false,
    });
    expect(draftHint(input, "g-sva7", "s-sva", fields())).toEqual({ kind: "teachingGroup" });
    expect(draftHint(input, "g-unknown", "s-ma", fields())).toBeNull();
  });
});

describe("ersättande grupper in Mål mode", () => {
  // SvA7 replaces Svenska (lib/replacing-groups.ts): u-2 is credited SvA7's
  // SvA instead of 7A's Svenska, as the gateway credits her, so the matrix
  // and the coverage page agree about 7A.
  const replacing: TargetSources = {
    ...sources,
    groups: groups.map((group) => (group.id === "g-sva7" ? { ...group, replacesSubjectId: "s-sv" } : group)),
  };
  const svLine = (given: TargetSources) =>
    buildTargetView(computePlannedCoverage(targetInput(given)), given.plans)
      .summary("g-7a")!
      .lines.find((line) => line.key === "alt:SV_SVA")!;

  it("hands the module the subject a group replaces, on that group alone", () => {
    const input = targetInput(replacing);
    expect(input.groups.find((group) => group.id === "g-sva7")).toEqual({
      id: "g-sva7",
      name: "SvA7",
      kind: "TEACHING_GROUP",
      gradeLevel: null,
      replacesSubjectId: "s-sv",
    });
    expect(input.groups.filter((group) => "replacesSubjectId" in group).map((group) => group.id)).toEqual(["g-sva7"]);
    expect(targetInput(sources).groups.some((group) => "replacesSubjectId" in group)).toBe(false);
  });

  it("credits a pupil of the replacing group 180 of 180 in Svenska/SvA, where both read 360", () => {
    expect(svLine(sources).pupils).toEqual({ min: 180, median: 270, max: 360, below: 0 });
    expect(svLine(replacing).pupils).toEqual({ min: 180, median: 180, max: 180, below: 0 });
    // The class's own line is the same either way.
    expect(svLine(replacing).status).toBe(svLine(sources).status);
  });

  it("does not warn that a class Svenska post gives the replacing group's pupils the time twice: they leave it", () => {
    // 7A without its Svenska post, both its pupils in SvA7, which carries the line.
    const carried: TargetSources = {
      ...replacing,
      requirements: requirements.filter((entry) => entry.id !== "r-sv7"),
      memberships: [
        { studentId: "u-1", studentGroupId: "g-sva7" },
        { studentId: "u-2", studentGroupId: "g-sva7" },
      ],
    };
    const input = targetInput(carried);
    expect(draftHint(input, "g-7a", "s-sv", fields())).toMatchObject({ kind: "target", carriedBy: [] });
    // An SvA post on the class would give them SvA twice: that is still said.
    expect(draftHint(input, "g-7a", "s-sva", fields())).toMatchObject({ kind: "target", carriedBy: ["g-sva7"] });
    // And with SvA7 an ordinary group, the Svenska warning stands as before.
    expect(draftHint(targetInput({ ...carried, groups }), "g-7a", "s-sv", fields())).toMatchObject({
      carriedBy: ["g-sva7"],
    });
  });
});

describe("the parts of a national subject", () => {
  // Slöjd, Textilslöjd and Trä- och metallslöjd are all SL: one line in 7A,
  // the plan's 65 on Slöjd alone, the class's own post in textil, and trä in
  // the class's two halves.
  const parts: TargetSources = {
    ...sources,
    subjects: [
      ...subjects,
      { id: "s-sl", name: "Slöjd", nationalCode: "SL", countsTowardTimplan: true },
      { id: "s-tx", name: "Textilslöjd", nationalCode: "SL", countsTowardTimplan: true },
      { id: "s-tm", name: "Trä- och metallslöjd", nationalCode: "SL", countsTowardTimplan: true },
    ],
    groups: [
      ...groups,
      { id: "g-7a1", name: "7A:1", kind: "TEACHING_GROUP" as const, gradeLevel: 7, halfOfId: "g-7a" },
      { id: "g-7a2", name: "7A:2", kind: "TEACHING_GROUP" as const, gradeLevel: 7, halfOfId: "g-7a" },
    ],
    plans: [
      { ...plans[0]!, entries: [...plans[0]!.entries, { subjectId: "s-sl", gradeLevel: 7, minutesPerWeek: 65 }] },
      plans[1]!,
    ],
    requirements: [
      ...requirements,
      row("r-tx7", "g-7a", "s-tx", 1, 40),
      row("r-tm7a", "g-7a1", "s-tm", 2, 40),
      row("r-tm7b", "g-7a2", "s-tm", 2, 40),
    ],
    memberships: [
      { studentId: "u-1", studentGroupId: "g-7a1" },
      { studentId: "u-2", studentGroupId: "g-7a2" },
    ],
  };
  const view = buildTargetView(computePlannedCoverage(targetInput(parts)), parts.plans);

  it("reads a cell of any part on the line, with the line's delta and its other parts named", () => {
    // 7A's own rows: textil 40 of the 65, the halves carry the rest for both pupils.
    expect(view.cell("g-7a", "s-tx")).toEqual({
      planned: 40,
      target: null,
      delta: -25,
      tone: "pupils",
      alternative: false,
      national: true,
      // The line's figures: 7A's textil 40 of the Slöjd entry of 65.
      linePlanned: 40,
      lineTarget: 65,
      partnerSubjectIds: ["s-sl"],
    });
    expect(view.cell("g-7a", "s-sl")).toMatchObject({
      planned: 0,
      target: 65,
      delta: -25,
      tone: "pupils",
      national: true,
      partnerSubjectIds: ["s-tx"],
    });
    // Trä- och metallslöjd is only in the halves: the class has no cell for it.
    expect(view.cell("g-7a", "s-tm")).toBeNull();
  });

  it("totals each column on its own cells, which add up to the class's one line", () => {
    expect(view.subjectTotals.get("s-sl")).toMatchObject({ planned: 0, target: 65, countedWith: null });
    expect(view.subjectTotals.get("s-tx")).toMatchObject({ planned: 40, target: null, countedWith: null });
    const line = view.summary("g-7a")!.lines.find((entry) => entry.nationalCode === "SL")!;
    expect(line).toMatchObject({ key: "national:SL", targetMinutesPerWeek: 65, plannedMinutesPerWeek: 40 });
  });

  it("judges a new post on the national line though the plan has no entry on its own subject", () => {
    const hint = draftHint(targetInput(parts), "g-7a", "s-tx", fields({ lessonsPerWeek: "1", minutesPerLesson: "40" }));
    expect(hint).toMatchObject({
      kind: "target",
      target: 65,
      planned: 40,
      delta: -25,
      national: true,
      partnerSubjectIds: ["s-sl"],
    });
  });

  it("says the halves carry the line when a class post would give their pupils the time twice", () => {
    // 7A's own textil post taken away: its pupils read trä in the halves, so a
    // textil post on the class is time on the line they already have.
    const without: TargetSources = { ...parts, requirements: parts.requirements.filter((entry) => entry.id !== "r-tx7") };
    expect(draftHint(targetInput(without), "g-7a", "s-tx", fields({ lessonsPerWeek: "1", minutesPerLesson: "40" }))).toMatchObject({
      national: true,
      carriedBy: ["g-7a1", "g-7a2"],
    });
  });
});

describe("the children of an ämnesgrupp", () => {
  // The plan's NO of 90 in 7A, and the class's posts on Biologi and Fysik: the
  // subjects carry the ämnesgrupp of their national code (withParentCodes), so
  // the three are one line, 'national:NO', as the gateway reads them.
  const children: TargetSources = {
    ...sources,
    subjects: [
      ...subjects,
      { id: "s-no", name: "Naturorienterande ämnen", nationalCode: "NO", countsTowardTimplan: true },
      { id: "s-bio", name: "Biologi", nationalCode: "BI", parentCode: "NO", countsTowardTimplan: true },
      { id: "s-fys", name: "Fysik", nationalCode: "FY", parentCode: "NO", countsTowardTimplan: true },
      { id: "s-kem", name: "Kemi", nationalCode: "KE", parentCode: "NO", countsTowardTimplan: true },
    ],
    plans: [
      { ...plans[0]!, entries: [...plans[0]!.entries, { subjectId: "s-no", gradeLevel: 7, minutesPerWeek: 90 }] },
      plans[1]!,
    ],
    requirements: [...requirements, row("r-bio7", "g-7a", "s-bio", 1, 30), row("r-fys7", "g-7a", "s-fys", 1, 30)],
  };
  const view = buildTargetView(computePlannedCoverage(targetInput(children)), children.plans);

  it("hands the module the ämnesgrupp on the subjects that have one only", () => {
    const input = targetInput(children);
    expect(input.subjects.filter((entry) => entry.parentCode !== undefined).map((entry) => [entry.id, entry.parentCode])).toEqual([
      ["s-bio", "NO"],
      ["s-fys", "NO"],
      ["s-kem", "NO"],
    ]);
    expect(input.subjects.find((entry) => entry.id === "s-no")).not.toHaveProperty("parentCode");
    // Without it the subjects reach the module as they always did.
    expect(targetInput(sources).subjects.every((entry) => !("parentCode" in entry))).toBe(true);
  });

  it("reads the cell of a child and of the group on the one line, with the others named", () => {
    expect(view.cell("g-7a", "s-bio")).toEqual({
      planned: 30,
      target: null,
      delta: -30,
      tone: "under",
      alternative: false,
      national: true,
      linePlanned: 60,
      lineTarget: 90,
      partnerSubjectIds: ["s-fys", "s-no"],
    });
    expect(view.cell("g-7a", "s-no")).toMatchObject({ planned: 0, target: 90, delta: -30, national: true, partnerSubjectIds: ["s-bio", "s-fys"] });
    // Kemi has no post and no entry in 7A: no cell.
    expect(view.cell("g-7a", "s-kem")).toBeNull();
  });

  it("totals the class on the line once: the posts of the children add up under the group’s 90", () => {
    const line = view.summary("g-7a")!.lines.find((entry) => entry.nationalCode === "NO")!;
    expect(line).toMatchObject({ key: "national:NO", targetMinutesPerWeek: 90, plannedMinutesPerWeek: 60, subjectIds: ["s-bio", "s-fys", "s-no"] });
  });

  it("judges a new post in Kemi on the line though the plan has no entry on Kemi", () => {
    const hint = draftHint(targetInput(children), "g-7a", "s-kem", fields({ lessonsPerWeek: "1", minutesPerLesson: "30" }));
    expect(hint).toMatchObject({
      kind: "target",
      target: 90,
      planned: 90,
      delta: 0,
      status: "MET",
      national: true,
      partnerSubjectIds: ["s-bio", "s-fys", "s-no"],
    });
  });

  describe("when the plan names the children", () => {
    // Biologi 60 and Kemi 60: each is a line of its own, as before the roll-up.
    const named: TargetSources = {
      ...children,
      plans: [
        {
          ...plans[0]!,
          entries: [
            ...plans[0]!.entries,
            { subjectId: "s-bio", gradeLevel: 7, minutesPerWeek: 60 },
            { subjectId: "s-kem", gradeLevel: 7, minutesPerWeek: 60 },
          ],
        },
        plans[1]!,
      ],
      // 7A: Biologi 1 × 30 and Fysik 1 × 30, no Kemi.
      requirements: [...requirements, row("r-bio7", "g-7a", "s-bio", 1, 30), row("r-fys7", "g-7a", "s-fys", 1, 30)],
    };
    const namedView = buildTargetView(computePlannedCoverage(targetInput(named)), named.plans);

    it("reads Biologi and Kemi as lines of their own: Kemi is unplanned, and Fysik, which the plan does not name, is the group's", () => {
      expect(namedView.cell("g-7a", "s-bio")).toMatchObject({ planned: 30, target: 60, delta: -30, tone: "under", national: false, partnerSubjectIds: [] });
      expect(namedView.cell("g-7a", "s-kem")).toMatchObject({ planned: 0, target: 60, delta: -60, tone: "unplanned", national: false });
      // Fysik is on NO's line, with the group's own subject, which has no entry here.
      expect(namedView.cell("g-7a", "s-fys")).toMatchObject({ planned: 30, target: null, national: true, tone: "none", partnerSubjectIds: [] });
    });

    it("judges a new Kemi post against Kemi’s own 60", () => {
      const hint = draftHint(targetInput(named), "g-7a", "s-kem", fields({ lessonsPerWeek: "1", minutesPerLesson: "60" }));
      expect(hint).toMatchObject({ kind: "target", target: 60, planned: 60, delta: 0, status: "MET", national: false, partnerSubjectIds: [] });
    });
  });
});
