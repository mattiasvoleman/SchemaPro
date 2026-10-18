import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigContext, ExpoConfig } from 'expo/config';
import appConfig, { appId, appVariant } from '../../app.config';
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
  delete clean.APP;
  delete clean.APP_VARIANT;
  delete clean.EAS_BUILD;
  delete clean.EAS_BUILD_PLATFORM;
  delete clean.GOOGLE_SERVICES_JSON;
  process.env = { ...clean, ...env };
  const context: ConfigContext = { projectRoot, staticConfigPath: null, packageJsonPath: null, config };
  return appConfig(context);
}

function identity(config: ExpoConfig): unknown[] {
  return [config.name, config.slug, config.scheme, config.ios?.bundleIdentifier, config.android?.package];
}

const VARIANTS = ['development', 'preview', 'production'] as const;

/** The six builds: what each installs as. Only the name tells preview from production; development sits beside both. */
const MATRIX: ReadonlyArray<[string, string, unknown[]]> = [
  ['rastra', 'development', ['Rastra Dev', 'rastra', 'rastra-dev', 'se.rastra.app.dev', 'se.rastra.app.dev']],
  ['rastra', 'preview', ['Rastra Test', 'rastra', 'rastra', 'se.rastra.app', 'se.rastra.app']],
  ['rastra', 'production', ['Rastra', 'rastra', 'rastra', 'se.rastra.app', 'se.rastra.app']],
  ['vardnadshavare', 'development', ['Rastra vårdnadshavare Dev', 'rastra', 'rastra-vardnadshavare-dev', 'se.rastra.vardnadshavare.dev', 'se.rastra.vardnadshavare.dev']],
  ['vardnadshavare', 'preview', ['Rastra vårdnadshavare Test', 'rastra', 'rastra-vardnadshavare', 'se.rastra.vardnadshavare', 'se.rastra.vardnadshavare']],
  ['vardnadshavare', 'production', ['Rastra vårdnadshavare', 'rastra', 'rastra-vardnadshavare', 'se.rastra.vardnadshavare', 'se.rastra.vardnadshavare']],
];

const RELEASE_VALUES = {
  EXPO_PUBLIC_API_BASE_URL: 'https://api.example.test',
  EXPO_PUBLIC_SUPABASE_URL: 'https://project.example.test',
  EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'publishable-key',
};

const plugin = (config: ExpoConfig, name: string) =>
  config.plugins?.find((entry) => (Array.isArray(entry) ? entry[0] : entry) === name);

describe('app.config: two apps, three variants each', () => {
  it.each(MATRIX)('builds %s in %s as its own identity, on one EAS project (one slug)', (app, variant, expected) => {
    expect(identity(resolve({ APP: app, APP_VARIANT: variant }))).toEqual(expected);
  });

  it('is app.json for Rastra in production, with APP and APP_VARIANT unset or set', () => {
    const production = resolve({});
    expect(identity(production)).toEqual(MATRIX[2]?.[2]);
    expect(identity(resolve({ APP: 'rastra', APP_VARIANT: 'production' }))).toEqual(MATRIX[2]?.[2]);
    expect(production.plugins?.slice(0, -1)).toEqual(base.plugins);
    expect(production.ios?.infoPlist).toEqual(base.ios?.infoPlist);
    expect(production.android?.blockedPermissions).toEqual(base.android?.blockedPermissions);
    expect(production.locales).toEqual(base.locales);
    expect(production.android?.googleServicesFile).toBeUndefined();
  });

  it('overrides an extra.app that `eas init` copied into app.json, so the guardian build stays itself', () => {
    // eas-cli writes the whole evaluated extra into app.json: Rastra's identity, with the project id.
    const written: ExpoConfig = {
      ...base,
      extra: { app: { id: 'rastra', name: 'Rastra', otherName: 'Rastra vårdnadshavare' }, router: {}, eas: { projectId: 'p' } },
    };
    expect(resolve({ APP: 'vardnadshavare' }, written).extra).toEqual({
      app: { id: 'vardnadshavare', name: 'Rastra vårdnadshavare', otherName: 'Rastra' },
      router: {},
      eas: { projectId: 'p' },
    });
  });

  it('writes the running app\'s identity into extra.app, where the sign-in gate and the texts read it', () => {
    for (const variant of VARIANTS) {
      expect(resolve({ APP_VARIANT: variant }).extra?.['app']).toEqual({ id: 'rastra', name: 'Rastra', otherName: 'Rastra vårdnadshavare' });
      expect(resolve({ APP: 'vardnadshavare', APP_VARIANT: variant }).extra?.['app']).toEqual({
        id: 'vardnadshavare',
        name: 'Rastra vårdnadshavare',
        otherName: 'Rastra',
      });
    }
  });

  it('changes nothing but the identity: every other field of app.json reaches every Rastra variant', () => {
    // extra.eas.projectId and owner are what `eas init` is for; push needs the id in every build of both apps.
    const linked: ExpoConfig = { ...base, owner: 'school-org', extra: { eas: { projectId: 'project-id' } } };
    for (const app of ['rastra', 'vardnadshavare']) {
      for (const variant of VARIANTS) {
        const config = resolve({ APP: app, APP_VARIANT: variant }, linked);
        const { name: _name, scheme: _scheme, plugins, ios, android, extra, locales: _locales, ...rest } = config;
        const { app: _app, ...extraRest } = extra ?? {};
        expect(extraRest).toEqual(linked.extra);
        const { name: _n, scheme: _s, plugins: basePlugins, ios: baseIos, android: baseAndroid, extra: _extra, locales: _l, ...baseRest } = linked;
        expect(rest).toEqual(baseRest);
        if (app !== 'rastra') continue;
        const { bundleIdentifier: _id, infoPlist, ...iosRest } = ios ?? {};
        const { package: _package, googleServicesFile: _file, ...androidRest } = android ?? {};
        const { bundleIdentifier: _bid, infoPlist: basePlist, ...baseIosRest } = baseIos ?? {};
        const { package: _bp, ...baseAndroidRest } = baseAndroid ?? {};
        expect(iosRest).toEqual(baseIosRest);
        expect(androidRest).toEqual(baseAndroidRest);
        expect(plugins?.slice(0, -1)).toEqual(basePlugins);
        const { NSLocalNetworkUsageDescription: _text, ...plist } = infoPlist ?? {};
        expect(plist).toEqual(basePlist);
      }
    }
  });

  it('gives the guardian app, which takes no attendance, no Face ID text and no biometric permission', () => {
    for (const variant of VARIANTS) {
      const guardian = resolve({ APP: 'vardnadshavare', APP_VARIANT: variant });
      expect(guardian.ios?.infoPlist).not.toHaveProperty('NSFaceIDUsageDescription');
      expect(guardian.locales).toBeUndefined();
      // Told false, both plugins remove the key instead of writing their English default.
      expect(plugin(guardian, 'expo-secure-store')).toEqual(['expo-secure-store', { faceIDPermission: false }]);
      expect(plugin(guardian, 'expo-local-authentication')).toEqual(['expo-local-authentication', { faceIDPermission: false }]);
      expect(guardian.android?.blockedPermissions).toEqual([
        ...(base.android?.blockedPermissions ?? []),
        'android.permission.USE_BIOMETRIC',
        'android.permission.USE_FINGERPRINT',
      ]);
      // Everything else of the base passes through: icons, splash, the rest of the plist.
      const { NSFaceIDUsageDescription: _faceId, ...rest } = base.ios?.infoPlist ?? {};
      const { NSLocalNetworkUsageDescription: _text, ...plist } = guardian.ios?.infoPlist ?? {};
      expect(plist).toEqual(rest);
      expect(guardian.ios?.icon).toEqual(base.ios?.icon);
    }
  });

  it('lets only Rastra\'s development build answer the dev client scheme, which both would otherwise claim', () => {
    const devClient = (config: ExpoConfig) => plugin(config, 'expo-dev-client');
    expect(devClient(resolve({ APP_VARIANT: 'development' }))).toEqual(['expo-dev-client', { addGeneratedScheme: true }]);
    for (const [app, variant] of [['rastra', 'preview'], ['rastra', 'production'], ['vardnadshavare', 'development'], ['vardnadshavare', 'production']]) {
      expect(devClient(resolve({ APP: app ?? '', APP_VARIANT: variant ?? '' }))).toEqual(['expo-dev-client', { addGeneratedScheme: false }]);
    }
  });

  it('refuses an unknown app or variant instead of building Rastra in production', () => {
    expect(() => appVariant('staging')).toThrow('APP_VARIANT');
    expect(() => resolve({ APP_VARIANT: 'Production' })).toThrow('APP_VARIANT');
    expect(() => appId('guardian')).toThrow('APP must be rastra or vardnadshavare');
    expect(() => resolve({ APP: 'Rastra' })).toThrow('APP must be rastra or vardnadshavare');
  });
});

describe('app.config on the EAS builder', () => {
  const builder = { EAS_BUILD: 'true', EAS_BUILD_PLATFORM: 'ios', ...RELEASE_VALUES };

  it('stops a build whose profile does not say which app it is', () => {
    expect(() => resolve({ ...builder, APP_VARIANT: 'production' })).toThrow('APP must be set in the build profile');
    expect(() => resolve({ ...builder, EAS_BUILD: '1', APP_VARIANT: 'development' })).toThrow('APP must be set');
    expect(() => resolve({ ...builder, APP: 'vardnadshavare', APP_VARIANT: 'production' })).not.toThrow();
    // Where EAS CLI or `expo start` evaluates the file, unset is Rastra.
    expect(() => resolve({ APP_VARIANT: 'production' })).not.toThrow();
  });

  it('stops a release build that lacks its public values, and neither a development build nor a local run', () => {
    expect(() => resolve({ EAS_BUILD: 'true', APP: 'rastra', APP_VARIANT: 'preview' })).toThrow(
      'EXPO_PUBLIC_API_BASE_URL, EXPO_PUBLIC_SUPABASE_URL, EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY in the EAS "preview" environment',
    );
    expect(() => resolve({ ...builder, APP: 'vardnadshavare', APP_VARIANT: 'production', EXPO_PUBLIC_SUPABASE_URL: '' })).toThrow(
      'needs EXPO_PUBLIC_SUPABASE_URL in the EAS "production" environment',
    );
    expect(() => resolve({ EAS_BUILD: 'true', APP: 'rastra', APP_VARIANT: 'development' })).not.toThrow();
    expect(() => resolve({ APP_VARIANT: 'preview' })).not.toThrow();
    expect(() => resolve({ ...builder, APP: 'rastra', APP_VARIANT: 'production' })).not.toThrow();
  });

  it('stops an Android release without FCM, which would install and never receive a push', () => {
    const android = { ...builder, EAS_BUILD_PLATFORM: 'android' };
    expect(() => resolve({ ...android, APP: 'vardnadshavare', APP_VARIANT: 'preview' })).toThrow(
      'needs GOOGLE_SERVICES_JSON in the EAS "preview" environment',
    );
    expect(() => resolve({ ...android, APP: 'rastra', APP_VARIANT: 'development' })).not.toThrow();
    const withFile = resolve({ ...android, APP: 'rastra', APP_VARIANT: 'production', GOOGLE_SERVICES_JSON: '/builder/google-services.json' });
    expect(withFile.android?.googleServicesFile).toBe('/builder/google-services.json');
  });

  it('runs the same checks in `eas build --local`, where EAS_BUILD is "1"', () => {
    expect(() => resolve({ EAS_BUILD: '1', APP: 'rastra', APP_VARIANT: 'preview' })).toThrow('in the EAS "preview" environment');
    expect(() => resolve({ ...builder, EAS_BUILD: '1', EAS_BUILD_PLATFORM: 'android', APP: 'rastra', APP_VARIANT: 'production' })).toThrow(
      'needs GOOGLE_SERVICES_JSON',
    );
  });

  it("stops a build from an app.json that holds anything but Rastra's production id, but leaves EAS CLI free to roll a write back", () => {
    const written = (ios: string, android: string): ExpoConfig => ({
      ...base,
      ios: { ...base.ios, bundleIdentifier: ios },
      android: { ...base.android, package: android },
    });
    for (const wrong of ['se.rastra.app.dev', 'se.rastra.vardnadshavare']) {
      expect(() => resolve({ ...builder, APP: 'rastra', APP_VARIANT: 'production' }, written(wrong, 'se.rastra.app'))).toThrow(
        `expo.ios.bundleIdentifier is "${wrong}", not Rastra's production id`,
      );
      expect(() =>
        resolve({ ...builder, EAS_BUILD_PLATFORM: 'android', GOOGLE_SERVICES_JSON: '/f', APP: 'vardnadshavare', APP_VARIANT: 'preview' }, written('se.rastra.app', wrong)),
      ).toThrow(`expo.android.package is "${wrong}"`);
      // Where the CLI evaluates the file it must not throw, or the CLI could
      // not roll its own write back.
      expect(() => resolve({}, written(wrong, wrong))).not.toThrow();
    }
    expect([base.ios?.bundleIdentifier, base.android?.package]).toEqual(['se.rastra.app', 'se.rastra.app']);
  });

  it("uses a developer's local google-services.json when there is one, and points at nothing when there is not", () => {
    expect(resolve({}).android?.googleServicesFile).toBeUndefined();
    writeFileSync(join(projectRoot, 'google-services.json'), '{}');
    expect(resolve({}).android?.googleServicesFile).toBe('./google-services.json');
    expect(resolve({ APP: 'vardnadshavare' }).android?.googleServicesFile).toBe('./google-services.json');
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

  it('is written the way EAS CLI writes it, so its rollback and `eas init` leave a clean diff', () => {
    // @expo/json-file: two spaces and a final newline. A hand-formatted array
    // would be rewritten by any write the CLI makes or rolls back, and §12.5
    // tells the operator to treat any app.json change as suspect.
    expect(readFileSync(join(MOBILE, 'app.json'), 'utf8')).toBe(`${JSON.stringify(staticConfig, null, 2)}\n`);
  });

  it('answers the export-compliance question in the app config, so eas build never asks it or writes the answer', () => {
    // Decided 2026-10-17: exempt (HTTPS, the keychain and SQLCipher for the
    // local database). With the key defined eas-cli neither asks nor writes
    // into app.json, which it would otherwise do together with the whole iOS
    // block it evaluated for the build's app and variant.
    expect(base.ios?.config).toEqual({ usesNonExemptEncryption: false });
    expect(plist).not.toHaveProperty('ITSAppUsesNonExemptEncryption');
    for (const app of ['rastra', 'vardnadshavare']) {
      expect(resolve({ APP: app }).ios?.config).toEqual({ usesNonExemptEncryption: false });
    }
  });

  it('supports tablets, with phones held upright', () => {
    // With supportsTablet Expo writes all four iPad orientations (iPad
    // multitasking); the screens lay out from the window's width.
    expect(base.ios?.supportsTablet).toBe(true);
    expect(base.orientation).toBe('portrait');
    expect(base.ios).not.toHaveProperty('requireFullScreen');
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
