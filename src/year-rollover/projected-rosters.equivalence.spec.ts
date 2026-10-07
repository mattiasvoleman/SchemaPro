import { IDS } from '../../test/utils/rollover-world';
import { SUCCESSOR, givenSuccessorWorld, schoolAdmin, type SuccessorWorld } from '../../test/utils/successor-world';
import type { ConfigService } from '@nestjs/config';
import type { HttpService } from '@nestjs/axios';
import { MasterLessonsService } from '../calendar/master-lessons.service';
import type { NotificationsService } from '../notifications/notifications.service';
import { OptimizationProxyService } from '../optimization/optimization-proxy.service';
import { RoomOptimizationService } from '../optimization/room-optimization.service';
import type { ScheduleVersionsService } from '../calendar/schedule-versions.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { LunchSittingsService } from '../resources/lunch-sittings.service';
import { readLoadInput } from '../staffing/load-input';
import { attendanceSpan } from '../staffing/staffing-enforcement';
import { StaffingLoadService } from '../staffing/staffing-load.service';
import { readPlannedInput } from '../timplan/timplan-coverage.service';
import * as projected from './projected-rosters';
import { readHomePupils, rostersOfYear, type RosterBasis } from './projected-rosters';

/**
 * FÖRBERÄKNADE KLASSLISTOR, PROVED READER BY READER.
 *
 * For each roster reader: what it computes for B (rolled, not activated)
 * BEFORE the activation, on the projected rosters, equals what it computes
 * AFTER YearRolloverService.executeActivation has really moved the pupils —
 * on the fixture of test/utils/successor-world.ts, in a strict world that
 * evaluates every relation filter the readers use and throws on any it
 * cannot.
 *
 * Both sides share planMoves by design — that is what "one projection"
 * means — so equality alone could be a tautology. Four other things are
 * proved with it:
 *
 *  - the basis is PROJECTED before and CURRENT after, as rostersOfYear
 *    resolves it from the year's flags, never forced;
 *  - NON-VACUITY: the same reader before the activation on a forced CURRENT
 *    basis reads something else, so every row depends on the overlay;
 *  - a literal, hand-written oracle of B's class lists, which a planMoves bug
 *    both sides shared would fail;
 *  - the active year A reads the same as on a forced CURRENT basis.
 */

const CURRENT: RosterBasis = { kind: 'CURRENT' };

/** Runs a read and says which bases rostersOfYear handed it; `force` replaces them. */
async function observed<T>(read: () => Promise<T>, force?: RosterBasis): Promise<{ value: T; kinds: string[] }> {
  const spy = jest.spyOn(projected, 'rostersOfYear');
  if (force) spy.mockResolvedValue(force);
  try {
    const value = await read();
    const bases = (await Promise.all(spy.mock.results.map((result) => result.value))) as RosterBasis[];
    return { value, kinds: bases.map((basis) => basis.kind) };
  } finally {
    spy.mockRestore();
  }
}

const writesIn = (world: SuccessorWorld['world']) =>
  world.calls.filter((call) => !/^(find|count|aggregate|groupBy|\$queryRaw)/.test(call.method));

/**
 * The proof for one reader. `read` computes the reader's output for B,
 * canonical (sorted, ids only); it is called before the activation (and
 * again on a forced CURRENT basis), then after it.
 */
async function proveEquivalent<T>(
  read: (world: SuccessorWorld) => Promise<T>,
  options: { writes?: boolean; setup?: (world: SuccessorWorld) => void } = {},
): Promise<{ before: T; world: SuccessorWorld }> {
  const world = await givenSuccessorWorld();
  options.setup?.(world);
  world.world.calls.length = 0;
  const before = await observed(() => read(world));
  expect(before.kinds.length).toBeGreaterThan(0);
  expect(new Set(before.kinds)).toEqual(new Set(['PROJECTED']));
  if (!options.writes) expect(writesIn(world.world)).toEqual([]);

  const forced = await observed(() => read(world), CURRENT);
  expect(forced.value).not.toEqual(before.value);

  await world.activate();
  const after = await observed(() => read(world));
  expect(new Set(after.kinds)).toEqual(new Set(['CURRENT']));
  expect(after.value).toEqual(before.value);
  return { before: before.value, world };
}

/** The year's flags as a reader that read its row would hand them over. */
const flagsOf = (world: SuccessorWorld, yearId: string) => {
  const row = world.world.rows['academicYear']!.find((year) => year['id'] === yearId)!;
  return { isActive: row['isActive'] as boolean, predecessorId: row['predecessorId'] as string | null };
};

const sortedBy = <T>(list: T[], key: (item: T) => string): T[] => [...list].sort((a, b) => (key(a) < key(b) ? -1 : 1));

describe('förberäknade klasslistor — the oracle', () => {
  it('B’s classes hold, before the activation and after it, exactly the pupils written here by hand', async () => {
    const world = await givenSuccessorWorld();
    const classes = ['8A', '9A'].map((name) => world.b(name));
    const lists = async () => {
      const basis = await rostersOfYear(world.world.tx, schoolAdmin, world.yearB);
      const rows = await readHomePupils(world.world.tx, basis, { role: 'STUDENT', isActive: true }, classes);
      return {
        basis: basis.kind,
        '8A': rows.filter((row) => row.studentGroupId === world.b('8A')).map((row) => row.id).sort(),
        '9A': rows.filter((row) => row.studentGroupId === world.b('9A')).map((row) => row.id).sort(),
      };
    };
    // 7A's two, p7b1 and p7c1 who moved into 7A this spring, and pNew, enrolled
    // straight into 8A. 8A's p8a1; not p8a2, who moved into the graduating 9A.
    // Nobody from 7B (its successor is a teaching group now) or the skipped 7C,
    // not the inactive pGone, not the graduates.
    const oracle = {
      '8A': [IDS.p7a1, IDS.p7a2, SUCCESSOR.p7b1, SUCCESSOR.p7c1, SUCCESSOR.pNew].sort(),
      '9A': [IDS.p8a1],
    };
    expect(await lists()).toEqual({ basis: 'PROJECTED', ...oracle });
    await world.activate();
    expect(await lists()).toEqual({ basis: 'CURRENT', ...oracle });
    // And nobody else's class changed: pGone in A's 7A, the others where they were.
    const homeOf = (id: string) => world.world.rows['user']!.find((user) => user['id'] === id)!['studentGroupId'];
    expect(homeOf(IDS.pGone)).toBe(IDS.g7a);
    expect(homeOf(SUCCESSOR.pSummer)).toBe(SUCCESSOR.gSummer);
    expect(homeOf(SUCCESSOR.pNone)).toBeNull();
    for (const id of [IDS.p9a1, SUCCESSOR.p8a2, SUCCESSOR.p7b2, SUCCESSOR.p7c2]) expect(homeOf(id)).toBeNull();
  });
});

/**
 * The generator's payload with nothing in it that depends on the order the
 * rosters were read in. Every anonymous id the proxy hands back a map for is
 * turned back into the real id; randomUUID is pinned to a counter, so the
 * ids it keeps to itself (teachers, subjects, a fixed lesson's own) come out
 * in the order the requirements are read, which the activation does not
 * change; and every list the rosters order is sorted.
 */
async function generatorPayload(world: SuccessorWorld): Promise<unknown> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeCrypto = require('node:crypto') as { randomUUID: () => string };
  let counter = 0;
  const pinned = jest
    .spyOn(nodeCrypto, 'randomUUID')
    .mockImplementation(() => `anon-${String(++counter).padStart(4, '0')}`);
  try {
    const proxy = new OptimizationProxyService(
      world.prisma,
      {} as HttpService,
      { getOrThrow: () => ({ url: 'http://engine.invalid', apiKey: 'k', timeoutMs: 1 }) } as unknown as ConfigService,
    );
    // The basis exactly as triggerScheduling asks for it: no flags known.
    const basis = await rostersOfYear(world.world.tx, schoolAdmin, world.yearB);
    const data = await (
      proxy as unknown as {
        fetchAndAnonymize: (...args: unknown[]) => Promise<Record<string, unknown>>;
      }
    ).fetchAndAnonymize(world.world.tx, world.yearB, IDS.school, basis);
    const real = new Map<string, string>();
    for (const key of ['groupAnonMap', 'requirementAnonMap', 'roomAnonMap', 'roomTypeAnonMap', 'constraintAnonMap', 'workRuleAnonMap']) {
      for (const [id, anon] of data[key] as Map<string, string>) real.set(anon, id);
    }
    const back = (value: unknown): unknown => {
      if (typeof value === 'string') return real.get(value) ?? value;
      if (Array.isArray(value)) return value.map(back);
      if (value instanceof Map) return [...value].map(back);
      if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, back(entry)]));
      }
      return value;
    };
    const payload = back({
      requirements: data['requirements'],
      groups: data['groups'],
      groupConflicts: data['groupConflicts'],
      fixedLessons: data['fixedLessons'],
      previousLessons: data['previousLessons'],
      rooms: data['rooms'],
      constraints: data['constraints'],
      frameTimes: data['frameTimes'],
      rasts: data['rasts'],
      lunchServings: data['lunchServings'],
      lunchPlacements: data['lunchPlacements'],
      teacherWorkRules: data['teacherWorkRules'],
      storedRules: data['storedRules'],
    }) as Record<string, unknown[]>;
    const byKey = (list: unknown[]) => sortedBy(list, (item) => JSON.stringify(item));
    return {
      ...payload,
      requirements: byKey(payload['requirements']!),
      groups: byKey(payload['groups']!),
      groupConflicts: byKey((payload['groupConflicts'] as string[][]).map((pair) => [...pair].sort())),
      fixedLessons: byKey(payload['fixedLessons']!),
      headcountByGroup: sortedBy([...(data['headcountByGroup'] as Map<string, number>)], ([id]) => id),
    };
  } finally {
    pinned.mockRestore();
  }
}

describe('förberäknade klasslistor — every reader reads the same before and after the activation', () => {
  it('P1 the generator’s payload: group sizes, grade spans, clash pairs and lunch headcounts', async () => {
    const { before, world } = await proveEquivalent(generatorPayload);
    const payload = before as {
      requirements: { id: string; studentGroupId: string; studentGroupSize: number; minGradeLevel: number | null; maxGradeLevel: number | null }[];
      groupConflicts: string[][];
      groups: { id: string; lunchHeadcount: number }[];
      headcountByGroup: [string, number][];
    };
    const [g8a, g9a, ma8] = [world.b('8A'), world.b('9A'), world.b('Ma8 grupp 1')];
    // 8A seats its five coming pupils, Ma8 its four active members over åk 8–9.
    expect(payload.requirements.find((row) => row.studentGroupId === g8a)).toMatchObject({ studentGroupSize: 5, minGradeLevel: 8, maxGradeLevel: 8 });
    expect(payload.requirements.find((row) => row.studentGroupId === ma8)).toMatchObject({ studentGroupSize: 4, minGradeLevel: 8, maxGradeLevel: 9 });
    expect(payload.groupConflicts).toEqual(expect.arrayContaining([[g8a, ma8].sort(), [g9a, ma8].sort()]));
    expect(payload.headcountByGroup).toEqual(sortedBy([[g8a, 5], [g9a, 1]] as [string, number][], ([id]) => id));
  });

  it('P3 room optimisation: each lesson’s needs, and the basis hash a proposal is applied against', async () => {
    const { before } = await proveEquivalent(async (world) => {
      const service = new RoomOptimizationService(
        world.prisma,
        {} as OptimizationProxyService,
        {} as ScheduleVersionsService,
        {} as RealtimeService,
      );
      const state = await (
        service as unknown as { readYear: (...args: unknown[]) => Promise<{ needs: Map<string, unknown> }> }
      ).readYear(world.world.tx, schoolAdmin, world.yearB);
      // With no rooms the proposal is answered without the engine: its basis.
      const proposal = await service.propose({ academicYearId: world.yearB, walkers: 'BOTH' } as never, schoolAdmin);
      return { needs: sortedBy([...state.needs], ([id]) => id), basis: proposal.basis };
    });
    const needs = new Map(before.needs as [string, { studentGroupSize: number; minGradeLevel: number | null; maxGradeLevel: number | null }][]);
    // Ma8's Monday lesson: four members, åk 8–9. The lesson naming p9a1, who
    // graduates, on 9A: 9A's one coming pupil, and p9a1 with no class.
    expect(needs.get(SUCCESSOR.lessonMa8)).toMatchObject({ studentGroupSize: 4, minGradeLevel: 8, maxGradeLevel: 9 });
    expect(needs.get(SUCCESSOR.lessonNamed)).toMatchObject({ studentGroupSize: 2, minGradeLevel: 9, maxGradeLevel: 9 });
  });

  it('P3 a room proposal made before the activation applies after it: the basis it was made on is the basis after', async () => {
    const world = await givenSuccessorWorld();
    const [r1, r2] = ['f4000000-0000-4000-8000-000000000001', 'f4000000-0000-4000-8000-000000000002'];
    const room = (id: string) => ({ id, schoolId: IDS.school, capacity: 30, roomTypeId: null, minGradeLevel: null, maxGradeLevel: null, building: null, floor: null });
    world.world.rows['room'] = [room(r1), room(r2)];
    // The unlocked lesson naming p9a1: its needs come from the rosters.
    world.world.rows['masterLesson']!.find((lesson) => lesson['id'] === SUCCESSOR.lessonNamed)!['roomId'] = r1;
    const engine = {
      callAiEngine: jest.fn(async (_path: string, payload: { lessons: { id: string; roomId: string | null }[]; rooms: { id: string }[] }) => {
        const lesson = payload.lessons.find((candidate) => candidate.roomId !== null)!;
        const other = payload.rooms.find((candidate) => candidate.id !== lesson.roomId)!;
        const none = { roomChanges: 0, floorChanges: 0, buildingChanges: 0 };
        return {
          requestId: 'r',
          status: 'OPTIMAL',
          changes: [{ lessonId: lesson.id, roomId: other.id }],
          teachers: { before: none, after: none },
          groups: { before: none, after: none },
          missedWishes: { before: 0, after: 0 },
          walkers: [],
          frozenLessonIds: [],
        };
      }),
    };
    const service = new RoomOptimizationService(
      world.prisma,
      engine as unknown as OptimizationProxyService,
      { snapshotInTransaction: jest.fn(async () => ({ id: 'version' })) } as unknown as ScheduleVersionsService,
      { notifyMasterTimetableChanged: jest.fn() } as unknown as RealtimeService,
    );
    const proposal = await observed(() => service.propose({ academicYearId: world.yearB, walkers: 'BOTH' } as never, schoolAdmin));
    expect(proposal.kinds).toEqual(['PROJECTED']);
    expect(proposal.value.changes).toEqual([expect.objectContaining({ lessonId: SUCCESSOR.lessonNamed, fromRoomId: r1, toRoomId: r2 })]);

    await world.activate();
    const applied = await observed(() =>
      service.apply(
        {
          academicYearId: world.yearB,
          basis: proposal.value.basis,
          changes: proposal.value.changes.map((change) => ({ lessonId: change.lessonId, fromRoomId: change.fromRoomId, toRoomId: change.toRoomId })),
        } as never,
        schoolAdmin,
      ),
    );
    expect(applied.kinds).toEqual(['CURRENT']);
    expect(applied.value).toMatchObject({ updated: 1 });
    expect(world.world.rows['masterLesson']!.find((lesson) => lesson['id'] === SUCCESSOR.lessonNamed)!['roomId']).toBe(r2);
  });

  it('P4 master lessons: the clashes a lesson placed by hand meets, and who sits in each group', async () => {
    const minutes = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3));
    const { before, world } = await proveEquivalent(
      async (world) => {
        const service = new MasterLessonsService(world.prisma, {} as RealtimeService, {} as NotificationsService);
        const internals = service as unknown as {
          findConflicts: (...args: unknown[]) => Promise<{ kind: string; message: string; masterLessonId?: string }[]>;
          rosterOf: (...args: unknown[]) => Promise<Map<string, Set<string>>>;
        };
        // As create asks for it: the flags off the year row it reads.
        const basis = await rostersOfYear(world.world.tx, schoolAdmin, world.yearB, flagsOf(world, world.yearB));
        const candidates = [
          // 8A against Ma8's Monday lesson: the pupils they share (rosterOf).
          { group: world.b('8A'), dayOfWeek: 1, studentIds: [] as string[] },
          // 8A against 9A's Tuesday lesson, which names p7a2 — coming to 8A (the reverse count).
          { group: world.b('8A'), dayOfWeek: 2, studentIds: [] },
          // Ma8 naming p8a1 — coming to 9A — against the same lesson (a participant's home class).
          { group: world.b('Ma8 grupp 1'), dayOfWeek: 2, studentIds: [IDS.p8a1] },
        ];
        const found = [];
        for (const [index, candidate] of candidates.entries()) {
          const conflicts = await internals.findConflicts(
            world.world.tx,
            basis,
            { id: null, academicYearId: world.yearB, studentGroupId: candidate.group, subjectId: IDS.sv },
            {
              dayOfWeek: candidate.dayOfWeek,
              startMinutes: minutes('08:00'),
              endMinutes: minutes('09:00'),
              teacherId: null,
              roomId: null,
              studentIds: candidate.studentIds,
            },
          );
          found.push(...conflicts.map((conflict) => [index, conflict.kind, conflict.message, conflict.masterLessonId]));
        }
        const roster = await internals.rosterOf(world.world.tx, basis, new Set(['8A', '9A', 'Ma8 grupp 1'].map(world.b)));
        return {
          conflicts: sortedBy(found, (row) => JSON.stringify(row)),
          roster: sortedBy([...roster].map(([group, ids]) => [group, [...ids].sort()]), (row) => row[0] as string),
        };
      },
      {
        setup: (world) => {
          world.world.rows['masterLesson']!.find((lesson) => lesson['id'] === SUCCESSOR.lessonNamed)!['participants'] = [
            { studentId: IDS.p9a1 },
            { studentId: IDS.p7a2 },
          ];
        },
      },
    );
    expect(before.conflicts).toEqual([
      [0, 'GROUP', 'Students of this group already have Matematik in this slot.', SUCCESSOR.lessonMa8],
      [1, 'GROUP', 'A student of this class attends Matematik in this slot.', SUCCESSOR.lessonNamed],
      [2, 'GROUP', 'A participating student already has Matematik in this slot.', SUCCESSOR.lessonNamed],
      [2, 'GROUP', 'Students of this group already have Matematik in this slot.', SUCCESSOR.lessonNamed],
    ]);
    // rosterOf has no role or isActive filter of its own: the inactive pGone
    // is in Ma8 before the activation as after it.
    const roster = new Map(before.roster as [string, string[]][]);
    expect(roster.get(world.b('Ma8 grupp 1'))).toContain(IDS.pGone);
    expect(roster.get(world.b('8A'))).toEqual([IDS.p7a1, IDS.p7a2, SUCCESSOR.p7b1, SUCCESSOR.p7c1, SUCCESSOR.pNew].sort());
  });

  it('P5 attendanceSpan (the vikarie badge and warning): Ma8 spans 8–9 from its members’ coming classes', async () => {
    const { before } = await proveEquivalent((world) =>
      attendanceSpan(world.world.tx, {
        academicYearId: world.yearB,
        groupIds: [world.b('Ma8 grupp 1')],
        rosters: { viewer: schoolAdmin, known: flagsOf(world, world.yearB) },
      }),
    );
    expect(before).toEqual({ min: 8, max: 9 });
  });

  it('P6 readLoadInput and suggest-teachers: the spans the load report, the picker and the requirement checks judge by', async () => {
    const { before } = await proveEquivalent(async (world) => {
      const read = await readLoadInput(world.world.tx, schoolAdmin, world.yearB, IDS.school, {
        alsoGroupIds: [world.b('Ma8 grupp 1')],
      });
      const ma8 = world.world.rows['teachingRequirement']!.find(
        (row) => row['academicYearId'] === world.yearB && row['studentGroupId'] === world.b('Ma8 grupp 1'),
      )!;
      const suggestions = await new StaffingLoadService(world.prisma).suggestTeachers(ma8['id'] as string, schoolAdmin);
      return {
        spans: sortedBy(read!.input.requirements, (row) => row.id).map((row) => [row.id, row.gradeSpan]),
        ma8: read!.spanOf([world.b('Ma8 grupp 1')]),
        suggestions: { gradeSpan: suggestions.gradeSpan, candidates: sortedBy(suggestions.candidates, (row) => row.userId) },
      };
    });
    expect(before.ma8).toEqual({ min: 8, max: 9 });
    // Anna is behörig for åk 8 only, and Ma8 holds an åk 9 pupil.
    expect(before.suggestions.candidates.find((row) => row.userId === IDS.anna)?.qualificationKind).toBeNull();
  });

  it('P7 lunch place: a meal placed by hand for 8A seats its five coming pupils', async () => {
    const { before } = await proveEquivalent(
      async (world) =>
        (
          await new LunchSittingsService(world.prisma).place(
            { academicYearId: world.yearB, studentGroupId: world.b('8A'), dayOfWeek: 1, startTime: '11:00' },
            schoolAdmin,
          )
        ).headcount,
      { writes: true },
    );
    expect(before).toBe(5);
  });

  it('P8 timplan coverage: the pupils, their coming home classes and their teaching groups', async () => {
    const { before } = await proveEquivalent(async (world) => {
      const input = await readPlannedInput(world.world.tx, schoolAdmin, world.yearB, true);
      return sortedBy(input!.pupils, (pupil) => pupil.id).map((pupil) => ({ ...pupil, groupIds: [...pupil.groupIds].sort() }));
    });
    // p8a2 graduates but is still in Ma8: a member with no class, as after.
    expect(before.find((pupil) => pupil.id === SUCCESSOR.p8a2)).toMatchObject({ homeGroupId: null });
    expect(before.filter((pupil) => pupil.homeGroupId !== null)).toHaveLength(6);
  });
});

describe('förberäknade klasslistor — the active year is read as it always was', () => {
  it('A reads the same through rostersOfYear as on a forced CURRENT basis, with no statement for the basis', async () => {
    const world = await givenSuccessorWorld();
    const readA = async () => ({
      span: await attendanceSpan(world.world.tx, {
        academicYearId: IDS.yearA,
        groupIds: [IDS.gMa7],
        rosters: { viewer: schoolAdmin, known: { isActive: true, predecessorId: null } },
      }),
      load: (await readLoadInput(world.world.tx, schoolAdmin, IDS.yearA, IDS.school))!.input.requirements.map((row) => [
        row.id,
        row.gradeSpan,
      ]),
      coverage: (await readPlannedInput(world.world.tx, schoolAdmin, IDS.yearA, true))!.pupils,
    });
    world.world.calls.length = 0;
    const real = await observed(readA);
    expect(new Set(real.kinds)).toEqual(new Set(['CURRENT']));
    // Decided from the flags each reader already read: no year list, no
    // school-wide pupil or membership read for the basis.
    expect(world.world.calls.filter((call) => call.model === 'academicYear' && call.method !== 'findUnique')).toEqual([]);
    expect(
      world.world.calls.filter((call) => call.model === 'studentGroupMember' && !(call.args as { where?: unknown } | null)?.where),
    ).toEqual([]);
    const forced = await observed(readA, CURRENT);
    expect(real.value).toEqual(forced.value);
  });
});
