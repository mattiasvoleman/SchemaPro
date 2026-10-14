import { CalendarRange } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { localePath } from "@/i18n/paths";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return <AuthFrame>{children}</AuthFrame>;
}

function AuthFrame({ children }: { children: React.ReactNode }) {
  const t = useTranslations("common");
  const tStatement = useTranslations("accessibilityStatement");
  const locale = useLocale();

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-muted/40 px-4">
      <div className="mb-8 flex items-center gap-2.5">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-md">
          <CalendarRange className="h-5 w-5" />
        </div>
        <div>
          <div className="text-lg font-semibold leading-tight">{t("appName")}</div>
          <div className="text-xs text-muted-foreground">{t("tagline")}</div>
        </div>
      </div>
      {/* The landmark a screen reader jumps to; the brand above is not the page. */}
      <main className="w-full max-w-sm">{children}</main>
      {/* Reachable before signing in, as Digg asks of the statement. A plain
          <a>: next/link would put 3.3KB of client router on /no-profile,
          which has no other link, for a page that needs no prefetch. */}
      <footer className="mt-8 text-xs">
        <a
          href={localePath(locale, "/tillganglighet")}
          className="text-muted-foreground underline underline-offset-4 hover:text-foreground"
        >
          {tStatement("link")}
        </a>
      </footer>
    </div>
  );
}
