import { apiRequest } from '../api';
import { callbackParams, emailDomain, lookupProvider, providerHints, refusalFor } from './schoolAccount';
import { en } from '../../i18n/en';
import { sv } from '../../i18n/sv';

jest.mock('../api', () => ({ apiRequest: jest.fn() }));

/**
 * "Logga in med skolkonto" in the app: the address's domain, the gateway's
 * lookup (the domain only, no bearer), the hints for the provider and the
 * codes the login screen words for what came back.
 */

describe('emailDomain', () => {
  it('answers the domain of an address, trimmed and lower case', () => {
    expect(emailDomain('  Anna.Andersson@Skola.Example ')).toBe('skola.example');
  });

  it('answers nothing for an address without a domain worth asking about', () => {
    for (const email of ['', 'anna', '@skola.example', 'anna@', 'anna@localhost', 'anna@10.0.0.1', 'anna@skola..example']) {
      expect(emailDomain(email)).toBeNull();
    }
  });
});

describe('lookupProvider', () => {
  it('asks the public route about the domain, without a bearer', async () => {
    (apiRequest as jest.Mock).mockResolvedValue({ provider: 'google' });
    await expect(lookupProvider('skola.example')).resolves.toBe('google');
    expect(apiRequest).toHaveBeenCalledWith('/public/v1/sign-in-methods/skola.example', { anonymous: true });
  });

  it('answers null for no provider and anything it does not know', async () => {
    for (const body of [{ provider: null }, { provider: 'github' }, {}, undefined]) {
      (apiRequest as jest.Mock).mockResolvedValue(body);
      await expect(lookupProvider('skola.example')).resolves.toBeNull();
    }
  });
});

describe('providerHints', () => {
  it('gives Entra the address and the domain, and Google the address', () => {
    expect(providerHints('azure', ' anna@skola.example ', 'skola.example')).toEqual({ login_hint: 'anna@skola.example', domain_hint: 'skola.example' });
    expect(providerHints('google', 'anna@skola.example', 'skola.example')).toEqual({ login_hint: 'anna@skola.example' });
  });
});

describe('refusalFor', () => {
  it('names each refusal Auth and the access-token hook give', () => {
    expect(refusalFor('signup_disabled')).toBe('SSO_NO_ACCOUNT');
    expect(refusalFor('provider_email_needs_verification')).toBe('SSO_UNVERIFIED');
    expect(refusalFor('email_not_confirmed')).toBe('SSO_UNVERIFIED');
    expect(refusalFor('sso_identity_not_allowed')).toBe('SSO_OTHER_ORGANISATION');
    expect(refusalFor('sso_not_enabled')).toBe('SSO_NOT_ENABLED');
    expect(refusalFor('access_denied')).toBe('SSO_CANCELLED');
    expect(refusalFor('consent_required')).toBe('SSO_CANCELLED');
    expect(refusalFor('interaction_required')).toBe('SSO_CANCELLED');
    expect(refusalFor('Network request failed')).toBe('LOGIN_FAILED');
    expect(refusalFor(null)).toBe('LOGIN_FAILED');
  });

  it('only answers codes the login screen has a sentence for, in both languages', () => {
    for (const code of ['signup_disabled', 'provider_email_needs_verification', 'sso_identity_not_allowed', 'sso_not_enabled', 'access_denied', null]) {
      const key = refusalFor(code) as keyof typeof sv.authErrors;
      expect(sv.authErrors[key]).toEqual(expect.any(String));
      expect(en.authErrors[key]).toEqual(expect.any(String));
    }
  });
});

describe('callbackParams', () => {
  it('reads the code, and an error from the query or the fragment', () => {
    expect(callbackParams('schemapro://auth/callback?code=abc').get('code')).toBe('abc');
    const refused = callbackParams('schemapro://auth/callback?error=access_denied&error_code=signup_disabled#error=x&error_description=Signups+not+allowed');
    expect(refused.get('error_code')).toBe('signup_disabled');
    expect(refused.get('error')).toBe('access_denied');
    expect(refused.get('error_description')).toBe('Signups not allowed');
    expect(callbackParams('schemapro://auth/callback#error_code=user_banned').get('error_code')).toBe('user_banned');
    expect(callbackParams('schemapro://auth/callback').get('code')).toBeNull();
  });
});
