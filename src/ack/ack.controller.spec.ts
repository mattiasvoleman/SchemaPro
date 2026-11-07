import { AckController } from './ack.controller';

/**
 * A request for a guardian's confirmation is up to 4 000 notices, so the route that writes one is
 * throttled on its own beside the database's limit of ten an hour for a person and 20 000 receipts
 * a day for a school (migration 20270117091000). The other routes keep the general limit.
 */
describe('AckController throttling', () => {
  const proto = AckController.prototype as unknown as Record<string, object>;

  it('lets one caller write five requests a minute', () => {
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', proto['create']!)).toBe(5);
    expect(Reflect.getMetadata('THROTTLER:TTLdefault', proto['create']!)).toBe(60_000);
  });

  it.each(['settings', 'updateSettings', 'pupils', 'mine', 'list', 'detail', 'confirm', 'stopReminder'])(
    'leaves %s at the general limit',
    (route) => {
      expect(Reflect.getMetadata('THROTTLER:LIMITdefault', proto[route]!)).toBeUndefined();
    },
  );
});
