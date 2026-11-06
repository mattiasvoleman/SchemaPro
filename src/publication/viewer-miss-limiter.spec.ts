import type { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { MISSES, ViewerMissLimiter } from './viewer-miss-limiter';

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
