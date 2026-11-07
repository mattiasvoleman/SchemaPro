import type { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { clientOfAddress, MISSES, PER_PERSON, ViewerMissLimiter } from './viewer-miss-limiter';

const KEY = 'k'.repeat(32);
const limiter = (...given: [] | [undefined]) =>
  new ViewerMissLimiter({ get: () => (given.length === 0 ? { proxyKey: KEY } : {}) } as unknown as ConfigService);
const request = (headers: Record<string, string>, ip = '203.0.113.7') => ({ headers, ip }) as unknown as Request;

describe('ViewerMissLimiter', () => {
  describe('whose request it is', () => {
    it('trusts the web server\'s word for the viewer\'s address only beside its key', () => {
      const miss = limiter();
      expect(miss.clientOf(request({ 'x-viewer-client-ip': '198.51.100.9', 'x-viewer-proxy-key': KEY }))).toBe('fwd:198.51.100.9');
      expect(miss.clientOf(request({ 'x-viewer-client-ip': '198.51.100.9', 'x-viewer-proxy-key': 'wrong' }))).toBe('ip:203.0.113.7');
      expect(miss.clientOf(request({ 'x-viewer-client-ip': '198.51.100.9' }))).toBe('ip:203.0.113.7');
      expect(miss.clientOf(request({ 'x-viewer-client-ip': 'x'.repeat(65), 'x-viewer-proxy-key': KEY }))).toBe('ip:203.0.113.7');
    });

    it('trusts nobody\'s word when it has no key', () => {
      expect(limiter(undefined).clientOf(request({ 'x-viewer-client-ip': '198.51.100.9', 'x-viewer-proxy-key': KEY }))).toBe('ip:203.0.113.7');
    });

    it('falls back to a name for an address it does not have', () => {
      expect(limiter().clientOf({ headers: {} } as unknown as Request)).toBe('ip:unknown');
    });
  });

  describe('the misses', () => {
    it('charges a miss to the address that made it and spends the address after the limit and one more', async () => {
      const miss = limiter();
      for (let i = 0; i <= MISSES.limit; i++) {
        expect(miss.spent('fwd:a')).toBe(false);
        await miss.miss('fwd:a');
      }
      expect(miss.spent('fwd:a')).toBe(true);
      // Another address is its own, and asking is free.
      expect(miss.spent('fwd:b')).toBe(false);
      expect(miss.spent('fwd:a')).toBe(true);
    });

    it('lets the address back when the block runs out', async () => {
      // The storage takes its clock when it is made.
      const now = jest.spyOn(Date, 'now');
      const start = Date.now();
      now.mockReturnValue(start);
      const miss = limiter();
      for (let i = 0; i <= MISSES.limit; i++) await miss.miss('fwd:a');
      expect(miss.spent('fwd:a')).toBe(true);
      now.mockReturnValue(start + MISSES.block - 1_000);
      expect(miss.spent('fwd:a')).toBe(true);
      now.mockReturnValue(start + MISSES.block + 1_000);
      expect(miss.spent('fwd:a')).toBe(false);
      now.mockRestore();
    });

    it('holds a key per address that missed, and none for one that did not', async () => {
      const miss = limiter();
      expect(miss.keysHeld).toBe(0);
      miss.spent('fwd:never');
      expect(miss.keysHeld).toBe(0);
      await miss.miss('fwd:a');
      expect(miss.keysHeld).toBe(1);
    });
  });
});

describe('clientOfAddress (one client is what one subscriber is given)', () => {
  it.each([
    ['203.0.113.7', '203.0.113.7'],
    ['2001:db8:1:2:3:4:5:6', '2001:db8:1:2::/64'],
    ['2001:db8:1:2:ffff:ffff:ffff:ffff', '2001:db8:1:2::/64'],
    ['2001:DB8:0001:0002::1', '2001:db8:1:2::/64'],
    ['2001:db8::1', '2001:db8:0:0::/64'],
    ['::1', '0:0:0:0::/64'],
    ['fe80::', 'fe80:0:0:0::/64'],
    ['::ffff:198.51.100.9', '198.51.100.9'],
    ['unknown', 'unknown'],
  ])('reads %s as %s', (address, client) => {
    expect(clientOfAddress(address)).toBe(client);
  });

  it('is one client for a program that rolls through its own /64', () => {
    const rolled = new Set(Array.from({ length: 500 }, (_, i) => clientOfAddress(`2001:db8:1:2:${i.toString(16)}:${(i * 7).toString(16)}::${i + 1}`)));
    expect(rolled).toEqual(new Set(['2001:db8:1:2::/64']));
  });

  it('is two clients for two /64s', () => {
    expect(clientOfAddress('2001:db8:1:2::1')).not.toBe(clientOfAddress('2001:db8:1:3::1'));
  });
});

describe('ViewerMissLimiter without a proxy key', () => {
  const noKey = () => limiter(undefined);

  it('keeps no count of misses by address: every visitor then arrives as the web server, and one program would shut the viewer for all', async () => {
    const miss = noKey();
    for (let i = 0; i < MISSES.limit * 3; i++) await miss.miss('ip:10.0.0.1');
    expect(miss.spent('ip:10.0.0.1')).toBe(false);
    expect(miss.keysHeld).toBe(0);
  });

  it('counts a signed-in person all the same: they are their own client', async () => {
    const miss = noKey();
    for (let i = 0; i <= MISSES.limit; i++) await miss.miss('user:a');
    expect(miss.spent('user:a')).toBe(true);
    expect(miss.spent('user:b')).toBe(false);
  });
});

describe('ViewerMissLimiter hits (the staff route)', () => {
  it('lets a person read up to the limit and tells how long to wait after it', async () => {
    const miss = limiter();
    for (let i = 0; i < PER_PERSON.limit; i++) expect(await miss.charge('user:a', PER_PERSON)).toBe(0);
    expect(await miss.charge('user:a', PER_PERSON)).toBeGreaterThan(0);
    expect(await miss.charge('user:b', PER_PERSON)).toBe(0);
  });
});

