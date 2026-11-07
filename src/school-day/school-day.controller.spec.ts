import 'reflect-metadata';
import { SchoolDayController } from './school-day.controller';

/**
 * The two reads that build a week in the API process are throttled below the global ceiling, as the print of the
 * same grids is: a week of a large school weighs up to 2 MB and every teacher the school lets in reads it. The
 * metadata is what @nestjs/throttler's guard reads; the settings read and write are small and keep the global one.
 */
describe('SchoolDayController throttling', () => {
  const metadata = (handler: keyof SchoolDayController, key: 'THROTTLER:LIMITdefault' | 'THROTTLER:TTLdefault') =>
    Reflect.getMetadata(key, SchoolDayController.prototype[handler]) as number | undefined;

  it.each(['grid', 'free'] as const)('%s is throttled to 30 a minute', (handler) => {
    expect(metadata(handler, 'THROTTLER:LIMITdefault')).toBe(30);
    expect(metadata(handler, 'THROTTLER:TTLdefault')).toBe(60_000);
  });

  it.each(['settings', 'updateSettings'] as const)('%s keeps the global ceiling', (handler) => {
    expect(metadata(handler, 'THROTTLER:LIMITdefault')).toBeUndefined();
  });
});
