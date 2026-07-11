// ─────────────────────────────────────────────────────────────────────────────
// Transport-security guard for outbound base URLs.
//
// All backend traffic (API + WebSocket) carries the Supabase JWT and student
// attendance data, so it must travel over TLS. This helper rejects any
// `http://` / `ws://` base URL at startup — a misconfigured env can no longer
// silently downgrade the app to cleartext. Plain-HTTP localhost is tolerated
// only in development builds for the simulator.
//
// Certificate pinning (defense against a malicious/enterprise root CA) is the
// recommended next hardening step. It requires native configuration and cannot
// be expressed in pure JS: add `react-native-ssl-pinning` (or iOS ATS pinned
// certificates + an Android Network Security Config) and route fetch/socket
// traffic through it. See docs/SECURITY_AUDIT.md.
// ─────────────────────────────────────────────────────────────────────────────

const SECURE_SCHEMES = ['https:', 'wss:'] as const;

function isLocalhost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

/**
 * Validates that `rawUrl` uses a TLS scheme. Returns the normalized URL string.
 * Throws in production if the scheme is insecure; allows localhost over plain
 * HTTP/WS only in development (`__DEV__`).
 */
export function assertSecureBaseUrl(rawUrl: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`[Security] ${label} is not a valid URL: "${rawUrl}".`);
  }

  if ((SECURE_SCHEMES as readonly string[]).includes(parsed.protocol)) {
    return rawUrl;
  }

  const devLocalhostAllowed =
    typeof __DEV__ !== 'undefined' && __DEV__ && isLocalhost(parsed.hostname);
  if (devLocalhostAllowed) {
    return rawUrl;
  }

  throw new Error(
    `[Security] ${label} must use https:// or wss:// (got "${parsed.protocol}//"). ` +
      'Refusing to send credentials over an insecure transport.',
  );
}
