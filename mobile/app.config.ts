import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigContext, ExpoConfig } from 'expo/config';

/**
 * Which app a build is, and in which variant.
 *
 * One code base, two apps with store listings of their own, chosen by APP:
 * - rastra: "Rastra", for staff and pupils (se.rastra.app).
 * - vardnadshavare: "Rastra vårdnadshavare", for guardians
 *   (se.rastra.vardnadshavare). It has no attendance, so no Face ID: its
 *   build carries no Face ID purpose text and no biometric permission.
 * Each app admits only its own roles (src/services/auth/appGate.ts), and it
 * learns which app it is from extra.app, written here from the same table
 * that gives it its bundle id.
 *
 * APP_VARIANT picks the variant of either app:
 * - development: a dev client (" Dev") with an id and URL scheme of its own
 *   (".dev", "-dev"), so it installs beside the real app and a sign-in comes
 *   back to it (Linking.createURL takes the first scheme, so
 *   rastra-dev://auth/callback must be in Supabase's redirect URLs before
 *   school accounts are switched on in that build).
 * - preview: the internal test build (" Test"). It keeps production's
 *   identity, so it replaces the real app on a test phone instead of sitting
 *   beside it: one Firebase client, one App ID, one version counter, and the
 *   redirect URL production already registers.
 * - production: the store app.
 *
 * eas.json sets both per build profile. Unset means Rastra in production, so
 * `expo export`, CI and anything else that does not ask builds exactly what
 * app.json describes; on the EAS builder an unset APP stops the build, since
 * a profile that forgot it would sign Rastra under the guardian app's name.
 * An unknown value throws everywhere: a typo must not produce a build that
 * installs over the real app.
 *
 * It exports a function of the static config, so `eas init` can still write
 * extra.eas.projectId (and owner) into app.json: @expo/config writes the
 * static file and checks that this function passes the change through, which
 * `...config` does. eas-cli writes the whole evaluated extra, so app.json
 * also gains extra.app (Rastra's identity) and extra.router; both are
 * harmless, since this function writes extra.app again for every build, and
 * DEPLOYMENT.md §12.2 says to drop them before committing. Both apps are one
 * EAS project, so the push registration of either reads the same id from
 * there.
 */

export type AppVariant = 'development' | 'preview' | 'production';
export type AppId = 'rastra' | 'vardnadshavare';

const VARIANTS: Readonly<Record<AppVariant, { name: string; id: string; scheme: string }>> = {
  development: { name: ' Dev', id: '.dev', scheme: '-dev' },
  preview: { name: ' Test', id: '', scheme: '' },
  production: { name: '', id: '', scheme: '' },
};

/**
 * The production identity app.json holds: Rastra's. A build from an app.json
 * that says anything else (a variant's or the other app's id, written back by
 * a tool from the config it evaluated) would be signed and uploaded under the
 * wrong id, and the first upload fixes an id for good.
 */
const RASTRA_ID = 'se.rastra.app';

/** The guardian app's identity; Rastra's is app.json's. */
const GUARDIAN = {
  name: 'Rastra vårdnadshavare',
  id: 'se.rastra.vardnadshavare',
  scheme: 'rastra-vardnadshavare',
} as const;

/** Plugins that write a Face ID purpose text of their own (an English default) unless told not to. */
const FACE_ID_PLUGINS: readonly string[] = ['expo-secure-store', 'expo-local-authentication'];

/** What expo-local-authentication's library manifest asks for on Android. */
const BIOMETRIC_PERMISSIONS: readonly string[] = ['android.permission.USE_BIOMETRIC', 'android.permission.USE_FINGERPRINT'];

/**
 * What a release build cannot work without. A missing EXPO_PUBLIC_* value is
 * inlined as undefined when the builder bundles the JavaScript, and the app
 * then fails at the first request on the phone; this stops the build instead.
 * Checked only where an EAS build runs: EAS_BUILD is "true" on EAS's
 * machines and "1" in `eas build --local`, and unset when EAS CLI evaluates
 * this file to start a build. Not checked for development builds, whose
 * JavaScript comes from the developer's own `expo start` and its .env.local.
 * EXPO_PUBLIC_WS_BASE_URL is left out: without it the app works and only
 * live updates are off.
 */
const REQUIRED_IN_RELEASE = [
  'EXPO_PUBLIC_API_BASE_URL',
  'EXPO_PUBLIC_SUPABASE_URL',
  'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
] as const;

export function appVariant(raw: string | undefined): AppVariant {
  if (raw === undefined || raw === '' || raw === 'production') return 'production';
  if (raw === 'development' || raw === 'preview') return raw;
  throw new Error(`APP_VARIANT must be development, preview or production, not "${raw}".`);
}

export function appId(raw: string | undefined, onEasBuilder = false): AppId {
  if (raw === 'rastra' || raw === 'vardnadshavare') return raw;
  if (raw === undefined || raw === '') {
    if (onEasBuilder) throw new Error('APP must be set in the build profile: rastra or vardnadshavare.');
    return 'rastra';
  }
  throw new Error(`APP must be rastra or vardnadshavare, not "${raw}".`);
}

function required(value: string | string[] | undefined, field: string): string {
  if (typeof value !== 'string' || value === '') throw new Error(`app.json must set ${field} as a single string.`);
  return value;
}

/**
 * Checked on the builder, not where EAS CLI evaluates this file: a throw
 * there would also stop the CLI from rolling back a write of its own that
 * left app.json with another id (appConfig.test.ts stops such a commit).
 */
function assertRastraIdentity(value: string, field: string): void {
  if (value !== RASTRA_ID) {
    throw new Error(`app.json's ${field} is "${value}", not Rastra's production id "${RASTRA_ID}"; restore it (git checkout mobile/app.json).`);
  }
}

/**
 * FCM's google-services.json. On the builder it is the EAS file variable
 * GOOGLE_SERVICES_JSON (a path to the file there); on a developer's machine
 * it may be a gitignored mobile/google-services.json. Neither is ever in the
 * repository. One file serves both apps: it lists a client for each of the
 * four packages. Prebuild throws on a configured path that does not exist,
 * so the field is set only when there is a file to point at; without it the
 * Android build has no FCM, and turning push on in Settings fails because
 * no token can be fetched.
 */
function googleServicesFile(env: NodeJS.ProcessEnv, projectRoot: string): string | undefined {
  if (env.GOOGLE_SERVICES_JSON) return env.GOOGLE_SERVICES_JSON;
  return existsSync(join(projectRoot, 'google-services.json')) ? './google-services.json' : undefined;
}

/**
 * The development build finds `expo start` on the local network, and iOS asks
 * first. The dev launcher's own English text would show; this one replaces it
 * in that build only. Preview and production must not carry the key: the dev
 * launcher's release build phase strips its own text and leaves any other.
 */
const DEV_LOCAL_NETWORK_TEXT =
  'Utvecklingsbygget letar efter utvecklingsservern på det lokala nätverket och hämtar appens kod därifrån.';

type Plugins = NonNullable<ExpoConfig['plugins']>;

/** The guardian app's plugins: the Face ID text plugins told to write none (false removes the key). */
function withoutFaceId(plugins: Plugins): Plugins {
  return plugins.map((plugin) => {
    const [name, props] = Array.isArray(plugin) ? plugin : [plugin, undefined];
    if (typeof name !== 'string' || !FACE_ID_PLUGINS.includes(name)) return plugin;
    return [name, { ...(props as Record<string, unknown> | undefined), faceIDPermission: false }];
  });
}

export default ({ config, projectRoot }: ConfigContext): ExpoConfig => {
  // Aliased so that babel-preset-expo never rewrites these reads when jest
  // transforms this file.
  const env = process.env;
  const onEasBuilder = env.EAS_BUILD === 'true' || env.EAS_BUILD === '1';
  const variant = appVariant(env.APP_VARIANT);
  const app = appId(env.APP, onEasBuilder);
  const firebase = googleServicesFile(env, projectRoot);

  if (onEasBuilder && variant !== 'development') {
    const missing: string[] = REQUIRED_IN_RELEASE.filter((name) => !env[name]);
    // An Android release without FCM installs and runs, and no one notices
    // that push never arrives until a teacher misses a notification.
    if (env.EAS_BUILD_PLATFORM === 'android' && !firebase) missing.push('GOOGLE_SERVICES_JSON');
    if (missing.length > 0) {
      throw new Error(`A ${variant} build needs ${missing.join(', ')} in the EAS "${variant}" environment.`);
    }
  }

  const rastraName = required(config.name, 'expo.name');
  const slug = required(config.slug, 'expo.slug');
  const rastraScheme = required(config.scheme, 'expo.scheme');
  const bundleIdentifier = required(config.ios?.bundleIdentifier, 'expo.ios.bundleIdentifier');
  const androidPackage = required(config.android?.package, 'expo.android.package');
  if (onEasBuilder) {
    assertRastraIdentity(bundleIdentifier, 'expo.ios.bundleIdentifier');
    assertRastraIdentity(androidPackage, 'expo.android.package');
  }

  const guardian = app === 'vardnadshavare';
  const identity = guardian
    ? { name: GUARDIAN.name, ios: GUARDIAN.id, android: GUARDIAN.id, scheme: GUARDIAN.scheme }
    : { name: rastraName, ios: bundleIdentifier, android: androidPackage, scheme: rastraScheme };
  const suffix = VARIANTS[variant];

  const { NSFaceIDUsageDescription: _faceId, ...withoutFaceIdText } = config.ios?.infoPlist ?? {};
  const infoPlist = guardian ? withoutFaceIdText : config.ios?.infoPlist;
  const plugins = config.plugins ?? [];

  return {
    ...config,
    name: `${identity.name}${suffix.name}`,
    slug,
    scheme: `${identity.scheme}${suffix.scheme}`,
    // The running app's own identity (src/config/appIdentity.ts): which roles
    // it admits, and the names its texts give.
    extra: { ...config.extra, app: { id: app, name: identity.name, otherName: guardian ? rastraName : GUARDIAN.name } },
    // The guardian app has no Face ID text to localise.
    locales: guardian ? undefined : config.locales,
    ios: {
      ...config.ios,
      bundleIdentifier: `${identity.ios}${suffix.id}`,
      infoPlist: variant === 'development' ? { ...infoPlist, NSLocalNetworkUsageDescription: DEV_LOCAL_NETWORK_TEXT } : infoPlist,
    },
    android: {
      ...config.android,
      package: `${identity.android}${suffix.id}`,
      ...(guardian ? { blockedPermissions: [...(config.android?.blockedPermissions ?? []), ...BIOMETRIC_PERMISSIONS] } : {}),
      ...(firebase ? { googleServicesFile: firebase } : {}),
    },
    plugins: [
      ...(guardian ? withoutFaceId(plugins) : plugins),
      // Only Rastra's development build answers exp+rastra://, the scheme
      // `expo start`'s QR code opens: both dev clients share the slug, and
      // two apps claiming one scheme would leave the phone to pick. The
      // guardian dev client is opened through its own scheme
      // (`npm run start:vardnadshavare` passes --scheme). The plugin is
      // applied to every build either way; listing it is how the option is set.
      ['expo-dev-client', { addGeneratedScheme: variant === 'development' && !guardian }],
    ],
  };
};
