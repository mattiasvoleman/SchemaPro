import { CalendarRange } from "lucide-react";
import { useTranslations } from "next-intl";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return <AuthFrame>{children}</AuthFrame>;
}

function AuthFrame({ children }: { children: React.ReactNode }) {
  const t = useTranslations("common");

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
      <div className="w-full max-w-sm">{children}</div>
    </div>
  );
}
