import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { createTestApp, type TestHarness } from './utils/test-app';

/**
 * The harness's server listens on the loopback address, once (test/utils/test-app.ts, omgång 12 B9). A supertest request to a server that is
 * not listening starts it with `listen(0)`, the wildcard address, and asks it at 127.0.0.1:<port>; on macOS another process that holds that port
 * on 127.0.0.1 then answers instead (404 "not found", or a hang-up). That is the "socket hang up" and "404 undefined" of the e2e suites under load.
 */
describe('the e2e harness server', () => {
  let harness: TestHarness;

  beforeAll(async () => {
    harness = await createTestApp();
  });

  afterAll(async () => {
    await harness.close();
  });

  it('is listening on 127.0.0.1 and not on the wildcard address, so that no other process on a port of the loopback answers for it', () => {
    const server = harness.app.getHttpServer() as import('node:http').Server;
    expect(server.listening).toBe(true);
    const address = server.address() as AddressInfo;
    expect(address.address).toBe('127.0.0.1');
    expect(address.port).toBeGreaterThan(0);
  });

  it('answers a request through the same port every time, rather than a new one per request', async () => {
    const server = harness.app.getHttpServer() as import('node:http').Server;
    const port = (server.address() as AddressInfo).port;
    for (let call = 0; call < 3; call += 1) {
      await request(server).get('/api/v1/definitely-not-a-route').expect(404);
      expect((server.address() as AddressInfo).port).toBe(port);
    }
  });

  it('does not keep the process alive for a spec that forgets to close it', () => {
    const server = harness.app.getHttpServer() as import('node:http').Server & { hasRef?: () => boolean };
    // The listening handle is unref'd: Node's hasRef() says so where it has it.
    if (typeof server.hasRef === 'function') expect(server.hasRef()).toBe(false);
  });
});
