"use client";

import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";

/**
 * Providers for the authenticated app only, mounted by (app)/layout.tsx.
 *
 * These deliberately do NOT live in the root layout. The four unauthenticated
 * routes call `supabase.auth` directly with local state and never call
 * `toast()`, so shipping a query cache and a toast renderer to them cost
 * ~17KB gzipped for nothing.
 *
 * Anything needed by an unauthenticated page belongs in `Providers` instead.
 */
export function AppProviders({
  children,
  toastLabel,
}: {
  children: React.ReactNode;
  /**
   * The name of the toasts' live region. Sonner's own is "Notifications",
   * English on a Swedish page and the same word as the bell beside it.
   */
  toastLabel: string;
}) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            retry: 1,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      {children}
      <Toaster richColors position="bottom-right" containerAriaLabel={toastLabel} />
    </QueryClientProvider>
  );
}
