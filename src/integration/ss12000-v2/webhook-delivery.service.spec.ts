import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { createPrismaMock, createTxMock } from '../../../test/utils/prisma-mock';
import type { PrismaService } from '../../database/prisma.service';
import { Ss12000SourceError } from '../ss12000-sync/errors';
import type { OutboundRequest } from '../ss12000-sync/outbound';
import { Ss12000Outbound, Ss12000Secrets } from '../ss12000-sync/ss12000-sync.providers';
import { verifySignature, webhookSecretAad } from './signing';
import { Ss12000WebhookDeliveryService } from './webhook-delivery.service';

const SCHOOL = '33333333-3333-4333-8333-333333333333';
const KEY = '90000000-0000-4000-8000-000000000001';
const SUB = 'a0000000-0000-4000-8000-000000000001';
const config = (background: boolean) => ({ get: () => ({ secretsKey: Buffer.alloc(32, 9), background }) }) as unknown as ConfigService;

function setup(options: { send?: (req: OutboundRequest) => Promise<{ status: number; headers: object; body: Buffer }>; background?: boolean } = {}) {
  const tx = createTxMock();
  const prisma = createPrismaMock(tx);
  const secrets = new Ss12000Secrets(config(options.background ?? false));
  const sent: OutboundRequest[] = [];
  class Outbound extends Ss12000Outbound {
    override clientOptions() {
      return {
        policy: { allowLoopback: true },
        send: async (req: OutboundRequest) => {
          sent.push(req);
          return options.send ? options.send(req) : { status: 204, headers: {}, body: Buffer.alloc(0) };
        },
      };
    }
  }
  const service = new Ss12000WebhookDeliveryService(prisma as unknown as PrismaService, new Outbound(), secrets, config(options.background ?? false));
  const settled: unknown[][] = [];
  let sealedRow: object | null = null;
  let due: object[] = [];
  (tx.$queryRaw as unknown as jest.Mock).mockImplementation(async (statement: { strings: string[]; values: unknown[] }) => {
    const text = statement.strings.join('?');
    if (text.includes('ss12000_provider_housekeeping')) return [{ tombstones: 0, deliveries: 0, released: 0 }];
    if (text.includes('ss12000_due_notifications')) {
      const out = due;
      due = [];
      return out;
    }
    if (text.includes('ss12000_webhook_secrets')) return sealedRow ? [sealedRow] : [];
    if (text.includes('ss12000_notification_settled')) {
      settled.push(statement.values);
      return [{ verdict: statement.values[1] ? 'DELIVERED' : 'RETRY' }];
    }
    return [];
  });
  const seal = (secret: string, previous?: string, aadKey = KEY) => {
    const now = secrets.box.sealWith(secret, webhookSecretAad(SCHOOL, aadKey));
    const before = previous ? secrets.box.sealWith(previous, webhookSecretAad(SCHOOL, KEY)) : null;
    sealedRow = {
      school_id: SCHOOL, ciphertext: now.ciphertext, iv: now.iv, auth_tag: now.authTag, enc_key_id: now.keyId,
      previous_ciphertext: before?.ciphertext ?? null, previous_iv: before?.iv ?? null, previous_auth_tag: before?.authTag ?? null, previous_enc_key_id: before?.keyId ?? null,
    };
  };
  const notice = (patch: object = {}) =>
    (due = [{ subscription_id: SUB, school_id: SCHOOL, key_id: KEY, target: 'https://hooks.example/n', modified: ['Room'], deleted: false, watermark_to: '42', attempts: 1, failing_since: null, ...patch }]);
  return { service, sent, settled, seal, notice, tx };
}

describe('Ss12000WebhookDeliveryService', () => {
  let spies: jest.SpyInstance[];
  beforeEach(() => {
    spies = (['log', 'warn', 'error'] as const).map((level) => jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined));
  });
  afterEach(() => spies.forEach((spy) => spy.mockRestore()));

  it('ticks only when SS12000_BACKGROUND is on, unref\'d, and stops on shutdown', () => {
    const off = setup().service;
    off.onModuleInit();
    expect(off.scheduled).toBe(false);
    const on = setup({ background: true }).service;
    on.onModuleInit();
    expect(on.scheduled).toBe(true);
    on.onModuleDestroy();
    expect(on.scheduled).toBe(false);
  });

  it('posts S1\'s body signed with the current and a still-valid previous secret, and settles with the horizon', async () => {
    const { service, sent, settled, seal, notice } = setup();
    seal('whsec_new', 'whsec_old');
    notice();
    await service.tick();
    expect(sent).toHaveLength(1);
    const body = sent[0]!.body!;
    expect(JSON.parse(body)).toEqual({ modifiedEntites: ['Room'], deletedEntities: false });
    const header = sent[0]!.headers['X-SchemaPro-Signature']!;
    const timestamp = Number(sent[0]!.headers['X-SchemaPro-Timestamp']);
    expect(verifySignature(header, 'whsec_new', timestamp, body) && verifySignature(header, 'whsec_old', timestamp, body)).toBe(true);
    expect(sent[0]).toMatchObject({ timeoutMs: 10_000, maxBytes: 64 * 1024, overflow: 'discard' });
    expect(settled[0]!.slice(0, 5)).toEqual([SUB, true, 204, 'DELIVERED', '42']);
  });

  it('settles every failure as a code: no secret, a refused target, an unreadable secret, a network failure, a non-2xx', async () => {
    const cases: Array<[string, (s: ReturnType<typeof setup>) => void, ((req: OutboundRequest) => Promise<never>) | undefined]> = [
      ['WEBHOOK_SECRET_MISSING', (s) => s.notice(), undefined],
      ['TARGET_REFUSED', (s) => (s.seal('whsec_a'), s.notice({ target: 'http://hooks.example/n' })), undefined],
      ['WEBHOOK_SECRET_UNREADABLE', (s) => (s.seal('whsec_a', undefined, '90000000-0000-4000-8000-0000000000ff'), s.notice()), undefined],
      ['WEBHOOK_TIMEOUT', (s) => (s.seal('whsec_a'), s.notice()), async () => Promise.reject(new Ss12000SourceError('SS12000_TIMEOUT'))],
    ];
    for (const [outcome, arrange, send] of cases) {
      const s = setup({ send });
      arrange(s);
      await s.service.tick();
      expect({ outcome, settled: s.settled[0]!.slice(1, 4) }).toEqual({ outcome, settled: [false, null, outcome] });
    }
    const failing = setup({ send: async () => ({ status: 503, headers: {}, body: Buffer.from('busy') }) });
    failing.seal('whsec_a');
    failing.notice();
    await failing.service.tick();
    expect(failing.settled[0]!.slice(1, 4)).toEqual([false, 503, 'HTTP_503']);
  });

  it('a previous secret that no longer opens is simply not sent', async () => {
    const { service, sent, seal, notice } = setup();
    seal('whsec_new');
    notice();
    await service.tick();
    expect(sent[0]!.headers['X-SchemaPro-Signature']!.split(',')).toHaveLength(1);
  });

  it('never throws: a failing settle is logged, a failing tick is swallowed, and a tick waits for the running one', async () => {
    const s = setup();
    s.seal('whsec_a');
    s.notice();
    (s.tx.$queryRaw as unknown as jest.Mock).mockImplementationOnce(async () => [{}]);
    const original = (s.tx.$queryRaw as unknown as jest.Mock).getMockImplementation()!;
    (s.tx.$queryRaw as unknown as jest.Mock).mockImplementation(async (statement: { strings: string[] }) => {
      if (statement.strings.join('?').includes('ss12000_notification_settled')) throw new Error('db down');
      return original(statement);
    });
    const first = s.service.tick();
    const second = s.service.tick();
    await Promise.all([first, second]);
    await expect(s.service.deliver({ subscription_id: SUB, school_id: SCHOOL, key_id: KEY, target: 'https://hooks.example/n', modified: [], deleted: true, watermark_to: '1', attempts: 0, failing_since: null })).resolves.toBe('UNSETTLED');
    (s.tx.$queryRaw as unknown as jest.Mock).mockRejectedValue(new Error('db down'));
    await expect(s.service.tick()).resolves.toBeUndefined();
  });
});
