import { en } from './en';
import { sv } from './sv';
import { translate, type Locale, type Messages, type MessageKey, type Params, type Translate } from './translate';
import { appIdentity, type AppIdentity } from '../config/appIdentity';

export type { Locale, Messages, MessageKey, Params, Translate } from './translate';
export { LOCALES } from './translate';

export const CATALOGUES: Readonly<Record<Locale, Messages>> = { sv, en };

/**
 * What every message may name without its caller passing it: {app} (this
 * app's store name), {appLabel} (the name under the icon, " Test" or " Dev"
 * included, which is what the phone's settings list) and {otherApp}. A build
 * without an identity (jest, a broken build) words them as Rastra; the gate,
 * not the wording, refuses such a build.
 */
export function appParams(identity: AppIdentity | null = appIdentity()): Params {
  const id = identity ?? { name: 'Rastra', label: 'Rastra', otherName: 'Rastra vårdnadshavare' };
  return { app: id.name, appLabel: id.label, otherApp: id.otherName };
}

/** A t() bound to one language, for code outside React (and for the provider). A caller's own param wins. */
export function translatorFor(locale: Locale, defaults: Params = appParams()): Translate {
  const messages = CATALOGUES[locale];
  return (key: MessageKey, params?: Params) => translate(messages, key, params ? { ...defaults, ...params } : defaults);
}
