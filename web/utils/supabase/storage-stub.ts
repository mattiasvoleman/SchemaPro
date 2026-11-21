/**
 * What the browser gets in place of `@supabase/storage-js` (next.config.mjs,
 * `turbopack.resolveAlias`, browser condition only).
 *
 * This app never calls `supabase.storage`: files go through the gateway. But
 * `SupabaseClient`'s constructor builds a `StorageClient` unconditionally, so
 * the whole package rode along in every signed-in page's first load — 5 KB of
 * Storage code, 1.4 KB of `iceberg-js` under it, and, because StorageFileApi
 * names the Node global `Buffer`, Turbopack's 5.9 KB `buffer` polyfill beside
 * them. About 12 KB gzipped on every route for something nothing here calls.
 *
 * The stub is constructible, as the constructor requires, and refuses the
 * moment anything uses it, so a day somebody does reach for `supabase.storage`
 * they get this message and not an undefined method. utils/supabase/
 * storage-stub.test.ts holds the stub to what the installed supabase-js
 * imports from the real package.
 */

const REFUSAL =
  "Supabase Storage is not bundled in the browser build: this app keeps files behind the gateway. " +
  "Remove the @supabase/storage-js alias in next.config.mjs if you need it.";

function refuse(): never {
  throw new Error(REFUSAL);
}

export class StorageApiError extends Error {
  readonly status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.name = "StorageApiError";
    this.status = status;
  }
}

export class StorageClient {
  from(): never {
    return refuse();
  }
  listBuckets(): never {
    return refuse();
  }
  getBucket(): never {
    return refuse();
  }
  createBucket(): never {
    return refuse();
  }
  updateBucket(): never {
    return refuse();
  }
  emptyBucket(): never {
    return refuse();
  }
  deleteBucket(): never {
    return refuse();
  }
}
