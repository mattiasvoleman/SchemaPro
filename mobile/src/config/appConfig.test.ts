import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigContext, ExpoConfig } from 'expo/config';
import appConfig, { appVariant } from '../../app.config';
import staticConfig from '../../app.json';
import en from '../../locales/en.json';
import sv from '../../locales/sv.json';

/**
 * app.config.ts decides which app a build installs as, and app.json and
 * locales/ carry the texts iOS shows before the app has run a line of
 * JavaScript. A mistake in either is invisible until a build is on a phone:
 * a test build that installs beside the real app instead of over it, a
 * release with no API address, an English permission prompt, a missing icon.
 */
const MOBILE = join(__dirname, '..', '..');
const base = staticConfig.expo as ExpoConfig;

// An empty project root, so a developer's own gitignored google-services.json
// in mobile/ does not change what these tests see.
let projectRoot: string;
beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'app-config-'));
});
afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

const SAVED = { ...process.env };
afterEach(() => {
  process.env = { ...SAVED };
});

function resolve(env: Record<string, string>, config: ExpoConfig = base): ExpoConfig {
  const clean = { ...SAVED };
  delete clean.APP_VARIANT;
  delete clean.EAS_BUILD;
  delete clean.EAS_BUILD_PLATFORM;
  delete clean.GOOGLE_SERVICES_JSON;
  process.env = { ...clean, ...env };
  const context: ConfigContext = { projectRoot, staticConfigPath: null, packageJsonPath: null, config };
  return appConfig(context);
}

/** app.json with its iOS infoPlist changed, as a write into it would leave it. */
function withInfoPlist(changes: Record<string, unknown>, ios: Partial<NonNullable<ExpoConfig['ios']>> = {}): ExpoConfig {
  return { ...base, ios: { ...base.ios, ...ios, infoPlist: { ...base.ios?.infoPlist, ...changes } } };
}

function identity(config: ExpoConfig): unknown[] {
  return [config.name, config.slug, config.scheme, config.ios?.bundleIdentifier, config.android?.package];
}

const PRODUCTION = ['SchemaPro', 'schemapro-teacher', 'schemapro', 'com.schemapro.teacher', 'com.schemapro.teacher'];

const RELEASE_VALUES = {
  EXPO_PUBLIC_API_BASE_URL: 'https://api.example.test',
  EXPO_PUBLIC_SUPABASE_URL: 'https://project.example.test',
  EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'publishable-key',
};

describe('app.config variants', () => {
  it('is app.json for production, with or without APP_VARIANT', () => {
    expect(identity(resolve({}))).toEqual(PRODUCTION);
    expect(identity(resolve({ APP_VARIANT: 'production' }))).toEqual(PRODUCTION);
    const production = resolve({});
    expect(production.plugins?.slice(0, -1)).toEqual(base.plugins);
    expect(production.ios?.infoPlist).toEqual(base.ios?.infoPlist);
    expect(production.android?.blockedPermissions).toEqual(base.android?.blockedPermissions);
    expect(production.android?.googleServicesFile).toBeUndefined();
  });

  it('gives the development build an identity of its own, so it installs beside the real app', () => {
    expect(identity(resolve({ APP_VARIANT: 'development' }))).toEqual([
      'SchemaPro Dev',
      'schemapro-teacher',
      'schemapro-dev',
      'com.schemapro.teacher.dev',
      'com.schemapro.teacher.dev',
    ]);
  });

  it('keeps the production identity for the test build, so it replaces the real app and only the name differs', () => {
    expect(identity(resolve({ APP_VARIANT: 'preview' }))).toEqual(['SchemaPro Test', ...PRODUCTION.slice(1)]);
  });

  it('lets only the development build answer the dev client scheme', () => {
    const devClient = (config: ExpoConfig) =>
      config.plugins?.find((plugin) => Array.isArray(plugin) && plugin[0] === 'expo-dev-client');
    expect(devClient(resolve({ APP_VARIANT: 'development' }))).toEqual(['expo-dev-client', { addGeneratedScheme: true }]);
    expect(devClient(resolve({ APP_VARIANT: 'preview' }))).toEqual(['expo-dev-client', { addGeneratedScheme: false }]);
    expect(devClient(resolve({}))).toEqual(['expo-dev-client', { addGeneratedScheme: false }]);
  });

  it('changes nothing but the identity: every other field of app.json reaches every variant', () => {
    // extra.eas.projectId and owner are what `eas init` writes; push needs the id in every build.
    const linked: ExpoConfig = { ...base, owner: 'school-org', extra: { eas: { projectId: 'project-id' } } };
    for (const variant of ['development', 'preview', 'production']) {
      const config = resolve({ APP_VARIANT: variant }, linked);
      const { name: _name, scheme: _scheme, plugins, ios, android, ...rest } = config;
      const { bundleIdentifier: _id, infoPlist, ...iosRest } = ios ?? {};
      const { package: _package, googleServicesFile: _file, ...androidRest } = android ?? {};
      const { name: _n, scheme: _s, plugins: basePlugins, ios: baseIos, android: baseAndroid, ...baseRest } = linked;
      const { bundleIdentifier: _bid, infoPlist: basePlist, ...baseIosRest } = baseIos ?? {};
      const { package: _bp, ...baseAndroidRest } = baseAndroid ?? {};
      expect(rest).toEqual(baseRest);
      expect(iosRest).toEqual(baseIosRest);
      expect(androidRest).toEqual(baseAndroidRest);
      expect(plugins?.slice(0, -1)).toEqual(basePlugins);
      const { NSLocalNetworkUsageDescription: _text, ...plist } = infoPlist ?? {};
      expect(plist).toEqual(basePlist);
    }
  });

  it('refuses an unknown variant instead of building production', () => {
    expect(() => appVariant('staging')).toThrow('APP_VARIANT');
    expect(() => resolve({ APP_VARIANT: 'Production' })).toThrow('APP_VARIANT');
  });
});

describe('app.config on the EAS builder', () => {
  it('stops a release build that lacks its public values, and neither a development build nor a local run', () => {
    expect(() => resolve({ EAS_BUILD: 'true', APP_VARIANT: 'preview' })).toThrow(
      'EXPO_PUBLIC_API_BASE_URL, EXPO_PUBLIC_SUPABASE_URL, EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY in the EAS "preview" environment',
    );
    expect(() => resolve({ EAS_BUILD: 'true', APP_VARIANT: 'production', ...RELEASE_VALUES, EXPO_PUBLIC_SUPABASE_URL: '' })).toThrow(
      'needs EXPO_PUBLIC_SUPABASE_URL in the EAS "production" environment',
    );
    expect(() => resolve({ EAS_BUILD: 'true', APP_VARIANT: 'development' })).not.toThrow();
    expect(() => resolve({ APP_VARIANT: 'preview' })).not.toThrow();
    expect(() => resolve({ EAS_BUILD: 'true', EAS_BUILD_PLATFORM: 'ios', APP_VARIANT: 'production', ...RELEASE_VALUES })).not.toThrow();
  });

  it('stops an Android release without FCM, which would install and never receive a push', () => {
    const android = { EAS_BUILD: 'true', EAS_BUILD_PLATFORM: 'android', ...RELEASE_VALUES };
    expect(() => resolve({ ...android, APP_VARIANT: 'preview' })).toThrow('needs GOOGLE_SERVICES_JSON in the EAS "preview" environment');
    expect(() => resolve({ ...android, APP_VARIANT: 'development' })).not.toThrow();
    const withFile = resolve({ ...android, APP_VARIANT: 'production', GOOGLE_SERVICES_JSON: '/builder/google-services.json' });
    expect(withFile.android?.googleServicesFile).toBe('/builder/google-services.json');
  });

  it('runs the same checks in `eas build --local`, where EAS_BUILD is "1"', () => {
    expect(() => resolve({ EAS_BUILD: '1', APP_VARIANT: 'preview' })).toThrow('in the EAS "preview" environment');
    expect(() => resolve({ EAS_BUILD: '1', EAS_BUILD_PLATFORM: 'android', APP_VARIANT: 'production', ...RELEASE_VALUES })).toThrow(
      'needs GOOGLE_SERVICES_JSON',
    );
  });

  it('stops a build from an app.json that already carries the development suffix, but leaves EAS CLI free to roll it back', () => {
    const devBase = withInfoPlist({}, { bundleIdentifier: 'com.schemapro.teacher.dev' });
    const builder = { EAS_BUILD: 'true', EAS_BUILD_PLATFORM: 'ios', ...RELEASE_VALUES };
    expect(() => resolve({ ...builder, APP_VARIANT: 'production' }, devBase)).toThrow('development build\'s suffix');
    expect(() => resolve({ ...builder, APP_VARIANT: 'development' }, devBase)).toThrow('development build\'s suffix');
    const androidDev: ExpoConfig = { ...base, android: { ...base.android, package: 'com.schemapro.teacher.dev' } };
    expect(() => resolve({ ...builder, EAS_BUILD_PLATFORM: 'android', GOOGLE_SERVICES_JSON: '/f', APP_VARIANT: 'preview' }, androidDev)).toThrow(
      'expo.android.package ends in ".dev"',
    );
    // Where the CLI evaluates the file it must not throw, or the CLI could
    // not roll its own write back.
    expect(() => resolve({}, devBase)).not.toThrow();
    expect(base.ios?.bundleIdentifier?.endsWith('.dev')).toBe(false);
    expect(base.android?.package?.endsWith('.dev')).toBe(false);
  });

  it('keeps an answer written by eas build\'s export-compliance question out of every variant, so the CLI rolls its write back', () => {
    const prompted = withInfoPlist({ ITSAppUsesNonExemptEncryption: false });
    for (const variant of ['development', 'preview', 'production']) {
      const plist = resolve({ APP_VARIANT: variant }, prompted).ios?.infoPlist;
      expect(plist).not.toHaveProperty('ITSAppUsesNonExemptEncryption');
      expect(plist?.NSFaceIDUsageDescription).toBe(base.ios?.infoPlist?.NSFaceIDUsageDescription);
    }
    // The owner's decision goes where Expo reads it, and that passes through.
    const decided = withInfoPlist({}, { config: { usesNonExemptEncryption: false } });
    expect(resolve({}, decided).ios?.config).toEqual({ usesNonExemptEncryption: false });
  });

  it("uses a developer's local google-services.json when there is one, and points at nothing when there is not", () => {
    expect(resolve({}).android?.googleServicesFile).toBeUndefined();
    writeFileSync(join(projectRoot, 'google-services.json'), '{}');
    expect(resolve({}).android?.googleServicesFile).toBe('./google-services.json');
  });
});

describe('texts and assets iOS and Android show before the app runs', () => {
  const plist = base.ios?.infoPlist ?? {};

  it('has the same keys in every locale, and says the Face ID purpose in Swedish when no locale matches', () => {
    expect(Object.keys(base.locales ?? {}).sort()).toEqual(['en', 'sv']);
    expect(plist.CFBundleLocalizations).toEqual(['sv', 'en']);
    expect(Object.keys(en.ios).sort()).toEqual(Object.keys(sv.ios).sort());
    expect(plist.CFBundleDevelopmentRegion).toBe('sv');
    expect(plist.NSFaceIDUsageDescription).toBe(sv.ios.NSFaceIDUsageDescription);
  });

  it('writes nothing the InfoPlist.strings writer would break', () => {
    // Expo writes locale values between quotes without escaping them.
    for (const locale of [sv, en]) {
      for (const value of Object.values(locale.ios)) {
        expect(value).not.toMatch(/["\\\n]/);
        expect(value.length).toBeGreaterThan(0);
      }
    }
  });

  it('leaves the Face ID text to app.json, where no plugin default can replace it', () => {
    // A plugin's faceIDPermission prop wins over infoPlist, and only in the
    // base file: the English plugin text would return in the Swedish build.
    const props = (name: string) =>
      base.plugins?.find((plugin) => (Array.isArray(plugin) ? plugin[0] : plugin) === name);
    expect(props('expo-local-authentication')).toBe('expo-local-authentication');
    expect(props('expo-secure-store')).toBe('expo-secure-store');
  });

  it('claims no local network use in a release build, and asks for it in Swedish in the development build', () => {
    // A text of our own in a preview or production build would survive the
    // dev launcher's release build phase, which strips only its own.
    expect(plist).not.toHaveProperty('NSLocalNetworkUsageDescription');
    expect(sv.ios).not.toHaveProperty('NSLocalNetworkUsageDescription');
    expect(en.ios).not.toHaveProperty('NSLocalNetworkUsageDescription');
    expect(resolve({}).ios?.infoPlist).not.toHaveProperty('NSLocalNetworkUsageDescription');
    expect(resolve({ APP_VARIANT: 'preview' }).ios?.infoPlist).not.toHaveProperty('NSLocalNetworkUsageDescription');
    const dev = resolve({ APP_VARIANT: 'development' }).ios?.infoPlist?.NSLocalNetworkUsageDescription;
    expect(dev).toMatch(/lokala nätverket/);
    expect(dev).not.toMatch(/["\\\n]/);
  });

  it('leaves the export-compliance answer to the owner, in ios.config where Expo reads it', () => {
    // app.config.ts drops infoPlist.ITSAppUsesNonExemptEncryption, so set
    // there it would do nothing: the decision is ios.config.usesNonExemptEncryption.
    expect(plist).not.toHaveProperty('ITSAppUsesNonExemptEncryption');
  });

  it('blocks the Android permissions the template and libraries add and the app never uses', () => {
    expect(base.android?.blockedPermissions).toEqual(
      expect.arrayContaining([
        'android.permission.SYSTEM_ALERT_WINDOW',
        'android.permission.READ_EXTERNAL_STORAGE',
        'android.permission.WRITE_EXTERNAL_STORAGE',
        'com.google.android.gms.permission.AD_ID',
      ]),
    );
    expect(base.android?.permissions).toBeUndefined();
  });

  it('points every icon and splash path at a PNG in the repository', () => {
    const paths = JSON.stringify(staticConfig).match(/\.\/assets\/[^"]+/g) ?? [];
    expect(paths.length).toBeGreaterThanOrEqual(6);
    for (const path of paths) {
      const file = join(MOBILE, path);
      expect(existsSync(file)).toBe(true);
      expect(readFileSync(file).subarray(1, 4).toString('latin1')).toBe('PNG');
    }
  });
});
