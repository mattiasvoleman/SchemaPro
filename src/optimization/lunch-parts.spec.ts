import { datedMeals, MealPartsError, windowsOfMask } from './lunch-parts';
import type { AiEngineLunch } from './interfaces/ai-engine-payload.interface';
import type { PeriodStretch } from './year-periods';

/**
 * A läsår of 2026-08-15 (a Saturday) to 2027-06-11 cut into three periods by
 * what year-periods.ts says of it: the autumn to the Sunday before the
 * Christmas weeks, the two weeks between, and the spring after.
 */
const STRETCHES: PeriodStretch[][] = [
  [{ from: '2026-08-15', to: '2026-12-20' }],
  [{ from: '2026-12-21', to: '2027-01-10' }],
  [{ from: '2027-01-11', to: '2027-06-11' }],
];

const meal = (startTime: string, periods?: boolean[], day = 1): AiEngineLunch => ({
  studentGroupId: 'g-7a',
  dayOfWeek: day as AiEngineLunch['dayOfWeek'],
  startTime,
  endTime: startTime === '11:00:00' ? '11:30:00' : '12:00:00',
  ...(periods ? { periods } : {}),
});

describe('klassens måltid per del av läsåret: the answer as rows', () => {
  describe('windowsOfMask', () => {
    it('writes the läsår’s own bounds as null, never as the Saturday or the last day', () => {
      expect(windowsOfMask([true, false, false], STRETCHES)).toEqual([{ startDate: null, endDate: '2026-12-20' }]);
      expect(windowsOfMask([false, false, true], STRETCHES)).toEqual([{ startDate: '2027-01-11', endDate: null }]);
      // The weeks between hold neither bound: a Monday and a Sunday.
      expect(windowsOfMask([false, true, false], STRETCHES)).toEqual([
        { startDate: '2026-12-21', endDate: '2027-01-10' },
      ]);
    });

    it('joins periods that meet into one window and keeps the ones that do not apart', () => {
      expect(windowsOfMask([true, true, false], STRETCHES)).toEqual([{ startDate: null, endDate: '2027-01-10' }]);
      expect(windowsOfMask([false, true, true], STRETCHES)).toEqual([{ startDate: '2026-12-21', endDate: null }]);
      expect(windowsOfMask([true, false, true], STRETCHES)).toEqual([
        { startDate: null, endDate: '2026-12-20' },
        { startDate: '2027-01-11', endDate: null },
      ]);
      // Every period is the whole läsår: no dates at all.
      expect(windowsOfMask([true, true, true], STRETCHES)).toEqual([{ startDate: null, endDate: null }]);
    });

    it('reads a period of several stretches in the order of the year, whatever order the periods come in', () => {
      const apart: PeriodStretch[][] = [
        [
          { from: '2026-08-17', to: '2026-10-11' },
          { from: '2026-10-19', to: '2026-12-20' },
        ],
        [{ from: '2026-10-12', to: '2026-10-18' }],
      ];
      expect(windowsOfMask([true, false], apart)).toEqual([
        { startDate: null, endDate: '2026-10-11' },
        { startDate: '2026-10-19', endDate: null },
      ]);
      expect(windowsOfMask([true, true], apart)).toEqual([{ startDate: null, endDate: null }]);
    });

    it('refuses a mask of another length than the year has periods', () => {
      expect(() => windowsOfMask([true, false], STRETCHES)).toThrow(MealPartsError);
      expect(() => windowsOfMask([true, false, false, false], STRETCHES)).toThrow(MealPartsError);
    });
  });

  describe('datedMeals', () => {
    it('leaves a meal without a mask the whole läsår, as it was, in a year with or without periods', () => {
      for (const stretches of [null, STRETCHES, undefined]) {
        expect(datedMeals([meal('11:30:00')], stretches)).toEqual([
          { lunch: meal('11:30:00'), startDate: null, endDate: null },
        ]);
      }
    });

    it('writes a class’s two meals of one day as the rows of the weeks each is for', () => {
      const first = meal('11:30:00', [true, true, false]);
      const second = meal('11:00:00', [false, false, true]);
      expect(datedMeals([first, second], STRETCHES)).toEqual([
        { lunch: first, startDate: null, endDate: '2027-01-10' },
        { lunch: second, startDate: '2027-01-11', endDate: null },
      ]);
      // A meal whose periods are apart is a row for each run.
      const split = meal('11:30:00', [true, false, true]);
      const between = meal('11:00:00', [false, true, false]);
      expect(datedMeals([split, between], STRETCHES).map(({ lunch, startDate, endDate }) => [lunch.startTime, startDate, endDate])).toEqual([
        ['11:30:00', null, '2026-12-20'],
        ['11:30:00', '2027-01-11', null],
        ['11:00:00', '2026-12-21', '2027-01-10'],
      ]);
    });

    it('keeps a day with one meal and the other days of a class that has two apart', () => {
      const rows = datedMeals(
        [meal('11:30:00', [true, true, false]), meal('11:00:00', [false, false, true]), meal('11:00:00', undefined, 2)],
        STRETCHES,
      );
      expect(rows.map((row) => [row.lunch.dayOfWeek, row.startDate, row.endDate])).toEqual([
        [1, null, '2027-01-10'],
        [1, '2027-01-11', null],
        [2, null, null],
      ]);
    });

    it.each([
      ['a period with no meal', [meal('11:30:00', [true, false, false]), meal('11:00:00', [false, true, false])]],
      ['a period with two meals', [meal('11:30:00', [true, true, false]), meal('11:00:00', [false, true, true])]],
      ['two meals and no mask on one', [meal('11:30:00'), meal('11:00:00', [true, true, true])]],
      ['two meals and no mask on either', [meal('11:30:00'), meal('11:00:00')]],
      ['a mask of another length', [meal('11:30:00', [true, false]), meal('11:00:00', [false, true])]],
    ])('refuses %s, which would be written as a gap or a double in a child’s day', (_, lunches) => {
      expect(() => datedMeals(lunches, STRETCHES)).toThrow(MealPartsError);
    });

    it('refuses a mask in a year that has no periods', () => {
      expect(() => datedMeals([meal('11:30:00', [true, false])], null)).toThrow(MealPartsError);
    });
  });
});
