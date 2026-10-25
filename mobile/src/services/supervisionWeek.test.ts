import { ApiError, apiRequest } from './api';
import { fetchSupervisionWeek, passCardsOf, type WeekPass } from './supervisionWeek';

jest.mock('./api', () => ({
  apiRequest: jest.fn(),
  // The real class's shape: a status and maybe a code.
  ApiError: class extends Error {
    status: number;
    code?: string;
    constructor(status: number, message: string, code?: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
}));

const pass = (over: Partial<WeekPass> = {}): WeekPass => ({
  kind: 'OWN',
  shiftId: 's-1',
  date: '2026-10-19',
  startsAt: '2026-10-19T08:00:00.000Z',
  endsAt: '2026-10-19T08:20:00.000Z',
  areaName: 'Skolgården',
  siteName: 'Norra',
  handover: null,
  ...over,
});

describe('fetchSupervisionWeek', () => {
  it('asks the gateway for the signed-in teacher’s passes over the days, and nothing about anybody else', async () => {
    (apiRequest as jest.Mock).mockResolvedValue({ from: '2026-10-19', to: '2026-10-26', passes: [pass()] });
    await expect(fetchSupervisionWeek('2026-10-19', '2026-10-26')).resolves.toEqual([pass()]);
    expect(apiRequest).toHaveBeenCalledWith('/api/v1/supervision/week?from=2026-10-19&to=2026-10-26');
  });

  it('reads an answer without passes as none', async () => {
    (apiRequest as jest.Mock).mockResolvedValue(undefined);
    await expect(fetchSupervisionWeek('2026-10-19', '2026-10-26')).resolves.toEqual([]);
  });

  it('reads a gateway without the route (a 404 without a code) as no passes, and any other refusal as one', async () => {
    (apiRequest as jest.Mock).mockRejectedValue(new ApiError(404, 'Cannot GET /api/v1/supervision/week'));
    await expect(fetchSupervisionWeek('2026-10-19', '2026-10-26')).resolves.toEqual([]);
    (apiRequest as jest.Mock).mockRejectedValue(new ApiError(400, 'Högst 14 dagar åt gången.', 'SUPERVISION_WEEK_RANGE'));
    await expect(fetchSupervisionWeek('2026-10-19', '2026-11-26')).rejects.toBeInstanceOf(ApiError);
    (apiRequest as jest.Mock).mockRejectedValue(new ApiError(500, 'HTTP 500'));
    await expect(fetchSupervisionWeek('2026-10-19', '2026-10-26')).rejects.toBeInstanceOf(ApiError);
  });
});

describe('passCardsOf', () => {
  it('keys each pass apart from the lessons and says a vikarie’s pass and a handover', () => {
    expect(
      passCardsOf([
        pass(),
        pass({ kind: 'COVER', shiftId: 's-2', siteName: null }),
        pass({ shiftId: 's-3', handover: 'SUBSTITUTE' }),
        pass({ shiftId: 's-4', handover: 'NO_COVER' }),
      ]).map((card) => [card.key, card.marker, card.siteName, card.relieved]),
    ).toEqual([
      ['pass:OWN:s-1:2026-10-19', null, 'Norra', false],
      ['pass:COVER:s-2:2026-10-19', 'schedule.passCover', null, false],
      ['pass:OWN:s-3:2026-10-19', 'schedule.passHandedOver', 'Norra', true],
      ['pass:OWN:s-4:2026-10-19', 'schedule.passNoCover', 'Norra', true],
    ]);
  });
});
