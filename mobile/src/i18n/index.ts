import { en } from './en';
import { sv } from './sv';
import { translate, type Locale, type Messages, type MessageKey, type Params, type Translate } from './translate';

export type { Locale, Messages, MessageKey, Params, Translate } from './translate';
export { LOCALES } from './translate';

export const CATALOGUES: Readonly<Record<Locale, Messages>> = { sv, en };

/** A t() bound to one language, for code outside React (and for the provider). */
export function translatorFor(locale: Locale): Translate {
  const messages = CATALOGUES[locale];
  return (key: MessageKey, params?: Params) => translate(messages, key, params);
}
