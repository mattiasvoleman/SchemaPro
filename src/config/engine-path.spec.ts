import { isPrivateEngineHost, pathIdleLimitSecondsOf, PUBLIC_PATH_IDLE_LIMIT_SECONDS } from './engine-path';

/*
 * HOW LONG THE ROAD TO THE ENGINE HOLDS A SILENT REQUEST (omgång 15).
 *
 * The 2026-11-23 incident: the API reached the engine through its public domain, Railway's edge closed the
 * request after 300 s, and nothing in the gateway knew that the road had a limit. What is pinned here is which
 * addresses have one by default (a public https address) and which do not (the private network, the machine
 * itself, a private address, a compose service), and that the operator's number wins over the address in
 * either direction.
 */

describe('pathIdleLimitSecondsOf', () => {
  it('is five minutes for a public https address: Railway’s edge closes a request that sends nothing', () => {
    expect(PUBLIC_PATH_IDLE_LIMIT_SECONDS).toBe(300);
    expect(pathIdleLimitSecondsOf('https://schemapro-production.up.railway.app', undefined)).toBe(300);
    expect(pathIdleLimitSecondsOf('https://engine.schemapro.example:8443/', undefined)).toBe(300);
  });

  it.each([
    ['Railway’s private network', 'http://schemapro-engine.railway.internal:8080'],
    ['Railway’s private network over https', 'https://schemapro-engine.railway.internal'],
    ['localhost', 'http://localhost:8000'],
    ['a subdomain of localhost', 'http://engine.localhost:8000'],
    ['the loopback address', 'http://127.0.0.1:8000'],
    ['the loopback address over IPv6', 'http://[::1]:8000'],
    ['a private 10/8 address', 'http://10.1.2.3:8000'],
    ['a private 172.16/12 address', 'http://172.20.0.5:8000'],
    ['a private 192.168/16 address', 'http://192.168.1.20:8000'],
    ['a link-local address', 'http://169.254.10.10:8000'],
    ['Railway’s private network as an IPv6 literal (fd12::/16)', 'http://[fd12:3456:789a::1]:8080'],
    ['a compose service name, which has no dot in it', 'http://solver:8000'],
    ['a private name over https', 'https://solver:8000'],
  ])('is none for %s: no edge sits on the road', (_label, url) => {
    expect(pathIdleLimitSecondsOf(url, undefined)).toBeUndefined();
  });

  it('is none for a public http address: it is not the shape Railway serves, and a limit nobody can name is not guessed', () => {
    expect(pathIdleLimitSecondsOf('http://engine.schemapro.example', undefined)).toBeUndefined();
  });

  it('is the operator’s number when it is set, whatever the address says', () => {
    expect(pathIdleLimitSecondsOf('https://engine.schemapro.example', 120)).toBe(120);
    expect(pathIdleLimitSecondsOf('http://schemapro-engine.railway.internal:8080', 120)).toBe(120);
    expect(pathIdleLimitSecondsOf('http://engine.schemapro.example', 600)).toBe(600);
  });

  it('is none when the operator says 0: a public address whose road holds a silent request as long as it takes', () => {
    expect(pathIdleLimitSecondsOf('https://engine.schemapro.example', 0)).toBeUndefined();
  });

  it('is none for an address that cannot be read, rather than a limit it was never told', () => {
    expect(pathIdleLimitSecondsOf('undefined', undefined)).toBeUndefined();
    expect(pathIdleLimitSecondsOf('', undefined)).toBeUndefined();
  });
});

describe('isPrivateEngineHost', () => {
  it.each([
    'localhost',
    'ENGINE.RAILWAY.INTERNAL',
    'engine.railway.internal.',
    'engine.local',
    '0.0.0.0',
    '127.0.0.1',
    '100.64.0.1',
    '::1',
    '[::1]',
    '::',
    'fc00::1',
    'fdab:cd::1',
    'fe80::1',
    '::ffff:7f00:1',
    'solver',
  ])('says %s is private', (host) => {
    expect(isPrivateEngineHost(host)).toBe(true);
  });

  it.each([
    'schemapro-production.up.railway.app',
    'railway.app',
    '8.8.8.8',
    '172.32.0.1',
    '172.15.0.1',
    '192.169.0.1',
    '100.128.0.1',
    '2606:4700::1111',
    '::ffff:0808:0808',
    '999.1.1.1',
    '',
  ])('says %s is not', (host) => {
    expect(isPrivateEngineHost(host)).toBe(false);
  });
});
