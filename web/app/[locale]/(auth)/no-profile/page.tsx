import { getLocale, getTranslations } from "next-intl/server";
import { ShieldAlert } from "lucide-react";
import { localePath } from "@/i18n/paths";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { SignOutButton } from "./sign-out-button";

/** Server-rendered; only <SignOutButton> hydrates. See login/page.tsx. */
export default async function NoProfilePage() {
  const locale = await getLocale();
  const t = await getTranslations("auth");
  const tCommon = await getTranslations("common");

  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-4 pt-6 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-warning/15">
          <ShieldAlert className="h-6 w-6 text-warning" />
        </div>
        <p className="text-sm text-muted-foreground">{t("noProfile")}</p>
        <SignOutButton
          loginPath={localePath(locale, "/login")}
          className={cn(buttonVariants({ variant: "outline" }))}
          label={tCommon("signOut")}
        />
      </CardContent>
    </Card>
  );
}
