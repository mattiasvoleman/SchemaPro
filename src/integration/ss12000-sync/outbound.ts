import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import { isIP } from 'node:net';
import { Ss12000SourceError } from './errors';

/**
 * Every byte the sync sends to an SS12000 source leaves through here.
 *
 * baseUrl and tokenUrl are admin input the gateway will call with a bearer
 * token or a client certificate, so they are held to:
 *
 *   * https, always. No userinfo (no '@' in the authority) and, for both
 *     URLs, no query or fragment: a credential never sits in a URL, so a URL
 *     in a log is never a secret (the CHECKs of 20261014090000 say the same).
 *   * An address that is publicly routable. The host is resolved before
 *     every connection and EVERY address it resolves to must pass: loopback,
 *     RFC 1918, CGNAT (100.64/10), "this network" (0/8), link-local
 *     (169.254/16, which holds cloud metadata at 169.254.169.254, and
 *     fe80::/10), the IETF and benchmarking blocks (192.0.0/24, 198.18/15),
 *     documentation ranges, multicast, reserved, IPv6 ULA (fc00::/7, which
 *     is what *.railway.internal resolves to), site-local and the
 *     unspecified addresses are refused; IPv4-mapped (::ffff:a.b.c.d) and
 *     NAT64 (64:ff9b::/96) addresses are judged by the IPv4 address inside.
 *   * The connection is PINNED to the vetted address (the socket's `lookup`
 *     answers with it), so a DNS answer that changes between the check and
 *     the connect (a rebind) cannot slip through. TLS still verifies the
 *     certificate against the hostname (SNI and checkServerIdentity use the
 *     name, not the address).
 *   * No redirects: a 3xx fails the call, so a bearer is never forwarded to
 *     another host.
 *   * A timeout per request and a cap on the body read.
 *
 * Loopback is allowed only when SS12000_ALLOW_INSECURE_LOCAL=1 AND
 * NODE_ENV=test (env.validation refuses the flag anywhere else); https is
 * not relaxed even then — the tests' mock provider runs TLS with a test CA
 * handed in as `ca` (also honoured only under NODE_ENV=test, by the caller).
 */
export interface OutboundPolicy {
  /** Loopback addresses pass. Only ever true under NODE_ENV=test. */
  allowLoopback: boolean;
  /** Extra trust anchors (test CA). Undefined: Node's own root store. */
  ca?: string;
  /** The resolver to vet with (tests). Undefined: the system's. */
  resolve?: Resolver;
}

export interface OutboundRequest {
  method: 'GET' | 'POST';
  url: URL;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
  maxBytes: number;
  /** TLS client certificate and key (MTLS_CLIENT_CERT), PEM. */
  cert?: string;
  key?: string;
}

export interface OutboundResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

export type OutboundSender = (request: OutboundRequest, policy: OutboundPolicy) => Promise<OutboundResponse>;

const URL_SHAPE = /^https:\/\/[^/?#@\s]+(\/[^?#\s]*)?$/;

/**
 * The URL, if it is one the sync may call: https, no userinfo, no query or
 * fragment, at most 2048 characters; base URLs also without a trailing slash.
 * The same rule as the CHECKs, so the 400 comes before the database's.
 */
export function vetSourceUrl(raw: string, kind: 'base' | 'token'): URL | null {
  if (typeof raw !== 'string' || raw.length > 2048 || !URL_SHAPE.test(raw)) return null;
  if (kind === 'base' && raw.endsWith('/')) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !url.hostname) return null;
  return url;
}

/** scheme://host[:port], the part of a URL a secret is bound to. */
export function originOf(raw: string): string {
  return new URL(raw).origin;
}

// ---------------------------------------------------------------------------
// Address vetting
// ---------------------------------------------------------------------------

type Cidr = [bytes: number[], prefix: number];

function v4Bytes(address: string): number[] | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const bytes = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
  return bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255) ? bytes : null;
}

/** The 16 bytes of an IPv6 address (with '::' and a trailing dotted quad), or null. */
export function v6Bytes(address: string): number[] | null {
  let text = address.toLowerCase();
  const zone = text.indexOf('%');
  if (zone >= 0) text = text.slice(0, zone);
  let tail: number[] = [];
  const lastColon = text.lastIndexOf(':');
  if (text.slice(lastColon + 1).includes('.')) {
    const quad = v4Bytes(text.slice(lastColon + 1));
    if (!quad) return null;
    tail = quad;
    text = `${text.slice(0, lastColon + 1)}0:0`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string) => (part === '' ? [] : part.split(':'));
  const head = parse(halves[0] ?? '');
  const rest = halves.length === 2 ? parse(halves[1] ?? '') : [];
  const missing = 8 - head.length - rest.length;
  if ((halves.length === 2 && missing < 1) || (halves.length === 1 && missing !== 0)) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  const bytes: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    const value = parseInt(group, 16);
    bytes.push(value >> 8, value & 0xff);
  }
  if (tail.length === 4) bytes.splice(12, 4, ...tail);
  return bytes.length === 16 ? bytes : null;
}

function inCidr(bytes: number[], [net, prefix]: Cidr): boolean {
  for (let bit = 0; bit < prefix; bit++) {
    const byte = Math.floor(bit / 8);
    const mask = 0x80 >> bit % 8;
    if (((bytes[byte] ?? 0) & mask) !== ((net[byte] ?? 0) & mask)) return false;
  }
  return true;
}

const cidr4 = (text: string): Cidr => {
  const [address, prefix] = text.split('/');
  return [v4Bytes(address ?? '') ?? [], Number(prefix)];
};
const cidr6 = (text: string): Cidr => {
  const [address, prefix] = text.split('/');
  return [v6Bytes(address ?? '') ?? [], Number(prefix)];
};

const LOOPBACK_V4 = cidr4('127.0.0.0/8');
const LOOPBACK_V6 = cidr6('::1/128');

const REFUSED_V4: Cidr[] = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.88.99.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
].map(cidr4);

const REFUSED_V6: Cidr[] = [
  '::/128',
  '::1/128',
  '64:ff9b:1::/48',
  '100::/64',
  '2001::/23',
  '2001:db8::/32',
  '2002::/16',
  'fc00::/7',
  'fe80::/10',
  'fec0::/10',
  'ff00::/8',
].map(cidr6);

const MAPPED_V4 = cidr6('::ffff:0:0/96');
const NAT64 = cidr6('64:ff9b::/96');

/** Whether the sync may connect to `address` (an IP literal). */
export function addressIsAllowed(address: string, policy: Pick<OutboundPolicy, 'allowLoopback'>): boolean {
  const family = isIP(address);
  if (family === 4) {
    const bytes = v4Bytes(address);
    if (!bytes) return false;
    if (policy.allowLoopback && inCidr(bytes, LOOPBACK_V4)) return true;
    return !REFUSED_V4.some((range) => inCidr(bytes, range));
  }
  if (family === 6) {
    const bytes = v6Bytes(address);
    if (!bytes) return false;
    if (inCidr(bytes, MAPPED_V4) || inCidr(bytes, NAT64)) {
      return addressIsAllowed(bytes.slice(12).join('.'), policy);
    }
    if (policy.allowLoopback && inCidr(bytes, LOOPBACK_V6)) return true;
    return !REFUSED_V6.some((range) => inCidr(bytes, range));
  }
  return false;
}

export type Resolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

const systemResolver: Resolver = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

/** The address to connect to, once every address the host resolves to has passed. */
export async function vetHost(
  hostname: string,
  policy: Pick<OutboundPolicy, 'allowLoopback'>,
  resolve: Resolver = systemResolver,
): Promise<{ address: string; family: 4 | 6 }> {
  const bare = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  let addresses: Array<{ address: string; family: number }>;
  if (isIP(bare)) {
    addresses = [{ address: bare, family: isIP(bare) }];
  } else {
    try {
      addresses = await resolve(bare);
    } catch {
      throw new Ss12000SourceError('SS12000_DNS_FAILED');
    }
  }
  if (addresses.length === 0) throw new Ss12000SourceError('SS12000_DNS_FAILED');
  if (!addresses.every((entry) => addressIsAllowed(entry.address, policy))) {
    throw new Ss12000SourceError('SS12000_ADDRESS_REFUSED');
  }
  const first = addresses[0]!;
  return { address: first.address, family: first.family === 6 ? 6 : 4 };
}

const TLS_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'EPROTO',
]);

function networkCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string') {
    if (TLS_CODES.has(code) || code.startsWith('ERR_TLS') || code.startsWith('ERR_SSL') || code.startsWith('CERT_')) {
      return 'SS12000_TLS_FAILED';
    }
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'SS12000_DNS_FAILED';
  }
  return 'SS12000_CONNECTION_FAILED';
}

/**
 * One request to the source over node:https, pinned to a vetted address.
 * Resolves with the status, headers and body (at most maxBytes); rejects with
 * an Ss12000SourceError code only.
 */
export const sendOutbound: OutboundSender = async (req, policy) => {
  const vetted = await vetHost(req.url.hostname, policy, policy.resolve);
  const hostname = req.url.hostname.replace(/^\[|\]$/g, '');
  return new Promise<OutboundResponse>((resolve, reject) => {
    let settled = false;
    const fail = (code: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      outgoing.destroy();
      reject(new Ss12000SourceError(code));
    };
    const outgoing = httpsRequest(
      {
        protocol: 'https:',
        hostname,
        port: req.url.port ? Number(req.url.port) : 443,
        path: `${req.url.pathname}${req.url.search}`,
        method: req.method,
        headers: req.headers,
        agent: false,
        servername: isIP(hostname) ? undefined : hostname,
        ca: policy.ca,
        cert: req.cert,
        key: req.key,
        // Pinned: whatever the socket asks for, it gets the vetted address.
        lookup: ((_host: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
          if (options?.all) callback(null, [{ address: vetted.address, family: vetted.family }]);
          else callback(null, vetted.address, vetted.family);
        }) as never,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > req.maxBytes) {
            response.destroy();
            fail('SS12000_RESPONSE_TOO_LARGE');
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) });
        });
        response.on('error', (error) => fail(networkCode(error)));
      },
    );
    const timer = setTimeout(() => fail('SS12000_TIMEOUT'), req.timeoutMs);
    timer.unref();
    outgoing.on('error', (error) => fail(networkCode(error)));
    if (req.body !== undefined) outgoing.write(req.body);
    outgoing.end();
  });
};
