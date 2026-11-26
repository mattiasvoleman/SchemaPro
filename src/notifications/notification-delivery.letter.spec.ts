import { Logger } from '@nestjs/common';
import type { PrismaService } from '../database/prisma.service';
import { NotificationDeliveryService } from './notification-delivery.service';

/**
 * A letter to an address that is no user (Måltidskollen's kitchen): one mail through the same pace as every
 * other mail, with no inbox row, no push and no opt-out. Kept apart from notification-delivery.service.spec.ts,
 * which the delivery's own changes share.
 */
describe('NotificationDeliveryService.sendLetter', () => {
  const realFetch = global.fetch;
  const realKey = process.env.RESEND_API_KEY;
  const realFrom = process.env.EMAIL_FROM;
  let fetchMock: jest.Mock;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    fetchMock = jest.fn(async () => ({ ok: true, status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    process.env.RESEND_API_KEY = 're_test';
    process.env.EMAIL_FROM = 'Rastra Schema <noreply@example.test>';
  });
  afterEach(() => {
    global.fetch = realFetch;
    warn.mockRestore();
    if (realKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = realKey;
    if (realFrom === undefined) delete process.env.EMAIL_FROM;
    else process.env.EMAIL_FROM = realFrom;
  });

  const service = () => {
    const delivery = new NotificationDeliveryService({} as unknown as PrismaService);
    delivery.emailIntervalMs = 0;
    return delivery;
  };

  it('sends one mail to the address, blind, with the subject and the text', async () => {
    await expect(service().sendLetter('kok@skolan.se', 'Portioner torsdag', 'Totalt: 80 portioner.')).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]! as [string, { body: string; headers: Record<string, string> }];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.headers['Authorization']).toBe('Bearer re_test');
    expect(JSON.parse(init.body)).toEqual({
      from: 'Rastra Schema <noreply@example.test>',
      to: ['noreply@example.test'],
      bcc: ['kok@skolan.se'],
      subject: 'Portioner torsdag',
      text: 'Totalt: 80 portioner.',
    });
  });

  it('sends nothing, and says so, where Resend is not set up', async () => {
    delete process.env.RESEND_API_KEY;
    await expect(service().sendLetter('kok@skolan.se', 's', 'b')).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('says false for a mail Resend refuses and for one that never gets there, and sends each once', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 422 });
    await expect(service().sendLetter('kok@skolan.se', 's', 'b')).resolves.toBe(false);
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    await expect(service().sendLetter('kok@skolan.se', 's', 'b')).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('says false for a Resend that is down or asks to be asked again later, and logs the status and never the address', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 });
    await expect(service().sendLetter('kok@skolan.se', 's', 'b')).resolves.toBe(false);
    fetchMock.mockResolvedValueOnce({ ok: false, status: 429, headers: { get: () => '3' } });
    await expect(service().sendLetter('kok@skolan.se', 's', 'b')).resolves.toBe(false);
    const logged = warn.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).toContain('Email dispatch failed [status=503]');
    expect(logged).toContain('Email dispatch failed [status=429]');
    expect(logged).not.toContain('kok@');
  });

  it('goes under a key that is the letter’s own fingerprint: the same letter asked for again is the same mail, another is not', async () => {
    const keys = async (address: string, subject: string, body: string) => {
      fetchMock.mockClear();
      await service().sendLetter(address, subject, body);
      return (fetchMock.mock.calls[0]![1] as { headers: Record<string, string> }).headers['Idempotency-Key'];
    };
    const first = await keys('kok@skolan.se', 'Portioner torsdag', 'Totalt: 80 portioner.');
    expect(await keys('kok@skolan.se', 'Portioner torsdag', 'Totalt: 80 portioner.')).toBe(first);
    expect(await keys('kok@skolan.se', 'Portioner fredag', 'Totalt: 80 portioner.')).not.toBe(first);
    expect(await keys('annan@skolan.se', 'Portioner torsdag', 'Totalt: 80 portioner.')).not.toBe(first);
    // A fingerprint, not the letter: no address and no text in it, and it fits the provider's 256.
    expect(first).toMatch(/^letter\/[0-9a-f]{64}$/);
  });

  it('takes its place in the pace from the database, and the mail goes all the same when the database cannot say', async () => {
    const delivery = service();
    delivery.emailIntervalMs = 40;
    const slot = jest.fn().mockResolvedValueOnce(0).mockRejectedValueOnce(new Error('the database is down'));
    (delivery as unknown as { store: { slot: unknown } }).store = { slot };
    await expect(delivery.sendLetter('kok@skolan.se', 's', 'b')).resolves.toBe(true);
    await expect(delivery.sendLetter('kok@skolan.se', 's2', 'b')).resolves.toBe(true);
    expect(slot).toHaveBeenCalledWith('EMAIL', 40);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
