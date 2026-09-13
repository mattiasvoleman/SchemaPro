import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { hasLocale } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { routing } from "@/i18n/routing";
import { Providers } from "@/components/providers";
import "../globals.css";

export const metadata: Metadata = {
  title: {
    default: "SchemaPro",
    template: "%s · SchemaPro",
  },
  description: "AI-driven school scheduling & attendance system",
};

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export default async function LocaleLayout({
  children,
  params,
}: Readonly<{
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}>) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }
  setRequestLocale(locale);

  // No NextIntlClientProvider here. Without a `messages` prop it serialises
  // the entire catalogue into the page, and on /login that was 72KB of the
  // 80KB HTML — admin screens and engine sentences included — plus the
  // next-intl client runtime to read it. The unauthenticated pages resolve
  // their text on the server; (app)/layout.tsx mounts the provider for the
  // screens that translate in the browser.
  return (
    <html lang={locale} suppressHydrationWarning>
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
