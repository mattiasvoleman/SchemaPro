import { bindingFor, connectionOf, localDate, openSecrets, secretOrigin } from './connection';
import { Ss12000SourceError } from './errors';
import { SecretBox } from './secret-box';

const source = {
  id: '22222222-2222-4222-8222-222222222222',
  schoolId: '11111111-1111-4111-8111-111111111111',
  baseUrl: 'https://api.ist.example:8443/ss12000v2-api/source/SE1/v2.0',
  tokenUrl: 'https://skolid.example/connect/token',
};

describe('connection', () => {
  it('binds the client secret to the token URL\'s origin and the rest to the base URL\'s', () => {
    expect(secretOrigin(source, 'CLIENT_SECRET')).toBe('https://skolid.example');
    expect(secretOrigin(source, 'CLIENT_CERT_PEM')).toBe('https://api.ist.example:8443');
    expect(secretOrigin({ ...source, tokenUrl: null }, 'CLIENT_SECRET')).toBeNull();
    expect(bindingFor({ ...source, tokenUrl: null }, 'CLIENT_SECRET')).toBeNull();
  });

  it('opens what was sealed for this source, skips a kind with no binding, and refuses one moved to another host', () => {
    const box = new SecretBox(Buffer.alloc(32, 3));
    const sealed = box.seal('s3cret', bindingFor(source, 'CLIENT_SECRET')!);
    const row = { kind: 'CLIENT_SECRET' as const, ciphertext: sealed.ciphertext, iv: sealed.iv, auth_tag: sealed.authTag, key_id: sealed.keyId };
    expect(openSecrets(box, source, [row])).toEqual({ CLIENT_SECRET: 's3cret' });
    expect(openSecrets(box, { ...source, tokenUrl: null }, [row])).toEqual({});
    expect(() => openSecrets(box, { ...source, tokenUrl: 'https://evil.example/token' }, [row])).toThrow(
      new Ss12000SourceError('SS12000_SECRET_UNREADABLE'),
    );
    expect(() => openSecrets(new SecretBox(undefined), source, [row])).toThrow('SS12000_SECRETS_NOT_CONFIGURED');
  });

  it('carries the source\'s connection fields and the opened secrets only', () => {
    const conn = connectionOf(
      { ...source, authKind: 'BEARER_TOKEN', clientId: null, tokenScope: null, tokenAuthStyle: 'BASIC' } as never,
      { BEARER_TOKEN: 't' },
    );
    expect(conn).toEqual({
      sourceId: source.id, baseUrl: source.baseUrl, authKind: 'BEARER_TOKEN', tokenUrl: source.tokenUrl,
      clientId: null, tokenScope: null, tokenAuthStyle: 'BASIC', secrets: { BEARER_TOKEN: 't' },
    });
  });

  it('names the school-local date, which after 22:00 UTC in summer is already tomorrow in Stockholm', () => {
    expect(localDate('Europe/Stockholm', new Date('2026-10-10T22:30:00Z'))).toBe('2026-10-11');
    expect(localDate('UTC', new Date('2026-10-10T22:30:00Z'))).toBe('2026-10-10');
  });
});
