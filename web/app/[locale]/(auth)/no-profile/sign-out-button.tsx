"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { loadClient } from "@/utils/supabase/load-client";

/**
 * The one interactive control on the no-profile page. The page around it is
 * server-rendered; the Supabase client is fetched on the click.
 *
 * Two things can stop the sign-out, and neither may look like success. The
 * client chunk can fail to load (offline, or a deploy replaced it under an
 * open tab), and Supabase can answer with an error, in which case it keeps
 * the local session. Sending the user to the sign-in page after either would
 * leave them signed in behind a page that says otherwise, so the button stays
 * where it is and says something went wrong, the same line the sign-in forms
 * show.
 */
export function SignOutButton({
  loginPath,
  className,
  label,
  failed,
}: {
  /** Locale-prefixed sign-in path, e.g. /sv/login. */
  loginPath: string;
  className: string;
  label: string;
  /** Shown when the sign-out did not happen. */
  failed: string;
}) {
  const router = useRouter();
  const [error, setError] = useState(false);

  const signOut = async () => {
    setError(false);

    let signedOut: boolean;
    try {
      const supabase = await loadClient();
      const { error: signOutError } = await supabase.auth.signOut();
      signedOut = !signOutError;
    } catch {
      signedOut = false;
    }

    if (!signedOut) {
      setError(true);
      return;
    }

    router.replace(loginPath);
    router.refresh();
  };

  return (
    <>
      <button type="button" className={className} onClick={signOut}>
        {label}
      </button>
      {error ? <p className="text-sm text-destructive">{failed}</p> : null}
    </>
  );
}
