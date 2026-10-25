import { createTxMock } from '../../test/utils/prisma-mock';
import type { NotificationsService } from '../notifications/notifications.service';
import { passCoverEmail, passMeta, passWithdrawnEmail, sendPassNotices, settlePassNotices, type PassNotice } from './supervision-notices';

const TZ = 'Europe/Stockholm';
const pass = { areaName: 'Lågstadiegården', startsAt: new Date('2026-10-20T08:00:00Z'), endsAt: new Date('2026-10-20T08:20:00Z') };

const notice = (kind: PassNotice['kind'], userId = 'bo', date = '2026-10-20'): PassNotice => ({
  kind,
  userId,
  shiftId: 'shift',
  date,
  areaId: 'area',
  startsAt: pass.startsAt,
  endsAt: pass.endsAt,
});

describe('what a vikarie for a rastvaktspass is told', () => {
  it('names the place and the time on the school’s clock, and nobody', () => {
    expect(passMeta(pass)).toEqual({
      areaName: 'Lågstadiegården',
      startsAt: '2026-10-20T08:00:00.000Z',
      endsAt: '2026-10-20T08:20:00.000Z',
    });
    expect(passCoverEmail(pass, TZ)).toEqual({
      subject: 'Rastvaktspass: Lågstadiegården tis 20 okt 10:00',
      body: 'Du är inbokad som rastvakt: Lågstadiegården, tis 20 okt 10:00–10:20.',
    });
    expect(passWithdrawnEmail(pass, TZ)).toEqual({
      subject: 'Rastvaktspasset är avbokat: Lågstadiegården tis 20 okt 10:00',
      body: 'Rastvaktspasset är avbokat: Lågstadiegården, tis 20 okt 10:00–10:20. Du behöver inte ta det.',
    });
  });

  it('tells each person the last word per pass, and nothing when booked and withdrawn in one write', () => {
    expect(settlePassNotices([notice('COVER'), notice('WITHDRAWN')])).toEqual([]);
    expect(settlePassNotices([notice('WITHDRAWN', 'cilla'), notice('COVER', 'bo')])).toEqual([
      notice('WITHDRAWN', 'cilla'),
      notice('COVER', 'bo'),
    ]);
    expect(settlePassNotices([notice('COVER'), notice('COVER', 'bo', '2026-10-27')])).toHaveLength(2);
  });

  it('sends one notice per person with the area read once, typed for the booking and the withdrawal', async () => {
    const tx = createTxMock();
    tx.supervisionArea.findMany.mockResolvedValue([{ id: 'area', name: 'Lågstadiegården' }]);
    const notifyUsers = jest.fn().mockResolvedValue(1);
    const notifications = { notifyUsers } as unknown as NotificationsService;
    await sendPassNotices(notifications, tx as never, 'school', TZ, [notice('COVER'), notice('WITHDRAWN', 'cilla')]);
    expect(tx.supervisionArea.findMany).toHaveBeenCalledTimes(1);
    expect(notifyUsers.mock.calls.map(([, call]) => [call.userIds, call.type, call.meta.areaName])).toEqual([
      [['bo'], 'SUPERVISION_COVER', 'Lågstadiegården'],
      [['cilla'], 'SUPERVISION_COVER_WITHDRAWN', 'Lågstadiegården'],
    ]);
    await sendPassNotices(notifications, tx as never, 'school', TZ, []);
    expect(tx.supervisionArea.findMany).toHaveBeenCalledTimes(1);
  });
});
