import { BadRequestException } from '@nestjs/common';
import { parseDateString, parseTimeString, zonedTimeToUtc } from './time';

describe('parseTimeString', () => {
  it('parses HH:MM into a UTC-epoch-day Date', () => {
    const parsed = parseTimeString('09:30');
    expect(parsed.toISOString()).toBe('1970-01-01T09:30:00.000Z');
  });

  it('parses HH:MM:SS including the seconds component', () => {
    expect(parseTimeString('23:59:59').toISOString()).toBe(
      '1970-01-01T23:59:59.000Z',
    );
  });

  it('defaults seconds to zero when omitted', () => {
    expect(parseTimeString('08:00').getUTCSeconds()).toBe(0);
  });

  it.each(['9:30', '09:30:', '0930', '', '09:30:00.500', 'aa:bb'])(
    'rejects malformed input %p',
    (input) => {
      expect(() => parseTimeString(input)).toThrow(BadRequestException);
    },
  );

  it('names the offending value in the error message', () => {
    expect(() => parseTimeString('25-00')).toThrow(
      'Invalid time: 25-00. Expected HH:MM.',
    );
  });
});

describe('parseDateString', () => {
  it('parses YYYY-MM-DD at midnight UTC', () => {
    expect(parseDateString('2026-08-05').toISOString()).toBe(
      '2026-08-05T00:00:00.000Z',
    );
  });

  it.each(['2026-8-05', '05/08/2026', '2026-08-05T00:00:00Z', ''])(
    'rejects malformed input %p',
    (input) => {
      expect(() => parseDateString(input)).toThrow(BadRequestException);
    },
  );

  it('rejects a well-formed but non-existent calendar date', () => {
    // Shape passes the regex; Date.parse yields NaN — the second guard fires.
    expect(() => parseDateString('2026-13-45')).toThrow(
      'Invalid date: 2026-13-45.',
    );
  });
});

describe('zonedTimeToUtc', () => {
  it('treats the wall-clock time as local to the given zone (winter, UTC+1)', () => {
    expect(zonedTimeToUtc('2026-01-15', '09:00', 'Europe/Stockholm')).toEqual(
      new Date('2026-01-15T08:00:00.000Z'),
    );
  });

  it('applies daylight saving in summer (UTC+2)', () => {
    expect(zonedTimeToUtc('2026-07-15', '09:00', 'Europe/Stockholm')).toEqual(
      new Date('2026-07-15T07:00:00.000Z'),
    );
  });

  it('resolves times on the spring-forward day using the post-transition offset', () => {
    // EU DST starts 2026-03-29 at 01:00 UTC; 10:00 local is already CEST.
    expect(zonedTimeToUtc('2026-03-29', '10:00', 'Europe/Stockholm')).toEqual(
      new Date('2026-03-29T08:00:00.000Z'),
    );
  });

  it('resolves times on the fall-back day using the post-transition offset', () => {
    // EU DST ends 2026-10-25 at 01:00 UTC; 10:00 local is back on CET.
    expect(zonedTimeToUtc('2026-10-25', '10:00', 'Europe/Stockholm')).toEqual(
      new Date('2026-10-25T09:00:00.000Z'),
    );
  });

  it('accepts HH:MM:SS as well as HH:MM', () => {
    expect(
      zonedTimeToUtc('2026-01-15', '09:00:30', 'Europe/Stockholm'),
    ).toEqual(new Date('2026-01-15T08:00:30.000Z'));
  });

  it('is a no-op shift for UTC itself', () => {
    expect(zonedTimeToUtc('2026-01-15', '09:00', 'UTC')).toEqual(
      new Date('2026-01-15T09:00:00.000Z'),
    );
  });

  it('handles zones west of Greenwich', () => {
    // 2026-01-15 09:00 in New York (EST, UTC-5) is 14:00 UTC.
    expect(zonedTimeToUtc('2026-01-15', '09:00', 'America/New_York')).toEqual(
      new Date('2026-01-15T14:00:00.000Z'),
    );
  });

  it('handles a midnight wall-clock crossing the date line backwards', () => {
    // 00:30 local in Stockholm (UTC+1) is 23:30 UTC the previous day.
    expect(zonedTimeToUtc('2026-01-15', '00:30', 'Europe/Stockholm')).toEqual(
      new Date('2026-01-14T23:30:00.000Z'),
    );
  });
});
