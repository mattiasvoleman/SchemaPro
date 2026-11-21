/**
 * The words of the pseudonymiser's page, as the page's client part receives them (Pseudonymiseraren, X1).
 *
 * The page is public and ships no next-intl client runtime, so the server reads the `pseudonymiserare` namespace of the catalogue in the
 * visitor's language, flattens it to `{ "tool.addFiles": "…" }` and hands it to the tool as a prop; the tool fills in the few that have a
 * {count} or {name} with lib/pseudonym-message.ts. The KEYS are typed from the Swedish catalogue, so a key the tool asks for that does not
 * exist is a compile error and not a blank in a school's browser; messages.test.ts holds English to the same keys.
 */

import type sv from "@/messages/sv.json";
import { formatMessage, type MessageValues } from "@/lib/pseudonym-message";

type Namespace = (typeof sv)["pseudonymiserare"];

/** "a.b" for every string at the end of a path in an object. */
type Paths<T> = T extends string ? never : { [K in keyof T & string]: T[K] extends string ? K : `${K}.${Paths<T[K]>}` }[keyof T & string];

export type LabelKey = Paths<Namespace>;
export type Labels = Readonly<Record<LabelKey, string>>;

/** A nested namespace as the flat `{ "a.b": "text" }` the tool takes. Only strings are kept. */
export function flattenLabels(namespace: unknown, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  if (namespace === null || typeof namespace !== "object") return out;
  for (const [key, value] of Object.entries(namespace as Record<string, unknown>)) {
    if (typeof value === "string") out[`${prefix}${key}`] = value;
    else Object.assign(out, flattenLabels(value, `${prefix}${key}.`));
  }
  return out;
}

/** The function the tool and the report say things with: a key, and the values to fill in. */
export type Say = (key: LabelKey, values?: MessageValues) => string;

export function sayWith(labels: Labels, locale: string): Say {
  return (key, values) => formatMessage(labels[key], values, locale);
}
