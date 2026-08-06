"use client";

import { ThemeProvider } from "next-themes";

/**
 * Providers for **every** route, authenticated or not.
 *
 * Keep this minimal: anything added here is downloaded by /login,
 * /forgot-password and /_not-found, which need almost nothing. Theme is the
 * one genuine exception — dark mode applies to the auth pages too, and the
 * accessibility suite asserts contrast on /sv/login in dark mode.
 *
 * Data-fetching and notification providers live in `AppProviders`, mounted by
 * the (app) route group. Moving QueryClientProvider and sonner's Toaster out
 * of here removed ~17KB gzipped from every unauthenticated route, which was
 * previously loading a query cache and a toast renderer it never used.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      {children}
    </ThemeProvider>
  );
}
