import { IDS } from '../../test/utils/rollover-world';
import { SUCCESSOR, givenSuccessorWorld, schoolAdmin, type SuccessorWorld } from '../../test/utils/successor-world';
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
  options: { writes?: boolean } = {},
): Promise<{ before: T; world: SuccessorWorld }> {
  const world = await givenSuccessorWorld();
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

describe('förberäknade klasslistor — every reader reads the same before and after the activation', () => {
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
