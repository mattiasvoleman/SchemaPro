import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigContext, ExpoConfig } from 'expo/config';
import appConfig from '../../app.config';
import staticConfig from '../../app.json';
import eas from '../../eas.json';

/**
 * eas.json names the build profiles after their app and variant, and
 * app.config.ts takes the app and variant from the profile's env. Nothing
 * else ties the two: a guardian profile with a copied `"APP": "rastra"`
 * would pass every guard in app.config.ts and sign Rastra under the guardian
 * app's profile. And a standalone `eas submit` evaluates the app config
 * without the build profile's env (APP unset is Rastra), so each submit
 * profile names its app's ids itself; they must be the ones the build gets.
 */
type Profile = {
  extends?: string;
  environment?: string;
  env?: Record<string, string>;
};

const BUILD = eas.build as Record<string, Profile>;
const SUBMIT = eas.submit as Record<
  string,
  { ios?: { bundleIdentifier?: string; appName?: string }; android?: { applicationId?: string } }
>;

/** A profile with what it extends merged in, as eas-json does: the extending profile's env keys win. */
function resolved(name: string): Profile {
  const profile = BUILD[name];
  if (!profile) throw new Error(`no build profile ${name}`);
  if (!profile.extends) return profile;
  const base = resolved(profile.extends);
  return { ...base, ...profile, env: { ...base.env, ...profile.env } };
}

const SAVED = { ...process.env };
let projectRoot: string;
beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'eas-profiles-'));
});
afterEach(() => {
  process.env = { ...SAVED };
  rmSync(projectRoot, { recursive: true, force: true });
});

function evaluate(env: Record<string, string>): ExpoConfig {
  const clean = { ...SAVED };
  for (const key of ['APP', 'APP_VARIANT', 'EAS_BUILD', 'EAS_BUILD_PLATFORM', 'GOOGLE_SERVICES_JSON']) delete clean[key];
  process.env = { ...clean, ...env };
  const context: ConfigContext = { projectRoot, staticConfigPath: null, packageJsonPath: null, config: staticConfig.expo as ExpoConfig };
  return appConfig(context);
}

const NAMES = Object.keys(BUILD);

describe('eas.json build profiles', () => {
  it('are one per app and variant, and no bare profile lets a build guess an app', () => {
    expect(NAMES.sort()).toEqual(
      ['rastra', 'vardnadshavare'].flatMap((app) => ['development', 'preview', 'production'].map((v) => `${app}-${v}`)).sort(),
    );
  });

  it.each(NAMES)('%s builds the app and variant its name says, from the environment of that variant', (name) => {
    const [app, variant] = name.split('-');
    const profile = resolved(name);
    expect(profile.env?.['APP']).toBe(app);
    expect(profile.env?.['APP_VARIANT']).toBe(variant);
    expect(profile.environment).toBe(variant);
  });
});

describe('eas.json submit profiles', () => {
  it('exist for each production build, named after it', () => {
    expect(Object.keys(SUBMIT).sort()).toEqual(NAMES.filter((name) => name.endsWith('-production')).sort());
  });

  it.each(Object.keys(SUBMIT))('%s names the ids and the name its build gets', (name) => {
    const built = evaluate(resolved(name).env ?? {});
    const submit = SUBMIT[name];
    expect(submit?.ios?.bundleIdentifier).toBe(built.ios?.bundleIdentifier);
    expect(submit?.ios?.appName).toBe(built.name);
    expect(submit?.android?.applicationId).toBe(built.android?.package);
  });
});
