import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { localePath } from "@/i18n/paths";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { labelClassName } from "@/components/ui/label-style";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { UpdatePasswordForm } from "./update-password-form";

/** Server-rendered; only <UpdatePasswordForm> hydrates. See login/page.tsx. */
export default async function UpdatePasswordPage() {
  const locale = await getLocale();
  const t = await getTranslations("auth");
  const tCommon = await getTranslations("common");

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("updatePasswordTitle")}</CardTitle>
      </CardHeader>
      <CardContent>
        <UpdatePasswordForm
          home={localePath(locale, "/")}
          submitClassName={cn(buttonVariants({ className: "w-full" }))}
          labels={{ updatePassword: t("updatePassword"), failed: tCommon("error") }}
        >
          <div className="space-y-2">
            <label htmlFor="password" className={labelClassName}>
              {t("newPassword")}
            </label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={8}
              required
            />
          </div>
        </UpdatePasswordForm>
        <div className="mt-4 text-center">
          <Link
            href={localePath(locale, "/login")}
            className="text-sm text-primary underline-offset-4 hover:underline"
          >
            {t("backToSignIn")}
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
