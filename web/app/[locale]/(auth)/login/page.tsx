import Link from "next/link";
import { OctagonX } from "lucide-react";
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
import { isSsoReason } from "@/lib/school-account";
import { cn } from "@/lib/utils";
import { LoginForm, type SchoolAccountOption } from "./login-form";

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
 *
 * "Logga in med skolkonto" is offered when the deployment has turned it on
 * (NEXT_PUBLIC_SCHOOL_ACCOUNTS=on, after the hook and the providers are set
 * up, docs/DEPLOYMENT.md §11) and the gateway's address is known
 * (NEXT_PUBLIC_API_BASE_URL, which the lookup needs). A school-account
 * sign-in that came back without a session lands here with `?sso=<reason>`
 * from /auth/callback, and the reason is said above the form; anything else
 * in that parameter is ignored.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const locale = await getLocale();
  const t = await getTranslations("auth");
  const tCommon = await getTranslations("common");
  const { sso } = await searchParams;
  const reason = isSsoReason(sso) ? sso : null;
  const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL;
  const enabled = apiBase !== undefined && apiBase !== "" && process.env.NEXT_PUBLIC_SCHOOL_ACCOUNTS === "on";
  const schoolAccount: SchoolAccountOption | undefined = enabled
    ? {
        apiBase,
        callbackPath: localePath(locale, "/auth/callback"),
        className: cn(buttonVariants({ variant: "outline", className: "w-full" })),
        labels: {
          button: t("schoolAccount"),
          or: t("or"),
          redirecting: t("schoolAccountRedirecting"),
          needsEmail: t("schoolAccountNeedsEmail"),
          notFound: t("schoolAccountNotFound"),
          busy: t("schoolAccountBusy"),
        },
      }
    : undefined;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("signInTitle")}</CardTitle>
        <CardDescription>{t("signInSubtitle")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {reason ? (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm"
          >
            <OctagonX className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
            <p>{t(`ssoReasons.${reason}`)}</p>
          </div>
        ) : null}
        <LoginForm
          home={localePath(locale, "/")}
          submitClassName={cn(buttonVariants({ className: "w-full" }))}
          labels={{
            signIn: t("signIn"),
            signingIn: t("signingIn"),
            invalidCredentials: t("invalidCredentials"),
            failed: tCommon("error"),
            ssoRequired: t("ssoRequired"),
          }}
          schoolAccount={schoolAccount}
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
