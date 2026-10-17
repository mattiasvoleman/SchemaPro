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

function resolve(env: Record<string, string>): ExpoConfig {
  const clean = { ...SAVED };
  delete clean.APP_VARIANT;
  delete clean.EAS_BUILD;
  delete clean.EAS_BUILD_PLATFORM;
  delete clean.GOOGLE_SERVICES_JSON;
  process.env = { ...clean, ...env };
  const context: ConfigContext = { projectRoot, staticConfigPath: null, packageJsonPath: null, config: base };
  return appConfig(context);
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

  it('claims no local network use, so the dev client text is stripped from release builds', () => {
    expect(plist).not.toHaveProperty('NSLocalNetworkUsageDescription');
    expect(sv.ios).not.toHaveProperty('NSLocalNetworkUsageDescription');
    expect(en.ios).not.toHaveProperty('NSLocalNetworkUsageDescription');
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
