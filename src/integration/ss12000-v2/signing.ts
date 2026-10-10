import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Webhook signing, a SchemaPro extension in HEADERS only (S1 defines no
 * signing; its callback body stays S1's {modifiedEntites, deletedEntities}):
 *
 *   X-SchemaPro-Delivery:  a uuid per attempt
 *   X-SchemaPro-Timestamp: unix seconds
 *   X-SchemaPro-Signature: v1=<hex HMAC-SHA256(secret, timestamp + "." + body)>
 *
 * During the 24 hours after a key's secret is replaced the header carries
 * both, `v1=<new>,v1=<old>`, so a consumer can rotate without losing a
 * notice. A receiver recomputes the HMAC over the raw body it got and
 * compares in constant time (docs/integration-api.md has the snippet), and
 * rejects a timestamp more than five minutes away from its clock.
 */

/** A new signing secret: shown once, then stored sealed (20261014120000). */
export function newWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString('base64url')}`;
}

export function signature(secret: string, timestamp: number, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`, 'utf8').digest('hex');
}

export function signatureHeader(secrets: readonly string[], timestamp: number, body: string): string {
  return secrets.map((secret) => `v1=${signature(secret, timestamp, body)}`).join(',');
}

/** What a receiver does: true if any v1 signature in the header is the body's under `secret`. */
export function verifySignature(header: string, secret: string, timestamp: number, body: string): boolean {
  const expected = Buffer.from(signature(secret, timestamp, body), 'hex');
  return header
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.startsWith('v1='))
    .some((part) => {
      const given = Buffer.from(part.slice(3), 'hex');
      return given.length === expected.length && timingSafeEqual(given, expected);
    });
}

/** The AAD a key's sealed signing secret is bound to: its school and its key. */
export function webhookSecretAad(schoolId: string, keyId: string): Buffer {
  return Buffer.from(`integration-key-webhook:${schoolId}:${keyId}`, 'utf8');
}
