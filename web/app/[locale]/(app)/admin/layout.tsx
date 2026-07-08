import { redirect } from "@/i18n/navigation";
import { getSession, homePathForRole } from "@/lib/auth";

export default async function AdminLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const session = await getSession();

  if (session?.profile && session.profile.role !== "SCHOOL_ADMIN") {
    redirect({ href: homePathForRole(session.profile.role), locale });
    return null;
  }

  return <>{children}</>;
}
