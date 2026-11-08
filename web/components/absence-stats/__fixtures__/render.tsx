import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactElement } from "react";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";

/**
 * Renders under the real messages: a key missing from sv.json or en.json
 * throws here instead of printing its path.
 */
export function renderStats(ui: ReactElement, locale: "sv" | "en" = "sv") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider
        locale={locale}
        messages={locale === "sv" ? sv : en}
        timeZone="Europe/Stockholm"
        onError={(error) => {
          throw error;
        }}
      >
        {ui}
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

/**
 * The text of a node as a reader meets it: every text node apart from the
 * next by a space (a block under a figure is a line of its own), and every
 * kind of space plain (sv-SE writes 1 234 with a no-break space).
 */
export function plain(node: Node | string | null | undefined): string {
  if (node === null || node === undefined) return "";
  const parts: string[] = [];
  const walk = (one: Node) => {
    if (one.nodeType === Node.TEXT_NODE) parts.push(one.textContent ?? "");
    else one.childNodes.forEach(walk);
  };
  if (typeof node === "string") parts.push(node);
  else walk(node);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}
