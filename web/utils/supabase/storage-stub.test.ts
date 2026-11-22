import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import * as stub from "./storage-stub";

/**
 * The browser build swaps @supabase/storage-js for ./storage-stub.ts
 * (next.config.mjs). Nothing in the app calls Supabase Storage, so the swap
 * saves ~12 KB gzipped on every signed-in page; what these tests keep is that
 * it stays safe. The gate cannot: a stub that no longer fits the supabase-js
 * installed would build, pass the bundle gate and fail only in a browser.
 */
vi.mock("@supabase/storage-js", () => import("./storage-stub"));

const webRoot = path.resolve(import.meta.dirname, "../..");
const supabaseJs = path.join(webRoot, "node_modules/@supabase/supabase-js/dist");

describe("the storage stub fits the installed supabase-js", () => {
  it("exports everything supabase-js takes from @supabase/storage-js, in both builds", () => {
    const esm = readFileSync(path.join(supabaseJs, "index.mjs"), "utf8");
    const imported = [...esm.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']@supabase\/storage-js["']/g)]
      .flatMap((match) => match[1]!.split(","))
      .map((name) => name.trim().split(/\s+as\s+/)[0]!)
      .filter(Boolean);
    const cjs = readFileSync(path.join(supabaseJs, "index.cjs"), "utf8");
    const required = [...cjs.matchAll(/_supabase_storage_js\.(\w+)/g)].map((match) => match[1]!);

    // Guards the guard: a supabase-js that changed how it names the package
    // must not turn this into a test of nothing.
    expect(imported).toContain("StorageClient");
    expect(required).toContain("StorageClient");

    const missing = [...new Set([...imported, ...required])].filter((name) => !(name in stub));
    expect(missing).toEqual([]);
  });

  let client: SupabaseClient;
  beforeAll(async () => {
    const { createClient } = await import("@supabase/supabase-js");
    client = createClient("https://placeholder.supabase.co", "placeholder-publishable-key");
  });

  it("lets a real supabase-js client be built, as its constructor does without being asked", () => {
    expect(client.auth).toBeDefined();
    expect(client.from).toBeTypeOf("function");
    expect(client.channel).toBeTypeOf("function");
  });

  it("says why when something does use Storage, instead of failing on a missing method", () => {
    expect(() => client.storage.from("avatars")).toThrow(/not bundled in the browser build/);
    expect(() => client.storage.listBuckets()).toThrow(/storage-js alias in next\.config\.mjs/);
  });

  it("says the same for the members the stub once left undefined (vectors, analytics, throwOnError)", () => {
    expect(() => client.storage.vectors).toThrow(/not bundled in the browser build/);
    expect(() => client.storage.analytics).toThrow(/not bundled in the browser build/);
    expect(() => client.storage.throwOnError()).toThrow(/not bundled in the browser build/);
  });
});

describe("the alias in next.config.mjs", () => {
  // Loading next.config.mjs pulls in next-intl/plugin and Next's own config helpers: 2.4 s on a loaded
  // machine, and a 5 s timeout (the default) on the first run at load 170. A test of a config file is not a speed test.
  it("is for the browser only and names a file that exists, this one", { timeout: 30_000 }, async () => {
    const configPath = path.join(webRoot, "next.config.mjs");
    // A variable specifier: the config is plain JavaScript with no types.
    const config = (await import(/* @vite-ignore */ configPath)).default as {
      turbopack?: { resolveAlias?: Record<string, unknown> };
    };
    const alias = config.turbopack?.resolveAlias?.["@supabase/storage-js"];

    // Bare string would swap the server render's package too.
    expect(alias).toEqual({ browser: "./utils/supabase/storage-stub.ts" });
    const target = path.join(webRoot, (alias as { browser: string }).browser);
    expect(statSync(target).isFile()).toBe(true);
    expect(target).toBe(path.join(webRoot, "utils/supabase/storage-stub.ts"));
  });
});

/**
 * What in one file's text reaches for Supabase Storage, which the browser build
 * does not carry. Not only the literal `.storage.from(`: the same call is made
 * through a destructured client, an optional chain, a bracket, a reference kept
 * in a variable, `.vectors` or `.analytics`, or by importing the package itself,
 * and each of those builds, passes the bundle gate and fails first in a browser.
 */
function storageUses(source: string): string[] {
  const uses: string[] = [];
  // navigator.storage is the browser's own StorageManager, nothing to do with Supabase.
  if (/(?<!\bnavigator)(?:\?\.|\.)\s*storage\b/.test(source)) uses.push("a .storage member");
  if (/\{[^{}]*\bstorage\b[^{}]*\}\s*=(?![=>])/.test(source)) uses.push("a destructured storage");
  if (/\[\s*["'`]storage["'`]\s*\]/.test(source)) uses.push("a ['storage'] access");
  if (/@supabase\/storage-js/.test(source)) uses.push("an import of @supabase/storage-js");
  return uses;
}

describe("what counts as using Supabase Storage", () => {
  it.each([
    ["a call", 'const f = supabase.storage.from("a");'],
    ["a call over three lines", "supabase\n  .storage\n  .from('a');"],
    ["an optional chain", 'const f = supabase.storage?.from("a");'],
    ["a destructured client", "const { auth, storage } = createClient();"],
    ["a bracket", 'const f = supabase["storage"].from("a");'],
    ["a reference kept in a variable", "const files = supabase.storage;"],
    ["the vectors API", "supabase.storage.vectors.from('a');"],
    ["the package itself", 'import { StorageClient } from "@supabase/storage-js";'],
  ])("sees %s", (_name, source) => {
    expect(storageUses(source)).not.toEqual([]);
  });

  it.each([
    ["the auth session's own storage option", "createClient(url, key, { auth: { storage: cookieStorage } });"],
    ["the browser's local storage", 'window.localStorage.getItem("a");'],
    ["the browser's storage manager", "await navigator.storage.persist();"],
    ["a name that only starts with storage", "const key = options.storageKey;"],
  ])("leaves %s alone", (_name, source) => {
    expect(storageUses(source)).toEqual([]);
  });
});

describe("what the app asks of Supabase", () => {
  const SKIP = new Set(["node_modules", ".next", "e2e", "coverage", "playwright-report"]);
  const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      if (SKIP.has(name)) return [];
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) return sources(full);
      return /\.(ts|tsx|mts|js|jsx)$/.test(name) && !/\.test\.[mc]?[tj]sx?$/.test(name) && name !== "storage-stub.ts"
        ? [full]
        : [];
    });

  // Reads every source file under web/ (2 s on a loaded machine), so it gets room: the default is 5 s.
  it("never reaches for supabase.storage, which the browser build does not carry", { timeout: 30_000 }, () => {
    const calls = sources(webRoot).filter((file) => storageUses(readFileSync(file, "utf8")).length > 0);
    // To use Storage: remove the @supabase/storage-js alias in next.config.mjs
    // (and this stub), and accept ~12 KB on every signed-in page.
    expect(calls.map((file) => path.relative(webRoot, file))).toEqual([]);
  });
});
