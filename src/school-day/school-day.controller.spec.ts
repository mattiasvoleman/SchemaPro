import 'reflect-metadata';
import { SchoolDayController } from './school-day.controller';
import { PER_ADDRESS, SchoolDayThrottlerGuard } from './school-day-throttler.guard';

/**
 * The two reads that build a week in the API process are limited per login (SchoolDayThrottlerGuard) and, in the
 * global guard's bucket, per address at a ceiling high enough for a school's staff behind one NAT. The metadata
 * is what @nestjs/throttler's guard reads; the settings read and write are small and keep the global limit.
 */
describe('SchoolDayController throttling', () => {
  const metadata = (handler: keyof SchoolDayController, key: 'THROTTLER:LIMITdefault' | 'THROTTLER:TTLdefault') =>
    Reflect.getMetadata(key, SchoolDayController.prototype[handler]) as number | undefined;
  const guards = (handler: keyof SchoolDayController) =>
    (Reflect.getMetadata('__guards__', SchoolDayController.prototype[handler]) as unknown[] | undefined) ?? [];

  it.each(['grid', 'free'] as const)('%s has the per-login guard and a per-address ceiling above a school\'s staff', (handler) => {
    expect(guards(handler)).toContain(SchoolDayThrottlerGuard);
    expect(metadata(handler, 'THROTTLER:LIMITdefault')).toBe(PER_ADDRESS.limit);
    expect(metadata(handler, 'THROTTLER:TTLdefault')).toBe(PER_ADDRESS.ttl);
    expect(PER_ADDRESS.limit).toBeGreaterThanOrEqual(1000);
  });

  it.each(['settings', 'updateSettings'] as const)('%s keeps the global limit', (handler) => {
    expect(guards(handler)).not.toContain(SchoolDayThrottlerGuard);
    expect(metadata(handler, 'THROTTLER:LIMITdefault')).toBeUndefined();
  });
});
