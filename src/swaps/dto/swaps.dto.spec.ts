import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate, type ValidationError } from 'class-validator';
import { ApplySwapDto } from './swaps.dto';

const A = '55555555-5555-4555-8555-555555555555';
const B = '66666666-6666-4666-8666-666666666666';

const slot = (startTime: string, endTime: string, dayOfWeek = 1) => ({ dayOfWeek, startTime, endTime });
const move = (lessonId: string, from = slot('08:00', '09:00'), to = slot('10:00', '11:00', 2)) => ({ lessonId, from, to });
const body = (moves: unknown[]) => ({ lessonId: A, moves });

/** The dotted path of every constraint that failed, however deeply the slot is nested. */
function paths(errors: ValidationError[], parent = ''): string[] {
  return errors.flatMap((error) => {
    const path = parent ? `${parent}.${error.property}` : error.property;
    return [...(error.constraints ? [path] : []), ...paths(error.children ?? [], path)];
  });
}
const failing = async (value: object) => paths(await validate(plainToInstance(ApplySwapDto, value)));

describe('ApplySwapDto clocks', () => {
  it('takes every clock of the day, 00:00 to 23:59', async () => {
    await expect(failing(body([move(A, slot('00:00', '00:45'), slot('23:00', '23:59')), move(B)]))).resolves.toEqual([]);
  });

  /*
   * parseTimeString wraps an hour past 23 into the next day, so "34:00" is
   * stored as 10:00. A request judged on one clock and written on another
   * double-booked a teacher; the pattern is where it stops (the service stops
   * it a second time: swaps.apply.spec.ts).
   */
  it.each(['24:00', '25:00', '34:00', '99:99', '12:60', '08:75', '8:00', '08:00:00', '0800', ' 08:00', '08:00 ', ''])(
    'refuses %p as the new start, the new end, the old start and the old end',
    async (clock) => {
      expect(await failing(body([move(A, slot('08:00', '09:00'), slot(clock, '11:00')), move(B)]))).toEqual(['moves.0.to.startTime']);
      expect(await failing(body([move(A, slot('08:00', '09:00'), slot('10:00', clock)), move(B)]))).toEqual(['moves.0.to.endTime']);
      expect(await failing(body([move(A, slot(clock, '09:00'), slot('10:00', '11:00')), move(B)]))).toEqual(['moves.0.from.startTime']);
      expect(await failing(body([move(A, slot('08:00', clock), slot('10:00', '11:00')), move(B)]))).toEqual(['moves.0.from.endTime']);
    },
  );
});
