import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigContext, ExpoConfig } from 'expo/config';

/**
 * The app's identity per build variant.
 *
 * app.json stays the base. It holds everything every build shares (plugins,
 * permission texts, icons, Android permissions) and the production identity.
 * This file changes only what differs between variants:
 *
 * - development: a dev client ("SchemaPro Dev") with a bundle identifier,
 *   Android package and URL scheme of its own, so it installs beside the real
 *   app and the school-account sign-in comes back to it and not to the other
 *   app (Linking.createURL takes the first scheme, so
 *   schemapro-dev://auth/callback must be in Supabase's redirect URLs before
 *   school accounts are switched on in that build).
 * - preview: the internal test build ("SchemaPro Test"). It keeps production's
 *   identity, so it replaces the real app on a test phone instead of sitting
 *   beside it: one Firebase client, one App ID, one version counter, and the
 *   redirect URL production already registers. Only the name under the icon
 *   tells it apart.
 * - production: exactly app.json.
 *
 * eas.json sets APP_VARIANT per build profile. Unset means production, so
 * `expo export`, CI and anything else that does not ask builds exactly what
 * app.json describes. An unknown value throws rather than falling back: a
 * typo must not produce a build that installs over the real app.
 *
 * It exports a function of the static config, so `eas init` can still write
 * extra.eas.projectId (and owner) into app.json: @expo/config writes the
 * static file and checks that this function passes the change through, which
 * `...config` does. The push registration reads the id from there.
 */

export type AppVariant = 'development' | 'preview' | 'production';

const VARIANTS: Readonly<Record<AppVariant, { name: string; id: string; scheme: string }>> = {
  development: { name: ' Dev', id: '.dev', scheme: '-dev' },
  preview: { name: ' Test', id: '', scheme: '' },
  production: { name: '', id: '', scheme: '' },
};

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

function required(value: string | string[] | undefined, field: string): string {
  if (typeof value !== 'string' || value === '') throw new Error(`app.json must set ${field} as a single string.`);
  return value;
}

/**
 * app.json holds production's identity, and only this file adds `.dev`. An id
 * that already ends in it means something wrote a development build's
 * evaluated config back into app.json, and every build from it, production's
 * included, would be signed and uploaded as the development app. A build
 * from such a tree stops on the builder rather than at the store, where the
 * first upload fixes the id for good (appConfig.test.ts stops the commit).
 * Not where EAS CLI evaluates this file: a throw there would also stop the
 * CLI from rolling back such a write (withoutPromptedEncryptionAnswer).
 */
function assertProductionIdentity(value: string, field: string): void {
  const id = VARIANTS.development.id;
  if (value.endsWith(id)) {
    throw new Error(`app.json's ${field} ends in "${id}", the development build's suffix; restore it (git checkout mobile/app.json).`);
  }
}

/**
 * The answer to Apple's export-compliance question is the owner's decision
 * (docs/DEPLOYMENT.md §12.11) and goes into app.json as
 * ios.config.usesNonExemptEncryption, which Expo writes into Info.plist.
 * Until it is there, `eas build -p ios` asks the question itself and writes
 * the answer as infoPlist.ITSAppUsesNonExemptEncryption, together with the
 * whole ios block it evaluated for the build's variant (a development build's
 * bundle id included), into app.json. Dropping that key here makes the CLI's
 * check after the write fail, so it rolls app.json back, prints what it would
 * have added and builds on without it: the build waits as Missing Compliance
 * in TestFlight, as the runbook says.
 */
function withoutPromptedEncryptionAnswer(infoPlist: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!infoPlist || !('ITSAppUsesNonExemptEncryption' in infoPlist)) return infoPlist;
  const { ITSAppUsesNonExemptEncryption: _answer, ...rest } = infoPlist;
  return rest;
}

/**
 * The development build finds `expo start` on the local network, and iOS asks
 * first. The dev launcher's own English text would show; this one replaces it
 * in that build only. Preview and production must not carry the key: the dev
 * launcher's release build phase strips its own text and leaves any other.
 */
const DEV_LOCAL_NETWORK_TEXT =
  'Utvecklingsbygget letar efter utvecklingsservern på det lokala nätverket och hämtar appens kod därifrån.';

/**
 * FCM's google-services.json. On the builder it is the EAS file variable
 * GOOGLE_SERVICES_JSON (a path to the file there); on a developer's machine
 * it may be a gitignored mobile/google-services.json. Neither is ever in the
 * repository. Prebuild throws on a configured path that does not exist, so
 * the field is set only when there is a file to point at; without it the
 * Android build has no FCM, and turning push on in Settings fails because
 * no token can be fetched.
 */
function googleServicesFile(env: NodeJS.ProcessEnv, projectRoot: string): string | undefined {
  if (env.GOOGLE_SERVICES_JSON) return env.GOOGLE_SERVICES_JSON;
  return existsSync(join(projectRoot, 'google-services.json')) ? './google-services.json' : undefined;
}

export default ({ config, projectRoot }: ConfigContext): ExpoConfig => {
  // Aliased so that babel-preset-expo never rewrites these reads when jest
  // transforms this file.
  const env = process.env;
  const variant = appVariant(env.APP_VARIANT);
  const firebase = googleServicesFile(env, projectRoot);

  const onEasBuilder = env.EAS_BUILD === 'true' || env.EAS_BUILD === '1';
  if (onEasBuilder && variant !== 'development') {
    const missing: string[] = REQUIRED_IN_RELEASE.filter((name) => !env[name]);
    // An Android release without FCM installs and runs, and no one notices
    // that push never arrives until a teacher misses a notification.
    if (env.EAS_BUILD_PLATFORM === 'android' && !firebase) missing.push('GOOGLE_SERVICES_JSON');
    if (missing.length > 0) {
      throw new Error(`A ${variant} build needs ${missing.join(', ')} in the EAS "${variant}" environment.`);
    }
  }

  const name = required(config.name, 'expo.name');
  const slug = required(config.slug, 'expo.slug');
  const scheme = required(config.scheme, 'expo.scheme');
  const bundleIdentifier = required(config.ios?.bundleIdentifier, 'expo.ios.bundleIdentifier');
  const androidPackage = required(config.android?.package, 'expo.android.package');
  if (onEasBuilder) {
    assertProductionIdentity(bundleIdentifier, 'expo.ios.bundleIdentifier');
    assertProductionIdentity(androidPackage, 'expo.android.package');
  }

  const suffix = VARIANTS[variant];
  const infoPlist = withoutPromptedEncryptionAnswer(config.ios?.infoPlist);
  return {
    ...config,
    name: `${name}${suffix.name}`,
    slug,
    scheme: `${scheme}${suffix.scheme}`,
    ios: {
      ...config.ios,
      bundleIdentifier: `${bundleIdentifier}${suffix.id}`,
      infoPlist: variant === 'development' ? { ...infoPlist, NSLocalNetworkUsageDescription: DEV_LOCAL_NETWORK_TEXT } : infoPlist,
    },
    android: {
      ...config.android,
      package: `${androidPackage}${suffix.id}`,
      ...(firebase ? { googleServicesFile: firebase } : {}),
    },
    plugins: [
      ...(config.plugins ?? []),
      // Only the development build answers exp+schemapro-teacher://, the
      // scheme `expo start`'s QR code opens. The plugin is applied to every
      // build either way; listing it is how the option is set.
      ['expo-dev-client', { addGeneratedScheme: variant === 'development' }],
    ],
  };
};
