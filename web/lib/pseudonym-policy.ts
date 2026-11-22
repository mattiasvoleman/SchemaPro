/**
 * The policy the browser enforces on the pseudonymiser's page (Pseudonymiseraren, X1): the part of "the file never leaves your computer" that
 * does not rest on anyone reading our code.
 *
 * `connect-src 'none'` is the one that matters: fetch, XMLHttpRequest, WebSocket, EventSource and navigator.sendBeacon are all refused by the
 * browser itself, whatever a script on the page tries (our own code, a library of ours or a mistake of the next change). `form-action 'none'`
 * refuses a form posted, `frame-src 'none'` and `object-src 'none'` a frame or a plug-in that could be sent to, `img-src` allows
 * only data: and blob: so that no picture can be asked for with something in its address, and `base-uri 'none'` that a relative address is made to point
 * somewhere else. A school's IT can read it in the page's response (the network tab of the developer tools) and see the same.
 *
 * WHAT IT IS NOT. A policy without a nonce does not stop a script that is injected from navigating away with data in the address, and the page
 * carries `'unsafe-inline'` for scripts because Next writes its own bootstrap inline. A nonce needs the page rendered per request; the page has
 * no input from anyone that reaches the markup (React escapes it, and nothing is put in with innerHTML), which is what makes an injection
 * not possible here, and a test (pseudonym-offline.test.ts) reads the code for the rest. The policy is the guard against the ordinary
 * mistake and the thing a reader can check, not the only defence.
 *
 * In development Next's own hot reload talks to its server over a websocket and evaluates code, so connect-src and script-src are
 * relaxed there and only there (NODE_ENV), and a production build never is.
 */

/** The page's path without its language: the proxy matches on it. */
export const PSEUDONYMISERA_PATH = "/pseudonymisera";

export function pseudonymiserarePolicy(options: { development?: boolean } = {}): string {
  const development = options.development === true;
  const directives: [string, string][] = [
    ["default-src", "'none'"],
    ["script-src", development ? "'self' 'unsafe-inline' 'unsafe-eval'" : "'self' 'unsafe-inline'"],
    ["style-src", "'self' 'unsafe-inline'"],
    ["img-src", "data: blob:"],
    ["font-src", "'self' data:"],
    ["connect-src", development ? "'self' ws: wss:" : "'none'"],
    ["form-action", "'none'"],
    ["frame-src", "'none'"],
    ["frame-ancestors", "'none'"],
    ["object-src", "'none'"],
    ["base-uri", "'none'"],
    ["worker-src", "'none'"],
    ["manifest-src", "'none'"],
    ["media-src", "'none'"],
  ];
  return directives.map(([name, value]) => `${name} ${value}`).join("; ");
}

/** True for the page in either language: /sv/pseudonymisera, /en/pseudonymisera, and with a trailing slash. */
export function isPseudonymiseraPath(pathname: string): boolean {
  return /^\/(?:sv|en)\/pseudonymisera\/?$/.test(pathname);
}
