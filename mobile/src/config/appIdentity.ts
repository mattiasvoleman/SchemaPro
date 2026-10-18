import Constants from 'expo-constants';

/**
 * Which of the two store apps this build is.
 *
 * One code base, two apps with listings of their own: Rastra for staff and
 * pupils, Rastra vårdnadshavare for guardians. app.config.ts writes the
 * build's app into extra.app from the same table that gives it its bundle
 * id, so the two cannot disagree in a build; Constants.expoConfig is the
 * config embedded in the binary, read without the network. (A development
 * client reads it from the `expo start` it opened, hence the npm scripts per
 * app.)
 *
 * Read at call time, never at import: jest-expo's expo-constants carries no
 * extra, and a module that threw on import would take every importer's
 * suite with it.
 */
export type AppId = 'rastra' | 'vardnadshavare';

export interface AppIdentity {
  readonly id: AppId;
  /** The store name: "Rastra" or "Rastra vårdnadshavare". */
  readonly name: string;
  /** The name under the icon, " Test" or " Dev" included: what to look for in the phone's settings. */
  readonly label: string;
  /** The other app's store name, for a person who opened the wrong one. */
  readonly otherName: string;
}

export function isAppId(value: unknown): value is AppId {
  return value === 'rastra' || value === 'vardnadshavare';
}

/** This build's identity, or null when the build carries none (a broken build: the gate then admits nobody). */
export function appIdentity(): AppIdentity | null {
  const config = Constants.expoConfig;
  const raw: unknown = config?.extra?.['app'];
  if (raw === null || typeof raw !== 'object') return null;
  const { id, name, otherName } = raw as Record<string, unknown>;
  if (!isAppId(id) || typeof name !== 'string' || typeof otherName !== 'string') return null;
  return { id, name, otherName, label: typeof config?.name === 'string' && config.name !== '' ? config.name : name };
}

export function currentApp(): AppId | null {
  return appIdentity()?.id ?? null;
}
