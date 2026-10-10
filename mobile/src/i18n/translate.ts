import type { sv } from './sv';

/**
 * The catalogue's types and the one pure function that reads it.
 *
 * No i18n library: the app needs {name} interpolation and a one/other plural
 * in two languages, and both fit in this file. Pure, so the runner can reach
 * it — jest.config.js renders no screens by design.
 */

type Widen<T> = { readonly [K in keyof T]: T[K] extends string ? string : Widen<T[K]> };

/** The shape of sv.ts with every leaf widened to string: what en.ts must be. */
export type Messages = Widen<typeof sv>;

export type Locale = 'sv' | 'en';

export const LOCALES: readonly Locale[] = ['sv', 'en'];

type Paths<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : Paths<T[K], `${P}${K}.`>;
}[keyof T & string];

type Plural<K> = K extends `${infer Base}_one` ? Base : K extends `${infer Base}_other` ? Base : K;

/** Every key a screen may ask for, plurals by their base name ("notifications.unread"). */
export type MessageKey = Plural<Paths<Messages>>;

export type Params = Readonly<Record<string, string | number>>;

export type Translate = (key: MessageKey, params?: Params) => string;

function lookup(messages: Messages, path: string): unknown {
  let node: unknown = messages;
  for (const part of path.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

/**
 * The message for `key` in `messages`, with {name} replaced from `params`.
 *
 * A plural key is asked for by its base: with params.count === 1 the `_one`
 * form, else `_other`. A missing key returns the key itself — visible in the
 * UI and caught by catalog.test.ts — rather than throwing in a screen. A
 * placeholder without a value is left as written, for the same reason.
 */
export function translate(messages: Messages, key: string, params?: Params): string {
  let found = lookup(messages, key);
  if (typeof found !== 'string' && params && typeof params['count'] === 'number') {
    found = lookup(messages, `${key}_${params['count'] === 1 ? 'one' : 'other'}`);
  }
  if (typeof found !== 'string') return key;
  if (!params) return found;
  return found.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole,
  );
}
