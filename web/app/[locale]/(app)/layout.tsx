import { redirect } from "@/i18n/navigation";
import { getSession } from "@/lib/auth";
import { AppShell } from "@/components/layout/app-shell";
import { ProfileProvider } from "@/components/profile-context";

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

  return (
    <ProfileProvider profile={profile} school={school}>
      <AppShell
        role={profile.role}
        userName={`${profile.firstName} ${profile.lastName}`}
        email={profile.email}
        schoolName={school?.name ?? ""}
      >
        {children}
      </AppShell>
    </ProfileProvider>
  );
}
