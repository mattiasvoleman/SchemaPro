/*
 * Appends the ämnesgrupp cases to the planned contract fixture, first
 * requiring every existing case to recompute byte-identically (replacing any
 * earlier copy of these, so it can be rerun).
 *
 *   npx ts-node --transpile-only scripts/generate-timplan-groups-fixture.ts
 *
 * What they pin: the children of an ämnesgrupp the årskurs's plan does NOT
 * name — Biologi, Fysik and Kemi (under NO) and Geografi, Historia,
 * Religionskunskap and Samhällskunskap (under SO) — are ONE line with the
 * group's own subject, 'national:<top>', the way P1 and Stadium roll them up,
 * so a target on NO is met by posts on its children. The line's target is the
 * SUM of the plan's entries over its subjects, what is planned the sum of
 * their rows. A child the plan names (an entry of at least a minute) keeps its
 * own line as it had before the roll-up: a plan that states Kemi 60 holds the
 * class to Kemi 60, and Biologi's posts do not meet it — nor does a post on a
 * named child help the group's own line. Two subjects of one named child code
 * are one line, 'national:<child>', as #249 reads equal codes. A child no
 * other counted subject shares its line with keeps 'subject:<id>'. A pupil who
 * reads the children from several groups is on the one line; an ersättande
 * grupp that replaces a child takes the pupil off the class's rows in that
 * child only. A child's minimum is not judged (P1, and Stadium per pupil).
 *
 * No lov, no dated rows: a post weighs one a week, so the minutes are the
 * lessons times the length and the figures can be read off the inputs.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  computePlannedCoverage,
  type PlannedCoverageInput,
  type PlannedGroup,
  type PlannedRequirement,
} from '../src/common/timplan-planned';

const FILE = path.join(__dirname, '..', 'src/common/__fixtures__/timplan-planned-cases.json');
const PREFIX = 'ämnesgrupp:';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const before = fs.readFileSync(FILE, 'utf8');
const { cases } = JSON.parse(before) as {
  cases: { name: string; input: PlannedCoverageInput; coverage: unknown }[];
};
const kept = cases.filter((c) => !c.name.startsWith(PREFIX));
for (const c of kept) {
  if (JSON.stringify(computePlannedCoverage(c.input)) !== JSON.stringify(c.coverage)) {
    throw new Error(`"${c.name}" moved`);
  }
}
if (cases.length === kept.length && JSON.stringify({ cases: kept }, null, 1) + '\n' !== before) {
  throw new Error('kept cases do not reprint byte-identically');
}

const YEAR = { startDate: '2026-08-18', endDate: '2027-06-10' };
const ALL_YEAR = { startDate: null, endDate: null };

const S = {
  NO: id(4001),
  BI: id(4002),
  FY: id(4003),
  KE: id(4004),
  SO: id(4005),
  GE: id(4006),
  HI: id(4007),
  RE: id(4008),
  SH: id(4009),
  MA: id(4010),
  BIF: id(4011),
};
const subject = (subjectId: string, name: string, nationalCode: string, parentCode?: string) => ({
  id: subjectId,
  name,
  nationalCode,
  ...(parentCode ? { parentCode } : {}),
  countsTowardTimplan: true,
});
const NO = subject(S.NO, 'Naturorienterande ämnen', 'NO');
const BIOLOGI = subject(S.BI, 'Biologi', 'BI', 'NO');
const FYSIK = subject(S.FY, 'Fysik', 'FY', 'NO');
const KEMI = subject(S.KE, 'Kemi', 'KE', 'NO');
const SO = subject(S.SO, 'Samhällsorienterande ämnen', 'SO');
const GEOGRAFI = subject(S.GE, 'Geografi', 'GE', 'SO');
const HISTORIA = subject(S.HI, 'Historia', 'HI', 'SO');
const RELIGION = subject(S.RE, 'Religionskunskap', 'RE', 'SO');
const SAMHALL = subject(S.SH, 'Samhällskunskap', 'SH', 'SO');
const MATEMATIK = subject(S.MA, 'Matematik', 'MA');
const BIOLOGI_FORDJUPNING = subject(S.BIF, 'Biologi fördjupning', 'BI', 'NO');

const PLAN = id(4101);
const planOf = (...entries: [subjectId: string, gradeLevel: number, minutesPerWeek: number][]) => ({
  id: PLAN,
  name: 'Test grupper',
  status: 'DECIDED' as const,
  entries: entries.map(([subjectId, gradeLevel, minutesPerWeek]) => ({ subjectId, gradeLevel, minutesPerWeek })),
});

let groupSerial = 4200;
const theClass = (name: string, gradeLevel: number): PlannedGroup => ({
  id: id(groupSerial++),
  name,
  kind: 'CLASS',
  gradeLevel,
});
const teachingGroup = (name: string): PlannedGroup => ({
  id: id(groupSerial++),
  name,
  kind: 'TEACHING_GROUP',
  gradeLevel: null,
});
/** A group that replaces a subject (StudentGroups.replacesSubjectId), as the fixtures of ersättande grupper have it. */
const replacingGroup = (name: string, replacesSubjectId: string): PlannedGroup => ({
  ...teachingGroup(name),
  replacesSubjectId,
});

let rowSerial = 4400;
const post = (
  group: PlannedGroup,
  subjectId: string,
  lessonsPerWeek: number,
  minutesPerLesson: number,
): PlannedRequirement => ({
  id: id(rowSerial++),
  studentGroupId: group.id,
  subjectId,
  lessonsPerWeek,
  minutesPerLesson,
  recurrence: 'ALL_WEEKS',
  ...ALL_YEAR,
});

let pupilSerial = 4600;
const pupils = (home: PlannedGroup, count: number, groups: PlannedGroup[] = []) =>
  Array.from({ length: count }, () => ({
    id: id(pupilSerial++),
    homeGroupId: home.id,
    groupIds: groups.map((group) => group.id),
  }));

const reset = () => {
  groupSerial = 4200;
  rowSerial = 4400;
  pupilSerial = 4600;
};

const yearOf = (
  grades: number[],
  subjects: PlannedCoverageInput['subjects'],
  groups: PlannedGroup[],
  requirements: PlannedRequirement[],
  pupilList: ReturnType<typeof pupils>,
  plan: ReturnType<typeof planOf>,
): PlannedCoverageInput => ({
  year: YEAR,
  closures: [],
  plans: [plan],
  attachments: grades.map((gradeLevel) => ({ gradeLevel, localTimplanId: PLAN })),
  subjects,
  groups,
  requirements,
  pupils: pupilList,
  includePupils: true,
});

const ALL = [NO, BIOLOGI, FYSIK, KEMI, SO, GEOGRAFI, HISTORIA, RELIGION, SAMHALL, MATEMATIK];

/**
 * Åk 7, the plan's NO is 90. 7A plans Biologi, Fysik and Kemi at 1 × 30 each
 * and meets it on the one line (it read 90 of 0 UNPLANNED beside three
 * NO_TARGET lines before); 7B plans Biologi alone, 30 of 90.
 */
const targetOnTheGroup = (): PlannedCoverageInput => {
  reset();
  const c7A = theClass('7A', 7);
  const c7B = theClass('7B', 7);
  return yearOf(
    [7],
    ALL,
    [c7A, c7B],
    [post(c7A, S.BI, 1, 30), post(c7A, S.FY, 1, 30), post(c7A, S.KE, 1, 30), post(c7B, S.BI, 1, 30)],
    [...pupils(c7A, 3), ...pupils(c7B, 2)],
    planOf([S.NO, 7, 90]),
  );
};

/**
 * Åk 8, NO 90 and SO 120. 8A meets both on the children (Biologi and Kemi
 * 45 + 45; Geografi, Historia, Religionskunskap and Samhällskunskap 30 each);
 * 8B is short on NO (Fysik 60 of 90) and over on SO (180 of 120, past a lesson
 * of 30). The two groups are two lines.
 */
const bothGroups = (): PlannedCoverageInput => {
  reset();
  const c8A = theClass('8A', 8);
  const c8B = theClass('8B', 8);
  return yearOf(
    [8],
    ALL,
    [c8A, c8B],
    [
      post(c8A, S.BI, 1, 45),
      post(c8A, S.KE, 1, 45),
      post(c8A, S.GE, 1, 30),
      post(c8A, S.HI, 1, 30),
      post(c8A, S.RE, 1, 30),
      post(c8A, S.SH, 1, 30),
      post(c8B, S.FY, 1, 60),
      post(c8B, S.GE, 2, 30),
      post(c8B, S.HI, 2, 30),
      post(c8B, S.RE, 1, 30),
      post(c8B, S.SH, 1, 30),
    ],
    [...pupils(c8A, 2), ...pupils(c8B, 2)],
    planOf([S.NO, 8, 90], [S.SO, 8, 120]),
  );
};

/**
 * The plan names the children: Biologi 60, Fysik 60 and Kemi 60, no NO (the
 * form P1 itself prefers). Each keeps its own line, as before the roll-up. 7A
 * plans Biologi 2 × 60 and Fysik 1 × 60 and no Kemi: Biologi is OVER (120 of
 * 60), Fysik MET, and Kemi UNPLANNED with a warning (rolled up into one line
 * it would have read 180 of 180 MET). 7B plans one lesson of each and is met
 * on all three.
 */
const childrenNamed = (): PlannedCoverageInput => {
  reset();
  const c7A = theClass('7A', 7);
  const c7B = theClass('7B', 7);
  return yearOf(
    [7],
    ALL,
    [c7A, c7B],
    [
      post(c7A, S.BI, 2, 60),
      post(c7A, S.FY, 1, 60),
      post(c7B, S.BI, 1, 60),
      post(c7B, S.FY, 1, 60),
      post(c7B, S.KE, 1, 60),
    ],
    [...pupils(c7A, 2), ...pupils(c7B, 2)],
    planOf([S.BI, 7, 60], [S.FY, 7, 60], [S.KE, 7, 60]),
  );
};

/**
 * The plan names one child beside the group: NO 90 and Biologi 30. 7A holds
 * Biologi to its 30 (1 × 30) and Fysik and Kemi (1 × 45 each) to NO's 90, and
 * is met on both. 7B plans Biologi 3 × 30: Biologi is OVER (90 of 30), and a
 * post on a named child does not help the group's line, which is UNPLANNED
 * (0 of 90).
 */
const groupBesideAChild = (): PlannedCoverageInput => {
  reset();
  const c7A = theClass('7A', 7);
  const c7B = theClass('7B', 7);
  return yearOf(
    [7],
    ALL,
    [c7A, c7B],
    [post(c7A, S.BI, 1, 30), post(c7A, S.FY, 1, 45), post(c7A, S.KE, 1, 45), post(c7B, S.BI, 3, 30)],
    [],
    planOf([S.NO, 7, 90], [S.BI, 7, 30]),
  );
};

/**
 * The same children are the group's where the plan states NO and their own
 * where it names them. Åk 7's plan has NO 90 (7A: Biologi and Fysik 45 each,
 * one line, met); åk 8's has Biologi 60 and Fysik 30 (8A: Biologi 1 × 60 and
 * Fysik 1 × 30, a line each, met).
 */
const groupInOneGradeChildrenInAnother = (): PlannedCoverageInput => {
  reset();
  const c7A = theClass('7A', 7);
  const c8A = theClass('8A', 8);
  return yearOf(
    [7, 8],
    ALL,
    [c7A, c8A],
    [post(c7A, S.BI, 1, 45), post(c7A, S.FY, 1, 45), post(c8A, S.BI, 1, 60), post(c8A, S.FY, 1, 30)],
    [...pupils(c7A, 2), ...pupils(c8A, 2)],
    planOf([S.NO, 7, 90], [S.BI, 8, 60], [S.FY, 8, 30]),
  );
};

/**
 * Two subjects of a child the plan names are one line, as #249 reads equal
 * codes: Biologi 1 × 30 and Biologi fördjupning 1 × 30 against the plan's
 * Biologi 60 are 'national:BI', summed and met (7A, åk 7). Where the plan names
 * NO instead (8A, åk 8) the same two are the group's, 'national:NO', 60 of 60.
 */
const twoSubjectsOfAChild = (): PlannedCoverageInput => {
  reset();
  const c7A = theClass('7A', 7);
  const c8A = theClass('8A', 8);
  return yearOf(
    [7, 8],
    [...ALL, BIOLOGI_FORDJUPNING],
    [c7A, c8A],
    [post(c7A, S.BI, 1, 30), post(c7A, S.BIF, 1, 30), post(c8A, S.BI, 1, 30), post(c8A, S.BIF, 1, 30)],
    [],
    planOf([S.BI, 7, 60], [S.NO, 8, 60]),
  );
};

/**
 * A school with only two children of NO and a plan that names both: Biologi 45
 * and Fysik 45. 7A plans Biologi 2 × 45 and no Fysik: Biologi OVER, Fysik
 * UNPLANNED (rolled up it would have read 90 of 90 MET).
 */
const twoChildrenNamed = (): PlannedCoverageInput => {
  reset();
  const c7A = theClass('7A', 7);
  return yearOf([7], [BIOLOGI, FYSIK, MATEMATIK], [c7A], [post(c7A, S.BI, 2, 45)], [], planOf([S.BI, 7, 45], [S.FY, 7, 45]));
};

/**
 * A school that teaches NO as one subject in åk 4 and its children in åk 8
 * has one line for both, 'national:NO': 4A's NO 1 × 60 against the plan's 60,
 * 8A's Biologi 3 × 30 against the plan's 90 on NO.
 */
const groupAndChildren = (): PlannedCoverageInput => {
  reset();
  const c4A = theClass('4A', 4);
  const c8A = theClass('8A', 8);
  return yearOf(
    [4, 8],
    [NO, BIOLOGI, MATEMATIK],
    [c4A, c8A],
    [post(c4A, S.NO, 1, 60), post(c8A, S.BI, 3, 30)],
    [],
    planOf([S.NO, 4, 60], [S.NO, 8, 90]),
  );
};

/**
 * Biologi is the only subject of NO the school has: no other counted subject
 * rolls up to NO, so it keeps 'subject:<id>' with its own entry and its own
 * rows, and no line says nationalCode.
 */
const childAlone = (): PlannedCoverageInput => {
  reset();
  const c7A = theClass('7A', 7);
  return yearOf([7], [BIOLOGI, MATEMATIK], [c7A], [post(c7A, S.BI, 1, 45)], [], planOf([S.BI, 7, 45]));
};

/**
 * 7A plans nothing of NO; Biologi 7 (1 × 90, five pupils) and Fysik 7
 * (1 × 60, five pupils) carry it, so the class is read through its pupils:
 * the Fysik pupils are 60 of 90 on the one line on their own, listed with
 * their Fysik as the only source, and nobody is double planned.
 */
const pupilsThroughGroups = (): PlannedCoverageInput => {
  reset();
  const c7A = theClass('7A', 7);
  const biologi = teachingGroup('Biologi 7');
  const fysik = teachingGroup('Fysik 7');
  return yearOf(
    [7],
    ALL,
    [c7A, biologi, fysik],
    [post(biologi, S.BI, 1, 90), post(fysik, S.FY, 1, 60)],
    [...pupils(c7A, 5, [biologi]), ...pupils(c7A, 5, [fysik])],
    planOf([S.NO, 7, 90]),
  );
};

/**
 * An ersättande grupp on a child of the line. 7A plans Biologi, Fysik and Kemi
 * at 1 × 30 each, the plan's NO of 90, met by the class. 7A-val replaces Kemi
 * (its pupil reads matematik there): that pupil is off the class's Kemi and
 * only there, so they read Biologi and Fysik, 60 of 90, their own shortfall
 * and listed with the class's two other rows as sources; the other pupil reads
 * the class's 90.
 */
const replacingAChild = (): PlannedCoverageInput => {
  reset();
  const c7A = theClass('7A', 7);
  const val = replacingGroup('7A-val', S.KE);
  return yearOf(
    [7],
    ALL,
    [c7A, val],
    [post(c7A, S.BI, 1, 30), post(c7A, S.FY, 1, 30), post(c7A, S.KE, 1, 30), post(val, S.MA, 1, 30)],
    [...pupils(c7A, 1, [val]), ...pupils(c7A, 1)],
    planOf([S.NO, 7, 90]),
  );
};

/**
 * An entry of no minutes does not name a child. The plan has NO 90 and Kemi 0:
 * Kemi is not asked for, so it stays with the group, and 7A's Biologi and Fysik
 * (45 each) meet the line, which lists Kemi for its entry.
 */
const entryOfNoMinutes = (): PlannedCoverageInput => {
  reset();
  const c7A = theClass('7A', 7);
  return yearOf([7], ALL, [c7A], [post(c7A, S.BI, 1, 45), post(c7A, S.FY, 1, 45)], [], planOf([S.NO, 7, 90], [S.KE, 7, 0]));
};

/**
 * Teaching groups carry a child the plan names. The plan has Kemi 60 and 7A
 * plans no Kemi; Kemi 7 (1 × 60) holds both of 7A's pupils, so the class is read
 * through them: the Kemi line is PUPILS, not unplanned.
 */
const namedChildCarried = (): PlannedCoverageInput => {
  reset();
  const c7A = theClass('7A', 7);
  const kemi = teachingGroup('Kemi 7');
  return yearOf([7], ALL, [c7A, kemi], [post(kemi, S.KE, 1, 60)], pupils(c7A, 2, [kemi]), planOf([S.KE, 7, 60]));
};

/**
 * An ersättande grupp on a child the plan names, in a class that is short on
 * it. The plan has Kemi 60 and 7A plans Kemi 1 × 30: the class is UNDER and
 * says so once. 7A-val replaces Kemi, so its pupil has none of the class's
 * Kemi (0 of 60) and that is their own finding, listed; the other pupil, 30 of
 * 60, is short only because the class is, and is counted and not listed.
 */
const namedChildReplaced = (): PlannedCoverageInput => {
  reset();
  const c7A = theClass('7A', 7);
  const val = replacingGroup('7A-val', S.KE);
  return yearOf(
    [7],
    ALL,
    [c7A, val],
    [post(c7A, S.KE, 1, 30), post(val, S.MA, 1, 30)],
    [...pupils(c7A, 1, [val]), ...pupils(c7A, 1)],
    planOf([S.KE, 7, 60]),
  );
};

const added: { name: string; input: PlannedCoverageInput }[] = [
  {
    name: `${PREFIX} åk 7 — a target of 90 on NO is met by Biologi, Fysik and Kemi at 1 × 30 each (7A) and short with Biologi alone (7B): one line, national:NO, and no NO_TARGET beside it`,
    input: targetOnTheGroup(),
  },
  {
    name: `${PREFIX} åk 8 — NO 90 and SO 120 are two lines: 8A meets both on the children, 8B is short on NO (Fysik 60) and over on SO (Geografi, Historia, Religionskunskap and Samhällskunskap 180)`,
    input: bothGroups(),
  },
  {
    name: `${PREFIX} a plan that names the children keeps their lines — Biologi 60, Fysik 60 and Kemi 60: 7A plans no Kemi and Kemi is unplanned (rolled up it would have read 180 of 180), Biologi 2 × 60 is over`,
    input: childrenNamed(),
  },
  {
    name: `${PREFIX} NO 90 beside Biologi 30 holds Biologi to its 30 and Fysik and Kemi to NO's 90, and a post on the named child does not help the group's line — 7A meets both, 7B's Biologi 3 × 30 is over and NO is unplanned`,
    input: groupBesideAChild(),
  },
  {
    name: `${PREFIX} the same children are the group's in åk 7, where the plan states NO 90, and their own in åk 8, where it names Biologi 60 and Fysik 30`,
    input: groupInOneGradeChildrenInAnother(),
  },
  {
    name: `${PREFIX} two subjects of a child the plan names are one line, national:BI, summed (Biologi and Biologi fördjupning, 30 + 30 of 60), and the group's national:NO where the plan names NO`,
    input: twoSubjectsOfAChild(),
  },
  {
    name: `${PREFIX} a school with only Biologi and Fysik under NO and a plan that names both keeps both lines — Biologi 2 × 45 is over and Fysik is unplanned`,
    input: twoChildrenNamed(),
  },
  {
    name: `${PREFIX} an entry of no minutes does not name a child — NO 90 and Kemi 0: Kemi stays with the group and Biologi and Fysik at 45 each meet the line`,
    input: entryOfNoMinutes(),
  },
  {
    name: `${PREFIX} teaching groups carry a child the plan names — Kemi 60 read by both pupils from Kemi 7 makes the Kemi line PUPILS, not unplanned`,
    input: namedChildCarried(),
  },
  {
    name: `${PREFIX} an ersättande grupp on a child the plan names takes the pupil off the class's Kemi, and the 0 of 60 is theirs while the class's 30 of 60 is the class's`,
    input: namedChildReplaced(),
  },
  {
    name: `${PREFIX} NO taught as one subject in åk 4 and as its children in åk 8 is one line for both, national:NO, with the plan's 60 and 90 on NO`,
    input: groupAndChildren(),
  },
  {
    name: `${PREFIX} Biologi as the only subject of NO the school has keeps its own line, subject:<id>, and no nationalCode`,
    input: childAlone(),
  },
  {
    name: `${PREFIX} pupils who read the children of NO from teaching groups are on the one line — Biologi 90 for five, Fysik 60 for five: the class is read through its pupils and the Fysik pupils are 60 of 90 on their own`,
    input: pupilsThroughGroups(),
  },
  {
    name: `${PREFIX} an ersättande grupp that replaces Kemi takes the pupil off the class's Kemi and nothing else — 60 of 90 on the NO line, their own shortfall, while the class (Biologi, Fysik and Kemi at 1 × 30) meets it`,
    input: replacingAChild(),
  },
];

const out = [...kept, ...added.map(({ name, input }) => ({ name, input, coverage: computePlannedCoverage(input) }))];
fs.writeFileSync(FILE, JSON.stringify({ cases: out }, null, 1) + '\n');
console.log(`timplan-planned-cases.json: ${kept.length} kept, ${added.length} added`);
