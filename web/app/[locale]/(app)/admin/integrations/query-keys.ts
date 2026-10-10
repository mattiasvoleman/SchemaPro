/*
 * The react-query keys of /admin/integrations — the publication-keys.ts
 * pattern, beside the one page that uses them. Each is the prefix
 * react-query matches on invalidation.
 */
export const INTEGRATION_KEYS = {
  providerKeys: ["integrationKeysProvider"],
} as const;
