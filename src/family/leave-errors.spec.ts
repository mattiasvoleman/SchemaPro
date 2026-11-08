import { leaveSqlStateOf, tooLateDaysOf } from './leave-errors';

/**
 * What a refusal of Ledighetspolicyn's triggers and functions looks like once the adapter has passed it on, and the two
 * numbers read out of it. A refusal that comes back unrecognised is a 500, so each way of carrying the SQLSTATE is held:
 * the adapter's cause, the rendered code in the message, and the text the trigger raised.
 */
const adapterError = (cause: Record<string, unknown>): Error => Object.assign(new Error('database refused'), { meta: { driverAdapterError: { cause } } });

describe('leaveSqlStateOf', () => {
  it('reads the SQLSTATE the adapter reports in the cause, first', () => {
    expect(leaveSqlStateOf(adapterError({ originalCode: 'LV409' }))).toBe('LV409');
    expect(leaveSqlStateOf(adapterError({ originalCode: 'LV412', originalMessage: 'LEAVE_REQUEST_TOO_LATE' }))).toBe('LV412');
  });

  it('reads the code rendered in a message when the cause carries none', () => {
    expect(leaveSqlStateOf(new Error('Invalid `prisma.leaveRequest.updateMany()` invocation: Code: `LV409`. Message: ...'))).toBe('LV409');
  });

  it.each([
    ['LEAVE_AWAITING_CONSENT', 'LV412'],
    ['LEAVE_REQUEST_TOO_LATE', 'LV413'],
    ['LEAVE_CONTACT_REQUIRED', 'LV414'],
    ['LEAVE_CONTACT_INCOMPLETE', 'LV415'],
  ])('reads %s from the text a trigger raised, when no code came with it: %s', (text, state) => {
    expect(leaveSqlStateOf(new Error(`ERROR: ${text}`))).toBe(state);
  });

  it('knows nothing of any other error', () => {
    expect(leaveSqlStateOf(new Error('connection reset'))).toBeNull();
    expect(leaveSqlStateOf(adapterError({}))).toBeNull();
    expect(leaveSqlStateOf(null)).toBeNull();
    expect(leaveSqlStateOf('LV412')).toBeNull();
  });
});

describe('tooLateDaysOf', () => {
  it.each([[7], [14], [90]])('reads the whole minimum of %i days, not its first digit', (days) => {
    expect(tooLateDaysOf(adapterError({ detail: `days=${days}` }))).toBe(days);
    expect(tooLateDaysOf(new Error(`LEAVE_REQUEST_TOO_LATE days=${days}`))).toBe(days);
  });

  it('reads it from the message the adapter keeps when the cause has no detail, and gives up quietly otherwise', () => {
    expect(tooLateDaysOf(adapterError({ originalMessage: 'LEAVE_REQUEST_TOO_LATE DETAIL: days=21' }))).toBe(21);
    expect(tooLateDaysOf(adapterError({}))).toBeNull();
    expect(tooLateDaysOf(new Error('no number here'))).toBeNull();
  });
});
