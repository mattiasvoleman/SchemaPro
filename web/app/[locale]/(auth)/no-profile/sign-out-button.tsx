"use client";

import { useRouter } from "next/navigation";
import { loadClient } from "@/utils/supabase/load-client";

/**
 * The one interactive control on the no-profile page. The page around it is
 * server-rendered; the Supabase client is fetched on the click.
 */
export function SignOutButton({
  loginPath,
  className,
  label,
}: {
  /** Locale-prefixed sign-in path, e.g. /sv/login. */
  loginPath: string;
  className: string;
  label: string;
}) {
  const router = useRouter();

  const signOut = async () => {
    const supabase = await loadClient();
    await supabase.auth.signOut();
    router.replace(loginPath);
    router.refresh();
  };

  return (
    <button type="button" className={className} onClick={signOut}>
      {label}
    </button>
  );
}
