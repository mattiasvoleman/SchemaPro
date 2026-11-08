import { Role } from '../auth/enums/role.enum';
import { decisionNotice, initialStatus } from './booking-decision';

describe('initialStatus', () => {
  it('starts PENDING when approval is required and the booker is staff', () => {
    expect(initialStatus(true, Role.TEACHER)).toBe('PENDING');
  });

  it('starts APPROVED for an administrator, who decides for themselves', () => {
    expect(initialStatus(true, Role.SCHOOL_ADMIN)).toBe('APPROVED');
  });

  it('starts APPROVED when nothing requires approval, whoever books', () => {
    expect(initialStatus(false, Role.TEACHER)).toBe('APPROVED');
    expect(initialStatus(false, Role.SCHOOL_ADMIN)).toBe('APPROVED');
  });

  it('takes the role as the plain string a token carries', () => {
    expect(initialStatus(true, 'SCHOOL_ADMIN')).toBe('APPROVED');
    expect(initialStatus(true, 'TEACHER')).toBe('PENDING');
  });
});

describe('decisionNotice', () => {
  const startsAt = new Date('2026-11-10T17:00:00.000Z');

  it('says a room booking was approved, word for word as before resources existed', () => {
    const notice = decisionNotice({
      status: 'APPROVED',
      targetName: 'Aulan',
      targetKey: 'roomName',
      title: 'Föräldramöte',
      startsAt,
    });

    expect(notice.meta).toEqual({
      status: 'APPROVED',
      roomName: 'Aulan',
      title: 'Föräldramöte',
      startsAt: '2026-11-10T17:00:00.000Z',
      note: null,
    });
    expect(notice.email.subject).toBe('Room booking approved / Lokalbokning godkänd');
    expect(notice.email.body).toBe(
      'Your booking of Aulan (Föräldramöte) at 2026-11-10T17:00:00.000Z was approved.' +
        '\n\nDin bokning av Aulan (Föräldramöte) 2026-11-10T17:00:00.000Z godkändes.',
    );
  });

  it('says a room booking was rejected and carries the note in both places', () => {
    const notice = decisionNotice({
      status: 'REJECTED',
      targetName: 'Aulan',
      targetKey: 'roomName',
      title: 'Föräldramöte',
      startsAt,
      note: 'Upptagen av provskrivning',
    });

    expect(notice.meta).toMatchObject({ status: 'REJECTED', note: 'Upptagen av provskrivning' });
    expect(notice.email.subject).toBe('Room booking rejected / Lokalbokning avslagen');
    expect(notice.email.body).toBe(
      'Your booking of Aulan (Föräldramöte) at 2026-11-10T17:00:00.000Z was rejected.' +
        '\nNote: Upptagen av provskrivning' +
        '\n\nDin bokning av Aulan (Föräldramöte) 2026-11-10T17:00:00.000Z avslogs.',
    );
  });

  it('names the resource under its own key and words it as a resource booking', () => {
    const notice = decisionNotice({
      status: 'APPROVED',
      targetName: 'Minibuss',
      targetKey: 'resourceName',
      title: 'Utflykt',
      startsAt,
      note: null,
    });

    expect(notice.meta).toEqual({
      status: 'APPROVED',
      resourceName: 'Minibuss',
      title: 'Utflykt',
      startsAt: '2026-11-10T17:00:00.000Z',
      note: null,
    });
    expect(notice.meta).not.toHaveProperty('roomName');
    expect(notice.email.subject).toBe('Resource booking approved / Resursbokning godkänd');
    expect(notice.email.body).toContain('Your booking of Minibuss (Utflykt)');
    expect(notice.email.body).not.toContain('Note:');
  });

  it('words a rejected resource booking as one, and a blank note adds no line', () => {
    const notice = decisionNotice({
      status: 'REJECTED',
      targetName: 'Minibuss',
      targetKey: 'resourceName',
      title: 'Utflykt',
      startsAt,
      note: '',
    });

    expect(notice.email.subject).toBe('Resource booking rejected / Resursbokning avslagen');
    expect(notice.email.body).not.toContain('Note:');
    expect(notice.meta['note']).toBe('');
  });
});
