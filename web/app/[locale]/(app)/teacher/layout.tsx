import { redirect } from "@/i18n/navigation";
import { getSession, homePathForRole } from "@/lib/auth";

export default async function TeacherLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const session = await getSession();

  if (session?.profile && session.profile.role === "STUDENT") {
    redirect({ href: homePathForRole(session.profile.role), locale });
    return null;
  }

  return <>{children}</>;
}
