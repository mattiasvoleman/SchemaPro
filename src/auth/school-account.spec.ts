import { firstFactorsOf, schoolAccountOf } from './school-account';

const TENANT = '2f6a1c3e-8b4d-4f5a-9c7e-1d2b3a4c5e6f';
const OTHER = '5e4d3c2b-1a09-4877-8665-544332211000';
const entra = (tenant: string, claims: Record<string, unknown> = { tid: tenant }) => ({
  iss: `https://login.microsoftonline.com/${tenant}/v2.0`,
  custom_claims: claims,
});
const oauth = [{ method: 'oauth', timestamp: 1 }];

describe('firstFactorsOf', () => {
  it('reads { method } entries and plain strings, without refreshes and second factors', () => {
    expect(
      firstFactorsOf([
        { method: 'oauth', timestamp: 1 },
        'password',
        { method: 'totp' },
        'token_refresh',
        { method: 'mfa/webauthn' },
        { method: 'oauth' },
        { nothing: true },
        7,
        null,
      ]),
    ).toEqual(['oauth', 'password']);
  });

  it('reads nothing from something that is not a list', () => {
    expect(firstFactorsOf(undefined)).toEqual([]);
    expect(firstFactorsOf('oauth')).toEqual([]);
    expect(firstFactorsOf({ method: 'oauth' })).toEqual([]);
  });
});

describe('schoolAccountOf', () => {
  it('names the Entra tenant of a session that signed in with a school account only', () => {
    expect(schoolAccountOf({ amr: oauth, user_metadata: entra(TENANT) })).toEqual({ provider: 'azure', entraTenantId: TENANT });
    expect(
      schoolAccountOf({ amr: [...oauth, { method: 'totp' }, 'token_refresh'], user_metadata: entra(TENANT.toUpperCase(), {}) }),
    ).toEqual({ provider: 'azure', entraTenantId: TENANT });
  });

  it('names the Google Workspace domain, lower case', () => {
    expect(
      schoolAccountOf({ amr: oauth, user_metadata: { iss: 'https://accounts.google.com', custom_claims: { hd: 'Skola.Example' } } }),
    ).toEqual({ provider: 'google', googleHostedDomain: 'skola.example' });
    expect(
      schoolAccountOf({ amr: oauth, user_metadata: { iss: 'accounts.google.com', custom_claims: { hd: 'skola.example' } } }),
    ).toEqual({ provider: 'google', googleHostedDomain: 'skola.example' });
  });

  it('names nothing for a session that did not sign in with a school account alone', () => {
    for (const amr of [[{ method: 'password' }], [...oauth, { method: 'password' }], [], undefined, [{ method: 'token_refresh' }]]) {
      expect(schoolAccountOf({ amr, user_metadata: entra(TENANT) })).toBeNull();
    }
  });

  it('names nothing when the metadata says no tenant or Workspace it can trust', () => {
    for (const metadata of [
      undefined,
      'azure',
      {},
      { iss: 42 },
      { iss: 'https://login.microsoftonline.com/common/v2.0' },
      { iss: `https://skola.ciamlogin.com/${TENANT}/v2.0` },
      entra(TENANT, { tid: OTHER }),
      { iss: 'https://accounts.google.com' },
      { iss: 'https://accounts.google.com', custom_claims: { hd: '' } },
      { iss: 'https://accounts.google.com', custom_claims: 'hd' },
      { iss: 'https://www.googleapis.com/userinfo/v2/me', custom_claims: { hd: 'skola.example' } },
    ]) {
      expect(schoolAccountOf({ amr: oauth, user_metadata: metadata })).toBeNull();
    }
  });
});
