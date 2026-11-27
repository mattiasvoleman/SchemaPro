import { checkAuthSettings, describeAuthSettings, signupOf, smtpOf } from './auth-settings';

const OWN_SMTP = {
  smtp_host: 'smtp.skolan.example',
  smtp_port: '587',
  smtp_user: 'secret-user',
  smtp_pass: 'secret-pass',
  smtp_admin_email: 'noreply@skolan.example',
  smtp_sender_name: 'Rastra',
  rate_limit_email_sent: 30,
  disable_signup: true,
};

function fetchOf(answers: Record<string, unknown | number>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const impl = (async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url, headers: init?.headers ?? {} });
    const key = Object.keys(answers).find((k) => url.includes(k));
    const answer = key ? answers[key] : 404;
    if (typeof answer === 'number') return { ok: false, status: answer, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => answer };
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('signupOf', () => {
  it.each([
    [{ disable_signup: true }, 'DISABLED'],
    [{ disable_signup: false }, 'ENABLED'],
    [{}, 'UNKNOWN'],
    [{ disable_signup: 'yes' }, 'UNKNOWN'],
    [null, 'UNKNOWN'],
    [[true], 'UNKNOWN'],
  ])('%j is %s', (settings, verdict) => {
    expect(signupOf(settings)).toBe(verdict);
  });
});

describe('smtpOf', () => {
  it('a host is the project\'s own SMTP, with its port, sender and hourly limit, and nothing else', () => {
    const verdict = smtpOf(OWN_SMTP);
    expect(verdict).toEqual({ kind: 'CUSTOM', host: 'smtp.skolan.example', port: 587, sender: 'noreply@skolan.example', perHour: 30 });
    expect(JSON.stringify(verdict)).not.toContain('secret');
  });

  it('no host is Supabase\'s own sender', () => {
    expect(smtpOf({ smtp_host: null, rate_limit_email_sent: 2 })).toEqual({ kind: 'BUILT_IN', perHour: 2 });
    expect(smtpOf({ smtp_host: '  ' })).toEqual({ kind: 'BUILT_IN', perHour: null });
    expect(smtpOf({})).toEqual({ kind: 'BUILT_IN', perHour: null });
  });

  it('a port or a limit that is not a whole number is not kept', () => {
    expect(smtpOf({ smtp_host: 'h', smtp_port: 'abc', rate_limit_email_sent: -1 })).toEqual({ kind: 'CUSTOM', host: 'h', port: null, sender: null, perHour: null });
    expect(smtpOf({ smtp_host: 'h', smtp_port: 465, smtp_admin_email: ' ' })).toEqual({ kind: 'CUSTOM', host: 'h', port: 465, sender: null, perHour: null });
  });

  it('an answer that is not a config is not read', () => {
    expect(smtpOf('nope')).toEqual({ kind: 'UNKNOWN', why: expect.stringContaining('not a config') });
    expect(smtpOf(null).kind).toBe('UNKNOWN');
  });
});

describe('checkAuthSettings', () => {
  it('reads the public settings with the key as apikey, and the config with the access token as a bearer', async () => {
    const { impl, calls } = fetchOf({ '/auth/v1/settings': { disable_signup: true }, '/config/auth': OWN_SMTP });
    const report = await checkAuthSettings({
      supabaseUrl: 'https://abcdefghij.supabase.co/',
      apiKey: 'service-key',
      accessToken: 'sbp_token',
      projectRef: 'abcdefghij',
      fetchImpl: impl,
    });
    expect(report.signup).toBe('DISABLED');
    expect(report.smtp.kind).toBe('CUSTOM');
    expect(calls[0]).toEqual({ url: 'https://abcdefghij.supabase.co/auth/v1/settings', headers: { apikey: 'service-key' } });
    expect(calls[1]).toEqual({ url: 'https://api.supabase.com/v1/projects/abcdefghij/config/auth', headers: { authorization: 'Bearer sbp_token' } });
    expect(JSON.stringify(report)).not.toContain('secret');
  });

  it('without a token the SMTP is not read, and the Management API is not asked', async () => {
    const { impl, calls } = fetchOf({ '/auth/v1/settings': { disable_signup: false } });
    const report = await checkAuthSettings({ supabaseUrl: 'https://x.supabase.co', apiKey: 'k', fetchImpl: impl });
    expect(report.signup).toBe('ENABLED');
    expect(report.smtp).toEqual({ kind: 'UNKNOWN', why: expect.stringContaining('SUPABASE_ACCESS_TOKEN') });
    expect(calls).toHaveLength(1);
  });

  it('one of the two Management API variables is not enough', async () => {
    const { impl, calls } = fetchOf({ '/auth/v1/settings': { disable_signup: true } });
    const report = await checkAuthSettings({ supabaseUrl: 'https://x.supabase.co', apiKey: 'k', accessToken: 't', fetchImpl: impl });
    expect(report.smtp).toEqual({ kind: 'UNKNOWN', why: expect.stringContaining('Both') });
    expect(calls).toHaveLength(1);
  });

  it('a project reference that is not one is not put in a URL', async () => {
    const { impl, calls } = fetchOf({ '/auth/v1/settings': { disable_signup: true } });
    const report = await checkAuthSettings({ supabaseUrl: 'https://x.supabase.co', apiKey: 'k', accessToken: 't', projectRef: '../../v1/organizations', fetchImpl: impl });
    expect(report.smtp.kind).toBe('UNKNOWN');
    expect(calls).toHaveLength(1);
  });

  it('a read that fails is "not read", never an exception, and the config answers signups when the settings did not', async () => {
    const { impl } = fetchOf({ '/auth/v1/settings': 502, '/config/auth': { smtp_host: '', disable_signup: false } });
    const report = await checkAuthSettings({ supabaseUrl: 'https://x.supabase.co', apiKey: 'k', accessToken: 't', projectRef: 'abcdefghij', fetchImpl: impl });
    expect(report.signup).toBe('ENABLED');
    expect(report.smtp).toEqual({ kind: 'BUILT_IN', perHour: null });

    const down = fetchOf({ '/auth/v1/settings': 502, '/config/auth': 401 });
    const failed = await checkAuthSettings({ supabaseUrl: 'https://x.supabase.co', apiKey: 'k', accessToken: 't', projectRef: 'abcdefghij', fetchImpl: down.impl });
    expect(failed.signup).toBe('UNKNOWN');
    expect(failed.smtp).toEqual({ kind: 'UNKNOWN', why: 'The Management API could not be read (HTTP 401).' });
  });

  it('the public settings stay the answer about signups when the config disagrees', async () => {
    const { impl } = fetchOf({ '/auth/v1/settings': { disable_signup: true }, '/config/auth': { smtp_host: 'h', disable_signup: false } });
    const report = await checkAuthSettings({ supabaseUrl: 'https://x.supabase.co', apiKey: 'k', accessToken: 't', projectRef: 'abcdefghij', fetchImpl: impl });
    expect(report.signup).toBe('DISABLED');
  });
});

describe('describeAuthSettings', () => {
  it('says what is wrong in the words the operator acts on', () => {
    const lines = describeAuthSettings({ signup: 'ENABLED', smtp: { kind: 'BUILT_IN', perHour: 2 } }).join('\n');
    expect(lines).toContain('Public signups:   ON');
    expect(lines).toContain('Supabase\'s own sender (2 mails an hour)');
    expect(lines).toContain('HTTP 429');
  });

  it('a project with its own SMTP at 30 an hour is told what 300 people cost', () => {
    const lines = describeAuthSettings({ signup: 'DISABLED', smtp: { kind: 'CUSTOM', host: 'smtp.skolan.example', port: 587, sender: 'noreply@skolan.example', perHour: 30 } }).join('\n');
    expect(lines).toContain('Public signups:   off');
    expect(lines).toContain('smtp.skolan.example:587 as noreply@skolan.example, at most 30 mails an hour');
    expect(lines).toContain('takes 10 hours');
  });

  it('a generous limit is not warned about, and a limit of 0 does not divide by it', () => {
    const generous = describeAuthSettings({ signup: 'DISABLED', smtp: { kind: 'CUSTOM', host: 'h', port: null, sender: null, perHour: 500 } }).join('\n');
    expect(generous).not.toContain('takes');
    const zero = describeAuthSettings({ signup: 'DISABLED', smtp: { kind: 'CUSTOM', host: 'h', port: null, sender: null, perHour: 0 } }).join('\n');
    expect(zero).not.toContain('Infinity');
  });

  it('what was not read is said not to be read', () => {
    const lines = describeAuthSettings({ signup: 'UNKNOWN', smtp: { kind: 'UNKNOWN', why: 'No token.' } }).join('\n');
    expect(lines).toContain('Public signups:   not read');
    expect(lines).toContain('Sender (SMTP):    not read. No token.');
  });
});
