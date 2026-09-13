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
import { LoginForm } from "./login-form";

/**
 * Server-rendered; only <LoginForm> hydrates.
 *
 * The whole page used to be a client component. That put next-intl's client
 * runtime, tailwind-merge and the Supabase client into the first load, and
 * needed the root layout to send every message in the app along with it. Now
 * the text is resolved here and handed to the form as strings, and the
 * Supabase client is fetched once somebody starts filling the form in.
 *
 * Three imports are avoided on purpose, because each one puts a client
 * boundary into the page whether or not anything from it is rendered:
 *  - @/i18n/navigation, whose <Link> needs a client-side intl provider these
 *    routes do not mount. Paths come from localePath, links from next/link.
 *  - <Label> from components/ui, which is radix plus tailwind-merge. The
 *    labels are plain <label>s carrying the same class.
 *  - @/utils/supabase/client; see utils/supabase/load-client.ts.
 * The other unauthenticated pages follow the same rules.
 */
export default async function LoginPage() {
  const locale = await getLocale();
  const t = await getTranslations("auth");
  const tCommon = await getTranslations("common");

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("signInTitle")}</CardTitle>
        <CardDescription>{t("signInSubtitle")}</CardDescription>
      </CardHeader>
      <CardContent>
        <LoginForm
          home={localePath(locale, "/")}
          submitClassName={cn(buttonVariants({ className: "w-full" }))}
          labels={{
            signIn: t("signIn"),
            signingIn: t("signingIn"),
            invalidCredentials: t("invalidCredentials"),
            failed: tCommon("error"),
          }}
        >
          <div className="space-y-2">
            <label htmlFor="email" className={labelClassName}>
              {t("email")}
            </label>
            <Input id="email" name="email" type="email" autoComplete="email" required />
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label htmlFor="password" className={labelClassName}>
                {t("password")}
              </label>
              <Link
                href={localePath(locale, "/forgot-password")}
                className="text-xs text-primary underline-offset-4 hover:underline"
              >
                {t("forgotPassword")}
              </Link>
            </div>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </div>
        </LoginForm>
      </CardContent>
    </Card>
  );
}
