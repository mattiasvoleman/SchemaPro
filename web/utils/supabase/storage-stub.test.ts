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
});

describe("the alias in next.config.mjs", () => {
  it("is for the browser only and names a file that exists, this one", async () => {
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

describe("what the app asks of Supabase", () => {
  const SKIP = new Set(["node_modules", ".next", "e2e", "coverage", "playwright-report"]);
  const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      if (SKIP.has(name)) return [];
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) return sources(full);
      return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && name !== "storage-stub.ts" ? [full] : [];
    });

  it("never calls supabase.storage, which the browser build does not carry", () => {
    const calls = sources(webRoot).filter((file) =>
      /\.storage\s*\.\s*(from|listBuckets|getBucket|createBucket|updateBucket|emptyBucket|deleteBucket)\b/.test(
        readFileSync(file, "utf8"),
      ),
    );
    // To use Storage: remove the @supabase/storage-js alias in next.config.mjs
    // (and this stub), and accept ~12 KB on every signed-in page.
    expect(calls.map((file) => path.relative(webRoot, file))).toEqual([]);
  });
});
