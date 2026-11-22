import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import createNextIntlPlugin from "next-intl/plugin";

const __dirname = dirname(fileURLToPath(import.meta.url));

const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // This app lives in a monorepo with multiple lockfiles; pin the Turbopack
  // root to this package so Next.js does not infer the repo root.
  turbopack: {
    root: __dirname,
    resolveAlias: {
      // The browser never uses Supabase Storage; see utils/supabase/storage-stub.ts.
      // The server render keeps the real package.
      "@supabase/storage-js": { browser: "./utils/supabase/storage-stub.ts" },
    },
  },
};

export default withNextIntl(nextConfig);
