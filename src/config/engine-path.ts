/*
 * THE ROAD TO THE ENGINE, AND HOW LONG IT HOLDS A REQUEST THAT SENDS NOTHING
 * (omgång 15, the 2026-11-23 incident).
 *
 * The API reaches the engine over HTTP, and between the two there can be a proxy
 * that closes a request after a while without a byte on it. Railway's edge does:
 * a request through a service's public domain is closed after five minutes
 * unless data keeps flowing (docs.railway.com, Networking > Public networking >
 * Specs & limits, read 2026-11-24). The engine sends nothing while it solves.
 * On 2026-11-23 the only real school ran Generera twice, the engine searched for
 * its 540 s budget, and both runs were closed at 300 s with "The AI engine
 * returned an error": no code, no report, no suggestions, and an engine that
 * answered, ten minutes later, to nobody.
 *
 * This is the one place that says how long the road to the engine holds a silent
 * request. It is a property of the ADDRESS the API uses:
 *
 *   - a public https address (`https://<service>.up.railway.app`) goes through
 *     the edge: 300 s;
 *   - Railway's private network (`<service>.railway.internal`), localhost, a
 *     private address and a compose service name do not: no limit;
 *   - AI_ENGINE_PATH_IDLE_LIMIT_SECONDS overrides either: a number for a road
 *     that holds less or more, 0 for a road that holds as long as it takes.
 *
 * A public http address is not given the default: it is not the shape Railway
 * serves, and a limit nobody can name is not guessed (the operator sets the
 * variable if the road in front of it closes a silent request).
 *
 * Pure: nothing here reads the environment or the network, so the deployment's
 * numbers are tested without either.
 */

/** What Railway's edge holds a request that sends nothing: five minutes. */
export const PUBLIC_PATH_IDLE_LIMIT_SECONDS = 300;

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Whether an IPv4 address is one a request to it stays inside a private network for. */
function privateIpv4(octets: readonly number[]): boolean {
  const [a, b] = octets as [number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    // Carrier-grade NAT, which is what a mesh VPN's addresses are: not the public internet either.
    (a === 100 && b >= 64 && b <= 127)
  );
}

/**
 * Whether a URL's host is one the API reaches without a public edge between them: Railway's private
 * network, the machine itself, a private address, and a name with no dot in it (a compose service).
 * An address that cannot be read is not private: nothing is assumed about what it is.
 */
export function isPrivateEngineHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host === '') return false;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  // `.internal` is the name Railway gives a service on the private network, and the one ICANN reserved for private use.
  if (host.endsWith('.internal') || host.endsWith('.local')) return true;
  const v4 = IPV4.exec(host);
  if (v4 !== null) {
    const octets = v4.slice(1).map(Number);
    return octets.every((octet) => octet <= 255) && privateIpv4(octets);
  }
  if (host.includes(':')) {
    // An IPv6 literal: the machine itself, a unique local address (Railway's private network is fd12::/16), link-local.
    if (host === '::' || host === '::1') return true;
    if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) return true;
    // An IPv4 address written as IPv6, which URL parsing turns into two hextets: ::ffff:7f00:1.
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
    if (mapped !== null) {
      const high = parseInt(mapped[1]!, 16);
      const low = parseInt(mapped[2]!, 16);
      return privateIpv4([high >> 8, high & 255, low >> 8, low & 255]);
    }
    return false;
  }
  // A bare name (`http://solver:8000`) is a service on the machine's own network.
  return !host.includes('.');
}

/**
 * How long the road to the engine holds a request that sends nothing, in seconds, or undefined when it
 * holds it as long as it takes (or nobody knows that it does not).
 *
 * `configured` is AI_ENGINE_PATH_IDLE_LIMIT_SECONDS as it was set: a number is the limit, 0 is "none"
 * whatever the address says, and undefined leaves it to the address.
 */
export function pathIdleLimitSecondsOf(baseUrl: string, configured: number | undefined): number | undefined {
  if (configured !== undefined) return configured > 0 ? configured : undefined;
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:') return undefined;
  return isPrivateEngineHost(url.hostname) ? undefined : PUBLIC_PATH_IDLE_LIMIT_SECONDS;
}
