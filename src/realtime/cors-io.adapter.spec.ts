import type { INestApplicationContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createServer,
  request,
  type IncomingHttpHeaders,
  type Server as HttpServer,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'socket.io';
import { CorsIoAdapter } from './cors-io.adapter';

/*
 * Asserted on the wire: a real Socket.IO server on a loopback port, asked the
 * way a browser asks, with an Origin header on the polling handshake. The
 * options object the adapter builds is only a means; what matters is which
 * CORS headers come back.
 */

const ALLOWED = 'https://app.schemapro.example';

let http: HttpServer;
let io: Server | undefined;

/** The adapter reads its allowlist from the app's validated config. */
const adapterFor = (corsOrigins: string[]) => {
  http = createServer();
  const config = new ConfigService({ app: { corsOrigins } });
  const app = Object.assign(http, { get: () => config });
  return new CorsIoAdapter(app as unknown as INestApplicationContext);
};

const listen = async (server: Server): Promise<number> => {
  io = server;
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  return (http.address() as AddressInfo).port;
};

const handshakeFrom = (port: number, origin: string) =>
  new Promise<IncomingHttpHeaders>((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: '/socket.io/?EIO=4&transport=polling',
        headers: { Origin: origin },
        agent: false,
      },
      (res) => {
        res.resume();
        resolve(res.headers);
      },
    );
    // With no Socket.IO server attached nothing answers at all; fail in
    // seconds rather than at the suite's thirty-second timeout.
    req.setTimeout(2000, () =>
      req.destroy(new Error('nothing answered the handshake')),
    );
    req.on('error', reject);
    req.end();
  });

afterEach(async () => {
  if (io) {
    // Closes the HTTP server it is attached to as well.
    await new Promise<void>((resolve) => io!.close(() => resolve()));
    io = undefined;
  } else if (http?.listening) {
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }
});

describe('CorsIoAdapter', () => {
  it('answers an allowlisted origin with that origin and credentials, as the HTTP server does', async () => {
    const adapter = adapterFor([ALLOWED, 'https://admin.schemapro.example']);
    const port = await listen(adapter.createIOServer(0));

    const headers = await handshakeFrom(port, ALLOWED);

    expect(headers['access-control-allow-origin']).toBe(ALLOWED);
    expect(headers['access-control-allow-credentials']).toBe('true');
  });

  it('does not answer an origin outside the allowlist, whatever the gateway itself declared', async () => {
    const adapter = adapterFor([ALLOWED]);
    const port = await listen(adapter.createIOServer(0, { cors: { origin: '*' } } as never));

    const headers = await handshakeFrom(port, 'https://evil.example');

    expect(headers['access-control-allow-origin']).toBeUndefined();
  });

  it('sends no CORS headers at all when nothing is allowlisted', async () => {
    // An unset CORS_ORIGINS must close browsers out, not open the gateway to
    // every origin the way an empty cors object would.
    const adapter = adapterFor([]);
    const port = await listen(adapter.createIOServer(0));

    const headers = await handshakeFrom(port, ALLOWED);

    expect(headers['access-control-allow-origin']).toBeUndefined();
    expect(headers['access-control-allow-credentials']).toBeUndefined();
  });
});
