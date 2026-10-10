import { createCipheriv, createDecipheriv, createHash, createPrivateKey, randomBytes, X509Certificate } from 'node:crypto';
import type { Ss12000SecretKind } from '@prisma/client';

/**
 * The source's credentials at rest: AES-256-GCM with Node's crypto, a random
 * 12-byte iv per write, and an AAD that binds a ciphertext to
 *
 *   ss12000-source:<schoolId>:<sourceId>:<kind>:<origin>
 *
 * where origin is the scheme, host and port the credential is SENT to —
 * tokenUrl's for CLIENT_SECRET, baseUrl's for BEARER_TOKEN and the client
 * key and certificate. A ciphertext copied into another school, source or
 * kind does not decrypt, and neither does one whose host the admin changed:
 * the stored IST secret cannot be pointed at a new host without the admin
 * typing it again (migration 20261014090000).
 *
 * The key is INTEGRATION_SECRETS_KEY (base64, exactly 32 bytes), with an
 * optional INTEGRATION_SECRETS_KEY_PREVIOUS that still decrypts during a
 * rotation. keyId is the first 16 hex digits of the key's sha256: it names
 * the key without revealing it. Nothing is ever written in plaintext: with
 * no key configured the box refuses to seal (503
 * SS12000_SECRETS_NOT_CONFIGURED at the API).
 */
export interface SealedSecret {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  keyId: string;
}

export interface SecretBinding {
  schoolId: string;
  sourceId: string;
  kind: Ss12000SecretKind;
  origin: string;
}

export class SecretBoxError extends Error {
  constructor(readonly code: 'SS12000_SECRETS_NOT_CONFIGURED' | 'SS12000_SECRET_UNREADABLE') {
    super(code);
    this.name = 'SecretBoxError';
  }
}

export function keyIdOf(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

export function aadOf(binding: SecretBinding): Buffer {
  return Buffer.from(
    `ss12000-source:${binding.schoolId}:${binding.sourceId}:${binding.kind}:${binding.origin}`,
    'utf8',
  );
}

export class SecretBox {
  private readonly keys: Map<string, Buffer>;
  private readonly current: { id: string; key: Buffer } | null;

  constructor(current: Buffer | undefined, previous?: Buffer) {
    this.keys = new Map();
    this.current = current ? { id: keyIdOf(current), key: current } : null;
    if (current) this.keys.set(keyIdOf(current), current);
    if (previous) this.keys.set(keyIdOf(previous), previous);
  }

  get configured(): boolean {
    return this.current !== null;
  }

  seal(plaintext: string, binding: SecretBinding): SealedSecret {
    return this.sealWith(plaintext, aadOf(binding));
  }

  /** The plaintext, or SS12000_SECRET_UNREADABLE for a wrong key, binding or tampered row. */
  open(sealed: SealedSecret, binding: SecretBinding): string {
    return this.openWith(sealed, aadOf(binding));
  }

  /**
   * The same box with an AAD the caller names: a key's webhook signing
   * secret (20261014120000) is bound to `integration-key-webhook:<schoolId>:
   * <keyId>` (ss12000-v2/signing.ts), not to a source.
   */
  sealWith(plaintext: string, aad: Buffer): SealedSecret {
    if (!this.current) throw new SecretBoxError('SS12000_SECRETS_NOT_CONFIGURED');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.current.key, iv);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return { ciphertext, iv, authTag: cipher.getAuthTag(), keyId: this.current.id };
  }

  openWith(sealed: SealedSecret, aad: Buffer): string {
    const key = this.keys.get(sealed.keyId);
    if (!key) throw new SecretBoxError(this.current ? 'SS12000_SECRET_UNREADABLE' : 'SS12000_SECRETS_NOT_CONFIGURED');
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, sealed.iv);
      decipher.setAAD(aad);
      decipher.setAuthTag(sealed.authTag);
      return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString('utf8');
    } catch {
      throw new SecretBoxError('SS12000_SECRET_UNREADABLE');
    }
  }
}

/** The largest credential accepted, in UTF-8 bytes: a PEM key with its chain fits. */
export const SECRET_MAX_BYTES = 16 * 1024;

/**
 * Whether a credential is what its kind says, as a code (never echoing the
 * value): a PEM key Node can load, a certificate it can parse, a token of
 * printable characters without whitespace.
 */
export function secretValueProblem(kind: Ss12000SecretKind, value: string): string | null {
  if (Buffer.byteLength(value, 'utf8') > SECRET_MAX_BYTES) return 'SS12000_SECRET_TOO_LARGE';
  switch (kind) {
    case 'CLIENT_SECRET':
    case 'BEARER_TOKEN':
      return /^[\x21-\x7e]{1,4096}$/.test(value) ? null : 'SS12000_SECRET_MALFORMED';
    case 'CLIENT_KEY_PEM':
      try {
        createPrivateKey(value);
        return null;
      } catch {
        return 'SS12000_KEY_PEM_INVALID';
      }
    case 'CLIENT_CERT_PEM':
      try {
        new X509Certificate(value);
        return null;
      } catch {
        return 'SS12000_CERT_PEM_INVALID';
      }
    default:
      return 'SS12000_SECRET_MALFORMED';
  }
}
