import { absenceDates, passBoardItems, passSummaryOf, type BoardCover, type PassBoardInput } from './supervision-board';

const TZ = 'Europe/Stockholm';
const ANNA = '00000000-0000-4000-8000-0000000000a1';
const BO = '00000000-0000-4000-8000-0000000000b0';
const CILLA = '00000000-0000-4000-8000-0000000000c1';
const YEAR = '00000000-0000-4000-8000-0000000000e1';
const GARD = '00000000-0000-4000-8000-0000000000f1';
const MON = '00000000-0000-4000-8000-000000000101';
const TUE = '00000000-0000-4000-8000-000000000102';

/** Anna watches the yard on Mondays 10:00–10:20 and Tuesdays 12:00–12:30; she is away Monday 19 to Tuesday 20 October. */
function input(overrides: Partial<PassBoardInput> = {}): PassBoardInput {
  return {
    window: { from: '2026-10-19', to: '2026-10-25' },
    timezone: TZ,
    absences: [{ id: 'abs-1', userId: ANNA, startsAt: new Date('2026-10-18T22:00:00Z'), endsAt: new Date('2026-10-20T22:00:00Z') }],
    shifts: [
      { id: MON, academicYearId: YEAR, areaId: GARD, userId: ANNA, dayOfWeek: 1, start: 600, end: 620, validFrom: null, validTo: null },
      { id: TUE, academicYearId: YEAR, areaId: GARD, userId: ANNA, dayOfWeek: 2, start: 720, end: 750, validFrom: null, validTo: null },
    ],
    areas: new Map([[GARD, { minGradeLevel: 0, maxGradeLevel: 3 }]]),
    years: new Map([[YEAR, { startDate: '2026-08-17', endDate: '2027-06-11' }]]),
    closures: new Map(),
    covers: [],
    vikarieAway: () => false,
    now: new Date('2026-10-19T06:00:00Z'),
    ...overrides,
  };
}

function cover(overrides: Partial<BoardCover> = {}): BoardCover {
  return {
    shiftId: MON,
    date: '2026-10-19',
    areaId: GARD,
    startsAt: new Date('2026-10-19T08:00:00Z'),
    endsAt: new Date('2026-10-19T08:20:00Z'),
    absenceId: 'abs-1',
    absentTeacherId: ANNA,
    absenceStartsAt: new Date('2026-10-18T22:00:00Z'),
    absenceEndsAt: new Date('2026-10-20T22:00:00Z'),
    decision: 'SUBSTITUTE',
    substituteId: BO,
    decidedAt: new Date('2026-10-18T19:00:00Z'),
    ...overrides,
  };
}

describe('the board’s passes', () => {
  it('lists each pass of the absent teacher on each date it runs inside the absence, open', () => {
    const items = passBoardItems(input());
    expect(items.map((item) => [item.shiftId, item.date, item.startsAt, item.status, item.absenceId])).toEqual([
      [MON, '2026-10-19', '2026-10-19T08:00:00.000Z', 'OPEN', 'abs-1'],
      [TUE, '2026-10-20', '2026-10-20T10:00:00.000Z', 'OPEN', 'abs-1'],
    ]);
    expect(items[0]).toMatchObject({ absentTeacherId: ANNA, areaId: GARD, decision: null, substituteId: null, passed: false });
  });

  it('leaves out a pass the absence does not reach by a minute, and a teacher who is not away', () => {
    // Away from 10:20 on the Monday: the pass ends as she leaves.
    const late = { id: 'abs-2', userId: ANNA, startsAt: new Date('2026-10-19T08:20:00Z'), endsAt: new Date('2026-10-19T22:00:00Z') };
    expect(passBoardItems(input({ absences: [late] }))).toEqual([]);
    const cilla = { id: 'abs-3', userId: CILLA, startsAt: new Date('2026-10-18T22:00:00Z'), endsAt: new Date('2026-10-20T22:00:00Z') };
    expect(passBoardItems(input({ absences: [cilla] }))).toEqual([]);
  });

  it('leaves out a date a lov closes the area on', () => {
    const items = passBoardItems(input({ closures: new Map([[YEAR, [{ startDate: '2026-10-19', endDate: '2026-10-19' }]]]) }));
    expect(items.map((item) => item.date)).toEqual(['2026-10-20']);
  });

  it('reads a vikarie on the pass as COVERED, NO_COVER as HANDLED, and a vikarie away as OPEN and stale', () => {
    const [covered] = passBoardItems(input({ covers: [cover()] }));
    expect(covered).toMatchObject({ status: 'COVERED', decision: 'SUBSTITUTE', substituteId: BO, decisionStale: false });
    const [handled] = passBoardItems(input({ covers: [cover({ decision: 'NO_COVER', substituteId: null })] }));
    expect(handled).toMatchObject({ status: 'HANDLED', substituteId: null });
    const asked: string[] = [];
    const [stale] = passBoardItems(
      input({
        covers: [cover()],
        vikarieAway: (id, span) => {
          asked.push(`${id}@${span.startsAt.toISOString()}`);
          return true;
        },
      }),
    );
    expect(stale).toMatchObject({ status: 'OPEN', decisionStale: true, substituteId: BO });
    expect(asked).toEqual([`${BO}@2026-10-19T08:00:00.000Z`]);
  });

  it('marks a pass that has ended as passed and counts it apart', () => {
    const items = passBoardItems(input({ now: new Date('2026-10-19T08:20:00Z') }));
    expect(items.map((item) => item.passed)).toEqual([true, false]);
    expect(passSummaryOf(items)).toEqual({ open: 1, covered: 0, handled: 0, passedOpen: 1 });
  });

  it('keeps a decision whose pass the absence no longer reaches, from its own occurrence, outside the absence', () => {
    // The absence now ends Monday 09:00 local: the Monday pass at 10:00 falls outside.
    const shortened = { id: 'abs-1', userId: ANNA, startsAt: new Date('2026-10-18T22:00:00Z'), endsAt: new Date('2026-10-19T07:00:00Z') };
    const items = passBoardItems(
      input({ absences: [shortened], covers: [cover({ absenceEndsAt: shortened.endsAt })] }),
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ shiftId: MON, date: '2026-10-19', status: 'COVERED', outsideAbsence: true, runs: true });
  });

  it('says a decision is left on a day its pass no longer runs: a lov added since, or its teacher deactivated', () => {
    const lov = new Map([[YEAR, [{ startDate: '2026-10-19', endDate: '2026-10-19' }]]]);
    const items = passBoardItems(input({ closures: lov, covers: [cover()] }));
    expect(items.map((item) => [item.date, item.status, item.runs])).toEqual([
      ['2026-10-19', 'COVERED', false],
      ['2026-10-20', 'OPEN', true],
    ]);
    const gone = input({ covers: [cover()] });
    gone.shifts = gone.shifts.map((shift) => ({ ...shift, inactiveFrom: '2026-10-19' }));
    expect(passBoardItems(gone).map((item) => [item.date, item.runs])).toEqual([['2026-10-19', false]]);
  });

  it('shows a decision left on a withdrawn absence for Ångra, and every item with its area’s name', () => {
    const left = cover({ absenceId: 'abs-old', absenceActive: false });
    const items = passBoardItems(input({ covers: [left], areas: new Map([[GARD, { minGradeLevel: 0, maxGradeLevel: 3, name: 'Skolgården' }]]) }));
    expect(items.map((item) => [item.date, item.absenceId, item.status, item.absenceActive, item.areaName])).toEqual([
      ['2026-10-19', 'abs-old', 'COVERED', false, 'Skolgården'],
      ['2026-10-20', 'abs-1', 'OPEN', true, 'Skolgården'],
    ]);
  });

  it('reads each absence’s own days when there is no window (the register’s counts)', () => {
    const items = passBoardItems(input({ window: null }));
    expect(items.map((item) => item.date)).toEqual(['2026-10-19', '2026-10-20']);
    expect(absenceDates({ startsAt: new Date('2026-10-18T22:00:00Z'), endsAt: new Date('2026-10-20T22:00:00Z') }, TZ)).toEqual({
      from: '2026-10-19',
      to: '2026-10-20',
    });
  });

  it('counts each status once', () => {
    const items = passBoardItems(input({ covers: [cover(), cover({ shiftId: TUE, date: '2026-10-20', decision: 'NO_COVER', substituteId: null })] }));
    expect(passSummaryOf(items)).toEqual({ open: 0, covered: 1, handled: 1, passedOpen: 0 });
  });
});
