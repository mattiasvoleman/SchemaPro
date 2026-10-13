import { NextIntlClientProvider } from "next-intl";
import { getTranslations } from "next-intl/server";
import { redirect } from "@/i18n/navigation";
import { getSession } from "@/lib/auth";
import { AppShell } from "@/components/layout/app-shell";
import { AppProviders } from "@/components/app-providers";
import { ClosedPageGate, ProfileProvider } from "@/components/profile-context";
import { closedPages } from "@/lib/admin-areas";
import { closedMenuStyle, closedPagesFor } from "@/components/admin/area-refusal";

export const dynamic = "force-dynamic";

export default async function AppLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const session = await getSession();

  if (!session) {
    redirect({ href: "/login", locale });
    return null;
  }
  if (!session.profile) {
    redirect({ href: "/no-profile", locale });
    return null;
  }

  const { profile, school } = session;
  const t = await getTranslations("common");
  const tNav = await getTranslations("nav");
  // Roller i skolan: the admin pages this profile does not use, worked out
  // here on the server, each with the page that says why
  // (lib/admin-areas.ts ClosedPages). A style rule leaves them out of the
  // menu (closedMenuStyle), and ClosedPageGate shows that page in place of
  // one. A profile the session did not read reads as full, as every
  // administrator was.
  const closed =
    profile.role === "SCHOOL_ADMIN"
      ? closedPages(profile.adminProfile === undefined ? "FULL" : profile.adminProfile)
      : [];

  // AppProviders (react-query + sonner) and NextIntlClientProvider are mounted
  // here rather than in the root layout so the unauthenticated routes do not
  // download them. The intl provider in particular carries every message in
  // the app; see [locale]/layout.tsx.
  return (
    <NextIntlClientProvider>
      <AppProviders toastLabel={t("toasts")}>
        <ProfileProvider profile={profile} school={school} closed={closedPagesFor(closed, profile.adminProfile ?? null, locale)}>
          {closed.length > 0 ? <style dangerouslySetInnerHTML={{ __html: closedMenuStyle(closed, tNav("label")) }} /> : null}
          <AppShell
            role={profile.role}
            userName={`${profile.firstName} ${profile.lastName}`}
            email={profile.email}
            schoolName={school?.name ?? ""}
          >
            <ClosedPageGate>{children}</ClosedPageGate>
          </AppShell>
        </ProfileProvider>
      </AppProviders>
    </NextIntlClientProvider>
  );
}
