import type { RastRow } from '../calendar/rasts-for-span';
import { supervisionCoverage, type CoverageArea, type CoverageInput, type CoverageShift } from './supervision-coverage';

/**
 * Which breaks nobody watches (Rastvaktsschema, 20261202090000). The year is
 * the four weeks from Monday 7 September 2026 to Sunday 4 October. Lågstadiet
 * (0–3) is out 10:00–10:20 and mellanstadiet (4–6) 10:10–10:30, every day;
 * on Friday lågstadiet goes out at 10:05 instead. Lågstadiet eats 11:00–11:40
 * and mellanstadiet 11:40–12:20; the school's lunch window is 11:00–12:30.
 * The year has classes in årskurs 0 to 6.
 */

const YEAR = { startDate: '2026-09-07', endDate: '2026-10-04' };
const clock = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
const time = (value: string) => new Date(`1970-01-01T${value}:00.000Z`);

const rast = (name: string, min: number, max: number, from: string, to: string, dayOfWeek: number | null = null): RastRow => ({
  name,
  minGradeLevel: min,
  maxGradeLevel: max,
  dayOfWeek,
  startTime: time(from),
  endTime: time(to),
});
const RASTS = [
  rast('Lågstadiets rast', 0, 3, '10:00', '10:20'),
  rast('Mellanstadiets rast', 4, 6, '10:10', '10:30'),
  rast('Fredagsrast', 0, 3, '10:05', '10:25', 5),
];
const SERVINGS = [
  { minGradeLevel: 0, maxGradeLevel: 3, dayOfWeek: null, start: clock('11:00'), end: clock('11:40') },
  { minGradeLevel: 4, maxGradeLevel: 6, dayOfWeek: null, start: clock('11:40'), end: clock('12:20') },
];

const area = (id: string, rest: Partial<CoverageArea> = {}): CoverageArea => ({
  id,
  minGradeLevel: null,
  maxGradeLevel: null,
  duringRasts: true,
  duringLunch: false,
  guardsNeeded: 1,
  ...rest,
});
let next = 0;
const pass = (areaId: string, dayOfWeek: number, from: string, to: string, rest: Partial<CoverageShift> = {}): CoverageShift => ({
  id: `p${(next += 1)}`,
  areaId,
  dayOfWeek,
  start: clock(from),
  end: clock(to),
  validFrom: null,
  validTo: null,
  ...rest,
});

const GARDEN = area('garden');
const HALL = area('hall', { duringRasts: false, duringLunch: true, guardsNeeded: 2 });

const coverage = (rest: Partial<CoverageInput>) =>
  supervisionCoverage({
    year: YEAR,
    closures: [],
    areas: [GARDEN],
    rasts: RASTS,
    servings: SERVINGS,
    lunch: { start: clock('11:00'), end: clock('12:30') },
    grades: [0, 1, 2, 3, 4, 5, 6],
    shifts: [],
    ...rest,
  });
const gapsOf = (result: ReturnType<typeof coverage>, dayOfWeek: number) => result.gaps.filter((gap) => gap.dayOfWeek === dayOfWeek);

describe('supervisionCoverage: the breaks', () => {
  it('lays the stages’ overlapping rasts together, and Friday’s own row shadows the one it overlaps', () => {
    const { breaks } = coverage({});
    expect(breaks.filter((row) => row.dayOfWeek === 1)).toEqual([
      expect.objectContaining({ start: clock('10:00'), end: clock('10:30'), names: ['Lågstadiets rast', 'Mellanstadiets rast'], lunch: false, needed: 1 }),
    ]);
    expect(breaks.filter((row) => row.dayOfWeek === 5)).toEqual([
      expect.objectContaining({ start: clock('10:05'), end: clock('10:30'), names: ['Fredagsrast', 'Mellanstadiets rast'] }),
    ]);
    // Monday to Friday, and no weekend day nothing is written for.
    expect([...new Set(breaks.map((row) => row.dayOfWeek))]).toEqual([1, 2, 3, 4, 5]);
  });

  it('watches an area’s own stages only, and a span no rast reaches has no break', () => {
    const lower = coverage({ areas: [area('lower', { minGradeLevel: 0, maxGradeLevel: 3 })] });
    expect(lower.breaks.find((row) => row.dayOfWeek === 1)).toEqual(
      expect.objectContaining({ start: clock('10:00'), end: clock('10:20'), names: ['Lågstadiets rast'] }),
    );
    expect(coverage({ areas: [area('senior', { minGradeLevel: 7, maxGradeLevel: 9 })] })).toEqual({ breaks: [], gaps: [] });
  });

  it('watches the meal by the stages’ sittings, two that only touch kept apart, and the school’s window where none speaks', () => {
    const hall = coverage({ areas: [HALL] });
    expect(hall.breaks.filter((row) => row.dayOfWeek === 2)).toEqual([
      expect.objectContaining({ start: clock('11:00'), end: clock('11:40'), names: ['Lunch'], lunch: true, needed: 2 }),
      expect.objectContaining({ start: clock('11:40'), end: clock('12:20'), names: ['Lunch'], lunch: true }),
    ]);
    const senior = coverage({
      areas: [area('senior-hall', { minGradeLevel: 7, maxGradeLevel: 9, duringRasts: false, duringLunch: true })],
      grades: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    });
    expect(senior.breaks.find((row) => row.dayOfWeek === 2)).toEqual(expect.objectContaining({ start: clock('11:00'), end: clock('12:30') }));
    expect(coverage({ areas: [HALL], lunch: null }).breaks).toEqual([]);
    // A year with no class yet: every årskurs, so the window reaches the hall.
    expect(coverage({ areas: [HALL], grades: [] }).breaks.find((row) => row.dayOfWeek === 2)).toEqual(
      expect.objectContaining({ start: clock('11:00'), end: clock('12:30') }),
    );
  });
});

describe('supervisionCoverage: the gaps', () => {
  it('says nothing of a break watched all through, whoever watches which minute', () => {
    const result = coverage({
      shifts: [
        pass('garden', 1, '10:00', '10:30'),
        pass('garden', 3, '10:00', '10:15'),
        pass('garden', 3, '10:15', '10:30'),
      ],
    });
    expect(gapsOf(result, 1)).toEqual([]);
    expect(gapsOf(result, 3)).toEqual([]);
    expect(result.breaks.find((row) => row.dayOfWeek === 3)!.shiftIds).toHaveLength(2);
  });

  it('names an unwatched break for the whole year, and the first stretch a short one is short', () => {
    const result = coverage({ shifts: [pass('garden', 4, '10:00', '10:20')] });
    expect(gapsOf(result, 2)).toEqual([
      expect.objectContaining({ fewest: 0, needed: 1, shortFrom: clock('10:00'), shortTo: clock('10:30'), from: '2026-09-07', to: '2026-10-04' }),
    ]);
    expect(gapsOf(result, 4)).toEqual([expect.objectContaining({ fewest: 0, shortFrom: clock('10:20'), shortTo: clock('10:30') })]);
  });

  it('counts rastvakter at once against what the area needs', () => {
    const result = coverage({ areas: [HALL], shifts: [pass('hall', 1, '11:00', '11:40'), pass('hall', 1, '11:00', '12:20'), pass('hall', 1, '11:40', '12:20')] });
    expect(gapsOf(result, 1)).toEqual([]);
    const one = coverage({ areas: [HALL], shifts: [pass('hall', 1, '11:00', '12:20')] });
    expect(gapsOf(one, 1)).toEqual([
      expect.objectContaining({ start: clock('11:00'), end: clock('11:40'), fewest: 1, needed: 2 }),
      expect.objectContaining({ start: clock('11:40'), end: clock('12:20'), fewest: 1, needed: 2 }),
    ]);
  });

  it('dates a gap by the passes’ Från and Till', () => {
    const result = coverage({ shifts: [pass('garden', 2, '10:00', '10:30', { validFrom: '2026-09-21' })] });
    expect(gapsOf(result, 2)).toEqual([expect.objectContaining({ from: '2026-09-07', to: '2026-09-20' })]);
  });

  it('asks nothing of a stretch the whole school is closed, and tells one gap across it', () => {
    const lov = [{ startDate: '2026-09-14', endDate: '2026-09-18' }];
    const handed = coverage({
      closures: lov,
      shifts: [pass('garden', 2, '10:00', '10:30', { validTo: '2026-09-13' }), pass('garden', 2, '10:00', '10:30', { validFrom: '2026-09-19' })],
    });
    expect(gapsOf(handed, 2)).toEqual([]);
    const lovOnly = coverage({ closures: lov, shifts: [pass('garden', 2, '10:00', '10:30', { validFrom: '2026-09-14', validTo: '2026-09-18' })] });
    expect(gapsOf(lovOnly, 2)).toEqual([expect.objectContaining({ from: '2026-09-07', to: '2026-10-04' })]);
    // A lov for some grades closes an area only when it spans all the area's.
    const lower = area('lower', { minGradeLevel: 1, maxGradeLevel: 3 });
    const week = [{ startDate: '2026-09-07', endDate: '2026-10-04', minGradeLevel: 0, maxGradeLevel: 3 }];
    expect(coverage({ areas: [lower], closures: week }).gaps).toEqual([]);
    expect(coverage({ areas: [GARDEN], closures: week }).gaps).not.toEqual([]);
  });

  it('never warns where the area needs nobody', () => {
    const result = coverage({ areas: [area('corridor', { guardsNeeded: 0 })] });
    expect(result.breaks).toHaveLength(5);
    expect(result.gaps).toEqual([]);
  });
});
