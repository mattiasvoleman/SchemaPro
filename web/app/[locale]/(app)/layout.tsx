import { NextIntlClientProvider } from "next-intl";
import { getTranslations } from "next-intl/server";
import { redirect } from "@/i18n/navigation";
import { getSession } from "@/lib/auth";
import { AppShell } from "@/components/layout/app-shell";
import { SchoolSwitcher } from "@/components/layout/school-switcher";
import { SCHOOL_META } from "@/lib/school-choice";
import { AppProviders } from "@/components/app-providers";
import { ClosedPageGate, ProfileProvider } from "@/components/profile-context";
import { READS_EVERY_PAGE, closedPages, readOnlyPages } from "@/lib/admin-areas";
import { closedMenuStyle, closedPagesFor, readOnlyNoticesFor, readOnlyStyle } from "@/components/admin/area-refusal";

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

  const { profile, school, schools, namedSchool } = session;
  const t = await getTranslations("common");
  const tNav = await getTranslations("nav");
  // Roller i skolan: the admin pages this profile does not use, worked out
  // here on the server, each with the page that says why
  // (lib/admin-areas.ts ClosedPages). A style rule leaves them out of the
  // menu (closedMenuStyle), and ClosedPageGate shows that page in place of
  // one. A profile the session did not read reads as full, as every
  // administrator was. Läsbehörighet: the pages a läsare opens read-only,
  // each with a notice that names the area, and a style rule that hides the
  // write controls of every area the profile does not write.
  const admin = profile.role === "SCHOOL_ADMIN";
  const adminProfile = profile.adminProfile === undefined ? "FULL" : profile.adminProfile;
  const closed = admin ? closedPages(adminProfile) : [];
  const readOnly = admin ? readOnlyPages(adminProfile) : [];
  const style = admin
    ? closedMenuStyle(closed, tNav("label")) + readOnlyStyle(readOnly, adminProfile, tNav("label"))
    : "";
  const changesNothing = admin && adminProfile !== null && READS_EVERY_PAGE.includes(adminProfile);

  // AppProviders (react-query + sonner) and NextIntlClientProvider are mounted
  // here rather than in the root layout so the unauthenticated routes do not
  // download them. The intl provider in particular carries every message in
  // the app; see [locale]/layout.tsx.
  return (
    <NextIntlClientProvider>
      <AppProviders toastLabel={t("toasts")}>
        <ProfileProvider
          profile={profile}
          school={school}
          readOnly={changesNothing}
          closed={closedPagesFor(closed, profile.adminProfile ?? null, locale)}
          schools={schools}
          namedSchool={namedSchool}
        >
          {/* Flera skolor per inloggning: the school this page is for, which
              the browser's clients name to the gateway and PostgREST
              (lib/school-choice.ts). Only for a session with more than one. */}
          {namedSchool ? <meta name={SCHOOL_META} content={namedSchool} /> : null}
          {style ? <style dangerouslySetInnerHTML={{ __html: style }} /> : null}
          <AppShell
            role={profile.role}
            userName={`${profile.firstName} ${profile.lastName}`}
            email={profile.email}
            schoolName={<SchoolSwitcher schools={schools} currentName={school?.name ?? ""} locale={locale} />}
          >
            <ClosedPageGate>
              {admin ? readOnlyNoticesFor(readOnly, adminProfile) : null}
              {children}
            </ClosedPageGate>
          </AppShell>
        </ProfileProvider>
      </AppProviders>
    </NextIntlClientProvider>
  );
}
