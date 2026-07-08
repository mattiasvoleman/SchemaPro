import { redirect } from "@/i18n/navigation";
import { getSession, homePathForRole } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function Page({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const session = await getSession();

  if (!session) {
    redirect({ href: "/login", locale });
  } else if (!session.profile) {
    redirect({ href: "/no-profile", locale });
  } else {
    redirect({ href: homePathForRole(session.profile.role), locale });
  }
}
