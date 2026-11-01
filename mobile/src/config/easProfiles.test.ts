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
type Platform = 'ios' | 'android';
type Section = {
  environment?: string;
  env?: Record<string, string>;
  distribution?: string;
  developmentClient?: boolean;
  autoIncrement?: boolean;
  buildType?: string;
};
type Profile = Section & { extends?: string; ios?: Section; android?: Section };

const BUILD = eas.build as Record<string, Profile>;
const SUBMIT = eas.submit as Record<
  string,
  {
    ios?: { bundleIdentifier?: string; appName?: string };
    android?: { applicationId?: string; track?: string; releaseStatus?: string };
  }
>;

/** eas-json's merge (resolver.js): the update wins, env keys merge, and so do the platform sections. */
function merge<T extends Profile>(base: T, update: T): T {
  const merged: T = { ...base, ...update };
  if (base.env && update.env) merged.env = { ...base.env, ...update.env };
  for (const platform of ['ios', 'android'] as const) {
    const [b, u] = [base[platform], update[platform]];
    if (b && u) merged[platform] = merge(b, u);
  }
  return merged;
}

function chain(name: string): Profile {
  const profile = BUILD[name];
  if (!profile) throw new Error(`no build profile ${name}`);
  const { extends: parent, ...rest } = profile;
  return parent ? merge(chain(parent), rest) : rest;
}

/** A profile as one platform's build sees it: what it extends, then that platform's section over the rest. */
function resolved(name: string, platform: Platform): Section {
  const { ios, android, ...base } = chain(name);
  return merge(base, (platform === 'ios' ? ios : android) ?? {});
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

  it.each(NAMES.flatMap((name) => (['ios', 'android'] as const).map((platform) => [name, platform] as const)))(
    '%s builds the app and variant its name says on %s, from the environment of that variant',
    (name, platform) => {
      const [app, variant] = name.split('-');
      const profile = resolved(name, platform);
      expect(profile.env?.['APP']).toBe(app);
      expect(profile.env?.['APP_VARIANT']).toBe(variant);
      expect(profile.environment).toBe(variant);
    },
  );
});

/**
 * What DEPLOYMENT.md §15.2 and §15.9 promise about how each variant is built
 * and numbered. Nothing else reads these keys before a build is paid for, and
 * a change to one is silent: a development profile without its client builds
 * an app with nothing to load, a preview that is no APK cannot be sent to an
 * Android phone by a link, and a build number nothing raises is refused by the
 * store on the second upload.
 */
describe('eas.json build settings', () => {
  const DEVELOPMENT = NAMES.filter((name) => name.endsWith('-development'));
  const PREVIEW = NAMES.filter((name) => name.endsWith('-preview'));
  const PRODUCTION = NAMES.filter((name) => name.endsWith('-production'));

  it('keeps the build number at EAS, where preview and production raise it at every build', () => {
    expect(eas.cli.appVersionSource).toBe('remote');
    for (const name of PREVIEW.concat(PRODUCTION)) expect(chain(name).autoIncrement).toBe(true);
    for (const name of DEVELOPMENT) expect(chain(name).autoIncrement).not.toBe(true);
  });

  it.each(DEVELOPMENT)('%s is a development client for internal distribution', (name) => {
    expect(chain(name).developmentClient).toBe(true);
    expect(chain(name).distribution).toBe('internal');
  });

  it.each(PREVIEW)('%s is internal distribution, an APK on Android and no development client', (name) => {
    expect(chain(name).distribution).toBe('internal');
    expect(resolved(name, 'android').buildType).toBe('apk');
    expect(resolved(name, 'ios').buildType).toBeUndefined();
    expect(chain(name).developmentClient).not.toBe(true);
  });

  it.each(PRODUCTION)('%s is a store build, not an APK and no development client', (name) => {
    expect(chain(name).distribution).toBe('store');
    expect(resolved(name, 'android').buildType).toBeUndefined();
    expect(chain(name).developmentClient).not.toBe(true);
  });
});

describe('eas.json submit profiles', () => {
  it('exist for each production build, named after it', () => {
    expect(Object.keys(SUBMIT).sort()).toEqual(NAMES.filter((name) => name.endsWith('-production')).sort());
  });

  it.each(Object.keys(SUBMIT))('%s names the ids and the name its build gets', (name) => {
    const ios = evaluate(resolved(name, 'ios').env ?? {});
    const android = evaluate(resolved(name, 'android').env ?? {});
    const submit = SUBMIT[name];
    expect(submit?.ios?.bundleIdentifier).toBe(ios.ios?.bundleIdentifier);
    expect(submit?.ios?.appName).toBe(ios.name);
    expect(submit?.android?.applicationId).toBe(android.android?.package);
  });

  // Play accepts nothing else while an app is a draft, and `eas submit` has
  // no confirmation step: a production track or a completed release would
  // publish the build to the store's public track at the first submit.
  it.each(Object.keys(SUBMIT))('%s uploads to Play\'s internal track as a draft', (name) => {
    expect(SUBMIT[name]?.android?.track).toBe('internal');
    expect(SUBMIT[name]?.android?.releaseStatus).toBe('draft');
  });
});
