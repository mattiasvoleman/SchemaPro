import { cookies } from "next/headers";
import { getLocale, getTranslations } from "next-intl/server";
import { ShieldAlert } from "lucide-react";
import { localePath } from "@/i18n/paths";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { schoolAccountAddressOf } from "@/lib/school-account";
import { cn } from "@/lib/utils";
import { createClient } from "@/utils/supabase/server";
import { SignOutButton } from "./sign-out-button";

/**
 * The school-account address of this session, or null. Such a person has an
 * Auth account, since public signups are off, but no SchemaPro profile: most
 * likely the school invited them under another address than the one their
 * school account carries, or removed them.
 */
async function schoolAccountAddress(): Promise<string | null> {
  try {
    const { data } = await createClient(await cookies()).auth.getClaims();
    return schoolAccountAddressOf(data?.claims);
  } catch {
    return null;
  }
}

/** Server-rendered; only <SignOutButton> hydrates. See login/page.tsx. */
export default async function NoProfilePage() {
  const locale = await getLocale();
  const t = await getTranslations("auth");
  const tCommon = await getTranslations("common");
  const address = await schoolAccountAddress();

  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-4 pt-6 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-warning/15">
          <ShieldAlert className="h-6 w-6 text-warning" />
        </div>
        <p className="text-sm text-muted-foreground">
          {address ? t("noProfileSchoolAccount", { email: address }) : t("noProfile")}
        </p>
        <SignOutButton
          loginPath={localePath(locale, "/login")}
          className={cn(buttonVariants({ variant: "outline" }))}
          label={tCommon("signOut")}
          failed={tCommon("error")}
        />
      </CardContent>
    </Card>
  );
}
