import { makeTestTls } from '../../../test/utils/test-tls';
import { SecretBox, SecretBoxError, aadOf, keyIdOf, secretValueProblem, type SecretBinding } from './secret-box';

const KEY = Buffer.alloc(32, 1);
const OLD_KEY = Buffer.alloc(32, 2);
const binding: SecretBinding = {
  schoolId: '11111111-1111-4111-8111-111111111111',
  sourceId: '22222222-2222-4222-8222-222222222222',
  kind: 'CLIENT_SECRET',
  origin: 'https://skolid.se',
};

describe('SecretBox (AES-256-GCM, origin-bound)', () => {
  it('round-trips a secret, with a fresh 12-byte iv and a 16-byte tag every time', () => {
    const box = new SecretBox(KEY);
    const a = box.seal('s3cret', binding);
    const b = box.seal('s3cret', binding);
    expect(a.iv).toHaveLength(12);
    expect(a.authTag).toHaveLength(16);
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ciphertext.toString('utf8')).not.toContain('s3cret');
    expect(box.open(a, binding)).toBe('s3cret');
  });

  it('names its key by a digest, never the key', () => {
    const box = new SecretBox(KEY);
    expect(box.seal('x', binding).keyId).toBe(keyIdOf(KEY));
    expect(keyIdOf(KEY)).toMatch(/^[0-9a-f]{16}$/);
    expect(keyIdOf(KEY)).not.toContain(KEY.toString('hex').slice(0, 8));
  });

  it.each([
    ['another school', { schoolId: '33333333-3333-4333-8333-333333333333' }],
    ['another source', { sourceId: '44444444-4444-4444-8444-444444444444' }],
    ['another kind', { kind: 'BEARER_TOKEN' as const }],
    ['another host (the admin moved the token URL)', { origin: 'https://evil.example' }],
  ])('refuses a ciphertext moved to %s', (_label, change) => {
    const box = new SecretBox(KEY);
    const sealed = box.seal('s3cret', binding);
    expect(() => box.open(sealed, { ...binding, ...change })).toThrow(new SecretBoxError('SS12000_SECRET_UNREADABLE'));
  });

  it('refuses a tampered ciphertext or tag', () => {
    const box = new SecretBox(KEY);
    const sealed = box.seal('s3cret', binding);
    const flipped = Buffer.from(sealed.ciphertext);
    flipped[0] = flipped[0]! ^ 1;
    expect(() => box.open({ ...sealed, ciphertext: flipped }, binding)).toThrow('SS12000_SECRET_UNREADABLE');
  });

  it.each([
    ['cut to 4 bytes', 4],
    ['cut to 12 bytes', 12],
  ])('refuses a genuine tag %s, so a short tag never stands in for the whole one', (_label, bytes) => {
    // Without an authTagLength Node accepts a GCM tag of 4 to 16 bytes and
    // checks only the bytes it is given: the first bytes of the real tag
    // then open the row, and a 4-byte tag is a forgery within reach.
    const box = new SecretBox(KEY);
    const sealed = box.seal('s3cret', binding);
    const short = { ...sealed, authTag: sealed.authTag.subarray(0, bytes) };
    expect(() => box.open(short, binding)).toThrow(new SecretBoxError('SS12000_SECRET_UNREADABLE'));
  });

  it('refuses an iv that is not 12 bytes', () => {
    const box = new SecretBox(KEY);
    const sealed = box.seal('s3cret', binding);
    expect(() => box.open({ ...sealed, iv: Buffer.concat([sealed.iv, Buffer.alloc(4)]) }, binding)).toThrow(
      new SecretBoxError('SS12000_SECRET_UNREADABLE'),
    );
  });

  it('decrypts with the previous key during a rotation and always seals with the current one', () => {
    const before = new SecretBox(OLD_KEY).seal('s3cret', binding);
    const rotated = new SecretBox(KEY, OLD_KEY);
    expect(rotated.open(before, binding)).toBe('s3cret');
    expect(rotated.seal('s3cret', binding).keyId).toBe(keyIdOf(KEY));
    expect(() => new SecretBox(KEY).open(before, binding)).toThrow('SS12000_SECRET_UNREADABLE');
  });

  it('refuses to seal without a key: nothing is ever stored in plaintext', () => {
    const box = new SecretBox(undefined);
    expect(box.configured).toBe(false);
    expect(() => box.seal('s3cret', binding)).toThrow(new SecretBoxError('SS12000_SECRETS_NOT_CONFIGURED'));
  });

  it('binds the AAD to school, source, kind and origin, in that order', () => {
    expect(aadOf(binding).toString('utf8')).toBe(
      'ss12000-source:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222:CLIENT_SECRET:https://skolid.se',
    );
  });

  describe('secretValueProblem', () => {
    it('accepts a printable token and a PEM key and certificate Node can load', () => {
      const tls = makeTestTls();
      expect(secretValueProblem('CLIENT_SECRET', 'abc-DEF_123')).toBeNull();
      expect(secretValueProblem('CLIENT_KEY_PEM', tls.clientKey)).toBeNull();
      expect(secretValueProblem('CLIENT_CERT_PEM', tls.clientCert)).toBeNull();
    });

    it('answers a code, never the value, for what its kind cannot be', () => {
      expect(secretValueProblem('CLIENT_SECRET', 'has space')).toBe('SS12000_SECRET_MALFORMED');
      expect(secretValueProblem('BEARER_TOKEN', '')).toBe('SS12000_SECRET_MALFORMED');
      expect(secretValueProblem('CLIENT_KEY_PEM', '-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----')).toBe('SS12000_KEY_PEM_INVALID');
      expect(secretValueProblem('CLIENT_CERT_PEM', 'not a certificate')).toBe('SS12000_CERT_PEM_INVALID');
      expect(secretValueProblem('CLIENT_SECRET', 'x'.repeat(16 * 1024 + 1))).toBe('SS12000_SECRET_TOO_LARGE');
    });
  });
});
