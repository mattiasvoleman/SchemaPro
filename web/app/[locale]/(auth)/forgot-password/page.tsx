import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { localePath } from "@/i18n/paths";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { labelClassName } from "@/components/ui/label-style";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { ForgotPasswordForm } from "./forgot-password-form";

/** Server-rendered; only <ForgotPasswordForm> hydrates. See login/page.tsx. */
export default async function ForgotPasswordPage() {
  const locale = await getLocale();
  const t = await getTranslations("auth");
  const tCommon = await getTranslations("common");

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("resetTitle")}</CardTitle>
        <CardDescription>{t("resetSubtitle")}</CardDescription>
      </CardHeader>
      <CardContent>
        <ForgotPasswordForm
          updatePasswordPath={localePath(locale, "/update-password")}
          submitClassName={cn(buttonVariants({ className: "w-full" }))}
          labels={{
            sendResetLink: t("sendResetLink"),
            resetSent: t("resetSent"),
            failed: tCommon("error"),
          }}
        >
          <div className="space-y-2">
            <label htmlFor="email" className={labelClassName}>
              {t("email")}
            </label>
            <Input id="email" name="email" type="email" autoComplete="email" required />
          </div>
        </ForgotPasswordForm>
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
