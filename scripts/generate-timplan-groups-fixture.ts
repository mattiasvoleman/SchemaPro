/*
 * Appends the ämnesgrupp cases to the planned contract fixture, first
 * requiring every existing case to recompute byte-identically (replacing any
 * earlier copy of these, so it can be rerun).
 *
 *   npx ts-node --transpile-only scripts/generate-timplan-groups-fixture.ts
 *
 * What they pin: counted subjects whose national codes roll up to the same TOP
 * code are ONE line, 'national:<top>', the way P1 and Stadium roll them up —
 * Biologi, Fysik and Kemi (children of the ämnesgrupp NO) and Geografi,
 * Historia, Religionskunskap and Samhällskunskap (children of SO), and the
 * group's own subject with them. The line's target is the SUM of the plan's
 * entries over its subjects, a group's entry beside its children's too (NO 90
 * with Biologi, Fysik and Kemi 30 each is 180, as P1's NO cell holds all of
 * it), and what is planned is the sum of their rows. A child's minimum is not
 * judged here (P1's TIMPLAN_GROUP_MINIMUM_UNMET). A child no other counted
 * subject shares its group with keeps its own line. A pupil who reads the
 * children from several groups is on the one line; an ersättande grupp that
 * replaces a child takes the pupil off the class's rows in that child only.
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
 * The plan has NO 90 and Biologi, Fysik and Kemi 30 each: a line of 180, as
 * P1's NO cell holds everything planned under it. 7A plans 90 + 45 + 45 on the
 * children and is met; 7B plans NO 1 × 90 with Biologi and Fysik at 30
 * (150, short by 30); 7C plans the group's own subject alone, 90 of 180.
 */
const groupBesideChildren = (): PlannedCoverageInput => {
  reset();
  const c7A = theClass('7A', 7);
  const c7B = theClass('7B', 7);
  const c7C = theClass('7C', 7);
  return yearOf(
    [7],
    ALL,
    [c7A, c7B, c7C],
    [
      post(c7A, S.BI, 1, 90),
      post(c7A, S.FY, 1, 45),
      post(c7A, S.KE, 1, 45),
      post(c7B, S.NO, 1, 90),
      post(c7B, S.BI, 1, 30),
      post(c7B, S.FY, 1, 30),
      post(c7C, S.NO, 1, 90),
    ],
    [],
    planOf([S.NO, 7, 90], [S.BI, 7, 30], [S.FY, 7, 30], [S.KE, 7, 30]),
  );
};

/**
 * A school that teaches NO as one subject in åk 4 and its children in åk 8
 * has one line for both, 'national:NO': 4A's NO 1 × 60 against the plan's 60,
 * 8A's Biologi 3 × 30 against the plan's 90 on Biologi.
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
    planOf([S.NO, 4, 60], [S.BI, 8, 90]),
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
    name: `${PREFIX} an entry on the group beside entries on its children is their sum — NO 90 with Biologi, Fysik and Kemi 30 each is a line of 180, as P1's NO cell holds all of it: 7A meets it on the children, 7B plans 150, 7C the group's own 90`,
    input: groupBesideChildren(),
  },
  {
    name: `${PREFIX} NO taught as one subject in åk 4 and as its children in åk 8 is one line for both, national:NO, with the plan's 60 on NO and 90 on Biologi`,
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
