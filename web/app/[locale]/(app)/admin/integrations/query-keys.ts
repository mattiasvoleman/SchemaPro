/*
 * The react-query keys of /admin/integrations — the publication-keys.ts
 * pattern, beside the one page that uses them. Each is the prefix
 * react-query matches on invalidation.
 *
 * ["people"] and ["groups"] are lib/queries.ts's, repeated as data so an
 * apply can make them stale without this page importing their hooks.
 */
export const INTEGRATION_KEYS = {
  source: ["ss12000Source"],
  runs: ["ss12000Runs"],
  changes: ["ss12000Changes"],
  provisioning: ["ss12000Provisioning"],
  providerKeys: ["integrationKeysProvider"],
} as const;

/** What an applied diff makes stale elsewhere: the register and the classes. */
export const AFTER_APPLY: readonly (readonly string[])[] = [["people"], ["groups"]];
